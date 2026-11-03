import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { TestDb } from '../../../helpers/db-harness.js'
import { createBrokerTestDb } from '../../../helpers/broker-db-harness.js'
import { createEventLog } from '../../../../src/broker/services/event-log.js'
import { createEventDispatcher } from '../../../../src/broker/event-dispatcher.js'
import {
  createQualityGateArbiter,
  type RunResult,
  type QualityGateSuggestionStore,
  type QualityGateExecutor,
} from '../../../../src/broker/services/quality-gate-arbiter.js'
import type { TeamCompletionData } from '../../../../src/broker/services/team-lifecycle.js'
import type { Suggestion } from '../../../../src/suggest/types.js'
import { MAX_ATTEMPTS_BEFORE_FAILED } from '../../../../src/suggest/suggestion-store.js'

// ── Fixtures ─────────────────────────────────────────────────────────

function ok(stdout = '', stderr = ''): RunResult {
  return { ok: true, stdout, stderr }
}
function fail(stderr = 'boom', code = 1): RunResult {
  return { ok: false, stdout: '', stderr, code }
}

function makeCompletion(overrides: Partial<TeamCompletionData> = {}): TeamCompletionData {
  return {
    teamId: 'team-task-sugg-abc123',
    memberSessionIds: ['s1', 's2'],
    stagedDiff:
      'diff --git a/foo.md b/foo.md\n--- a/foo.md\n+++ b/foo.md\n@@ -1 +1,2 @@\n line\n+new\n',
    artifacts: [],
    logs: [],
    aggregateOutcome: 'success',
    completedAt: new Date().toISOString(),
    ...overrides,
  }
}

function makeSuggestion(id: string, overrides: Partial<Suggestion> = {}): Suggestion {
  return {
    id,
    type: 'prompt',
    title: 'Example suggestion',
    description: 'test',
    status: 'approved',
    confidence: 0.9,
    evidence: [],
    tags: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    actionable: true,
    estimatedComplexity: 'solo',
    ...overrides,
  }
}

function makeFakeSuggestionStore(seed: Suggestion): QualityGateSuggestionStore & {
  updates: Array<{ id: string; status: string; reason?: string }>
  gateFailures: Array<{ id: string; reason: string; attemptCount: number; status: string }>
} {
  const map = new Map<string, Suggestion>([[seed.id, seed]])
  const updates: Array<{ id: string; status: string; reason?: string }> = []
  const gateFailures: Array<{
    id: string
    reason: string
    attemptCount: number
    status: string
  }> = []
  return {
    updates,
    gateFailures,
    get: (id: string) => map.get(id) ?? null,
    updateStatus: (id, status, reason) => {
      const cur = map.get(id)
      if (!cur) return null
      const next: Suggestion = { ...cur, status, reviewReason: reason }
      map.set(id, next)
      updates.push({ id, status, reason })
      return next
    },
    // Phase 10f: the gate's FAIL branch no longer calls `updateStatus(id, 'rejected')`; it calls
    // this. The fake mirrors the REAL contract of `recordQualityGateFailure` rather than just
    // recording the call, because the two properties these tests care about are exactly the two
    // the defect got wrong: the human's `reviewReason`/`reviewVerdict` are never touched, and the
    // status between attempts is `approved` (not a terminal label) so the brain picks it up again.
    //
    // Worth noting for anyone writing a stub against this interface: `recordGateFailure` in the
    // arbiter wraps this call in try/catch by design (FR-058b — a store error must leave the
    // suggestion non-terminal rather than crash the gate), and `tsconfig.json` excludes `test/`.
    // A stub that simply OMITS this method therefore fails silently as a caught TypeError, and
    // the only symptom is an empty assertion target. That is how this very stub behaved before
    // it was updated.
    recordQualityGateFailure: (id: string, reason: string) => {
      const cur = map.get(id)
      if (!cur) return null
      const attemptCount = (cur.attemptCount ?? 0) + 1
      const status = attemptCount >= MAX_ATTEMPTS_BEFORE_FAILED ? 'needs-human' : 'approved'
      const next: Suggestion = {
        ...cur,
        status: status as Suggestion['status'],
        attemptCount,
        machineReason: reason,
        inflightTeamId: undefined,
      }
      map.set(id, next)
      gateFailures.push({ id, reason, attemptCount, status })
      return next
    },
  }
}

function makeFakeExecutor(): QualityGateExecutor & { calls: number } {
  const state = { calls: 0 }
  const exec = {
    generatePlan: () => ({ steps: [] }),
    execute: () => {
      state.calls++
      return { success: true, errors: [] }
    },
    get calls() {
      return state.calls
    },
  }
  return exec as QualityGateExecutor & { calls: number }
}

function makeNegStoreStub() {
  const stored: Array<{ dontRule: string }> = []
  return {
    store: {
      storeFromTool: () => {
        throw new Error('not used')
      },
      storeFromHeuristic: (input: { dontRule: string }) => {
        stored.push({ dontRule: input.dontRule })
        return {
          id: 'nm-' + stored.length,
          originalText: '',
          dontRule: input.dontRule,
          category: 'behavior-complaint' as const,
          recommendedTarget: 'general' as const,
          confidence: 0.7,
          sessionId: null,
          source: 'heuristic' as const,
          targetApplied: false,
          appliedTo: null,
          createdAt: new Date().toISOString(),
        }
      },
      list: () => [],
      search: () => [],
      getById: () => null,
      count: () => stored.length,
    },
    stored,
  }
}

