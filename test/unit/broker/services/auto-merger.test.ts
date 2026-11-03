/**
 * Phase 13.12.34 — Auto-Merger Service tests.
 *
 * Two test surfaces:
 *   1) Pure-function tests for `evaluateSafetyGates` and `performMerge`
 *      using a fake `run` to simulate git output. Covers every gate
 *      independently plus the merge-state preconditions.
 *   2) Real-git integration: a tmp repo with a candidate branch, the
 *      service wired with `enabled=true`, and a synthetic verdict event
 *      dispatched. Confirms the branch is merged and `auto_merged` is
 *      emitted.
 */

import { describe, it, expect, afterEach } from 'vitest'
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execSync } from 'node:child_process'

import {
  createAutoMerger,
  evaluateSafetyGates,
  performMerge,
  DEFAULT_FORBIDDEN_FILES,
} from '../../../../src/broker/services/auto-merger.js'
import type { RunResult } from '../../../../src/broker/services/quality-gate-arbiter.js'
import { createEventDispatcher } from '../../../../src/broker/event-dispatcher.js'
import { createEventLog } from '../../../../src/broker/services/event-log.js'
import { createBrokerTestDb } from '../../../helpers/broker-db-harness.js'

function ok(stdout: string, stderr = ''): RunResult {
  return { ok: true, stdout, stderr }
}
function err(code: number, stdout = '', stderr = ''): RunResult {
  return { ok: false, stdout, stderr, code }
}

/**
 * Build a fake `run` from a routing function. The router receives the
 * raw command string and returns a `RunResult`. Useful for asserting
 * gate-by-gate behavior without spawning real git.
 */
function fakeRun(
  router: (cmd: string) => RunResult,
): (cmd: string, cwd: string) => RunResult {
  return (cmd: string) => router(cmd)
}

// ──────────────────────────────────────────────────────────────────────
// Part 1 — Pure gate evaluation
// ──────────────────────────────────────────────────────────────────────

