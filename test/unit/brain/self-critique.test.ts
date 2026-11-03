import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  parseSelfCritiqueResponse,
  runSelfCritique,
  loadSelfCritiqueConfig,
  writeCritiqueFile,
  buildCritiquePrompt,
  type SpawnCritic,
  type CriticSpawnResult,
} from '../../../src/brain/self-critique.js'
import type { Suggestion } from '../../../src/suggest/types.js'

function makeSuggestion(overrides: Partial<Suggestion> = {}): Suggestion {
  return {
    id: '550e8400-e29b-41d4-a716-446655440000',
    type: 'automation',
    title: 'Add nightly log rotation',
    description: 'Rotate /var/log/scns.log every midnight.',
    status: 'approved',
    confidence: 0.9,
    evidence: [],
    tags: [],
    createdAt: '2025-01-15T10:00:00Z',
    updatedAt: '2025-01-15T10:00:00Z',
    actionable: true,
    estimatedComplexity: 'solo',
    attemptCount: 0,
    lastError: null,
    lastAttemptAt: null,
    nextRetryAt: null,
    allowRepoWrites: false,
    ...overrides,
  }
}

function mockSpawn(result: Partial<CriticSpawnResult> = {}): SpawnCritic {
  return async () => ({
    stdout: '',
    stderr: '',
    sessionId: 'sc-mock',
    timedOut: false,
    exitCode: 0,
    ...result,
  })
}

describe('parseSelfCritiqueResponse', () => {
  it('extracts a fenced json block', () => {
    const raw = [
      'Here is my analysis.',
      '```json',
      '{"verdict":"pass","findings":["all good"],"requiredFollowups":[]}',
      '```',
      'End of critique.',
    ].join('\n')
    const v = parseSelfCritiqueResponse(raw)
    expect(v.verdict).toBe('pass')
    expect(v.findings).toEqual(['all good'])
  })

  it('extracts a fenced block with language fallback', () => {
    const raw = '```\n{"verdict":"fail","findings":["missing file"]}\n```'
    const v = parseSelfCritiqueResponse(raw)
    expect(v.verdict).toBe('fail')
    expect(v.findings).toEqual(['missing file'])
  })

  it('extracts inline (non-fenced) JSON object', () => {
    const raw =
      'Verdict follows: {"verdict": "needs-evidence", "findings": ["cannot verify file contents"]}'
    const v = parseSelfCritiqueResponse(raw)
    expect(v.verdict).toBe('needs-evidence')
    expect(v.findings).toEqual(['cannot verify file contents'])
  })

  it('prefers the LAST balanced object when multiple are present', () => {
    const raw = [
      '{"verdict":"fail","findings":["first guess"]}',
      'Actually on reflection, here is the final verdict:',
      '{"verdict":"pass","findings":["confirmed"]}',
    ].join('\n')
    const v = parseSelfCritiqueResponse(raw)
    expect(v.verdict).toBe('pass')
    expect(v.findings).toEqual(['confirmed'])
  })

  it('falls back to needs-evidence on malformed input', () => {
    const v = parseSelfCritiqueResponse('definitely not json at all')
    expect(v.verdict).toBe('needs-evidence')
    expect(v.degradedReason).toBe('malformed-response')
    expect(v.findings.length).toBeGreaterThan(0)
  })

  it('falls back to needs-evidence on empty input', () => {
    const v = parseSelfCritiqueResponse('')
    expect(v.verdict).toBe('needs-evidence')
    expect(v.degradedReason).toBe('malformed-response')
  })

  it('falls back to needs-evidence when verdict string is invalid', () => {
    const raw = '```json\n{"verdict":"maybe","findings":["dunno"]}\n```'
    const v = parseSelfCritiqueResponse(raw)
    expect(v.verdict).toBe('needs-evidence')
    expect(v.degradedReason).toMatch(/unrecognized-verdict/)
    expect(v.findings).toEqual(['dunno'])
  })

  it('normalizes string arrays and caps size', () => {
    const longArr = Array.from({ length: 60 }, (_, i) => `f${i}`)
    const raw = `\`\`\`json\n${JSON.stringify({ verdict: 'fail', findings: longArr, requiredFollowups: ['x'] })}\n\`\`\``
    const v = parseSelfCritiqueResponse(raw)
    expect(v.findings.length).toBe(50)
    expect(v.requiredFollowups).toEqual(['x'])
  })

  it('carries criticalReasons when provided', () => {
    const raw =
      '```json\n{"verdict":"fail","findings":["missing"],"requiredFollowups":[],"criticalReasons":["file never created"]}\n```'
    const v = parseSelfCritiqueResponse(raw)
    expect(v.criticalReasons).toEqual(['file never created'])
  })

  it('handles nested objects inside preamble without choking', () => {
    const raw = [
      'Intermediate reasoning with a sub-object { "note": "ignore me" }.',
      '```json',
      '{"verdict":"pass","findings":[]}',
      '```',
    ].join('\n')
    const v = parseSelfCritiqueResponse(raw)
    expect(v.verdict).toBe('pass')
  })
})