function runScript(script: Record<string, RunResult | ((cmd: string, cwd: string) => RunResult)>): {
  fn: (cmd: string, cwd: string) => RunResult
  calls: Array<{ cmd: string; cwd: string }>
} {
  const calls: Array<{ cmd: string; cwd: string }> = []
  return {
    calls,
    fn: (cmd, cwd) => {
      calls.push({ cmd, cwd })
      // The real `git worktree add … HEAD` checks out the project at HEAD —
      // for these fixtures an npm project. Materialize that shape (dir +
      // package.json) so the arbiter's non-npm probe (G2) sees an npm
      // worktree and the npm build/test/lint steps run as the tests expect.
      if (cmd.startsWith('git worktree add')) {
        const m = cmd.match(/git worktree add -b \S+ "([^"]+)" HEAD/)
        if (m) {
          mkdirSync(m[1], { recursive: true })
          writeFileSync(join(m[1], 'package.json'), '{"name":"fixture","version":"0.0.0"}')
        }
      }
      for (const [match, res] of Object.entries(script)) {
        if (cmd.includes(match)) {
          return typeof res === 'function' ? res(cmd, cwd) : res
        }
      }
      return ok()
    },
  }
}

// ── Tests ────────────────────────────────────────────────────────────

describe('QualityGateArbiter', () => {
  let testDb: TestDb
  let tmpRoot: string

  beforeEach(() => {
    testDb = createBrokerTestDb()
    tmpRoot = mkdtempSync(join(tmpdir(), 'qg-arbiter-test-'))
  })

  afterEach(() => {
    testDb.close()
    if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('PASS path: commits branch, applies artifact, marks suggestion implemented', async () => {
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(testDb.db, dispatcher)
    const sugg = makeSuggestion('abc123')
    const store = makeFakeSuggestionStore(sugg)
    const executor = makeFakeExecutor()

    // Capture commit-msg file contents during `commit -F` (before cleanup removes it).
    let capturedMsg = ''
    const wrappedScript = runScript({
      'git worktree add': ok('worktree added'),
      'git apply': ok(),
      'npm test': ok('All tests passed'),
      'npm run lint': ok('lint clean'),
      'git add': ok(),
      'git -c user.name=scns-auto': ok('commit ok'),
      'git worktree remove': ok(),
    })
    const captureRun = (cmd: string, cwd: string, opts?: { timeoutMs?: number }) => {
      if (cmd.includes('commit -F')) {
        const m = cmd.match(/commit -F "([^"]+)"/)
        if (m) {
          try {
            capturedMsg = readFileSync(m[1], 'utf-8')
          } catch {
            /* ignore */
          }
        }
      }
      return wrappedScript.fn(cmd, cwd, opts)
    }

    const arbiter = createQualityGateArbiter({
      db: testDb.db,
      eventLog,
      dispatcher,
      projectRoot: tmpRoot,
      suggestionStore: store,
      executor,
      runCommand: captureRun,
      worktreeBase: tmpRoot,
    })

    const verdict = await arbiter.handleTeamCompletion(makeCompletion())
    arbiter.stop()

    expect(verdict.passed).toBe(true)
    expect(verdict.reason).toBe('ok')
    expect(verdict.branch).toMatch(/^scns\/auto\/team-task-sugg-abc123-/)
    expect(verdict.sourceSuggestionId).toBe('abc123')

    // Commit ran with -F <file>, contents had feat: + trailer
    const commitCall = wrappedScript.calls.find((c) => c.cmd.includes('commit -F'))
    expect(commitCall).toBeDefined()
    expect(capturedMsg).toContain('feat: apply auto-approved suggestion abc123')
    expect(capturedMsg).toContain('Co-authored-by: Copilot')

    // Worktree removal happened
    const removeCall = wrappedScript.calls.find((c) => c.cmd.includes('git worktree remove'))
    expect(removeCall).toBeDefined()

    // Executor applied artifact
    expect(executor.calls).toBe(1)

    // Suggestion marked implemented with qg-pass reason
    expect(store.updates).toHaveLength(1)
    expect(store.updates[0]).toMatchObject({
      id: 'abc123',
      status: 'implemented',
      reason: 'qg-pass',
    })

    // quality_checks row persisted
    const rows = testDb.db.prepare('SELECT * FROM quality_checks').all() as Array<{
      passed: number
      task_type: string
    }>
    expect(rows).toHaveLength(1)
    expect(rows[0]!.passed).toBe(1)
    expect(rows[0]!.task_type).toBe('team:team-task-sugg-abc123')

    // Events: started + verdict(passed=true)
    const started = eventLog.since(0).filter((e) => e.event_type === 'quality_gate_started')
    const verdicts = eventLog.since(0).filter((e) => e.event_type === 'quality_gate_verdict')
    expect(started).toHaveLength(1)
    expect(verdicts).toHaveLength(1)
    const vp = JSON.parse(verdicts[0]!.payload as string)
    expect(vp.passed).toBe(true)
    expect(vp.branch).toBe(verdict.branch)
  })

  it('FAIL path (test failure): removes worktree, deletes branch, records negative memory, rejects suggestion', async () => {
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(testDb.db, dispatcher)
    const sugg = makeSuggestion('abc123')
    const store = makeFakeSuggestionStore(sugg)
    const neg = makeNegStoreStub()

    const script = runScript({
      'git worktree add': ok(),
      'git apply': ok(),
      'npm test': fail('1 test failed\nFAIL src/foo.test.ts'),
      'npm run lint': ok(),
      'git worktree remove': ok(),
      'git branch -D': ok(),
    })

    const arbiter = createQualityGateArbiter({
      db: testDb.db,
      eventLog,
      dispatcher,
      projectRoot: tmpRoot,
      suggestionStore: store,
      negativeMemoryStore: neg.store,
      runCommand: script.fn,
      worktreeBase: tmpRoot,
    })

    const verdict = await arbiter.handleTeamCompletion(makeCompletion())
    arbiter.stop()

    expect(verdict.passed).toBe(false)
    expect(verdict.reason).toBe('tests-failed')
    expect(verdict.findings).toContain('npm test failed')
    expect(verdict.branch).toBeNull()

    // Worktree removed with --force AND branch deleted
    expect(script.calls.some((c) => c.cmd.includes('git worktree remove --force'))).toBe(true)
    expect(script.calls.some((c) => c.cmd.includes('git branch -D'))).toBe(true)

    // Negative memory recorded
    expect(neg.stored.length).toBe(1)
    expect(neg.stored[0]!.dontRule).toContain('Quality gate rejected team')

    // Phase 10f (T142/FR-056): a failing gate is a BUILD failure, not a human refusal. It must not
    // reach `updateStatus` at all — the old `updateStatus(id, 'rejected', 'qg-fail:tests-failed')`
    // here is the exact write that turned John's approval of 65a914f4 into a recorded rejection.
    expect(store.updates).toHaveLength(0)
    expect(store.gateFailures[0]).toMatchObject({
      id: 'abc123',
      reason: 'qg-fail:tests-failed',
      attemptCount: 1,
      // First failure of five: back to `approved` so the brain's retry loop re-lists it.
      status: 'approved',
    })

    // Persisted row says passed=0
    const rows = testDb.db.prepare('SELECT passed FROM quality_checks').all() as Array<{
      passed: number
    }>
    expect(rows).toHaveLength(1)
    expect(rows[0]!.passed).toBe(0)
  })

  it('FAIL path (lint-only): reason=lint-failed, tests passed', async () => {
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(testDb.db, dispatcher)
    const script = runScript({
      'git worktree add': ok(),
      'git apply': ok(),
      'npm test': ok('OK'),
      'npm run lint': fail('eslint found 3 errors', 2),
      'git worktree remove': ok(),
      'git branch -D': ok(),
    })
    const arbiter = createQualityGateArbiter({
      db: testDb.db,
      eventLog,
      dispatcher,
      projectRoot: tmpRoot,
      runCommand: script.fn,
      worktreeBase: tmpRoot,
    })
    const verdict = await arbiter.handleTeamCompletion(makeCompletion())
    arbiter.stop()

    expect(verdict.passed).toBe(false)
    expect(verdict.reason).toBe('lint-failed')
    expect(verdict.findings).toContain('npm run lint failed')
  })

  it('FAIL path (rubric-only): test and lint clean, but rubric finds TODO:fix in output', async () => {
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(testDb.db, dispatcher)
    const script = runScript({
      'git worktree add': ok(),
      'git apply': ok(),
      // Rubric "no-unresolved" pattern trips on TODO:\s*fix
      'npm test': ok('tests green TODO: fix later'),
      'npm run lint': ok('clean'),
      'git worktree remove': ok(),
      'git branch -D': ok(),
    })
    const arbiter = createQualityGateArbiter({
      db: testDb.db,
      eventLog,
      dispatcher,
      projectRoot: tmpRoot,
      runCommand: script.fn,
      worktreeBase: tmpRoot,
    })
    const verdict = await arbiter.handleTeamCompletion(makeCompletion())
    arbiter.stop()

    expect(verdict.passed).toBe(false)
    expect(verdict.reason).toBe('rubric-failed')
    expect(verdict.findings.some((f) => f.toLowerCase().includes('unresolved'))).toBe(true)
  })

  it('empty-diff short-circuits to no-diff verdict without touching git', async () => {
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(testDb.db, dispatcher)
    const script = runScript({})
    const store = makeFakeSuggestionStore(makeSuggestion('abc123'))
    const arbiter = createQualityGateArbiter({
      db: testDb.db,
      eventLog,
      dispatcher,
      projectRoot: tmpRoot,
      runCommand: script.fn,
      worktreeBase: tmpRoot,
      suggestionStore: store,
    })
    const verdict = await arbiter.handleTeamCompletion(makeCompletion({ stagedDiff: '   \n  ' }))
    arbiter.stop()
    expect(verdict.passed).toBe(false)
    expect(verdict.reason).toBe('no-diff')
    expect(script.calls).toHaveLength(0)
    // no-diff is still a gate failure, and still not a rejection (FR-056).
    expect(store.updates).toHaveLength(0)
    expect(store.gateFailures[0]).toMatchObject({
      status: 'approved',
      reason: 'qg-fail:no-diff',
      attemptCount: 1,
    })
  })

  it('subscribes to team_completed events via dispatcher and invokes the handler', async () => {
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(testDb.db, dispatcher)
    const script = runScript({
      'git worktree add': ok(),
      'git apply': ok(),
      'npm test': ok(),
      'npm run lint': ok(),
      'git add': ok(),
      'git -c user.name=scns-auto': ok(),
      'git worktree remove': ok(),
    })
    const arbiter = createQualityGateArbiter({
      db: testDb.db,
      eventLog,
      dispatcher,
      projectRoot: tmpRoot,
      runCommand: script.fn,
      worktreeBase: tmpRoot,
    })

    // Simulate a team_completed event emission.
    eventLog.teamCompleted(null, makeCompletion() as unknown as Record<string, unknown>)
    // handler is async; wait a tick
    await new Promise((r) => setTimeout(r, 20))
    arbiter.stop()

    const starts = eventLog.since(0).filter((e) => e.event_type === 'quality_gate_started')
    expect(starts).toHaveLength(1)
  })

  it('real git worktree round-trip: arbiter creates, commits, removes; branch persists', { timeout: 60_000 }, async () => {
    // This test uses real git against a temp repo to prove the arbiter's
    // non-mocked git sequence actually produces a branch.
    const repoDir = mkdtempSync(join(tmpdir(), 'qg-realrepo-'))
    try {
      const { execSync } = await import('node:child_process')
      execSync('git init -q -b main', { cwd: repoDir })
      execSync('git -c user.email=t@t -c user.name=t commit --allow-empty -m init', {
        cwd: repoDir,
      })
      mkdirSync(join(repoDir, 'a'), { recursive: true })
      writeFileSync(join(repoDir, 'a', 'f.txt'), 'hello\n')
      execSync('git add -A && git -c user.email=t@t -c user.name=t commit -q -m seed', {
        cwd: repoDir,
      })

      // Build a diff that adds a second line to the file.
      writeFileSync(join(repoDir, 'a', 'f.txt'), 'hello\nworld\n')
      const diff = execSync('git diff', { cwd: repoDir, encoding: 'utf8' })
      execSync('git checkout -- .', { cwd: repoDir })

      const dispatcher = createEventDispatcher()
      const eventLog = createEventLog(testDb.db, dispatcher)
      // Real run: no test/lint (skipCommands).
      const arbiter = createQualityGateArbiter({
        db: testDb.db,
        eventLog,
        dispatcher,
        projectRoot: repoDir,
        worktreeBase: tmpRoot,
        skipCommands: true,
      })
      const verdict = await arbiter.handleTeamCompletion(makeCompletion({ stagedDiff: diff }))
      arbiter.stop()

      expect(verdict.passed).toBe(true)
      expect(verdict.branch).toMatch(/^scns\/auto\//)

      // Branch exists in repo
      const branches = execSync('git branch --list "scns/auto/*"', {
        cwd: repoDir,
        encoding: 'utf8',
      })
      expect(branches.trim()).toContain('scns/auto/')

      // Commit on that branch contains our change
      const sha = execSync(`git rev-parse ${verdict.branch}`, {
        cwd: repoDir,
        encoding: 'utf8',
      }).trim()
      const show = execSync(`git show --stat ${sha}`, {
        cwd: repoDir,
        encoding: 'utf8',
      })
      expect(show).toContain('a/f.txt')
      expect(show).toContain('Co-authored-by: Copilot')
    } finally {
      rmSync(repoDir, { recursive: true, force: true })
    }
  })

  it('13.12.20 Path A: resolves sourceSuggestionId via findByInflightTeamId when prefix misses', async () => {
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(testDb.db, dispatcher)
    // Brain-spawn Path A uses `team-sugg-<short>` (no `team-task-sugg-`
    // prefix), so the legacy prefix extractor returns null and the
    // reverse-lookup path must kick in.
    const suggestionId = 'path-a-uuid-v4-12345678'
    const teamId = 'team-sugg-path-a01'
    const sugg = makeSuggestion(suggestionId, {
      status: 'in-progress',
      inflightTeamId: teamId,
    })
    const baseStore = makeFakeSuggestionStore(sugg)
    const store: QualityGateSuggestionStore & typeof baseStore = {
      ...baseStore,
      findByInflightTeamId: (tid: string) => (tid === teamId ? sugg : null),
    }
    const executor = makeFakeExecutor()
    const wrappedScript = runScript({
      'git worktree add': ok(),
      'git apply': ok(),
      'npm test': ok(),
      'npm run lint': ok(),
      'git add': ok(),
      'git -c user.name=scns-auto': ok('commit ok'),
      'git worktree remove': ok(),
    })

    const arbiter = createQualityGateArbiter({
      db: testDb.db,
      eventLog,
      dispatcher,
      projectRoot: tmpRoot,
      suggestionStore: store,
      executor,
      runCommand: wrappedScript.fn,
      worktreeBase: tmpRoot,
    })

    const verdict = await arbiter.handleTeamCompletion(makeCompletion({ teamId }))
    arbiter.stop()

    expect(verdict.sourceSuggestionId).toBe(suggestionId)
    expect(verdict.passed).toBe(true)
    expect(store.updates).toHaveLength(1)
    expect(store.updates[0]).toMatchObject({
      id: suggestionId,
      status: 'implemented',
      reason: 'qg-pass',
    })
  })

  // ── Phase 13.12.24 — baseline-lint-diff gate ──────────────────────

  describe('baseline-lint-diff gate', () => {
    const baselineJson = (errs: Array<[string, number]>) =>
      JSON.stringify(errs.map(([filePath, errorCount]) => ({ filePath, errorCount })))

    function makeRun(
      baselineLint: string,
      baselineTest: RunResult,
      postLint: string | RunResult,
      postTest: RunResult,
    ): {
      fn: (cmd: string, cwd: string) => RunResult
      calls: Array<{ cmd: string; cwd: string }>
    } {
      const calls: Array<{ cmd: string; cwd: string }> = []
      const postLintResult: RunResult =
        typeof postLint === 'string'
          ? { ok: false, stdout: postLint, stderr: '', code: 1 }
          : postLint
      // Baseline commands run against `projectRoot`; post commands run
      // inside `worktreePath` which is a subdir of `projectRoot`.
      // We disambiguate by matching cwd string equality with projectRoot.
      return {
        calls,
        fn: (cmd, cwd) => {
          calls.push({ cmd, cwd })
          // Normalize separators: on win32 the arbiter passes a `\`-joined
          // worktree cwd, and a bare '/wt' probe misread every post-phase
          // command as baseline (post == baseline ⇒ false PASS verdicts).
          const isBaseline = !cwd.replaceAll('\\', '/').includes('/wt')
          if (cmd.includes('git rev-parse HEAD')) return ok('abc123deadbeef\n')
          if (cmd.includes('npm run lint')) {
            return isBaseline
              ? { ok: false, stdout: baselineLint, stderr: '', code: 1 }
              : postLintResult
          }
          if (cmd.includes('npm test')) return isBaseline ? baselineTest : postTest
          if (cmd.includes('git worktree add')) {
            // npm-project fixture shape (G2 non-npm probe reads the worktree).
            const m = cmd.match(/git worktree add -b \S+ "([^"]+)" HEAD/)
            if (m) {
              mkdirSync(m[1], { recursive: true })
              writeFileSync(join(m[1], 'package.json'), '{"name":"fixture","version":"0.0.0"}')
            }
            return ok()
          }
          if (cmd.includes('git worktree remove')) return ok()
          if (cmd.includes('git apply')) return ok()
          if (cmd.includes('git add')) return ok()
          if (cmd.startsWith('git -c user.name=scns-auto')) return ok('commit ok')
          if (cmd.includes('git branch -D')) return ok()
          return ok()
        },
      }
    }

    it('post-lint equal to baseline → PASS (no new errors)', async () => {
      const dispatcher = createEventDispatcher()
      const eventLog = createEventLog(testDb.db, dispatcher)
      const baseErrs = baselineJson([
        ['/repo/a.ts', 3],
        ['/repo/b.ts', 2],
      ])
      // Post has same 5 total errors: lint exits non-zero but the diff
      // introduces nothing new, so QG should PASS.
      const r = makeRun(baseErrs, ok('tests green'), baseErrs, ok('tests green'))
      const arbiter = createQualityGateArbiter({
        db: testDb.db,
        eventLog,
        dispatcher,
        projectRoot: tmpRoot,
        runCommand: r.fn,
        worktreeBase: tmpRoot,
        baselineLintEnabled: true,
        baselineTestsEnabled: true,
      })
      const verdict = await arbiter.handleTeamCompletion(makeCompletion())
      arbiter.stop()
      expect(verdict.passed).toBe(true)
      // Phase 13.12.27: baselines active + both diffs zero → reason is
      // now 'baseline-clean' (previously 'ok'). Either is PASS.
      expect(verdict.reason).toBe('baseline-clean')
    })

    it('post-lint introduces a new error in a new file → FAIL with regression finding', async () => {
      const dispatcher = createEventDispatcher()
      const eventLog = createEventLog(testDb.db, dispatcher)
      const baseErrs = baselineJson([['/repo/a.ts', 3]])
      const postErrs = baselineJson([
        ['/repo/a.ts', 3],
        ['/repo/new.ts', 2],
      ])
      const r = makeRun(baseErrs, ok('tests green'), postErrs, ok('tests green'))
      const arbiter = createQualityGateArbiter({
        db: testDb.db,
        eventLog,
        dispatcher,
        projectRoot: tmpRoot,
        runCommand: r.fn,
        worktreeBase: tmpRoot,
        baselineLintEnabled: true,
        baselineTestsEnabled: true,
      })
      const verdict = await arbiter.handleTeamCompletion(makeCompletion())
      arbiter.stop()
      expect(verdict.passed).toBe(false)
      expect(verdict.reason).toBe('lint-failed')
      expect(
        verdict.findings.some((f) => f.includes('Lint regressed') && f.includes('new.ts')),
      ).toBe(true)
    })

    it('post-lint has fewer errors than baseline → PASS (improvement)', async () => {
      const dispatcher = createEventDispatcher()
      const eventLog = createEventLog(testDb.db, dispatcher)
      const baseErrs = baselineJson([['/repo/a.ts', 5]])
      const postErrs = baselineJson([['/repo/a.ts', 2]])
      const r = makeRun(baseErrs, ok('tests green'), postErrs, ok('tests green'))
      const arbiter = createQualityGateArbiter({
        db: testDb.db,
        eventLog,
        dispatcher,
        projectRoot: tmpRoot,
        runCommand: r.fn,
        worktreeBase: tmpRoot,
        baselineLintEnabled: true,
        baselineTestsEnabled: true,
      })
      const verdict = await arbiter.handleTeamCompletion(makeCompletion())
      arbiter.stop()
      expect(verdict.passed).toBe(true)
    })

    it('tests gate: post failures equal baseline → PASS (no new failures)', async () => {
      const dispatcher = createEventDispatcher()
      const eventLog = createEventLog(testDb.db, dispatcher)
      const baselineTestOut = fail('FAIL dashboard/old.test.ts\n  some assertion')
      const postTestOut = fail('FAIL dashboard/old.test.ts\n  some assertion')
      const cleanLint = baselineJson([])
      const r = makeRun(cleanLint, baselineTestOut, cleanLint, postTestOut)
      const arbiter = createQualityGateArbiter({
        db: testDb.db,
        eventLog,
        dispatcher,
        projectRoot: tmpRoot,
        runCommand: r.fn,
        worktreeBase: tmpRoot,
        baselineLintEnabled: true,
        baselineTestsEnabled: true,
      })
      const verdict = await arbiter.handleTeamCompletion(makeCompletion())
      arbiter.stop()
      expect(verdict.passed).toBe(true)
    })

    // ── Phase 13.12.34 — GATE-LEVEL proof of the ANSI/prose phantom-failure fix.
    // The parseFailingTests unit tests prove the parser in isolation; this drives
    // the FULL arbiter pipeline (baseline run → candidate run → subtractSets →
    // verdict) with the EXACT production failure shape: the vitest FAIL badge
    // whose reset code `\x1b[22m\x1b[49m` sits between "FAIL " and the file path,
    // plus run-to-run-varying error prose ("should FAIL here" vs "should FAIL
    // with extra prose markers"). The SAME test FILE fails in baseline AND
    // candidate, so the gate must PASS. With the pre-13.12.34 parser this verdict
    // was a FALSE `tests-failed` (newFailingTests=["with"]); prod team 1fe872c4
    // hit it 6× on 2026-06-26, blocking the loop before the rubric/behavioral
    // branch. Unlike the plain-text test above (identical strings — passes even
    // with the buggy parser), this only PASSES once ANSI is stripped and the
    // capture is anchored on the real .test.ts path.
    it('tests gate: same file fails in baseline AND candidate with differing ANSI badge + prose → PASS (no phantom tests-failed)', async () => {
      const dispatcher = createEventDispatcher()
      const eventLog = createEventLog(testDb.db, dispatcher)
      const badge =
        '\u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m test/unit/foo.test.ts\u001b[2m > suite > name\u001b[22m'
      // Same failing FILE in both runs; only the ANSI-decorated prose differs
      // run-to-run (exactly the documented flake across baseline/candidate).
      const baselineTestOut = fail([badge, 'Error: should FAIL here'].join('\n'))
      const postTestOut = fail([badge, 'Error: should FAIL with extra prose markers'].join('\n'))
      const cleanLint = baselineJson([])
      const r = makeRun(cleanLint, baselineTestOut, cleanLint, postTestOut)
      const arbiter = createQualityGateArbiter({
        db: testDb.db,
        eventLog,
        dispatcher,
        projectRoot: tmpRoot,
        runCommand: r.fn,
        worktreeBase: tmpRoot,
        baselineLintEnabled: true,
        baselineTestsEnabled: true,
      })
      const verdict = await arbiter.handleTeamCompletion(makeCompletion())
      arbiter.stop()
      // The gate must NOT reject: zero NEW failing files ⇒ PASS (baseline-clean).
      expect(verdict.reason).not.toBe('tests-failed')
      expect(verdict.passed).toBe(true)
      // …and it must not leak a phantom "Tests regressed" finding naming a reset
      // code or a bare prose word.
      expect(verdict.findings.some((f) => f.includes('Tests regressed'))).toBe(false)
      // The persisted quality_checks row records the PASS.
      const rows = testDb.db.prepare('SELECT passed FROM quality_checks').all() as Array<{
        passed: number
      }>
      expect(rows).toHaveLength(1)
      expect(rows[0]!.passed).toBe(1)
    })

    it('tests gate: post introduces NEW failing file → FAIL with regression name', async () => {
      const dispatcher = createEventDispatcher()
      const eventLog = createEventLog(testDb.db, dispatcher)
      const baselineTestOut = fail('FAIL dashboard/old.test.ts\n')
      const postTestOut = fail('FAIL dashboard/old.test.ts\nFAIL src/fresh.test.ts\n')
      const cleanLint = baselineJson([])
      const r = makeRun(cleanLint, baselineTestOut, cleanLint, postTestOut)
      const arbiter = createQualityGateArbiter({
        db: testDb.db,
        eventLog,
        dispatcher,
        projectRoot: tmpRoot,
        runCommand: r.fn,
        worktreeBase: tmpRoot,
        baselineLintEnabled: true,
        baselineTestsEnabled: true,
      })
      const verdict = await arbiter.handleTeamCompletion(makeCompletion())
      arbiter.stop()
      expect(verdict.passed).toBe(false)
      expect(verdict.reason).toBe('tests-failed')
      expect(
        verdict.findings.some((f) => f.includes('Tests regressed') && f.includes('fresh.test.ts')),
      ).toBe(true)
    })

    it('disabled flags → legacy absolute-zero behavior (baseline errors cause FAIL)', async () => {
      const dispatcher = createEventDispatcher()
      const eventLog = createEventLog(testDb.db, dispatcher)
      const baseErrs = baselineJson([['/repo/a.ts', 3]])
      // Even though baseline==post (no new errors), with the gate
      // disabled we fall back to "lint exit != 0 → FAIL".
      const r = makeRun(baseErrs, ok(), baseErrs, ok())
      const arbiter = createQualityGateArbiter({
        db: testDb.db,
        eventLog,
        dispatcher,
        projectRoot: tmpRoot,
        runCommand: r.fn,
        worktreeBase: tmpRoot,
        baselineLintEnabled: false,
        baselineTestsEnabled: false,
      })
      const verdict = await arbiter.handleTeamCompletion(makeCompletion())
      arbiter.stop()
      expect(verdict.passed).toBe(false)
      expect(verdict.reason).toBe('lint-failed')
    })

    // ── Phase 13.12.27 — literal-findings false-FAIL regression ─────
    it('13.12.27 — baselines active + both diffs zero → PASS with reason baseline-clean (no "npm test failed" / "npm run lint failed" literals)', async () => {
      const dispatcher = createEventDispatcher()
      const eventLog = createEventLog(testDb.db, dispatcher)
      // Baseline lint has 12 errors; post has 0. newLintErrors = 0.
      const baseErrs = baselineJson([['/repo/a.ts', 12]])
      const postErrs = baselineJson([])
      // Both test runs exit non-zero but emit no parseable FAIL lines
      // (crash-shape — exactly the 9872e17a scenario). Arbiter's legacy
      // "postFailingTests.size === 0 && !testRes.ok" branch used to flip
      // testFailed=true even though newFailingTests was empty, leaking
      // the literal "npm test failed" into findings.
      const r = makeRun(baseErrs, fail('crash'), postErrs, fail('another crash'))
      const arbiter = createQualityGateArbiter({
        db: testDb.db,
        eventLog,
        dispatcher,
        projectRoot: tmpRoot,
        runCommand: r.fn,
        worktreeBase: tmpRoot,
        baselineLintEnabled: true,
        baselineTestsEnabled: true,
      })
      const verdict = await arbiter.handleTeamCompletion(makeCompletion())
      arbiter.stop()
      expect(verdict.passed).toBe(true)
      expect(verdict.reason).toBe('baseline-clean')
      expect(verdict.findings).not.toContain('npm test failed')
      expect(verdict.findings).not.toContain('npm run lint failed')
    })

    it('13.12.27 — baselines active + newLintErrors > 0 → still FAIL (no false PASS)', async () => {
      const dispatcher = createEventDispatcher()
      const eventLog = createEventLog(testDb.db, dispatcher)
      const baseErrs = baselineJson([['/repo/a.ts', 3]])
      const postErrs = baselineJson([
        ['/repo/a.ts', 3],
        ['/repo/new.ts', 5],
      ])
      const r = makeRun(baseErrs, ok('tests green'), postErrs, ok('tests green'))
      const arbiter = createQualityGateArbiter({
        db: testDb.db,
        eventLog,
        dispatcher,
        projectRoot: tmpRoot,
        runCommand: r.fn,
        worktreeBase: tmpRoot,
        baselineLintEnabled: true,
        baselineTestsEnabled: true,
      })
      const verdict = await arbiter.handleTeamCompletion(makeCompletion())
      arbiter.stop()
      expect(verdict.passed).toBe(false)
      expect(verdict.reason).toBe('lint-failed')
      expect(
        verdict.findings.some((f) => f.includes('Lint regressed') && f.includes('new.ts')),
      ).toBe(true)
    })

    it('13.12.27 — baselines disabled → legacy exit-code gate unchanged (regression guard)', async () => {
      const dispatcher = createEventDispatcher()
      const eventLog = createEventLog(testDb.db, dispatcher)
      const baseErrs = baselineJson([['/repo/a.ts', 3]])
      // Even with diff-clean-looking inputs, with baseline flags OFF the
      // legacy "exit != 0 → FAIL" behavior must be preserved.
      const r = makeRun(baseErrs, fail('crash'), baseErrs, fail('crash'))
      const arbiter = createQualityGateArbiter({
        db: testDb.db,
        eventLog,
        dispatcher,
        projectRoot: tmpRoot,
        runCommand: r.fn,
        worktreeBase: tmpRoot,
        baselineLintEnabled: false,
        baselineTestsEnabled: false,
      })
      const verdict = await arbiter.handleTeamCompletion(makeCompletion())
      arbiter.stop()
      expect(verdict.passed).toBe(false)
      // Legacy behavior: reason is 'tests-failed' or 'lint-failed', NOT
      // 'baseline-clean'. Literals allowed to flow.
      expect(verdict.reason).not.toBe('baseline-clean')
    })

    // ── Test/lint floor: tooling-missing must NEVER PASS ───────────
    // Regression for the scenario captured in quality_check
    // 5ebeadae-3e46-4fc3-b5ef-251e4948a0fc: worktree-side `npm test` and
    // `npm run lint` both exited 127 ("vitest: command not found",
    // "eslint: command not found"), baselines were parseable (projectRoot
    // had its tools), and the baselineClean override clobbered the
    // legitimate test/lint floor failures into PASS=true score=1.0.
    //
    // The floor must be absolute: if the worktree-side command was
    // missing (exit 127 / 126 / ENOENT / "command not found"), QG must
    // FAIL regardless of baseline diff.
    it('test/lint floor: post-side exit 127 (command not found) → FAIL even with baselines clean', async () => {
      const dispatcher = createEventDispatcher()
      const eventLog = createEventLog(testDb.db, dispatcher)
      // Baseline lint parses cleanly (projectRoot has tools). Post-side
      // lint and test exit 127 with the canonical "command not found"
      // shell error — no FAIL lines, no parseable JSON. Pre-fix this
      // satisfied baselineClean (newLintErrors=0, newFailingTests=0)
      // and silently produced PASS.
      const baseErrs = baselineJson([])
      const commandNotFound = (bin: string): RunResult => ({
        ok: false,
        stdout: '',
        stderr: `sh: ${bin}: command not found`,
        code: 127,
      })
      const r = makeRun(
        baseErrs,
        ok('tests green'),
        commandNotFound('eslint'),
        commandNotFound('vitest'),
      )
      const arbiter = createQualityGateArbiter({
        db: testDb.db,
        eventLog,
        dispatcher,
        projectRoot: tmpRoot,
        runCommand: r.fn,
        worktreeBase: tmpRoot,
        baselineLintEnabled: true,
        baselineTestsEnabled: true,
      })
      const verdict = await arbiter.handleTeamCompletion(makeCompletion())
      arbiter.stop()
      expect(verdict.passed).toBe(false)
      // Must NOT mask the failure as baseline-clean.
      expect(verdict.reason).not.toBe('baseline-clean')
      // Reason should indicate test/lint floor violation.
      expect(['tests-failed', 'lint-failed', 'tooling-missing']).toContain(verdict.reason)
      // Persisted quality_check row must reflect FAIL (passed=0).
      const rows = testDb.db.prepare('SELECT passed, score FROM quality_checks').all() as Array<{
        passed: number
        score: number
      }>
      expect(rows).toHaveLength(1)
      expect(rows[0]!.passed).toBe(0)
    })

    it('test/lint floor: exit 127 (canonical "command not found") still → FAIL', async () => {
      // Phase 13.12.30 — narrowed `isCommandMissing` to exit codes
      // 126/127 only. The previous behavior (also matching the substring
      // "command not found" in stdout+stderr at any non-zero exit) was
      // removed because it produced false positives whenever vitest
      // dumped fixture text containing those strings — see postmortem
      // qc=4f7e7f48 and the dedicated regression suite in
      // `quality-gate-arbiter.iscommandmissing.test.ts`. POSIX shells
      // unconditionally set 127 for "command not found", so the exit
      // code is sufficient signal in practice. A shell that masks 127
      // into 1 will produce a "tests-failed" / "lint-failed" verdict
      // (still actionable, with the real stderr surfaced in findings)
      // instead of the false-positive that this test originally guarded.
      const dispatcher = createEventDispatcher()
      const eventLog = createEventLog(testDb.db, dispatcher)
      const baseErrs = baselineJson([])
      const cmdNotFoundExit127: RunResult = {
        ok: false,
        stdout: '',
        stderr: 'bash: line 1: vitest: command not found',
        code: 127,
      }
      const r = makeRun(baseErrs, ok('tests green'), cmdNotFoundExit127, cmdNotFoundExit127)
      const arbiter = createQualityGateArbiter({
        db: testDb.db,
        eventLog,
        dispatcher,
        projectRoot: tmpRoot,
        runCommand: r.fn,
        worktreeBase: tmpRoot,
        baselineLintEnabled: true,
        baselineTestsEnabled: true,
      })
      const verdict = await arbiter.handleTeamCompletion(makeCompletion())
      arbiter.stop()
      expect(verdict.passed).toBe(false)
      expect(verdict.reason).toBe('tooling-missing')
    })

    it('baseline JSON unparseable → falls back to legacy exit-code gate', async () => {
      const dispatcher = createEventDispatcher()
      const eventLog = createEventLog(testDb.db, dispatcher)
      // Garbage output — parseEslintJson returns parsed:false; the gate
      // cannot downgrade and must honor lint exit code.
      const r = makeRun('not json at all', ok(), 'still not json', ok())
      const arbiter = createQualityGateArbiter({
        db: testDb.db,
        eventLog,
        dispatcher,
        projectRoot: tmpRoot,
        runCommand: r.fn,
        worktreeBase: tmpRoot,
        baselineLintEnabled: true,
        baselineTestsEnabled: true,
      })
      const verdict = await arbiter.handleTeamCompletion(makeCompletion())
      arbiter.stop()
      expect(verdict.passed).toBe(false)
      expect(verdict.reason).toBe('lint-failed')
    })
  })

  describe('parseEslintJson helper', () => {
    it('sums errorCount across files and skips zero-error entries', async () => {
      const { parseEslintJson } =
        await import('../../../../src/broker/services/quality-gate-arbiter.js')
      const out = parseEslintJson(
        JSON.stringify([
          { filePath: '/a', errorCount: 2 },
          { filePath: '/b', errorCount: 0 },
          { filePath: '/c', errorCount: 3 },
        ]),
      )
      expect(out.parsed).toBe(true)
      expect(out.total).toBe(5)
      expect(out.byFile).toEqual({ '/a': 2, '/c': 3 })
    })

    it('returns unparsed stats on bad input', async () => {
      const { parseEslintJson } =
        await import('../../../../src/broker/services/quality-gate-arbiter.js')
      expect(parseEslintJson('').parsed).toBe(false)
      expect(parseEslintJson('garbage').parsed).toBe(false)
      expect(parseEslintJson('[not json]').parsed).toBe(false)
    })

    it('tolerates npm prelude noise around the JSON array', async () => {
      const { parseEslintJson } =
        await import('../../../../src/broker/services/quality-gate-arbiter.js')
      const out = parseEslintJson(
        '> scns@0 lint\n> eslint .\n' +
          JSON.stringify([{ filePath: '/a', errorCount: 1 }]) +
          '\nnpm exit 1',
      )
      expect(out.parsed).toBe(true)
      expect(out.total).toBe(1)
    })
  })

  describe('parseFailingTests helper', () => {
    it('extracts file paths after FAIL markers', async () => {
      const { parseFailingTests } =
        await import('../../../../src/broker/services/quality-gate-arbiter.js')
      const out = parseFailingTests(
        [
          'PASS src/a.test.ts',
          'FAIL src/b.test.ts',
          ' ❯ FAIL src/c.test.ts ',
          'note: FAIL src/d.test.ts:',
        ].join('\n'),
      )
      expect(out.has('src/b.test.ts')).toBe(true)
      expect(out.has('src/c.test.ts')).toBe(true)
      expect(out.has('src/d.test.ts')).toBe(true)
      expect(out.has('src/a.test.ts')).toBe(false)
    })

    it('strips ANSI color codes before matching so the vitest FAIL badge yields the real file (not the reset code)', async () => {
      const { parseFailingTests } =
        await import('../../../../src/broker/services/quality-gate-arbiter.js')
      // Exact real vitest badge shape (reproduced 2026-06-28): the reset
      // sequence \x1b[22m\x1b[49m sits between "FAIL " and the file path.
      const out = parseFailingTests(
        '\u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m test/unit/foo.test.ts\u001b[2m > suite > name\u001b[22m',
      )
      expect(out.has('test/unit/foo.test.ts')).toBe(true)
      expect(out.has('\u001b[22m\u001b[49m')).toBe(false)
      expect(out.size).toBe(1)
    })

    it('ignores the word FAIL in error prose / dumped source (no phantom test names)', async () => {
      const { parseFailingTests } =
        await import('../../../../src/broker/services/quality-gate-arbiter.js')
      const out = parseFailingTests(
        [
          'Error: operation should FAIL with (no even special markers) present',
          "    // Mirrors a fixture: 'FAIL with (no even markers)'",
        ].join('\n'),
      )
      expect(out.size).toBe(0)
    })

    it('reports NO new failures when the same file fails in baseline and candidate with differing prose (the false-positive that blocked the loop)', async () => {
      const { parseFailingTests } =
        await import('../../../../src/broker/services/quality-gate-arbiter.js')
      const badge =
        '\u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m test/unit/foo.test.ts\u001b[2m > x'
      const baseline = parseFailingTests([badge, 'Error: should FAIL here'].join('\n'))
      const candidate = parseFailingTests(
        [badge, 'Error: should FAIL with extra prose markers'].join('\n'),
      )
      const newFailures = [...candidate].filter((v) => !baseline.has(v))
      expect(baseline).toEqual(candidate)
      expect(newFailures).toEqual([])
    })

    it('still detects a genuinely new failing file in the candidate', async () => {
      const { parseFailingTests } =
        await import('../../../../src/broker/services/quality-gate-arbiter.js')
      const badge = (f: string) => `\u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m ${f}\u001b[2m > x`
      const baseline = parseFailingTests(badge('test/unit/a.test.ts'))
      const candidate = parseFailingTests(
        [badge('test/unit/a.test.ts'), badge('test/unit/b.test.ts')].join('\n'),
      )
      const newFailures = [...candidate].filter((v) => !baseline.has(v))
      expect(newFailures).toEqual(['test/unit/b.test.ts'])
    })

    it('returns empty set on empty input', async () => {
      const { parseFailingTests } =
        await import('../../../../src/broker/services/quality-gate-arbiter.js')
      expect(parseFailingTests('').size).toBe(0)
    })
  })
})
