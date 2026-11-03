/**
 * Phase 1 wedge A — behavioral-improvement gate (pure module).
 *
 * Deterministic, offline (Mock / injected fakes — NO agent spawn):
 *  - default-OFF: both env opt-ins unset ⇒ measure/enforce false.
 *  - symmetric backend ⇒ delta 0, never regressed (the inert-by-default property).
 *  - injected asymmetric fakes ⇒ a real regression is detected; an improvement is not.
 *  - epsilon semantics: a tie at the tolerance is NOT a regression; just beyond IS.
 *  - no real backend is ever constructed; the default backend is a MockBackend.
 */
import { describe, it, expect } from 'vitest'
import {
  evaluateBehavioralGate,
  resolveBehavioralGateMode,
  DEFAULT_BEHAVIORAL_VAL_TASKS,
  DEFAULT_RETRIEVAL_VAL_TASKS,
  DEFAULT_WHY_RETRIEVAL_VAL_TASKS,
  ALL_RETRIEVAL_VAL_TASKS,
  BEHAVIORAL_VAL_NUDGE,
  RETRIEVAL_VAL_NUDGE,
  BEHAVIORAL_GATE_ENV,
  BEHAVIORAL_ENFORCE_ENV,
} from '../../../src/selfopt/behavioral-gate.js'
import { buildReplayPrompt } from '../../../src/selfopt/acp-replay-backend.js'
import { MockBackend } from '../../../src/selfopt/replay.js'
import type { ReplayBackend } from '../../../src/selfopt/replay.js'
import type { RuleCheck, TaskRecord } from '../../../src/selfopt/types.js'

/** A rule-judged val TaskRecord — the backend response is scored locally. */
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
    tags: ['task'],
    sourceSessions: [],
    split: 'val',
    origin: 'real',
    derivedFrom: '',
  }
}

/** A backend that returns a fixed response for every task. */
class FixedBackend implements ReplayBackend {
  constructor(private readonly response: string) {}
  attempt(): string {
    return this.response
  }
}

/** A backend that returns a per-task-id response (fallback otherwise). */
class ByIdBackend implements ReplayBackend {
  readonly seen: string[] = []
  constructor(
    private readonly map: Record<string, string>,
    private readonly fallback = '',
  ) {}
  attempt(task: TaskRecord): string {
    this.seen.push(task.id)
    return this.map[task.id] ?? this.fallback
  }
}

const env = (o: Record<string, string>): NodeJS.ProcessEnv => o as NodeJS.ProcessEnv

describe('wedge A — resolveBehavioralGateMode (default-OFF)', () => {
  it('T1: empty env ⇒ measure=false, enforce=false', () => {
    expect(resolveBehavioralGateMode(env({}))).toEqual({ measure: false, enforce: false })
  })

  it('T2: parses truthy/falsy forms of the measure flag', () => {
    for (const v of ['1', 'true', 'yes', 'on', 'ON', ' True ']) {
      expect(resolveBehavioralGateMode(env({ [BEHAVIORAL_GATE_ENV]: v })).measure).toBe(true)
    }
    for (const v of ['0', 'false', '', 'nope', 'off']) {
      expect(resolveBehavioralGateMode(env({ [BEHAVIORAL_GATE_ENV]: v })).measure).toBe(false)
    }
  })

  it('T3: enforce parses independently of measure (arbiter requires measure to act)', () => {
    expect(resolveBehavioralGateMode(env({ [BEHAVIORAL_ENFORCE_ENV]: '1' }))).toEqual({
      measure: false,
      enforce: true,
    })
    expect(
      resolveBehavioralGateMode(
        env({ [BEHAVIORAL_GATE_ENV]: '1', [BEHAVIORAL_ENFORCE_ENV]: 'yes' }),
      ),
    ).toEqual({ measure: true, enforce: true })
  })
})