describe('loadSelfCritiqueConfig', () => {
  it('defaults to enabled at L2 and L3', () => {
    expect(loadSelfCritiqueConfig(2, {}).enabled).toBe(true)
    expect(loadSelfCritiqueConfig(3, {}).enabled).toBe(true)
  })

  it('defaults to disabled at L0 and L1', () => {
    expect(loadSelfCritiqueConfig(0, {}).enabled).toBe(false)
    expect(loadSelfCritiqueConfig(1, {}).enabled).toBe(false)
  })

  it('env BRAIN_SELF_CRITIQUE_ENABLED=true overrides L0/L1 default', () => {
    expect(loadSelfCritiqueConfig(0, { BRAIN_SELF_CRITIQUE_ENABLED: 'true' }).enabled).toBe(true)
  })

  it('env BRAIN_SELF_CRITIQUE_ENABLED=false overrides L2/L3 default', () => {
    expect(loadSelfCritiqueConfig(3, { BRAIN_SELF_CRITIQUE_ENABLED: 'false' }).enabled).toBe(false)
  })

  it('uses default timeout when env is unset or invalid', () => {
    expect(loadSelfCritiqueConfig(2, {}).timeoutMs).toBe(120_000)
    expect(loadSelfCritiqueConfig(2, { BRAIN_SELF_CRITIQUE_TIMEOUT_MS: 'abc' }).timeoutMs).toBe(
      120_000,
    )
  })

  it('respects a valid timeout override within bounds', () => {
    expect(loadSelfCritiqueConfig(2, { BRAIN_SELF_CRITIQUE_TIMEOUT_MS: '45000' }).timeoutMs).toBe(
      45000,
    )
  })

  it('clamps timeout to the max ceiling', () => {
    const v = loadSelfCritiqueConfig(2, { BRAIN_SELF_CRITIQUE_TIMEOUT_MS: '99999999' })
    expect(v.timeoutMs).toBeLessThanOrEqual(10 * 60_000)
  })
})

describe('runSelfCritique', () => {
  const suggestion = makeSuggestion()

  it('short-circuits to pass when disabled', async () => {
    const v = await runSelfCritique(
      { suggestion, teamOutput: 'whatever' },
      { enabled: false, autonomyLevel: 2, spawnCritic: mockSpawn({ stdout: 'unused' }) },
    )
    expect(v.verdict).toBe('pass')
    expect(v.degradedReason).toBe('disabled-by-autonomy')
  })

  it('short-circuits to pass when autonomy < 2 (runtime demotion)', async () => {
    const v = await runSelfCritique(
      { suggestion, teamOutput: 'whatever' },
      { enabled: true, autonomyLevel: 1, spawnCritic: mockSpawn({ stdout: 'unused' }) },
    )
    expect(v.verdict).toBe('pass')
    expect(v.degradedReason).toBe('disabled-by-autonomy')
  })

  it('returns needs-evidence when no spawner is wired', async () => {
    const v = await runSelfCritique(
      { suggestion, teamOutput: 'output' },
      { enabled: true, autonomyLevel: 2 },
    )
    expect(v.verdict).toBe('needs-evidence')
    expect(v.degradedReason).toBe('no-spawner')
  })

  it('returns parsed pass verdict from critic stdout', async () => {
    const spawnCritic = mockSpawn({
      stdout: '```json\n{"verdict":"pass","findings":["ok"],"requiredFollowups":[]}\n```',
      sessionId: 'sc-123',
    })
    const v = await runSelfCritique(
      { suggestion, teamOutput: 'files: /a.txt' },
      { enabled: true, autonomyLevel: 2, spawnCritic },
    )
    expect(v.verdict).toBe('pass')
    expect(v.criticSessionId).toBe('sc-123')
  })

  it('returns parsed fail verdict and surfaces findings', async () => {
    const spawnCritic = mockSpawn({
      stdout:
        '```json\n{"verdict":"fail","findings":["file missing"],"requiredFollowups":["re-run"],"criticalReasons":["no write observed"]}\n```',
    })
    const v = await runSelfCritique(
      { suggestion, teamOutput: 'diff --git a/foo b/foo\n+++ b/foo\n--- a/foo' },
      { enabled: true, autonomyLevel: 3, spawnCritic },
    )
    expect(v.verdict).toBe('fail')
    expect(v.findings).toEqual(['file missing'])
    expect(v.criticalReasons).toEqual(['no write observed'])
  })

  it('degrades to needs-evidence on timeout', async () => {
    const spawnCritic = mockSpawn({ timedOut: true, stdout: '', sessionId: 'sc-t' })
    const v = await runSelfCritique(
      { suggestion, teamOutput: 'diff --git a/foo b/foo\n+++ b/foo\n--- a/foo' },
      { enabled: true, autonomyLevel: 2, spawnCritic, timeoutMs: 5000 },
    )
    expect(v.verdict).toBe('needs-evidence')
    expect(v.degradedReason).toBe('critique-timeout')
    expect(v.criticSessionId).toBe('sc-t')
  })

  it('degrades to needs-evidence on non-zero exit', async () => {
    const spawnCritic = mockSpawn({ exitCode: 2, stderr: 'boom', stdout: '' })
    const v = await runSelfCritique(
      { suggestion, teamOutput: 'diff --git a/foo b/foo\n+++ b/foo\n--- a/foo' },
      { enabled: true, autonomyLevel: 2, spawnCritic },
    )
    expect(v.verdict).toBe('needs-evidence')
    expect(v.degradedReason).toBe('critic-exit-nonzero')
  })

  it('degrades to needs-evidence when spawner throws', async () => {
    const spawnCritic: SpawnCritic = async () => {
      throw new Error('no binary')
    }
    const v = await runSelfCritique(
      { suggestion, teamOutput: 'diff --git a/foo b/foo\n+++ b/foo\n--- a/foo' },
      { enabled: true, autonomyLevel: 2, spawnCritic },
    )
    expect(v.verdict).toBe('needs-evidence')
    expect(v.degradedReason).toBe('spawn-failed')
  })
})

