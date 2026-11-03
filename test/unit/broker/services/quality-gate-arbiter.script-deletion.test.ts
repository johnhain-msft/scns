/**
 * F2 — pin the `--if-present` script-deletion edge (blind-review caveat 2,
 * PR #38, accepted at deploy).
 *
 * The gate runs `npm run build --silent --if-present` (test/lint likewise),
 * so a diff that DELETES a script from package.json makes the corresponding
 * gate step silently skip — the gate loses teeth with no trace. Semantics
 * decided by John 2026-08-14 ("we need to ensure that theres a gate to
 * prevent losing those gate scripts"):
 *
 *   HARD FAIL. A diff that removes any gate script HEAD defined
 *   (build/test/lint), or package.json itself, FAILS the verdict with
 *   reason 'gate-scripts-removed' before the npm steps run. This is a
 *   John-approved hardening, not a silent one (AGENTS.md rule 12).
 *
 * The content-repo weakening (no package.json in HEAD at all — Cosmere_RPG
 * shape) is INTENDED and must stay finding-free (it fixed 229/230
 * environmental failures; see quality-gate-arbiter.non-npm.test.ts).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { TestDb } from '../../../helpers/db-harness.js'
import { createBrokerTestDb } from '../../../helpers/broker-db-harness.js'
import { createEventLog } from '../../../../src/broker/services/event-log.js'
import { createEventDispatcher } from '../../../../src/broker/event-dispatcher.js'
import {
  createQualityGateArbiter,
  detectLostNpmScripts,
  type RunResult,
} from '../../../../src/broker/services/quality-gate-arbiter.js'
import type { TeamCompletionData } from '../../../../src/broker/services/team-lifecycle.js'

function ok(stdout = '', stderr = ''): RunResult {
  return { ok: true, stdout, stderr }
}

const HEAD_PKG = JSON.stringify({
  name: 'fixture',
  version: '0.0.0',
  scripts: { build: 'tsc', test: 'vitest run', lint: 'eslint .' },
})

function makeProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'qg-scriptdel-proj-'))
  const binDir = join(root, 'node_modules', '.bin')
  mkdirSync(binDir, { recursive: true })
  for (const bin of ['vitest', 'eslint']) {
    writeFileSync(join(binDir, bin), '#!/usr/bin/env node\n', { mode: 0o755 })
  }
  return root
}

/**
 * Mocked runner (pattern: quality-gate-arbiter.non-npm.test.ts). The
 * `worktreePackageJson` option is what the simulated checkout+diff leaves
 * on disk (null = the diff deleted package.json entirely);
 * `headPackageJson` is what `git show HEAD:package.json` reports (null =
 * HEAD never had one — content repo).
 */
function makeRunCommand(
  recorded: { cmds: string[] },
  opts: {
    worktreePackageJson: string | null
    headPackageJson: string | null
  },
): (cmd: string, cwd: string) => RunResult {
  return (cmd: string, _cwd: string): RunResult => {
    recorded.cmds.push(cmd)
    if (cmd.startsWith('git worktree add')) {
      const m = cmd.match(/git worktree add -b \S+ "([^"]+)" HEAD/)
      if (m) {
        mkdirSync(m[1], { recursive: true })
        if (opts.worktreePackageJson !== null) {
          writeFileSync(join(m[1], 'package.json'), opts.worktreePackageJson)
        }
      }
      return ok()
    }
    if (cmd === 'git show HEAD:package.json') {
      return opts.headPackageJson !== null
        ? ok(opts.headPackageJson)
        : { ok: false, stdout: '', stderr: 'fatal: path does not exist', code: 128 }
    }
    if (cmd.startsWith('git apply')) return ok()
    if (cmd.startsWith('npm')) return ok()
    if (cmd.startsWith('git rev-parse')) return ok('deadbeef\n')
    return ok()
  }
}

function completion(): TeamCompletionData {
  return {
    teamId: 'team-selfissue-task-999-scriptdel',
    memberSessionIds: ['s1'],
    stagedDiff:
      'diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n@@ -1 +1 @@\n-old\n+new\n',
    artifacts: [],
    logs: [],
    aggregateOutcome: 'success',
    completedAt: new Date().toISOString(),
  }
}

// ──────────────────────────────────────────────────────────────────────
// Part 1 — detectLostNpmScripts (pure helper)
// ──────────────────────────────────────────────────────────────────────

