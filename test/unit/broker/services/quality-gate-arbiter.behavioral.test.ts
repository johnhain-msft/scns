/**
 * Phase 1 wedge A — behavioral-improvement gate wired into the quality-gate
 * arbiter (additive, default-OFF).
 *
 * All git is mocked via an injected `runCommand` (NO real git) and all replay
 * backends are Mock / injected fakes (NO agent spawn). The gate is consulted ONLY
 * on the rubric-PASS branch, so it can only DOWNGRADE PASS→FAIL on a measured
 * regression — never upgrade FAIL→PASS.
 *
 *   T10 env-OFF (default) ⇒ verdict + event carry NO behavioral fields; PASS unchanged.
 *   T11 measure-only, symmetric Mock ⇒ additive behavioral fields, still PASS.
 *   T12 measure+enforce, symmetric Mock ⇒ still PASS (Mock can't veto).
 *   T13 measure+enforce, injected regressing candidate ⇒ PASS downgraded to FAIL.
 *   T14 measure+enforce, injected improving candidate ⇒ PASS preserved.
 *   T15 enforce on but the rubric already FAILs ⇒ gate never runs (no upgrade).
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
import type { ReplayBackend } from '../../../../src/selfopt/replay.js'
import type { RuleCheck, TaskRecord } from '../../../../src/selfopt/types.js'

function ok(stdout = '', stderr = ''): RunResult {
  return { ok: true, stdout, stderr }
}

const env = (o: Record<string, string>): NodeJS.ProcessEnv => o as NodeJS.ProcessEnv

function makeProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'qg-behavioral-proj-'))
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
  overrides: Partial<{ build: RunResult; test: RunResult; lint: RunResult }> = {},
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
    return ok()
  }
}

function baseCompletion(): TeamCompletionData {
  return {
    teamId: 'team-behavioral-a',
    memberSessionIds: ['s1'],
    stagedDiff:
      'diff --git a/foo.md b/foo.md\n--- a/foo.md\n+++ b/foo.md\n@@ -1 +1,2 @@\n line\n+new\n',
    artifacts: [],
    logs: [],
    aggregateOutcome: 'success',
    completedAt: new Date().toISOString(),
  }
}

function ruleTask(id: string, intent: string, checks: RuleCheck[]): TaskRecord {
  return {
    id,
    project: 'scns',
    intent,
    contextExcerpt: '',
    attemptedSolution: '',
    outcome: 'mixed',
    referenceKind: 'rule',
    reference: '',
    recordedScore: null,
    judge: { kind: 'rule', checks },
    tags: ['behavioral'],
    sourceSessions: [],
    split: 'val',
    origin: 'real',
    derivedFrom: '',
  }
}

class FixedBackend implements ReplayBackend {
  readonly seen: string[] = []
  constructor(private readonly response: string) {}
  attempt(task: TaskRecord): string {
    this.seen.push(task.id)
    return this.response
  }
}

const VERIFY_TASKS: readonly TaskRecord[] = [
  ruleTask('t', 'do the thing', [{ op: 'contains', arg: 'verify' }]),
]

function lastVerdictEvent(eventLog: ReturnType<typeof createEventLog>): Record<string, unknown> {
  const evts = eventLog.since(0).filter((e) => e.event_type === 'quality_gate_verdict')
  return JSON.parse(evts[evts.length - 1]!.payload) as Record<string, unknown>
}

describe('QualityGateArbiter — behavioral-improvement gate (wedge A)', () => {
  let testDb: TestDb
  let tmpRoot: string
  let projectRoot: string

  beforeEach(() => {
    testDb = createBrokerTestDb()
    tmpRoot = mkdtempSync(join(tmpdir(), 'qg-behavioral-wt-'))
    projectRoot = makeProjectRoot()
  })
  afterEach(() => {
    testDb.close()
    if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true })
    if (existsSync(projectRoot)) rmSync(projectRoot, { recursive: true, force: true })
  })

  // T10 — default-OFF: no behavioral fields anywhere; PASS unchanged.
  it('T10: env-OFF ⇒ verdict + event carry no behavioral fields, still PASS', async () => {
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
      behavioralGate: { env: env({}) },
    })
    const verdict = await arbiter.handleTeamCompletion(baseCompletion())
    arbiter.stop()

    expect(verdict.passed).toBe(true)
    expect(verdict.behavioral).toBeUndefined()
    const evt = lastVerdictEvent(eventLog)
    expect('behavioralRan' in evt).toBe(false)
    expect('behavioralDelta' in evt).toBe(false)
    // commit happened (PASS path completed)
    expect(recorded.cmds.some((c) => c.startsWith('git -c user.name=scns-auto'))).toBe(true)
  })

  // T11 — measure-only, symmetric Mock ⇒ additive fields, still PASS.
  it('T11: measure-only symmetric Mock ⇒ behavioral fields attached, delta 0, still PASS', async () => {
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
      behavioralGate: { env: env({ SCNS_QG_BEHAVIORAL_GATE: '1' }) },
    })
    const verdict = await arbiter.handleTeamCompletion(baseCompletion())
    arbiter.stop()

    expect(verdict.passed).toBe(true)
    expect(verdict.behavioral?.ran).toBe(true)
    expect(verdict.behavioral?.delta).toBe(0)
    expect(verdict.behavioral?.regressed).toBe(false)
    const evt = lastVerdictEvent(eventLog)
    expect(evt.behavioralRan).toBe(true)
    expect(evt.behavioralDelta).toBe(0)
    expect(evt.behavioralRegressed).toBe(false)
    expect(recorded.cmds.some((c) => c.startsWith('git -c user.name=scns-auto'))).toBe(true)
  })

  // T12 — measure+enforce, symmetric Mock ⇒ still PASS (Mock can't veto).
  it('T12: measure+enforce symmetric Mock ⇒ never vetoes, still PASS', async () => {
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
      behavioralGate: {
        env: env({ SCNS_QG_BEHAVIORAL_GATE: '1', SCNS_QG_BEHAVIORAL_ENFORCE: '1' }),
      },
    })
    const verdict = await arbiter.handleTeamCompletion(baseCompletion())
    arbiter.stop()

    expect(verdict.passed).toBe(true)
    expect(verdict.behavioral?.regressed).toBe(false)
    expect(recorded.cmds.some((c) => c.startsWith('git -c user.name=scns-auto'))).toBe(true)
  })

  // T13 — measure+enforce, injected regressing candidate ⇒ PASS downgraded to FAIL.
  it('T13: measure+enforce + regressing candidate ⇒ behavioral-regression FAIL, no commit', async () => {
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(testDb.db, dispatcher)
    const recorded: Recorded = { cmds: [] }
    const outcomes: Array<{ passed: boolean }> = []
    const arbiter = createQualityGateArbiter({
      db: testDb.db,
      eventLog,
      dispatcher,
      projectRoot,
      runCommand: makeRunCommand(recorded),
      worktreeBase: tmpRoot,
      onOutcome: (o) => outcomes.push({ passed: o.passed }),
      behavioralGate: {
        env: env({ SCNS_QG_BEHAVIORAL_GATE: '1', SCNS_QG_BEHAVIORAL_ENFORCE: '1' }),
        valTasks: VERIFY_TASKS,
        makeBaselineBackend: () => new FixedBackend('please verify it'),
        makeCandidateBackend: () => new FixedBackend('all done'),
      },
    })
    const verdict = await arbiter.handleTeamCompletion(baseCompletion())
    arbiter.stop()

    expect(verdict.passed).toBe(false)
    expect(verdict.reason).toBe('behavioral-regression')
    expect(verdict.branch).toBeNull()
    // commit must NOT have run; branch deleted via finishFail.
    expect(recorded.cmds.some((c) => c.startsWith('git -c user.name=scns-auto'))).toBe(false)
    expect(recorded.cmds.some((c) => c.startsWith('git branch -D'))).toBe(true)
    expect(outcomes).toEqual([{ passed: false }])
    const evt = lastVerdictEvent(eventLog)
    expect(evt.passed).toBe(false)
    expect(evt.reason).toBe('behavioral-regression')
  })

  // T14 — measure+enforce, injected improving candidate ⇒ PASS preserved.
  it('T14: measure+enforce + improving candidate ⇒ never a false veto, still PASS', async () => {
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
      behavioralGate: {
        env: env({ SCNS_QG_BEHAVIORAL_GATE: '1', SCNS_QG_BEHAVIORAL_ENFORCE: '1' }),
        valTasks: VERIFY_TASKS,
        makeBaselineBackend: () => new FixedBackend('all done'),
        makeCandidateBackend: () => new FixedBackend('please verify it'),
      },
    })
    const verdict = await arbiter.handleTeamCompletion(baseCompletion())
    arbiter.stop()

    expect(verdict.passed).toBe(true)
    expect(verdict.behavioral?.delta).toBe(1)
    expect(verdict.behavioral?.regressed).toBe(false)
    expect(recorded.cmds.some((c) => c.startsWith('git -c user.name=scns-auto'))).toBe(true)
  })

  // T15 — enforce on but the rubric already FAILs ⇒ gate never runs (no upgrade).
  it('T15: rubric FAIL ⇒ behavioral gate never runs, cannot upgrade FAIL→PASS', async () => {
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(testDb.db, dispatcher)
    const recorded: Recorded = { cmds: [] }
    const candidate = new FixedBackend('please verify it')
    const arbiter = createQualityGateArbiter({
      db: testDb.db,
      eventLog,
      dispatcher,
      projectRoot,
      runCommand: makeRunCommand(recorded, {
        build: { ok: false, stdout: '', stderr: 'TS2304: Cannot find name "foo"', code: 2 },
      }),
      worktreeBase: tmpRoot,
      behavioralGate: {
        env: env({ SCNS_QG_BEHAVIORAL_GATE: '1', SCNS_QG_BEHAVIORAL_ENFORCE: '1' }),
        valTasks: VERIFY_TASKS,
        makeCandidateBackend: () => candidate,
      },
    })
    const verdict = await arbiter.handleTeamCompletion(baseCompletion())
    arbiter.stop()

    expect(verdict.passed).toBe(false)
    expect(verdict.reason).toBe('build-failed')
    expect(verdict.behavioral).toBeUndefined()
    // the behavioral gate must not have been consulted on the FAIL path
    expect(candidate.seen).toEqual([])
  })

  // ── Production seam: makeBackends (per-completion pair + dispose lifecycle) ──

  // T16 — makeBackends regressing pair + enforce ⇒ veto AND dispose runs.
  it('T16: makeBackends regressing pair + enforce ⇒ behavioral-regression FAIL, dispose runs', async () => {
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(testDb.db, dispatcher)
    const recorded: Recorded = { cmds: [] }
    let disposed = 0
    let seen: { headCwd: string; candidateCwd: string } | null = null
    const arbiter = createQualityGateArbiter({
      db: testDb.db,
      eventLog,
      dispatcher,
      projectRoot,
      runCommand: makeRunCommand(recorded),
      worktreeBase: tmpRoot,
      behavioralGate: {
        env: env({ SCNS_QG_BEHAVIORAL_GATE: '1', SCNS_QG_BEHAVIORAL_ENFORCE: '1' }),
        valTasks: VERIFY_TASKS,
        makeBackends: (input) => {
          seen = input
          return {
            baseline: new FixedBackend('please verify it'),
            candidate: new FixedBackend('all done'),
            dispose: () => {
              disposed++
            },
          }
        },
      },
    })
    const verdict = await arbiter.handleTeamCompletion(baseCompletion())
    arbiter.stop()

    expect(verdict.passed).toBe(false)
    expect(verdict.reason).toBe('behavioral-regression')
    expect(disposed).toBe(1)
    // the arbiter feeds HEAD (projectRoot) + the candidate worktree path to the pair
    expect(seen?.headCwd).toBe(projectRoot)
    expect(typeof seen?.candidateCwd).toBe('string')
    expect(recorded.cmds.some((c) => c.startsWith('git -c user.name=scns-auto'))).toBe(false)
  })

  // T17 — makeBackends improving pair ⇒ PASS preserved, dispose still runs.
  it('T17: makeBackends improving pair ⇒ PASS preserved, dispose runs', async () => {
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(testDb.db, dispatcher)
    const recorded: Recorded = { cmds: [] }
    let disposed = 0
    const arbiter = createQualityGateArbiter({
      db: testDb.db,
      eventLog,
      dispatcher,
      projectRoot,
      runCommand: makeRunCommand(recorded),
      worktreeBase: tmpRoot,
      behavioralGate: {
        env: env({ SCNS_QG_BEHAVIORAL_GATE: '1', SCNS_QG_BEHAVIORAL_ENFORCE: '1' }),
        valTasks: VERIFY_TASKS,
        makeBackends: () => ({
          baseline: new FixedBackend('all done'),
          candidate: new FixedBackend('please verify it'),
          dispose: () => {
            disposed++
          },
        }),
      },
    })
    const verdict = await arbiter.handleTeamCompletion(baseCompletion())
    arbiter.stop()

    expect(verdict.passed).toBe(true)
    expect(verdict.behavioral?.delta).toBe(1)
    expect(disposed).toBe(1)
    expect(recorded.cmds.some((c) => c.startsWith('git -c user.name=scns-auto'))).toBe(true)
  })

  // T18 — a thrown backend is swallowed as no-signal (never a false veto), dispose still runs.
  it('T18: makeBackends backend throws ⇒ no signal, PASS preserved, dispose runs', async () => {
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(testDb.db, dispatcher)
    const recorded: Recorded = { cmds: [] }
    let disposed = 0
    const arbiter = createQualityGateArbiter({
      db: testDb.db,
      eventLog,
      dispatcher,
      projectRoot,
      runCommand: makeRunCommand(recorded),
      worktreeBase: tmpRoot,
      behavioralGate: {
        env: env({ SCNS_QG_BEHAVIORAL_GATE: '1', SCNS_QG_BEHAVIORAL_ENFORCE: '1' }),
        valTasks: VERIFY_TASKS,
        makeBackends: () => ({
          baseline: {
            attempt: () => {
              throw new Error('simulated spawn failure')
            },
          },
          candidate: new FixedBackend('please verify it'),
          dispose: () => {
            disposed++
          },
        }),
      },
    })
    const verdict = await arbiter.handleTeamCompletion(baseCompletion())
    arbiter.stop()

    expect(verdict.passed).toBe(true)
    expect(verdict.behavioral).toBeUndefined()
    expect(disposed).toBe(1)
    expect(recorded.cmds.some((c) => c.startsWith('git -c user.name=scns-auto'))).toBe(true)
  })
})
