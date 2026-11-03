/**
 * G2 (scns#36 handoff) — the exit-254 worktree build failure was ENVIRONMENTAL.
 *
 * Live evidence 2026-08-10 (Cosmere child, port 3500): ALL five gate attempts
 * that night — and 229/230 historically — failed with the byte-identical
 * signature `Build failed in worktree (exit 254): no stderr`, preceded by
 * `worktree_provisioning {npmStrategy:"symlink", linked:false,
 * reason:"src-missing"}`.
 *
 * Root cause (reproduced 1:1 on 2026-08-10): the child's projectRoot
 * (~/Coding_Projects/Cosmere_RPG) is NOT an npm project — no package.json, no
 * node_modules. `npm run build --silent` with no package.json anywhere up the
 * tree exits 254 (observed and reproduced; with one higher up the tree npm
 * instead reports a missing script, exit 1 — the stray exit-1 events), and
 * `--silent` (loglevel silent) suppresses npm's own `npm error …` report, so
 * stderr is empty. The bridge's `src-missing` is the same fact upstream:
 * `<projectRoot>/node_modules` does not exist.
 *
 * The contract pinned here:
 *   (a) a worktree with NO package.json skips npm build/test/lint entirely
 *       (including the projectRoot baseline runs) and the diff is judged by
 *       the remaining gates (rubric/claim/redundancy) — a good diff can PASS;
 *   (b) the skip is announced in the persisted verdict output;
 *   (c) a worktree WITH package.json still runs the npm steps (control), and
 *       the build step tolerates a missing "build" script via --if-present;
 *   (d) a real build failure whose tool writes to STDOUT (tsc does) is no
 *       longer reported as "no stderr" — the finding falls back to the first
 *       non-empty stdout line.
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
  type RunResult,
} from '../../../../src/broker/services/quality-gate-arbiter.js'
import type { TeamCompletionData } from '../../../../src/broker/services/team-lifecycle.js'

function ok(stdout = '', stderr = ''): RunResult {
  return { ok: true, stdout, stderr }
}

function makeProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'qg-nonnpm-proj-'))
  const binDir = join(root, 'node_modules', '.bin')
  mkdirSync(binDir, { recursive: true })
  for (const bin of ['vitest', 'eslint']) {
    writeFileSync(join(binDir, bin), '#!/usr/bin/env node\n', { mode: 0o755 })
  }
  return root
}

interface Recorded {
  cmds: string[]
}

/**
 * Mocked runner. `worktreeHasPackageJson` controls whether the simulated
 * `git worktree add` produces a checkout that looks like an npm project —
 * the real command checks out HEAD, so package.json presence is a property
 * of the PROJECT being gated, exactly what the arbiter must key on.
 */
function makeRunCommand(
  recorded: Recorded,
  opts: {
    worktreeHasPackageJson: boolean
    build?: RunResult
    test?: RunResult
    lint?: RunResult
  },
): (cmd: string, cwd: string) => RunResult {
  return (cmd: string, _cwd: string): RunResult => {
    recorded.cmds.push(cmd)
    if (cmd.startsWith('git worktree add')) {
      const m = cmd.match(/git worktree add -b \S+ "([^"]+)" HEAD/)
      if (m) {
        mkdirSync(m[1], { recursive: true })
        if (opts.worktreeHasPackageJson) {
          writeFileSync(
            join(m[1], 'package.json'),
            JSON.stringify({ name: 'fixture', version: '0.0.0' }),
          )
        }
      }
      return ok()
    }
    if (cmd.startsWith('git apply')) return ok()
    if (cmd.startsWith('npm run build')) return opts.build ?? ok()
    if (cmd.startsWith('npm test')) return opts.test ?? ok()
    if (cmd.startsWith('npm run lint')) return opts.lint ?? ok()
    if (cmd.startsWith('git rev-parse')) return ok('deadbeef\n')
    return ok()
  }
}

function completion(): TeamCompletionData {
  return {
    teamId: 'team-selfissue-task-1786401919067-g6w074',
    memberSessionIds: ['s1'],
    stagedDiff:
      'diff --git a/lore.md b/lore.md\n--- a/lore.md\n+++ b/lore.md\n@@ -1 +1,2 @@\n line\n+new\n',
    artifacts: [],
    logs: [],
    aggregateOutcome: 'success',
    completedAt: new Date().toISOString(),
  }
}