describe('evaluateSafetyGates (Phase 13.12.34)', () => {
  const DEFAULT_OPTS = {
    maxDiffLines: 500,
    forbiddenFiles: DEFAULT_FORBIDDEN_FILES,
  }

  function passingRun(): (cmd: string) => RunResult {
    return (cmd: string) => {
      if (cmd.startsWith('git rev-parse main'))
        return ok('1234abcd5678efef9012345678901234567890ab\n')
      if (cmd.startsWith('git rev-parse "scns/auto'))
        return ok('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n')
      if (cmd.startsWith('git ls-tree'))
        return ok(
          '100644 blob deadbeef\tsrc/feature.ts\n' +
            '100644 blob abc12345\ttest/feature.test.ts\n',
        )
      if (cmd.startsWith('git diff --name-only'))
        return ok('src/feature.ts\ntest/feature.test.ts\n')
      if (cmd.includes('-- .github/copilot-instructions.md'))
        return ok('')
      if (cmd.startsWith('git diff --numstat'))
        return ok('5\t1\tsrc/feature.ts\n10\t0\ttest/feature.test.ts\n')
      return err(1, '', 'unexpected cmd: ' + cmd)
    }
  }

  it('passes all gates for a clean test-bearing branch', () => {
    const result = evaluateSafetyGates(
      fakeRun(passingRun()),
      'scns/auto/abc123',
      '/repo',
      DEFAULT_OPTS,
    )
    expect(result.ok).toBe(true)
    const gateNames = result.outcomes.map((o) => o.gate)
    expect(gateNames).toContain('main-baseline-exists')
    expect(gateNames).toContain('no-staged-symlinks')
    expect(gateNames).toContain('no-forbidden-files')
    expect(gateNames).toContain('no-qg-infra-without-override')
    expect(gateNames).toContain('no-neg-mem-edit')
    expect(gateNames).toContain('has-test-coverage')
    expect(gateNames).toContain('diff-size-bounded')
    for (const o of result.outcomes) expect(o.passed).toBe(true)
  })

  it('FAILS when `git rev-parse main` fails', () => {
    const result = evaluateSafetyGates(
      fakeRun((cmd) =>
        cmd.startsWith('git rev-parse main')
          ? err(128, '', 'fatal: unknown revision')
          : ok(''),
      ),
      'scns/auto/abc',
      '/repo',
      DEFAULT_OPTS,
    )
    expect(result.ok).toBe(false)
    expect(result.outcomes[0]).toMatchObject({
      gate: 'main-baseline-exists',
      passed: false,
    })
  })

  it('FAILS when branch tree contains a symlink (mode 120000)', () => {
    const router = passingRun()
    const result = evaluateSafetyGates(
      fakeRun((cmd) => {
        if (cmd.startsWith('git ls-tree')) {
          return ok(
            '100644 blob deadbeef\tsrc/feature.ts\n' +
              '120000 blob abc12345\tnode_modules\n' +
              '100644 blob xx\ttest/feature.test.ts\n',
          )
        }
        return router(cmd)
      }),
      'scns/auto/poison',
      '/repo',
      DEFAULT_OPTS,
    )
    expect(result.ok).toBe(false)
    const symGate = result.outcomes.find((o) => o.gate === 'no-staged-symlinks')
    expect(symGate?.passed).toBe(false)
    expect(symGate?.detail).toContain('node_modules')
  })

  it('FAILS when branch touches a forbidden file', () => {
    const router = passingRun()
    const result = evaluateSafetyGates(
      fakeRun((cmd) => {
        if (cmd.startsWith('git diff --name-only')) {
          return ok(
            'src/broker/services/auto-dispatch.ts\nsrc/feature.ts\ntest/feature.test.ts\n',
          )
        }
        return router(cmd)
      }),
      'scns/auto/forbidden',
      '/repo',
      DEFAULT_OPTS,
    )
    expect(result.ok).toBe(false)
    const gate = result.outcomes.find((o) => o.gate === 'no-forbidden-files')
    expect(gate?.passed).toBe(false)
    expect(gate?.detail).toContain('auto-dispatch.ts')
  })

  it('FAILS when branch touches the negative-memories block', () => {
    const router = passingRun()
    const result = evaluateSafetyGates(
      fakeRun((cmd) => {
        if (cmd.includes('-- .github/copilot-instructions.md')) {
          return ok(
            '@@ -1,5 +1,3 @@\n <!-- SCNS:negative-memories:start -->\n-- Do not claim functionality works without live verification\n <!-- SCNS:negative-memories:end -->\n',
          )
        }
        return router(cmd)
      }),
      'scns/auto/neg-mem',
      '/repo',
      DEFAULT_OPTS,
    )
    expect(result.ok).toBe(false)
    const gate = result.outcomes.find((o) => o.gate === 'no-neg-mem-edit')
    expect(gate?.passed).toBe(false)
  })

  it('FAILS when branch has zero test files', () => {
    const router = passingRun()
    const result = evaluateSafetyGates(
      fakeRun((cmd) => {
        if (cmd.startsWith('git diff --name-only')) {
          return ok('src/feature.ts\nsrc/other.ts\n')
        }
        if (cmd.startsWith('git diff --numstat')) {
          return ok('5\t1\tsrc/feature.ts\n10\t0\tsrc/other.ts\n')
        }
        return router(cmd)
      }),
      'scns/auto/no-tests',
      '/repo',
      DEFAULT_OPTS,
    )
    expect(result.ok).toBe(false)
    const gate = result.outcomes.find((o) => o.gate === 'has-test-coverage')
    expect(gate?.passed).toBe(false)
  })

  it('PASSES when test file uses test/ directory convention', () => {
    const router = passingRun()
    const result = evaluateSafetyGates(
      fakeRun((cmd) => {
        if (cmd.startsWith('git diff --name-only'))
          return ok('src/feature.ts\ntest/unit/feature.test.ts\n')
        return router(cmd)
      }),
      'scns/auto/dir-test',
      '/repo',
      DEFAULT_OPTS,
    )
    expect(result.ok).toBe(true)
  })

  it('PASSES when test file uses *.spec.ts convention', () => {
    const router = passingRun()
    const result = evaluateSafetyGates(
      fakeRun((cmd) => {
        if (cmd.startsWith('git diff --name-only'))
          return ok('src/feature.ts\nsrc/feature.spec.ts\n')
        return router(cmd)
      }),
      'scns/auto/spec',
      '/repo',
      DEFAULT_OPTS,
    )
    expect(result.ok).toBe(true)
  })

  it('FAILS when diff exceeds maxDiffLines', () => {
    const router = passingRun()
    const result = evaluateSafetyGates(
      fakeRun((cmd) => {
        if (cmd.startsWith('git diff --numstat')) {
          return ok('400\t150\tsrc/feature.ts\n50\t10\ttest/feature.test.ts\n')
        }
        return router(cmd)
      }),
      'scns/auto/huge',
      '/repo',
      { maxDiffLines: 500, forbiddenFiles: DEFAULT_FORBIDDEN_FILES },
    )
    expect(result.ok).toBe(false)
    const gate = result.outcomes.find((o) => o.gate === 'diff-size-bounded')
    expect(gate?.passed).toBe(false)
    expect(gate?.detail).toContain('610') // 400+150+50+10
  })

  it('handles binary-file numstat ("-\\t-\\tpath") without crashing', () => {
    const router = passingRun()
    const result = evaluateSafetyGates(
      fakeRun((cmd) => {
        if (cmd.startsWith('git diff --numstat')) {
          return ok('-\t-\tsrc/binary.png\n5\t1\ttest/feature.test.ts\n')
        }
        return router(cmd)
      }),
      'scns/auto/binary',
      '/repo',
      DEFAULT_OPTS,
    )
    expect(result.ok).toBe(true)
    const gate = result.outcomes.find((o) => o.gate === 'diff-size-bounded')
    expect(gate?.detail).toContain('6 lines') // 5+1 only; binary skipped
  })

  it('FAILS no-qg-infra-without-override when diff touches QG arbiter', () => {
    const router = passingRun()
    const result = evaluateSafetyGates(
      fakeRun((cmd) => {
        if (cmd.startsWith('git diff --name-only')) {
          return ok(
            'src/broker/services/quality-gate-arbiter.ts\ntest/unit/broker/services/quality-gate-arbiter.test.ts\n',
          )
        }
        if (cmd.startsWith('git ls-tree')) {
          return ok(
            '100644 blob deadbeef\tsrc/broker/services/quality-gate-arbiter.ts\n' +
              '100644 blob abc12345\ttest/unit/broker/services/quality-gate-arbiter.test.ts\n',
          )
        }
        return router(cmd)
      }),
      'scns/auto/fix-qg-bug',
      '/repo',
      DEFAULT_OPTS,
    )
    expect(result.ok).toBe(false)
    const gate = result.outcomes.find(
      (o) => o.gate === 'no-qg-infra-without-override',
    )
    expect(gate).toBeDefined()
    expect(gate?.passed).toBe(false)
    expect(gate?.detail).toMatch(/QG-infrastructure change requires human review/)
    expect(gate?.detail).toContain('quality-gate-arbiter.ts')
  })

  it('PASSES no-qg-infra-without-override when allowQgInfraMerge=true', () => {
    const router = passingRun()
    const result = evaluateSafetyGates(
      fakeRun((cmd) => {
        if (cmd.startsWith('git diff --name-only')) {
          return ok(
            'src/broker/services/quality-gate-arbiter.ts\ntest/feature.test.ts\n',
          )
        }
        if (cmd.startsWith('git ls-tree')) {
          return ok(
            '100644 blob deadbeef\tsrc/broker/services/quality-gate-arbiter.ts\n' +
              '100644 blob abc12345\ttest/feature.test.ts\n',
          )
        }
        return router(cmd)
      }),
      'scns/auto/fix-qg-bug',
      '/repo',
      { ...DEFAULT_OPTS, allowQgInfraMerge: true },
    )
    const gate = result.outcomes.find(
      (o) => o.gate === 'no-qg-infra-without-override',
    )
    expect(gate?.passed).toBe(true)
    expect(gate?.detail).toMatch(/allowed via override/)
    // Note: `quality-gate-arbiter.ts` is also in DEFAULT_FORBIDDEN_FILES
    // as defense-in-depth, so result.ok would still be false. The
    // override only relaxes the classifier gate. A real rollout would
    // also need a forbiddenFiles override or a file outside the list.
  })

  it('PASSES no-qg-infra-without-override for an ordinary diff', () => {
    const result = evaluateSafetyGates(
      fakeRun(passingRun()),
      'scns/auto/feature',
      '/repo',
      DEFAULT_OPTS,
    )
    const gate = result.outcomes.find(
      (o) => o.gate === 'no-qg-infra-without-override',
    )
    expect(gate?.passed).toBe(true)
    expect(gate?.detail).toMatch(/no QG-infrastructure files modified/)
  })
})