describe('wedge A — evaluateBehavioralGate', () => {
  it('T4: symmetric (default Mock) ⇒ ran, delta 0, never regressed', async () => {
    const r = await evaluateBehavioralGate()
    expect(r.ran).toBe(true)
    expect(r.nTasks).toBe(DEFAULT_BEHAVIORAL_VAL_TASKS.length)
    expect(r.delta).toBe(0)
    expect(r.regressed).toBe(false)
    expect(r.baselineScore).toBe(r.candidateScore)
  })

  it('T5: candidate that fails a held-out check ⇒ regression detected', async () => {
    const valTasks = [ruleTask('t', 'do the thing', [{ op: 'contains', arg: 'verify' }])]
    const r = await evaluateBehavioralGate({
      valTasks,
      baselineBackend: new FixedBackend('please verify it'),
      candidateBackend: new FixedBackend('all done'),
    })
    expect(r.baselineScore).toBe(1)
    expect(r.candidateScore).toBe(0)
    expect(r.delta).toBe(-1)
    expect(r.regressed).toBe(true)
  })

  it('T6: candidate that improves ⇒ NOT flagged as a regression', async () => {
    const valTasks = [ruleTask('t', 'do the thing', [{ op: 'contains', arg: 'verify' }])]
    const r = await evaluateBehavioralGate({
      valTasks,
      baselineBackend: new FixedBackend('all done'),
      candidateBackend: new FixedBackend('please verify it'),
    })
    expect(r.delta).toBe(1)
    expect(r.regressed).toBe(false)
  })

  it('T7: empty val set ⇒ ran=false, skipReason, never regressed', async () => {
    const r = await evaluateBehavioralGate({ valTasks: [] })
    expect(r.ran).toBe(false)
    expect(r.skipReason).toBe('no-val-tasks')
    expect(r.regressed).toBe(false)
    expect(r.nTasks).toBe(0)
  })

  it('T8: epsilon boundary — a tie at the tolerance is not a regression; just beyond is', async () => {
    const valTasks = [
      ruleTask('a', 'task a', [{ op: 'contains', arg: 'verify' }]),
      ruleTask('b', 'task b', [{ op: 'contains', arg: 'verify' }]),
    ]
    const baselineBackend = new FixedBackend('verify') // both pass ⇒ 1.0
    const candidateBackend = new ByIdBackend({ a: 'verify', b: 'nope' }) // ⇒ 0.5
    const atBoundary = await evaluateBehavioralGate({
      valTasks,
      baselineBackend,
      candidateBackend,
      epsilon: 0.5,
    })
    expect(atBoundary.delta).toBeCloseTo(-0.5, 10)
    expect(atBoundary.regressed).toBe(false)

    const beyond = await evaluateBehavioralGate({
      valTasks,
      baselineBackend,
      candidateBackend: new ByIdBackend({ a: 'verify', b: 'nope' }),
      epsilon: 0.4,
    })
    expect(beyond.regressed).toBe(true)
  })

  it('T9: injected backends are invoked per task; default backend is offline/deterministic (no spawn)', async () => {
    const valTasks = [
      ruleTask('a', 'task a', [{ op: 'contains', arg: 'verify' }]),
      ruleTask('b', 'task b', [{ op: 'contains', arg: 'verify' }]),
    ]
    const baseline = new ByIdBackend({ a: 'verify', b: 'verify' })
    const candidate = new ByIdBackend({ a: 'verify', b: 'verify' })
    await evaluateBehavioralGate({ valTasks, baselineBackend: baseline, candidateBackend: candidate })
    expect(baseline.seen.sort()).toEqual(['a', 'b'])
    expect(candidate.seen.sort()).toEqual(['a', 'b'])

    // With NO backends the module supplies a deterministic default (MockBackend):
    // two runs over the same tasks produce identical, reproducible scores.
    const r1 = await evaluateBehavioralGate({ valTasks })
    const r2 = await evaluateBehavioralGate({ valTasks })
    expect(r1.baselineScore).toBe(r2.baselineScore)
    expect(r1.candidateScore).toBe(r2.candidateScore)
    expect(r1.delta).toBe(0)
  })
})

describe('wedge C wire_real_default — bounded default val-task nudge', () => {
  it('T10: every default val task carries the bounded nudge in contextExcerpt', () => {
    expect(DEFAULT_BEHAVIORAL_VAL_TASKS.length).toBeGreaterThan(0)
    for (const t of DEFAULT_BEHAVIORAL_VAL_TASKS) {
      expect(t.contextExcerpt).toBe(BEHAVIORAL_VAL_NUDGE)
      expect(t.contextExcerpt.trim()).not.toBe('')
    }
  })

  it('T11: the nudge instructs short plain prose and forbids running tools/commands', () => {
    expect(BEHAVIORAL_VAL_NUDGE).toMatch(/one or two sentences/i)
    expect(BEHAVIORAL_VAL_NUDGE).toMatch(/do not run any commands or tools/i)
  })

  it('T12: the nudge reaches a REAL backend via buildReplayPrompt as a # Context section', () => {
    const task = DEFAULT_BEHAVIORAL_VAL_TASKS[0]
    const prompt = buildReplayPrompt(task, '', '')
    expect(prompt).toContain('# Context')
    expect(prompt).toContain(BEHAVIORAL_VAL_NUDGE)
  })

  it('T13: the nudge is INERT under Mock — response omits it and the default delta stays 0', async () => {
    // MockBackend.attempt ignores contextExcerpt, so the bounded nudge cannot
    // alter the offline score or the delta-0 safety property.
    const task = DEFAULT_BEHAVIORAL_VAL_TASKS[0]
    const mockResponse = new MockBackend().attempt(task, '', '')
    expect(mockResponse).not.toContain(BEHAVIORAL_VAL_NUDGE)

    const r = await evaluateBehavioralGate()
    expect(r.ran).toBe(true)
    expect(r.nTasks).toBe(DEFAULT_BEHAVIORAL_VAL_TASKS.length)
    expect(r.delta).toBe(0)
    expect(r.regressed).toBe(false)
  })
})

