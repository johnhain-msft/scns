/**
 * DEFECT (2026-09-21): an `lsp` suggestion was proposed for a server that was ALREADY registered.
 *
 * `extractLspSuggestions` decided purely from file-change counts and never looked at the
 * `lsp-config.json` the executor writes to. With `typescript` already present under `lspServers`
 * — installed binary and all — the extractor still emitted "Configure TypeScript LSP
 * (typescript-language-server)", which was approved and spun up a full implementer/QA team to
 * perform a write that was already on disk.
 *
 * The check must read the SAME file the executor writes (`lspConfigPath(configBaseDir)`), or the
 * proposal and the write can disagree again — the exact drift `artifact-targets.ts` exists to stop.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { createExecutor } from '../../../src/suggest/executor.js'
import { readConfiguredLspServerIds } from '../../../src/suggest/lsp-servers.js'
import { lspConfigPath } from '../../../src/suggest/artifact-targets.js'
import { extractLspSuggestions } from '../../../src/suggest/extractors/lsp-extractor.js'
import type {
  PatternSources,
  ObservationPatternData,
} from '../../../src/suggest/extractors/types.js'
import { createSuggestionGenerator } from '../../../src/suggest/generator.js'
import { createConfidenceScorer } from '../../../src/suggest/confidence.js'
import { createEvidenceGatherer } from '../../../src/suggest/evidence.js'
import type { Suggestion, SuggestionType } from '../../../src/suggest/types.js'
import type { DetectedPatterns } from '../../../src/observe/pattern-detector.js'

function makeObs(overrides: Partial<ObservationPatternData> = {}): ObservationPatternData {
  return {
    topApps: [],
    appCounts: new Map(),
    topRepos: [],
    repoCounts: new Map(),
    fileTypeCounts: new Map(),
    recentFocus: null,
    ...overrides,
  }
}

let baseDir: string

/** Write an `lsp-config.json` at the exact path the executor targets. */
function writeLspConfig(contents: string): void {
  const target = lspConfigPath(baseDir)
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, contents, 'utf8')
}

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'scns-lsp-configured-'))
})

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true })
})

describe('readConfiguredLspServerIds', () => {
  it('returns the ids already registered under lspServers', () => {
    writeLspConfig(
      JSON.stringify({
        lspServers: {
          typescript: { command: 'typescript-language-server', args: ['--stdio'] },
          python: { command: 'pyright-langserver', args: ['--stdio'] },
        },
      }),
    )

    const ids = readConfiguredLspServerIds(baseDir)

    expect([...ids].sort()).toEqual(['python', 'typescript'])
  })

  it('returns an empty set when no config file exists (nothing is configured yet)', () => {
    const ids = readConfiguredLspServerIds(baseDir)
    expect(ids.size).toBe(0)
  })

  it('fails open with an empty set when the config is malformed JSON', () => {
    writeLspConfig('{ this is not json')
    const ids = readConfiguredLspServerIds(baseDir)
    expect(ids.size).toBe(0)
  })

  it('returns an empty set when lspServers is absent or not an object', () => {
    writeLspConfig(JSON.stringify({ lspServers: 'nope' }))
    expect(readConfiguredLspServerIds(baseDir).size).toBe(0)
  })
})

describe('extractLspSuggestions — already-configured servers', () => {
  it('does NOT propose a server that is already registered', () => {
    const sources: PatternSources = {
      observations: makeObs({ fileTypeCounts: new Map([['.ts', 59]]) }),
      configuredLspServers: ['typescript'],
    }

    const result = extractLspSuggestions(sources)

    expect(result.filter((c) => c.tags.includes('typescript'))).toEqual([])
  })

  it('still proposes a DIFFERENT language that is not yet registered', () => {
    const sources: PatternSources = {
      observations: makeObs({
        fileTypeCounts: new Map([
          ['.ts', 59],
          ['.py', 55],
        ]),
      }),
      configuredLspServers: ['typescript'],
    }

    const result = extractLspSuggestions(sources)

    expect(result.filter((c) => c.tags.includes('typescript'))).toEqual([])
    expect(result.filter((c) => c.tags.includes('python'))).toHaveLength(1)
  })

  it('proposes normally when the configured list is absent (fail-open)', () => {
    const sources: PatternSources = {
      observations: makeObs({ fileTypeCounts: new Map([['.ts', 59]]) }),
    }

    const result = extractLspSuggestions(sources)

    expect(result.filter((c) => c.tags.includes('typescript'))).toHaveLength(1)
  })
})