describe('detectLostNpmScripts', () => {
  let wt: string
  beforeEach(() => {
    wt = mkdtempSync(join(tmpdir(), 'qg-scriptdel-wt-'))
  })
  afterEach(() => {
    if (existsSync(wt)) rmSync(wt, { recursive: true, force: true })
  })

  function runWithHead(head: string | null): (cmd: string, cwd: string) => RunResult {
    return (cmd: string) =>
      cmd === 'git show HEAD:package.json'
        ? head !== null
          ? ok(head)
          : { ok: false, stdout: '', stderr: 'fatal: bad path', code: 128 }
        : ok()
  }

  it('reports each gate script HEAD defined that the worktree lost', () => {
    writeFileSync(
      join(wt, 'package.json'),
      JSON.stringify({ name: 'x', scripts: { lint: 'eslint .' } }),
    )
    const findings = detectLostNpmScripts(runWithHead(HEAD_PKG), wt)
    expect(findings.some((f) => f.includes('"build"'))).toBe(true)
    expect(findings.some((f) => f.includes('"test"'))).toBe(true)
    expect(findings.some((f) => f.includes('"lint"'))).toBe(false)
    // The finding must name the silent mechanism so a reader understands
    // why no build failure appears anywhere else in the verdict.
    expect(findings.join(' ')).toContain('--if-present')
  })

  it('reports package.json deletion itself when HEAD had gate scripts', () => {
    const findings = detectLostNpmScripts(runWithHead(HEAD_PKG), wt)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatch(/package\.json/)
    expect(findings[0]).toMatch(/cannot run/i)
  })

  it('is silent when nothing was lost (scripts unchanged)', () => {
    writeFileSync(join(wt, 'package.json'), HEAD_PKG)
    expect(detectLostNpmScripts(runWithHead(HEAD_PKG), wt)).toEqual([])
  })

  it('is silent on a content repo (HEAD never had package.json) — intended weakening', () => {
    expect(detectLostNpmScripts(runWithHead(null), wt)).toEqual([])
  })

  it('is silent when the worktree package.json is unparseable (npm itself will fail the gate)', () => {
    writeFileSync(join(wt, 'package.json'), '{ not json')
    expect(detectLostNpmScripts(runWithHead(HEAD_PKG), wt)).toEqual([])
  })

  it('is silent when HEAD package.json is unparseable (no baseline to compare)', () => {
    writeFileSync(join(wt, 'package.json'), HEAD_PKG)
    expect(detectLostNpmScripts(runWithHead('{ nope'), wt)).toEqual([])
  })
})

// ──────────────────────────────────────────────────────────────────────
// Part 2 — arbiter integration: PASS verdicts carry the finding
// ──────────────────────────────────────────────────────────────────────

describe('QualityGateArbiter — --if-present script-deletion edge (F2)', () => {
  let testDb: TestDb
  let tmpRoot: string
  let projectRoot: string

  beforeEach(() => {
    testDb = createBrokerTestDb()
    tmpRoot = mkdtempSync(join(tmpdir(), 'qg-scriptdel-wtbase-'))
    projectRoot = makeProjectRoot()
  })
  afterEach(() => {
    testDb.close()
    if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true })
    if (existsSync(projectRoot)) rmSync(projectRoot, { recursive: true, force: true })
  })

  async function runArbiter(opts: {
    worktreePackageJson: string | null
    headPackageJson: string | null
  }) {
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(testDb.db, dispatcher)
    const recorded = { cmds: [] as string[] }
    const arbiter = createQualityGateArbiter({
      db: testDb.db,
      eventLog,
      dispatcher,
      projectRoot,
      runCommand: makeRunCommand(recorded, opts),
      worktreeBase: tmpRoot,
    })
    const verdict = await arbiter.handleTeamCompletion(completion())
    arbiter.stop()
    return { verdict, eventLog, recorded }
  }

  it('FAILS when the diff deletes the build script HEAD had', async () => {
    const { verdict, eventLog } = await runArbiter({
      worktreePackageJson: JSON.stringify({
        name: 'fixture',
        scripts: { test: 'vitest run', lint: 'eslint .' },
      }),
      headPackageJson: HEAD_PKG,
    })

    expect(verdict.passed).toBe(false)
    expect(verdict.reason).toBe('gate-scripts-removed')
    expect(verdict.score).toBe(0)
    expect(verdict.branch).toBeNull()
    expect(verdict.findings.some((f) => f.includes('"build"'))).toBe(true)

    // The emitted verdict event carries the same failure.
    const evt = eventLog.since(0).find((e) => e.event_type === 'quality_gate_verdict')
    expect(evt).toBeDefined()
    const payload = JSON.parse(evt!.payload) as {
      passed: boolean
      reason: string
      findings: string[]
    }
    expect(payload.passed).toBe(false)
    expect(payload.reason).toBe('gate-scripts-removed')
    expect(payload.findings.some((f) => f.includes('"build"'))).toBe(true)
  })

  it('FAILS (before any npm step) when the diff deletes package.json entirely', async () => {
    const { verdict, recorded } = await runArbiter({
      worktreePackageJson: null,
      headPackageJson: HEAD_PKG,
    })

    expect(verdict.passed).toBe(false)
    expect(verdict.reason).toBe('gate-scripts-removed')
    // Fail-fast: no npm step runs against a diff that de-npm'd the project.
    expect(recorded.cmds.filter((c) => c.startsWith('npm'))).toEqual([])
    expect(verdict.findings.some((f) => /package\.json/.test(f))).toBe(true)
  })

  it('control: unchanged scripts → PASS with no findings (no noise)', async () => {
    const { verdict } = await runArbiter({
      worktreePackageJson: HEAD_PKG,
      headPackageJson: HEAD_PKG,
    })
    expect(verdict.passed).toBe(true)
    expect(verdict.findings).toEqual([])
  })

  it('control: content repo (no package.json anywhere) stays finding-free — intended weakening', async () => {
    const { verdict } = await runArbiter({
      worktreePackageJson: null,
      headPackageJson: null,
    })
    expect(verdict.passed).toBe(true)
    expect(verdict.findings).toEqual([])
  })
})