describe('buildCritiquePrompt', () => {
  it('includes the suggestion id and truncates oversized output', () => {
    const suggestion = makeSuggestion({ id: 'abc-1' })
    const big = 'x'.repeat(20_000)
    const prompt = buildCritiquePrompt({ suggestion, teamOutput: big })
    expect(prompt).toContain('id: abc-1')
    expect(prompt).toContain('… [truncated]')
    expect(prompt).toContain('"verdict"')
  })
})

describe('writeCritiqueFile', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'scns-crit-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('writes a critique.md under the target status dir', () => {
    const suggestion = makeSuggestion({ id: 'id-pass' })
    const path = writeCritiqueFile({
      verdict: {
        verdict: 'pass',
        findings: ['ok'],
        requiredFollowups: [],
        criticSessionId: 'sc-1',
      },
      suggestion,
      targetStatus: 'implemented',
      suggestionsRoot: root,
    })
    expect(path).toBe(join(root, 'implemented', 'id-pass.critique.md'))
    expect(existsSync(path)).toBe(true)
    const body = readFileSync(path, 'utf-8')
    expect(body).toContain('verdict: pass')
    expect(body).toContain('## Findings')
    expect(body).toContain('criticSessionId: sc-1')
  })

  it('renders critical reasons on fail verdicts', () => {
    const suggestion = makeSuggestion({ id: 'id-fail' })
    writeCritiqueFile({
      verdict: {
        verdict: 'fail',
        findings: ['missing file'],
        requiredFollowups: ['retry'],
        criticalReasons: ['no write happened'],
      },
      suggestion,
      targetStatus: 'failed',
      suggestionsRoot: root,
    })
    const body = readFileSync(join(root, 'failed', 'id-fail.critique.md'), 'utf-8')
    expect(body).toContain('## Critical Reasons')
    expect(body).toContain('- no write happened')
  })

  it('appends a Self-Critique block to the suggestion body for needs-human', () => {
    const suggestion = makeSuggestion({ id: 'id-nh' })
    mkdirSync(join(root, 'needs-human'), { recursive: true })
    writeFileSync(
      join(root, 'needs-human', 'id-nh.md'),
      '---\nid: id-nh\n---\n# Suggestion body\n',
      'utf-8',
    )
    writeCritiqueFile({
      verdict: {
        verdict: 'needs-evidence',
        findings: ['cannot verify'],
        requiredFollowups: ['human look'],
      },
      suggestion,
      targetStatus: 'needs-human',
      suggestionsRoot: root,
    })
    const body = readFileSync(join(root, 'needs-human', 'id-nh.md'), 'utf-8')
    expect(body).toContain('## Self-Critique')
    expect(body).toContain('- cannot verify')
    expect(body).toContain('human look')
  })

  it('does not double-append the Self-Critique block', () => {
    const suggestion = makeSuggestion({ id: 'id-nh2' })
    mkdirSync(join(root, 'needs-human'), { recursive: true })
    writeFileSync(
      join(root, 'needs-human', 'id-nh2.md'),
      '# body\n\n## Self-Critique\n- verdict: `needs-evidence`\n',
      'utf-8',
    )
    writeCritiqueFile({
      verdict: { verdict: 'needs-evidence', findings: ['x'], requiredFollowups: [] },
      suggestion,
      targetStatus: 'needs-human',
      suggestionsRoot: root,
    })
    const body = readFileSync(join(root, 'needs-human', 'id-nh2.md'), 'utf-8')
    expect(body.match(/## Self-Critique/g)?.length).toBe(1)
  })
})