// ── Generator wiring: the extractor check is inert unless the generator supplies the data ──

function createMockStore() {
  const suggestions = new Map<string, Suggestion>()
  return {
    save(s: Suggestion): void {
      suggestions.set(s.id, s)
    },
    get(id: string): Suggestion | null {
      return suggestions.get(id) ?? null
    },
    list(status?: string): readonly Suggestion[] {
      const all = [...suggestions.values()]
      return status ? all.filter((s) => s.status === status) : all
    },
    updateStatus(id: string, newStatus: string): Suggestion | null {
      const s = suggestions.get(id)
      if (!s) return null
      const updated = { ...s, status: newStatus, updatedAt: new Date().toISOString() }
      suggestions.set(id, updated)
      return updated
    },
    findSimilar(_title: string, _type: SuggestionType): Suggestion | null {
      return null
    },
    getRejectedTitles(): readonly string[] {
      return []
    },
    remove(id: string): boolean {
      return suggestions.delete(id)
    },
  }
}

function makeDetectedPatterns(): DetectedPatterns {
  return {
    workSchedule: null,
    toolFrequency: null,
    projectFocus: {
      repoCounts: new Map([['scns', 30]]),
      topRepos: ['scns'],
      // Pattern detector emits undotted keys; the generator normalizes them.
      fileTypeCounts: new Map([['ts', 59]]),
      recentFocus: 'scns',
      repoActivityCounts: new Map([['scns', 80]]),
    },
    observationCount: 200,
    windowStart: '2025-01-01T00:00:00.000Z',
    windowEnd: '2025-01-07T23:59:59.000Z',
  }
}

function generateWith(configBaseDir: string): readonly Suggestion[] {
  const gen = createSuggestionGenerator(
    {
      scorer: createConfidenceScorer(),
      evidenceGatherer: createEvidenceGatherer(),
      store: createMockStore(),
    },
    { minimumConfidence: 0, configBaseDir },
  )
  return gen.generate(makeDetectedPatterns())
}

describe('generator — LSP proposals respect the real lsp-config.json', () => {
  // POSITIVE CONTROL: with nothing registered the suggestion must appear, otherwise the
  // negative case below would pass for the wrong reason.
  it('proposes the TypeScript LSP when lsp-config.json registers nothing', () => {
    const tsSuggestions = generateWith(baseDir).filter(
      (s) => s.type === 'lsp' && s.tags.includes('typescript'),
    )
    expect(tsSuggestions).toHaveLength(1)
  })

  it('does NOT propose the TypeScript LSP when it is already registered on disk', () => {
    writeLspConfig(
      JSON.stringify({
        lspServers: {
          typescript: {
            command: 'typescript-language-server',
            args: ['--stdio'],
            fileExtensions: { '.ts': 'typescript' },
          },
        },
      }),
    )

    const tsSuggestions = generateWith(baseDir).filter(
      (s) => s.type === 'lsp' && s.tags.includes('typescript'),
    )
    expect(tsSuggestions).toEqual([])
  })
})

// ── Execute-time: suppression at generation cannot retract a proposal already on disk ──

/**
 * SECOND DEFECT, SAME FAMILY (2026-09-21). Suppressing the proposal at GENERATION time fixes
 * only future generations. It cannot retract the proposals already sitting in the store — and it
 * is blind to a server that became configured by any other route (a human hand-editing
 * `lsp-config.json`, another machine syncing it, an earlier approval of this very suggestion).
 *
 * Such a proposal still passes both existing `lsp` preflight checks — the tags resolve to a real
 * spec and the binary is on PATH — so it is approved and executed, and the merge
 * `{...existingServers, ...incoming}` rewrites a key byte-for-byte identically. The write reports
 * success, so the suggestion reads as "implemented" while nothing changed.
 *
 * This is not hypothetical: it is how this defect was found. A stale "Configure TypeScript LSP
 * (typescript-language-server)" proposal was approved against a config that had registered
 * `typescript` for weeks, and spun up a full implementer/QA team to perform a no-op.
 *
 * The gate must therefore re-read the config at APPROVE time, via the same
 * `readConfiguredLspServerIds` the extractor uses, so the two boundaries cannot disagree.
 */