// ──────────────────────────────────────────────────────────────────────
// Part 2 — performMerge preconditions
// ──────────────────────────────────────────────────────────────────────

describe('performMerge (Phase 13.12.34)', () => {
  it('refuses to merge when HEAD is not on main', () => {
    const result = performMerge(
      fakeRun((cmd) => {
        if (cmd.includes('rev-parse --abbrev-ref HEAD'))
          return ok('feature-branch\n')
        return ok('')
      }),
      'scns/auto/abc',
      '/repo',
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain("HEAD is on 'feature-branch'")
    }
  })

  it('refuses to merge when working tree is dirty', () => {
    const result = performMerge(
      fakeRun((cmd) => {
        if (cmd.includes('rev-parse --abbrev-ref HEAD')) return ok('main\n')
        if (cmd === 'git status --porcelain') return ok(' M src/foo.ts\n')
        return ok('')
      }),
      'scns/auto/abc',
      '/repo',
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('working tree dirty')
    }
  })

  it('merges when the ONLY dirty path is the broker-managed negmem file (issue #5)', () => {
    const result = performMerge(
      fakeRun((cmd) => {
        if (cmd.includes('rev-parse --abbrev-ref HEAD')) return ok('main\n')
        if (cmd === 'git status --porcelain') return ok(' M .github/copilot-instructions.md\n')
        if (cmd.includes('merge --no-ff')) return ok('Merge made\n')
        if (cmd === 'git rev-parse HEAD') return ok('a'.repeat(40) + '\n')
        return ok('')
      }),
      'scns/auto/abc',
      '/repo',
    )
    expect(result.ok).toBe(true)
  })

  it('still refuses when a real file is dirty alongside the managed file', () => {
    const result = performMerge(
      fakeRun((cmd) => {
        if (cmd.includes('rev-parse --abbrev-ref HEAD')) return ok('main\n')
        if (cmd === 'git status --porcelain')
          return ok(' M .github/copilot-instructions.md\n M src/foo.ts\n')
        return ok('')
      }),
      'scns/auto/abc',
      '/repo',
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('working tree dirty')
  })

  it('aborts and returns failure when merge command fails', () => {
    let abortCalled = false
    const result = performMerge(
      fakeRun((cmd) => {
        if (cmd.includes('rev-parse --abbrev-ref HEAD')) return ok('main\n')
        if (cmd === 'git status --porcelain') return ok('')
        if (cmd.includes('merge --no-ff'))
          return err(1, '', 'CONFLICT: merge conflict in src/foo.ts')
        if (cmd === 'git merge --abort') {
          abortCalled = true
          return ok('')
        }
        return ok('')
      }),
      'scns/auto/conflict',
      '/repo',
    )
    expect(result.ok).toBe(false)
    expect(abortCalled).toBe(true)
    if (!result.ok) {
      expect(result.reason).toContain('CONFLICT')
    }
  })

  it('returns the new HEAD SHA on successful merge', () => {
    const result = performMerge(
      fakeRun((cmd) => {
        if (cmd === 'git rev-parse --abbrev-ref HEAD') return ok('main\n')
        if (cmd === 'git status --porcelain') return ok('')
        if (cmd.includes('merge --no-ff')) return ok('Merge made by recursive\n')
        if (cmd === 'git rev-parse HEAD')
          return ok('abcdef0123456789abcdef0123456789abcdef01\n')
        return err(1, '', 'unexpected: ' + cmd)
      }),
      'scns/auto/abc',
      '/repo',
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.sha).toBe('abcdef0123456789abcdef0123456789abcdef01')
    }
  })
})