// ── Phase 13.12.24a: empty-teamOutput guard ──────────────────────────

describe('runSelfCritique — empty teamOutput guard (13.12.24a)', () => {
  it('returns needs-evidence for empty teamOutput without spawning critic', async () => {
    const spawn = vi.fn(
      mockSpawn({
        stdout: '```json\n{"verdict":"pass","findings":[],"requiredFollowups":[]}\n```',
      }),
    )
    const v = await runSelfCritique(
      { suggestion: makeSuggestion(), teamOutput: '' },
      { enabled: true, autonomyLevel: 2, spawnCritic: spawn },
    )
    expect(v.verdict).toBe('needs-evidence')
    expect(v.degradedReason).toBe('empty-team-output')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('returns needs-evidence for bare executor stub (success: true)', async () => {
    const spawn = vi.fn(
      mockSpawn({
        stdout: '```json\n{"verdict":"pass","findings":[],"requiredFollowups":[]}\n```',
      }),
    )
    const v = await runSelfCritique(
      { suggestion: makeSuggestion(), teamOutput: 'success: true' },
      { enabled: true, autonomyLevel: 2, spawnCritic: spawn },
    )
    expect(v.verdict).toBe('needs-evidence')
    expect(v.degradedReason).toBe('empty-team-output')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('does NOT short-circuit when teamOutput contains a staged diff', async () => {
    const spawn = vi.fn(
      mockSpawn({
        stdout: '```json\n{"verdict":"pass","findings":[],"requiredFollowups":[]}\n```',
      }),
    )
    const diff = [
      'diff --git a/foo.ts b/foo.ts',
      'index 111..222 100644',
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -1,3 +1,4 @@',
      '+const added = 1',
    ].join('\n')
    const v = await runSelfCritique(
      { suggestion: makeSuggestion(), teamOutput: diff },
      { enabled: true, autonomyLevel: 2, spawnCritic: spawn },
    )
    expect(v.verdict).toBe('pass')
    expect(spawn).toHaveBeenCalledTimes(1)
  })
})

describe('hasSubstantiveEvidence (13.12.24a)', () => {
  it('accepts the executor\'s own filesCreated listing, and still rejects "(none)"', async () => {
    const { hasSubstantiveEvidence } = await import('../../../src/brain/self-critique.js')

    // Verbatim shape produced by `suggest execute` for a one-file artifact. Registering an LSP
    // server writes exactly one config file; the resulting 92-character report was previously
    // read as "no evidence" because the probe looked for `files:` and the fallback needed 200
    // characters, so a successful install was routed to needs-human.
    const realExecutorOutput = [
      'success: true',
      'stepsCompleted: 1/1',
      'filesCreated:',
      '  - /Users/x/.copilot/lsp-config.json',
    ].join('\n')
    expect(hasSubstantiveEvidence(realExecutorOutput)).toBe(true)

    const nothingHappened = ['success: true', 'stepsCompleted: 0/0', 'filesCreated: (none)'].join(
      '\n',
    )
    expect(hasSubstantiveEvidence(nothingHappened)).toBe(false)
  })

  it('rejects empty and trivial inputs', async () => {
    const { hasSubstantiveEvidence } = await import('../../../src/brain/self-critique.js')
    expect(hasSubstantiveEvidence('')).toBe(false)
    expect(hasSubstantiveEvidence('   ')).toBe(false)
    expect(hasSubstantiveEvidence('success: true')).toBe(false)
    expect(hasSubstantiveEvidence('success: true\nerror: undefined')).toBe(false)
  })

  it('accepts diff markers and long text', async () => {
    const { hasSubstantiveEvidence } = await import('../../../src/brain/self-critique.js')
    expect(hasSubstantiveEvidence('diff --git a/x b/x\n--- a/x\n+++ b/x')).toBe(true)
    expect(hasSubstantiveEvidence('files: src/foo.ts, src/bar.ts\nchanged 2 files')).toBe(true)
    expect(hasSubstantiveEvidence('x'.repeat(250))).toBe(true)
  })
})