describe('THE BRIDGE — retrieval-sensitive val tasks', () => {
  it('every retrieval val task carries a decoupled retrievalQuery + the retrieval nudge', () => {
    expect(DEFAULT_RETRIEVAL_VAL_TASKS.length).toBeGreaterThan(0)
    for (const t of DEFAULT_RETRIEVAL_VAL_TASKS) {
      expect(t.retrievalQuery && t.retrievalQuery.trim()).toBeTruthy()
      expect(t.retrievalQuery).not.toBe(t.intent) // decoupled probe vs question
      expect(t.contextExcerpt).toBe(RETRIEVAL_VAL_NUDGE)
      expect(t.split).toBe('val')
      expect(t.referenceKind).toBe('rule')
      expect(t.tags).toContain('retrieval')
    }
  })

  it('the retrieval nudge forces context-only answers with an `unknown` fallback', () => {
    expect(RETRIEVAL_VAL_NUDGE).toMatch(/only from the scns memories/i)
    expect(RETRIEVAL_VAL_NUDGE).toMatch(/\bunknown\b/i)
    expect(RETRIEVAL_VAL_NUDGE).toMatch(/do not run any commands or tools/i)
  })

  it('a retrieval improvement (candidate quotes the fact, baseline says unknown) scores +1', async () => {
    // Baseline retrieval misses the fact ⇒ the agent answers "unknown".
    // Candidate retrieval surfaces it ⇒ the agent quotes BROKER_DB_PATH.
    const baseline = new ByIdBackend({}, 'unknown')
    const candidate = new ByIdBackend(
      Object.fromEntries(
        DEFAULT_RETRIEVAL_VAL_TASKS.map((t) => [t.id, 'The broker reads BROKER_DB_PATH from env.']),
      ),
    )
    const r = await evaluateBehavioralGate({
      valTasks: DEFAULT_RETRIEVAL_VAL_TASKS,
      baselineBackend: baseline,
      candidateBackend: candidate,
    })
    expect(r.ran).toBe(true)
    expect(r.baselineScore).toBe(0)
    expect(r.candidateScore).toBe(1)
    expect(r.delta).toBe(1)
    expect(r.regressed).toBe(false)
  })

  it('symmetric backend over the retrieval set ⇒ delta 0 (inert safety property holds)', async () => {
    const r = await evaluateBehavioralGate({
      valTasks: DEFAULT_RETRIEVAL_VAL_TASKS,
      baselineBackend: new MockBackend(),
      candidateBackend: new MockBackend(),
    })
    expect(r.delta).toBe(0)
    expect(r.regressed).toBe(false)
  })
})

describe('THE BRIDGE — WHY/causal retrieval val tasks', () => {
  it('the WHY val set is a non-empty WHY-intent, causal-tagged retrieval set', () => {
    expect(DEFAULT_WHY_RETRIEVAL_VAL_TASKS.length).toBeGreaterThan(0)
    for (const t of DEFAULT_WHY_RETRIEVAL_VAL_TASKS) {
      // a WHY-intent probe (so intentRouting:true routes through the causal branch)
      expect(t.retrievalQuery?.toLowerCase()).toMatch(/\bwhy\b/)
      expect(t.retrievalQuery).not.toBe(t.intent)
      expect(t.contextExcerpt).toBe(RETRIEVAL_VAL_NUDGE)
      expect(t.tags).toContain('retrieval')
      expect(t.tags).toContain('causal')
      // the discriminating token lives only in a causal edge rationale
      const checks = t.judge.kind === 'rule' ? t.judge.checks : []
      expect(checks.some((c) => c.op === 'contains' && c.arg === 'DEFAULT_GIT_EXEC_TIMEOUT_MS')).toBe(
        true,
      )
    }
  })

  it('ALL_RETRIEVAL_VAL_TASKS = ENTITY set ⊕ WHY set (both MAGMA levers), ids unique', () => {
    expect(ALL_RETRIEVAL_VAL_TASKS).toHaveLength(
      DEFAULT_RETRIEVAL_VAL_TASKS.length + DEFAULT_WHY_RETRIEVAL_VAL_TASKS.length,
    )
    const ids = ALL_RETRIEVAL_VAL_TASKS.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('a WHY causal improvement (candidate quotes the rationale token, baseline unknown) scores +1', async () => {
    const baseline = new ByIdBackend({}, 'unknown')
    const candidate = new ByIdBackend(
      Object.fromEntries(
        DEFAULT_WHY_RETRIEVAL_VAL_TASKS.map((t) => [
          t.id,
          'The Gap 3 fix raised DEFAULT_GIT_EXEC_TIMEOUT_MS to 30s.',
        ]),
      ),
    )
    const r = await evaluateBehavioralGate({
      valTasks: DEFAULT_WHY_RETRIEVAL_VAL_TASKS,
      baselineBackend: baseline,
      candidateBackend: candidate,
    })
    expect(r.baselineScore).toBe(0)
    expect(r.candidateScore).toBe(1)
    expect(r.delta).toBe(1)
    expect(r.regressed).toBe(false)
  })

  it('the WHY set is inert (delta 0) under a symmetric backend ⇒ no false veto when ungrounded', async () => {
    const r = await evaluateBehavioralGate({
      valTasks: ALL_RETRIEVAL_VAL_TASKS,
      baselineBackend: new MockBackend(),
      candidateBackend: new MockBackend(),
    })
    expect(r.delta).toBe(0)
    expect(r.regressed).toBe(false)
  })
})