describe('executor — LSP gate refuses a server that is already registered', () => {
  const TS_LSP_SUGGESTION: Suggestion = {
    id: '550e8400-e29b-41d4-a716-446655440111',
    type: 'lsp',
    title: 'Configure TypeScript LSP (typescript-language-server)',
    description: 'stale proposal',
    status: 'approved',
    confidence: 0.9,
    actionable: true,
    estimatedComplexity: 'solo',
    tags: ['lsp', 'typescript', 'codebase-improvement'],
    evidence: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  } as unknown as Suggestion

  let configBaseDir: string
  let binDir: string
  let originalPath: string | undefined

  /** Write an `lsp-config.json` under the executor's own config base dir. */
  function writeExecutorLspConfig(contents: string): void {
    const target = lspConfigPath(configBaseDir)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, contents, 'utf8')
  }

  beforeEach(() => {
    configBaseDir = mkdtempSync(join(homedir(), '.scns-test-lsp-stale-'))
    binDir = mkdtempSync(join(tmpdir(), 'scns-test-bin-'))
    originalPath = process.env.PATH
    // The binary IS installed, so the existing PATH preflight passes. That isolates the
    // already-configured check: any refusal below can only come from the new one.
    writeFileSync(join(binDir, 'typescript-language-server'), '', 'utf-8')
    process.env.PATH = [binDir, tmpdir()].join(delimiter)
  })

  afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    rmSync(configBaseDir, { recursive: true, force: true })
    rmSync(binDir, { recursive: true, force: true })
  })

  // POSITIVE CONTROL: the same suggestion, binary and gate must SUCCEED when the server is not
  // yet registered. Without this, the refusal below could pass for any unrelated reason.
  it('executes normally when the server is not yet registered', () => {
    const executor = createExecutor({ autonomyLevel: 2, configBaseDir })
    const plan = executor.generatePlan(TS_LSP_SUGGESTION)
    const result = executor.execute(plan, TS_LSP_SUGGESTION)

    expect(result.errors).toEqual([])
    expect(result.success).toBe(true)

    const written = JSON.parse(readFileSync(lspConfigPath(configBaseDir), 'utf8')) as {
      lspServers: Record<string, unknown>
    }
    expect(Object.keys(written.lspServers)).toContain('typescript')
  })

  it('rejects a stale proposal for a server already in lsp-config.json', () => {
    writeExecutorLspConfig(
      JSON.stringify({
        lspServers: {
          typescript: {
            command: 'typescript-language-server',
            args: ['--stdio'],
            fileExtensions: { '.ts': 'typescript' },
          },
        },
      }),
    )

    const executor = createExecutor({ autonomyLevel: 2, configBaseDir })
    const plan = executor.generatePlan(TS_LSP_SUGGESTION)
    const result = executor.execute(plan, TS_LSP_SUGGESTION)

    expect(result.success).toBe(false)
    // `rejected`, NOT `needs-human`: there is no decision for a human to make. The work the
    // suggestion asks for is already done, so escalating it would put a no-op in front of a
    // person — the very cost this check exists to remove.
    expect(result.gateDecision?.status).toBe('rejected')
    expect(result.errors[0]).toContain('already registered')
  })

  it('leaves the existing config byte-for-byte untouched when it refuses', () => {
    const original = `${JSON.stringify(
      {
        lspServers: {
          typescript: { command: 'typescript-language-server', args: ['--stdio'] },
        },
      },
      null,
      2,
    )}\n`
    writeExecutorLspConfig(original)

    const executor = createExecutor({ autonomyLevel: 2, configBaseDir })
    executor.execute(executor.generatePlan(TS_LSP_SUGGESTION), TS_LSP_SUGGESTION)

    expect(readFileSync(lspConfigPath(configBaseDir), 'utf8')).toBe(original)
  })

  it('still registers a DIFFERENT server when only the other one is configured', () => {
    writeExecutorLspConfig(
      JSON.stringify({
        lspServers: { python: { command: 'pyright-langserver', args: ['--stdio'] } },
      }),
    )

    const executor = createExecutor({ autonomyLevel: 2, configBaseDir })
    const result = executor.execute(executor.generatePlan(TS_LSP_SUGGESTION), TS_LSP_SUGGESTION)

    expect(result.errors).toEqual([])
    expect(result.success).toBe(true)

    const written = JSON.parse(readFileSync(lspConfigPath(configBaseDir), 'utf8')) as {
      lspServers: Record<string, unknown>
    }
    // The pre-existing server must survive the merge.
    expect(Object.keys(written.lspServers).sort()).toEqual(['python', 'typescript'])
  })
})