// ──────────────────────────────────────────────────────────────────────
// Part 3 — End-to-end with real git repo
// ──────────────────────────────────────────────────────────────────────

const tmpDirs: string[] = []
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()
    if (d) {
      try {
        rmSync(d, { recursive: true, force: true })
      } catch {
        /* best-effort */
      }
    }
  }
})

function seedRepoWithAutoBranch(): {
  repoDir: string
  branch: string
} {
  const repoDir = mkdtempSync(join(tmpdir(), 'auto-merger-e2e-'))
  tmpDirs.push(repoDir)

  execSync('git init -q -b main', { cwd: repoDir })
  execSync('git config user.email t@t', { cwd: repoDir })
  execSync('git config user.name t', { cwd: repoDir })
  writeFileSync(join(repoDir, 'README.md'), '# seed\n')
  mkdirSync(join(repoDir, 'src'), { recursive: true })
  mkdirSync(join(repoDir, 'test'), { recursive: true })
  writeFileSync(join(repoDir, 'src', 'app.ts'), 'export const v = 1\n')
  execSync('git add -A && git commit -q -m seed', { cwd: repoDir })

  // Create scns/auto branch with feature + test
  const branch = 'scns/auto/test-branch-' + Math.random().toString(36).slice(2, 8)
  execSync(`git checkout -q -b ${branch}`, { cwd: repoDir })
  writeFileSync(join(repoDir, 'src', 'app.ts'), 'export const v = 2\n')
  writeFileSync(join(repoDir, 'test', 'app.test.ts'), 'test 1\n')
  execSync('git add -A && git commit -q -m "feat: bump v"', { cwd: repoDir })
  execSync('git checkout -q main', { cwd: repoDir })

  return { repoDir, branch }
}