describe('QualityGateArbiter — non-npm project (Cosmere_RPG shape)', () => {
  let testDb: TestDb
  let tmpRoot: string
  let projectRoot: string

  beforeEach(() => {
    testDb = createBrokerTestDb()
    tmpRoot = mkdtempSync(join(tmpdir(), 'qg-nonnpm-wt-'))
    projectRoot = makeProjectRoot()
  })
  afterEach(() => {
    testDb.close()
    if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true })
    if (existsSync(projectRoot)) rmSync(projectRoot, { recursive: true, force: true })
  })

  it('a) no package.json in worktree → npm steps skipped (baselines included), good diff PASSES', async () => {
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(testDb.db, dispatcher)
    const recorded: Recorded = { cmds: [] }

    const arbiter = createQualityGateArbiter({
      db: testDb.db,
      eventLog,
      dispatcher,
      projectRoot,
      runCommand: makeRunCommand(recorded, { worktreeHasPackageJson: false }),
      worktreeBase: tmpRoot,
      // Baselines ON to prove the projectRoot-side npm runs are skipped too.
      baselineLintEnabled: true,
      baselineTestsEnabled: true,
    })
    const verdict = await arbiter.handleTeamCompletion(completion())
    arbiter.stop()

    // No npm invocation anywhere — worktree or projectRoot.
    expect(recorded.cmds.filter((c) => c.startsWith('npm'))).toEqual([])
    // The environmental failure is gone: the diff is judged on its merits.
    expect(verdict.passed).toBe(true)
    expect(verdict.branch).not.toBeNull()
  })

  it('b) the skip is announced in the persisted verdict output', async () => {
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(testDb.db, dispatcher)
    const recorded: Recorded = { cmds: [] }

    const arbiter = createQualityGateArbiter({
      db: testDb.db,
      eventLog,
      dispatcher,
      projectRoot,
      runCommand: makeRunCommand(recorded, { worktreeHasPackageJson: false }),
      worktreeBase: tmpRoot,
    })
    await arbiter.handleTeamCompletion(completion())
    arbiter.stop()

    const row = testDb.db
      .prepare<
        [],
        { output: string | null }
      >('SELECT output FROM quality_checks ORDER BY id DESC LIMIT 1')
      .get()
    const output = row?.output ?? ''
    expect(output).toMatch(/non-npm project.*skipped/i)
    // A skipped run must not persist "=== npm … (exit 0) ===" banners that
    // read as build/test/lint having run and succeeded (Copilot, PR #38).
    expect(output).not.toMatch(/=== npm run build/)
    expect(output).not.toMatch(/=== npm test/)
    expect(output).not.toMatch(/=== npm run lint/)
  })

  it('c) control: package.json present → npm steps run, build uses --if-present', async () => {
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(testDb.db, dispatcher)
    const recorded: Recorded = { cmds: [] }

    const arbiter = createQualityGateArbiter({
      db: testDb.db,
      eventLog,
      dispatcher,
      projectRoot,
      runCommand: makeRunCommand(recorded, { worktreeHasPackageJson: true }),
      worktreeBase: tmpRoot,
    })
    const verdict = await arbiter.handleTeamCompletion(completion())
    arbiter.stop()

    const buildCmd = recorded.cmds.find((c) => c.startsWith('npm run build'))
    expect(buildCmd).toBeDefined()
    // Missing "build" script must not be an environmental gate-fail.
    expect(buildCmd).toContain('--if-present')
    expect(recorded.cmds.some((c) => c.startsWith('npm test'))).toBe(true)
    expect(recorded.cmds.some((c) => c.startsWith('npm run lint'))).toBe(true)
    expect(verdict.passed).toBe(true)
  })

  it('d) build failure with stdout-only diagnostics is surfaced (no more blind "no stderr")', async () => {
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(testDb.db, dispatcher)
    const recorded: Recorded = { cmds: [] }

    const arbiter = createQualityGateArbiter({
      db: testDb.db,
      eventLog,
      dispatcher,
      projectRoot,
      runCommand: makeRunCommand(recorded, {
        worktreeHasPackageJson: true,
        // tsc writes its diagnostics to STDOUT; stderr stays empty.
        build: {
          ok: false,
          stdout: "src/foo.ts(3,1): error TS2304: Cannot find name 'bar'.\nmore noise",
          stderr: '',
          code: 2,
        },
      }),
      worktreeBase: tmpRoot,
    })
    const verdict = await arbiter.handleTeamCompletion(completion())
    arbiter.stop()

    expect(verdict.passed).toBe(false)
    expect(verdict.reason).toBe('build-failed')
    const findingsBlob = verdict.findings.join(' || ')
    expect(findingsBlob).toMatch(/TS2304/)
    expect(findingsBlob).not.toMatch(/no stderr/)
  })
})
