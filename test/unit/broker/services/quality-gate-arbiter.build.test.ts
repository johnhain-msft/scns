/**
 * Task 39 — QG worktree runs `npm run build` before `npm test` / lint.
 *
 * Postmortem qc=4f7e7f48-0a9f-465d-b5dc-59984e557d6b (task 37 follow-up):
 * Task 37 fixed node_modules bridging so vitest/eslint resolve in the
 * QG worktree, but 35 tests still failed because they exec dist/cli.js
 * (test/unit/cli.test.ts, test/unit/broker/startup.test.ts) and the
 * worktree never runs `npm run build`. Every test that spawns the
 * compiled CLI errors with `Cannot find module '<wt>/dist/cli.js'`.
 *
 * Acceptance:
 *   (a) `npm run build` is invoked in the worktree BEFORE `npm test`
 *       and `npm run lint`.
 *   (b) combinedOutput surfaces `=== npm run build (exit 0) ===` on
 *       success.
 *   (c1) Build exit != 126/127 (real compile failure) → passed=false,
 *        reason='build-failed', score=0, finding starts with `Build
 *        failed in worktree (exit `; no `npm test failed` / `npm run
 *        lint failed` findings (i.e. we do not fall through to the
 *        test/lint branches). Phase 13.12.31 — build failures are the
 *        developer's regression, NOT a tooling problem.
 *   (c2) Build exit 126/127 (`isCommandMissing(buildRes)`) → reason
 *        'tooling-missing', score=1.0. Only the shell-can't-find-the-
 *        binary case is tooling.
 *   (d) skipCommands=true skips the build step entirely.
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
  // Bridge resolution requires both vitest + eslint to exist in
  // `<projectRoot>/node_modules/.bin/` (otherwise bridge falls back to
  // 'tooling-unresolved' and we never reach the build step we care about).
  const root = mkdtempSync(join(tmpdir(), 'qg-build-proj-'))
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

function makeRunCommand(
  recorded: Recorded,
  overrides: Partial<{
    build: RunResult
    test: RunResult
    lint: RunResult
  }> = {},
): (cmd: string, cwd: string) => RunResult {
  return (cmd: string, _cwd: string): RunResult => {
    recorded.cmds.push(cmd)
    if (cmd.startsWith('git worktree add')) {
      const m = cmd.match(/git worktree add -b \S+ "([^"]+)" HEAD/)
      if (m) {
        mkdirSync(m[1], { recursive: true })
        // npm-project fixture shape (G2 non-npm probe reads the worktree).
        writeFileSync(join(m[1], 'package.json'), '{"name":"fixture","version":"0.0.0"}')
      }
      return ok()
    }
    if (cmd.startsWith('git apply')) return ok()
    if (cmd.startsWith('npm run build')) return overrides.build ?? ok()
    if (cmd.startsWith('npm test')) return overrides.test ?? ok()
    if (cmd.startsWith('npm run lint')) return overrides.lint ?? ok()
    if (cmd.startsWith('git rev-parse')) return ok('deadbeef\n')
    if (cmd.startsWith('git worktree remove')) return ok()
    if (cmd.startsWith('git add')) return ok()
    if (cmd.startsWith('git -c user.name=scns-auto')) return ok()
    if (cmd.startsWith('git branch')) return ok()
    return ok()
  }
}

function baseCompletion(): TeamCompletionData {
  return {
    teamId: 'team-task-39',
    memberSessionIds: ['s1'],
    stagedDiff:
      'diff --git a/foo.md b/foo.md\n--- a/foo.md\n+++ b/foo.md\n@@ -1 +1,2 @@\n line\n+new\n',
    artifacts: [],
    logs: [],
    aggregateOutcome: 'success',
    completedAt: new Date().toISOString(),
  }
}

describe('QualityGateArbiter — npm run build precedes test/lint', () => {
  let testDb: TestDb
  let tmpRoot: string
  let projectRoot: string

  beforeEach(() => {
    testDb = createBrokerTestDb()
    tmpRoot = mkdtempSync(join(tmpdir(), 'qg-build-wt-'))
    projectRoot = makeProjectRoot()
  })
  afterEach(() => {
    testDb.close()
    if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true })
    if (existsSync(projectRoot)) rmSync(projectRoot, { recursive: true, force: true })
  })

  // (a) build invoked BEFORE npm test / npm run lint.
  it('a) invokes `npm run build` before `npm test` and `npm run lint`', async () => {
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(testDb.db, dispatcher)
    const recorded: Recorded = { cmds: [] }

    const arbiter = createQualityGateArbiter({
      db: testDb.db,
      eventLog,
      dispatcher,
      projectRoot,
      runCommand: makeRunCommand(recorded),
      worktreeBase: tmpRoot,
    })
    await arbiter.handleTeamCompletion(baseCompletion())
    arbiter.stop()

    const buildIdx = recorded.cmds.findIndex((c) => c.startsWith('npm run build'))
    const testIdx = recorded.cmds.findIndex((c) => c.startsWith('npm test'))
    const lintIdx = recorded.cmds.findIndex((c) => c.startsWith('npm run lint'))
    expect(buildIdx).toBeGreaterThanOrEqual(0)
    expect(testIdx).toBeGreaterThan(buildIdx)
    expect(lintIdx).toBeGreaterThan(buildIdx)
  })

  // (b) combinedOutput contains `=== npm run build (exit 0) ===` on success.
  it('b) surfaces `=== npm run build (exit 0) ===` in verdict output on success', async () => {
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(testDb.db, dispatcher)
    const recorded: Recorded = { cmds: [] }

    const arbiter = createQualityGateArbiter({
      db: testDb.db,
      eventLog,
      dispatcher,
      projectRoot,
      runCommand: makeRunCommand(recorded, {
        build: { ok: true, stdout: 'compiled OK', stderr: '' },
      }),
      worktreeBase: tmpRoot,
    })
    await arbiter.handleTeamCompletion(baseCompletion())
    arbiter.stop()

    // Read back the persisted quality_check row to inspect combinedOutput.
    const row = testDb.db
      .prepare<
        [],
        { output: string | null }
      >('SELECT output FROM quality_checks ORDER BY id DESC LIMIT 1')
      .get()
    expect(row?.output ?? '').toMatch(/=== npm run build \(exit 0\) ===/)
  })

  // (c1) Build exits with a real compile error (exit 2) → reason
  //      'build-failed', score=0. This is the dev's regression, NOT a
  //      tooling problem — see Phase 13.12.31. Findings still include
  //      the build banner; test/lint must not have run.
  it('c1) build compile failure (exit 2) → reason=build-failed, score=0, no test/lint fall-through', async () => {
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(testDb.db, dispatcher)
    const recorded: Recorded = { cmds: [] }

    const arbiter = createQualityGateArbiter({
      db: testDb.db,
      eventLog,
      dispatcher,
      projectRoot,
      runCommand: makeRunCommand(recorded, {
        build: {
          ok: false,
          stdout: '',
          stderr: 'TS2304: Cannot find name "foo"\nadditional noise',
          code: 2,
        },
        // These should NEVER be reached because the build failure
        // short-circuits the worktree run. Make them obviously toxic
        // so a regression that *did* fall through would emit findings
        // we can detect.
        test: { ok: false, stdout: 'FAIL test/x.test.ts', stderr: '', code: 1 },
        lint: { ok: false, stdout: 'lint error blob', stderr: '', code: 1 },
      }),
      worktreeBase: tmpRoot,
    })
    const verdict = await arbiter.handleTeamCompletion(baseCompletion())
    arbiter.stop()

    expect(verdict.passed).toBe(false)
    expect(verdict.reason).toBe('build-failed')
    expect(verdict.score).toBe(0)
    const findingsBlob = verdict.findings.join(' || ')
    expect(verdict.findings.some((f) => f.startsWith('Build failed in worktree (exit '))).toBe(true)
    expect(findingsBlob).toMatch(/TS2304/)
    expect(findingsBlob).not.toMatch(/npm test failed/)
    expect(findingsBlob).not.toMatch(/npm run lint failed/)
    // test/lint must not have run after a failed build.
    expect(recorded.cmds.some((c) => c.startsWith('npm test'))).toBe(false)
    expect(recorded.cmds.some((c) => c.startsWith('npm run lint'))).toBe(false)
  })

  // (c2) Build exits 127 (`tsc: command not found`) → reason
  //      'tooling-missing', score=1.0. Only the shell-could-not-locate
  //      case is classified as tooling because the dev cannot fix it.
  it('c2) build exit 127 (command not found) → reason=tooling-missing, score=1.0', async () => {
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(testDb.db, dispatcher)
    const recorded: Recorded = { cmds: [] }

    const arbiter = createQualityGateArbiter({
      db: testDb.db,
      eventLog,
      dispatcher,
      projectRoot,
      runCommand: makeRunCommand(recorded, {
        build: {
          ok: false,
          stdout: '',
          stderr: 'sh: tsc: command not found',
          code: 127,
        },
      }),
      worktreeBase: tmpRoot,
    })
    const verdict = await arbiter.handleTeamCompletion(baseCompletion())
    arbiter.stop()

    expect(verdict.passed).toBe(false)
    expect(verdict.reason).toBe('tooling-missing')
    expect(verdict.score).toBe(1.0)
    expect(recorded.cmds.some((c) => c.startsWith('npm test'))).toBe(false)
    expect(recorded.cmds.some((c) => c.startsWith('npm run lint'))).toBe(false)
  })

  // (c3) `--silent` swallows npm-level errors (EJSONPARSE in a diffed package.json,
  //      …): exit 1 with ZERO bytes on both streams. Every such verdict read
  //      "no output captured" and was undiagnosable — 10+ live occurrences
  //      2026-09-12..09-28 burned whole retry budgets. The gate now re-runs the
  //      build once WITHOUT --silent purely to harvest npm's own report.
  it('c3) silent empty-output build failure → diagnostic re-run without --silent supplies the finding', async () => {
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(testDb.db, dispatcher)
    const recorded: Recorded = { cmds: [] }

    const base = makeRunCommand(recorded)
    const runCommand = (cmd: string, cwd: string): RunResult => {
      if (cmd.startsWith('npm run build')) {
        recorded.cmds.push(cmd)
        return cmd.includes('--silent')
          ? { ok: false, stdout: '', stderr: '', code: 1 }
          : {
              ok: false,
              stdout: '',
              stderr: 'npm error code EJSONPARSE\nnpm error JSON.parse Invalid package.json',
              code: 1,
            }
      }
      return base(cmd, cwd)
    }

    const arbiter = createQualityGateArbiter({
      db: testDb.db,
      eventLog,
      dispatcher,
      projectRoot,
      runCommand,
      worktreeBase: tmpRoot,
    })
    const verdict = await arbiter.handleTeamCompletion(baseCompletion())
    arbiter.stop()

    expect(verdict.passed).toBe(false)
    expect(verdict.reason).toBe('build-failed')
    const findingsBlob = verdict.findings.join(' || ')
    expect(findingsBlob).toMatch(/EJSONPARSE/)
    expect(findingsBlob).toMatch(/\[from diagnostic re-run without --silent\]/)
    expect(findingsBlob).not.toMatch(/no output captured/)
    // The probe is the SAME build command minus --silent, run after the silent one.
    const buildCmds = recorded.cmds.filter((c) => c.startsWith('npm run build'))
    expect(buildCmds).toEqual(['npm run build --silent --if-present', 'npm run build --if-present'])
    // Probe output is persisted alongside the original banner for later diagnosis.
    const row = testDb.db
      .prepare<
        [],
        { output: string | null }
      >('SELECT output FROM quality_checks ORDER BY id DESC LIMIT 1')
      .get()
    expect(row?.output ?? '').toMatch(
      /=== diagnostic re-run: npm run build --if-present \(exit 1\) ===/,
    )
    // Still a short-circuit: test/lint never ran.
    expect(recorded.cmds.some((c) => c.startsWith('npm test'))).toBe(false)
    expect(recorded.cmds.some((c) => c.startsWith('npm run lint'))).toBe(false)
  })

  // (c4) If even the probe is silent, the honest "no output captured" stands —
  //      the re-run must never invent a diagnostic.
  it('c4) probe also produces no output → finding stays "no output captured"', async () => {
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(testDb.db, dispatcher)
    const recorded: Recorded = { cmds: [] }

    const base = makeRunCommand(recorded)
    const runCommand = (cmd: string, cwd: string): RunResult => {
      if (cmd.startsWith('npm run build')) {
        recorded.cmds.push(cmd)
        return { ok: false, stdout: '', stderr: '', code: 1 }
      }
      return base(cmd, cwd)
    }

    const arbiter = createQualityGateArbiter({
      db: testDb.db,
      eventLog,
      dispatcher,
      projectRoot,
      runCommand,
      worktreeBase: tmpRoot,
    })
    const verdict = await arbiter.handleTeamCompletion(baseCompletion())
    arbiter.stop()

    expect(verdict.passed).toBe(false)
    expect(verdict.reason).toBe('build-failed')
    expect(verdict.findings.join(' ')).toMatch(/no output captured/)
  })

  // (d) skipCommands=true skips the build step entirely.
  it('d) skipCommands=true → no `npm run build` invocation', async () => {
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(testDb.db, dispatcher)
    const recorded: Recorded = { cmds: [] }

    const arbiter = createQualityGateArbiter({
      db: testDb.db,
      eventLog,
      dispatcher,
      projectRoot,
      runCommand: makeRunCommand(recorded),
      worktreeBase: tmpRoot,
      skipCommands: true,
    })
    await arbiter.handleTeamCompletion(baseCompletion())
    arbiter.stop()

    expect(recorded.cmds.some((c) => c.startsWith('npm run build'))).toBe(false)
    expect(recorded.cmds.some((c) => c.startsWith('npm test'))).toBe(false)
    expect(recorded.cmds.some((c) => c.startsWith('npm run lint'))).toBe(false)
  })
})