/**
 * Real-git tests spawn ~8 `git` subprocesses per seed. On Windows each spawn
 * costs process creation plus AV scanning of the new objects, which put these
 * within noise of the 10s global ceiling — measured 8332ms / 7470ms / 5835ms in
 * isolation, and the first timed out outright under full-suite load.
 *
 * Spawning git IS the test, so unlike the suggestion-store seeding there is no
 * wasted work to remove here. This is an explicit backstop, scoped to the
 * real-git suites rather than raised globally, so a regression in the fast
 * unit tests above still trips the 10s default.
 */
const REAL_GIT_TIMEOUT_MS = 60_000

describe('AutoMerger end-to-end with real git (Phase 13.12.34)', { timeout: REAL_GIT_TIMEOUT_MS }, () => {
  it('merges a safe scns/auto branch and emits auto_merged event', () => {
    const { repoDir, branch } = seedRepoWithAutoBranch()
    const testDb = createBrokerTestDb()
    try {
      const dispatcher = createEventDispatcher()
      const eventLog = createEventLog(testDb.db, dispatcher)

      const merger = createAutoMerger({
        db: testDb.db,
        eventLog,
        dispatcher,
        projectRoot: repoDir,
        enabled: true,
      })

      // Dispatch a synthetic quality_gate_verdict
      dispatcher.dispatch({
        id: 1,
        event_type: 'quality_gate_verdict',
        session_id: null,
        team_id: 'team-xyz',
        payload: JSON.stringify({
          team_id: 'team-xyz',
          passed: true,
          branch,
          sourceSuggestionId: 'sugg-xyz',
        }),
        created_at: new Date().toISOString(),
      })
      merger.stop()

      // HEAD of main should have advanced
      const log = execSync('git log --first-parent --oneline main', {
        cwd: repoDir,
        encoding: 'utf8',
      })
      expect(log.split('\n').length).toBeGreaterThanOrEqual(2)
      expect(log).toContain("Merge")

      // An auto_merged event should have been emitted
      const events = eventLog.since(0)
      const merged = events.find((e) => e.event_type === 'auto_merged')
      expect(merged).toBeDefined()
      const payload = JSON.parse(merged!.payload)
      expect(payload.branch).toBe(branch)
      expect(payload.team_id).toBe('team-xyz')
      expect(typeof payload.merge_sha).toBe('string')
    } finally {
      testDb.close()
    }
  })

  it('refuses to merge a branch with no test files, emits auto_merge_rejected', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'auto-merger-notest-'))
    tmpDirs.push(repoDir)

    execSync('git init -q -b main', { cwd: repoDir })
    execSync('git config user.email t@t', { cwd: repoDir })
    execSync('git config user.name t', { cwd: repoDir })
    writeFileSync(join(repoDir, 'README.md'), '# seed\n')
    execSync('git add -A && git commit -q -m seed', { cwd: repoDir })

    const branch = 'scns/auto/no-tests'
    execSync(`git checkout -q -b ${branch}`, { cwd: repoDir })
    writeFileSync(join(repoDir, 'src.ts'), 'just code\n')
    execSync('git add -A && git commit -q -m "feat: no tests"', { cwd: repoDir })
    execSync('git checkout -q main', { cwd: repoDir })

    const testDb = createBrokerTestDb()
    try {
      const dispatcher = createEventDispatcher()
      const eventLog = createEventLog(testDb.db, dispatcher)
      const merger = createAutoMerger({
        db: testDb.db,
        eventLog,
        dispatcher,
        projectRoot: repoDir,
        enabled: true,
      })

      dispatcher.dispatch({
        id: 1,
        event_type: 'quality_gate_verdict',
        session_id: null,
        team_id: 'team-x',
        payload: JSON.stringify({ team_id: 'team-x', passed: true, branch }),
        created_at: new Date().toISOString(),
      })
      merger.stop()

      // main should NOT have advanced
      const log = execSync('git log --first-parent --oneline main', {
        cwd: repoDir,
        encoding: 'utf8',
      })
      expect(log.trim().split('\n').length).toBe(1)

      const events = eventLog.since(0)
      const rejected = events.find((e) => e.event_type === 'auto_merge_rejected')
      expect(rejected).toBeDefined()
      const payload = JSON.parse(rejected!.payload)
      expect(payload.branch).toBe(branch)
      expect(
        payload.failedGates.some(
          (g: { gate: string }) => g.gate === 'has-test-coverage',
        ),
      ).toBe(true)
    } finally {
      testDb.close()
    }
  })

  it('does NOT subscribe when enabled=false (flag-gated default)', () => {
    const { repoDir, branch } = seedRepoWithAutoBranch()
    const testDb = createBrokerTestDb()
    try {
      const dispatcher = createEventDispatcher()
      const eventLog = createEventLog(testDb.db, dispatcher)
      const merger = createAutoMerger({
        db: testDb.db,
        eventLog,
        dispatcher,
        projectRoot: repoDir,
        enabled: false,
      })
      dispatcher.dispatch({
        id: 1,
        event_type: 'quality_gate_verdict',
        session_id: null,
        team_id: 'team-x',
        payload: JSON.stringify({ team_id: 'team-x', passed: true, branch }),
        created_at: new Date().toISOString(),
      })
      merger.stop()

      // No merge should occur, no auto_* events emitted
      const log = execSync('git log --first-parent --oneline main', {
        cwd: repoDir,
        encoding: 'utf8',
      })
      expect(log.trim().split('\n').length).toBe(1)
      const events = eventLog.since(0)
      expect(events.find((e) => e.event_type === 'auto_merged')).toBeUndefined()
      expect(
        events.find((e) => e.event_type === 'auto_merge_rejected'),
      ).toBeUndefined()
    } finally {
      testDb.close()
    }
  })

  it('ignores branches that do not start with scns/auto/', () => {
    const { repoDir } = seedRepoWithAutoBranch()
    const testDb = createBrokerTestDb()
    try {
      const dispatcher = createEventDispatcher()
      const eventLog = createEventLog(testDb.db, dispatcher)
      const merger = createAutoMerger({
        db: testDb.db,
        eventLog,
        dispatcher,
        projectRoot: repoDir,
        enabled: true,
      })
      dispatcher.dispatch({
        id: 1,
        event_type: 'quality_gate_verdict',
        session_id: null,
        team_id: 'team-x',
        payload: JSON.stringify({
          team_id: 'team-x',
          passed: true,
          branch: 'feature/manual',
        }),
        created_at: new Date().toISOString(),
      })
      merger.stop()

      const events = eventLog.since(0)
      expect(events.find((e) => e.event_type === 'auto_merged')).toBeUndefined()
      expect(
        events.find((e) => e.event_type === 'auto_merge_rejected'),
      ).toBeUndefined()
    } finally {
      testDb.close()
    }
  })
})

// ──────────────────────────────────────────────────────────────────────
// Part 3 — P0.3: completeTaskOnMerge callback wiring
// ──────────────────────────────────────────────────────────────────────

describe('AutoMerger completeTaskOnMerge callback (P0.3)', { timeout: REAL_GIT_TIMEOUT_MS }, () => {
  it('invokes completeTaskOnMerge and emits task_completed after a successful merge', () => {
    const { repoDir, branch } = seedRepoWithAutoBranch()
    const testDb = createBrokerTestDb()
    try {
      const dispatcher = createEventDispatcher()
      const eventLog = createEventLog(testDb.db, dispatcher)

      const calls: Array<{
        teamId: string
        mergeSha: string
        qualityCheckId: string | null
      }> = []

      const merger = createAutoMerger({
        db: testDb.db,
        eventLog,
        dispatcher,
        projectRoot: repoDir,
        enabled: true,
        completeTaskOnMerge: (input) => {
          calls.push(input)
          return {
            transitioned: true,
            reason: 'completed',
            taskId: 42,
            ownerSessionId: 'dev-A',
            dispatchId: 'disp-A',
            completedAtIso: '2026-05-19T00:00:00.000Z',
          }
        },
      })

      dispatcher.dispatch({
        id: 1,
        event_type: 'quality_gate_verdict',
        session_id: null,
        team_id: 'team-merge-callback',
        payload: JSON.stringify({
          team_id: 'team-merge-callback',
          passed: true,
          branch,
          sourceSuggestionId: null,
          qualityCheckId: 'qc-merge-1',
        }),
        created_at: new Date().toISOString(),
      })
      merger.stop()

      expect(calls).toHaveLength(1)
      expect(calls[0]!.teamId).toBe('team-merge-callback')
      expect(calls[0]!.qualityCheckId).toBe('qc-merge-1')
      expect(typeof calls[0]!.mergeSha).toBe('string')
      expect(calls[0]!.mergeSha.length).toBeGreaterThan(0)

      const events = eventLog.since(0)
      const taskCompleted = events.find((e) => e.event_type === 'task_completed')
      expect(taskCompleted).toBeDefined()
      const payload = JSON.parse(taskCompleted!.payload)
      expect(payload.task_id).toBe(42)
      expect(payload.team_id).toBe('team-merge-callback')
      expect(payload.merge_sha).toBe(calls[0]!.mergeSha)
      expect(payload.completion_source).toBe('auto_merge')
    } finally {
      testDb.close()
    }
  })

  it('does NOT emit task_completed when callback returns transitioned=false', () => {
    const { repoDir, branch } = seedRepoWithAutoBranch()
    const testDb = createBrokerTestDb()
    try {
      const dispatcher = createEventDispatcher()
      const eventLog = createEventLog(testDb.db, dispatcher)

      const merger = createAutoMerger({
        db: testDb.db,
        eventLog,
        dispatcher,
        projectRoot: repoDir,
        enabled: true,
        completeTaskOnMerge: () => ({
          transitioned: false,
          reason: 'already-completed',
          taskId: -1,
          ownerSessionId: null,
          dispatchId: null,
          completedAtIso: null,
        }),
      })

      dispatcher.dispatch({
        id: 1,
        event_type: 'quality_gate_verdict',
        session_id: null,
        team_id: 'team-already-done',
        payload: JSON.stringify({
          team_id: 'team-already-done',
          passed: true,
          branch,
          qualityCheckId: 'qc-already',
        }),
        created_at: new Date().toISOString(),
      })
      merger.stop()

      const events = eventLog.since(0)
      // The merge itself still happened — auto_merged was emitted.
      expect(events.find((e) => e.event_type === 'auto_merged')).toBeDefined()
      // But no task_completed event — the callback declined to transition.
      expect(events.find((e) => e.event_type === 'task_completed')).toBeUndefined()
    } finally {
      testDb.close()
    }
  })

  it('survives a callback that throws — merge audit trail stays intact', () => {
    const { repoDir, branch } = seedRepoWithAutoBranch()
    const testDb = createBrokerTestDb()
    try {
      const dispatcher = createEventDispatcher()
      const eventLog = createEventLog(testDb.db, dispatcher)

      const merger = createAutoMerger({
        db: testDb.db,
        eventLog,
        dispatcher,
        projectRoot: repoDir,
        enabled: true,
        completeTaskOnMerge: () => {
          throw new Error('boom — DB connection blew up mid-update')
        },
      })

      dispatcher.dispatch({
        id: 1,
        event_type: 'quality_gate_verdict',
        session_id: null,
        team_id: 'team-throwing-cb',
        payload: JSON.stringify({
          team_id: 'team-throwing-cb',
          passed: true,
          branch,
          qualityCheckId: 'qc-throw',
        }),
        created_at: new Date().toISOString(),
      })
      merger.stop()

      // auto_merged still emitted — merge succeeded.
      const events = eventLog.since(0)
      expect(events.find((e) => e.event_type === 'auto_merged')).toBeDefined()
      // No task_completed because the callback threw.
      expect(events.find((e) => e.event_type === 'task_completed')).toBeUndefined()
    } finally {
      testDb.close()
    }
  })
})
