/**
 * SCNS selfopt — Phase 1 wedge A: behavioral-improvement gate (signal).
 *
 * The quality-gate arbiter today decides PASS/FAIL on the CODE DIFF (rubric over
 * test/lint output, optional build/test, baseline-lint/test diff, negative-memory
 * preservation). It never checks whether a change actually improves SCNS's
 * BEHAVIOR on a held-out task set. This module is the additive, default-OFF
 * signal that does: a non-regression check over RULE-JUDGED held-out tasks.
 *
 * Pure + fully injectable — no I/O, no env mutation, NO agent spawn. The
 * baseline/candidate backends are injected (default a deterministic `MockBackend`);
 * the real diff-exercising `AcpReplayBackend` is a SEPARATE opt-in wedge and is
 * never constructed here.
 *
 * Design landmine (deliberately avoided): mined `referenceKind:'recorded'` tasks
 * carry the historical quality-gate label, which is CONSTANT under any backend, so
 * a recorded task can never move a non-regression decision. We therefore gate on
 * genuine rule-judged tasks (the same substrate the gated negative-memory
 * applicator uses) — we do NOT synthesize rule checks from recorded scores.
 *
 * Safety property: the gate can only ever DOWNGRADE an otherwise-PASS verdict on a
 * measured regression; it never upgrades FAIL→PASS (the arbiter only ever consults
 * it on the rubric-PASS branch). And under a deterministic/symmetric backend the
 * baseline and candidate responses are identical, so `delta === 0` by construction
 * and it cannot veto.
 */
import { computeBaseline } from './baseline.js'
import { MockBackend } from './replay.js'
import type { ReplayBackend } from './replay.js'
import { DEFAULT_NONREGRESSION_EPSILON } from './staging.js'
import type { GateMetric, RuleCheck, TaskRecord, TaskSplit } from './types.js'

/** Env opt-in names (both default-OFF). */
export const BEHAVIORAL_GATE_ENV = 'SCNS_QG_BEHAVIORAL_GATE'
export const BEHAVIORAL_ENFORCE_ENV = 'SCNS_QG_BEHAVIORAL_ENFORCE'

export interface BehavioralGateMode {
  /** Compute + attach the behavioral measurement to the verdict (advisory). */
  readonly measure: boolean
  /** Allow a measured regression to downgrade an otherwise-PASS verdict. */
  readonly enforce: boolean
}

function isTruthy(v: string | undefined): boolean {
  if (v === undefined) return false
  const s = v.trim().toLowerCase()
  return s === '1' || s === 'true' || s === 'yes' || s === 'on'
}

/**
 * Resolve the two (default-OFF) env opt-ins. `enforce` is parsed independently,
 * but the arbiter only ever acts on it when `measure` is also true — enabling
 * enforce alone never gates anything.
 */
export function resolveBehavioralGateMode(env: NodeJS.ProcessEnv): BehavioralGateMode {
  return {
    measure: isTruthy(env[BEHAVIORAL_GATE_ENV]),
    enforce: isTruthy(env[BEHAVIORAL_ENFORCE_ENV]),
  }
}

/**
 * Bounded plain-text nudge attached to every default val task's `contextExcerpt`.
 *
 * Proven in wedge C phases (c)/(d): a real `copilot --acp` agent handed these
 * rule-judged tasks otherwise tries to *do the work* (e.g. `npm install` + run the
 * full suite), blowing the per-attempt timeout. Deny-all tool permissions already
 * stop it from executing anything, but this nudge also stops it from narrating long
 * tool plans — it answers in one or two plain sentences, yielding the clean short
 * responses the rule judges score.
 *
 * It only reaches a REAL backend: `buildReplayPrompt` emits it as a `# Context`
 * section, while `MockBackend.attempt` ignores `contextExcerpt` entirely — so the
 * default Mock path (and its delta-0 safety property) is byte-for-byte unchanged.
 */
export const BEHAVIORAL_VAL_NUDGE =
  'Respond in one or two sentences of plain prose. Do not run any commands or tools.'

/** Build one rule-judged held-out val TaskRecord (response scored locally). */
function ruleTask(id: string, intent: string, checks: readonly RuleCheck[]): TaskRecord {
  return {
    id,
    project: 'scns',
    intent,
    contextExcerpt: BEHAVIORAL_VAL_NUDGE,
    attemptedSolution: '',
    outcome: 'mixed',
    referenceKind: 'rule',
    reference: '',
    recordedScore: null,
    judge: { kind: 'rule', checks: [...checks] },
    tags: ['behavioral'],
    sourceSessions: [],
    split: 'val',
    origin: 'real',
    derivedFrom: '',
  }
}

/**
 * Default in-memory, rule-judged held-out gate set (NO broker mining). These are
 * genuine rule judges whose score responds to the agent's response text, so a
 * real diff-exercising backend can actually move them — unlike recorded tasks.
 * Each carries {@link BEHAVIORAL_VAL_NUDGE} in `contextExcerpt` to bound a real
 * agent to short, tool-free plain-text answers (inert under the default Mock).
 */
export const DEFAULT_BEHAVIORAL_VAL_TASKS: readonly TaskRecord[] = [
  ruleTask('behavioral_verify', 'Verify the change works before claiming success', [
    { op: 'contains', arg: 'verify' },
  ]),
  ruleTask('behavioral_concise', 'Summarize the change concisely', [
    { op: 'max_chars', arg: 2000 },
  ]),
]

/**
 * THE BRIDGE — nudge for RETRIEVAL-sensitive val tasks. Forces the agent to answer
 * STRICTLY from the injected `# Guidance` (the retrieved memory) and to say `unknown`
 * when the answer is absent. That is what makes retrieval quality the ONLY lever: a
 * candidate whose retrieval surfaces the answer chunk scores; a baseline whose
 * retrieval misses it answers `unknown` and scores 0. The fact asked for is a
 * proper-noun SCNS internal (an env var name) the base model cannot know, so the
 * answer cannot come from anywhere but retrieved memory.
 */
export const RETRIEVAL_VAL_NUDGE =
  'Answer ONLY from the SCNS memories provided above. Quote the exact identifier. If the ' +
  'memories do not contain the answer, reply with the single word: unknown. Respond in one ' +
  'sentence. Do not run any commands or tools.'

/** Build one retrieval-sensitive rule-judged val task (decoupled retrieval query). */
function retrievalTask(
  id: string,
  intent: string,
  retrievalQuery: string,
  checks: readonly RuleCheck[],
  extraTags: readonly string[] = [],
): TaskRecord {
  return {
    id,
    project: 'scns',
    intent,
    contextExcerpt: RETRIEVAL_VAL_NUDGE,
    attemptedSolution: '',
    outcome: 'mixed',
    referenceKind: 'rule',
    reference: '',
    recordedScore: null,
    judge: { kind: 'rule', checks: [...checks] },
    tags: ['behavioral', 'retrieval', ...extraTags],
    sourceSessions: [],
    split: 'val',
    origin: 'real',
    derivedFrom: '',
    retrievalQuery,
  }
}

/**
 * THE BRIDGE — default retrieval-sensitive gate set. Each task asks for a proper-noun
 * SCNS-internal fact (an env var name) that lives in an entity's neighborhood but is
 * NOT lexically present in the (vague, entity-named) `retrievalQuery`, so it is
 * surfaced by the MAGMA entity/temporal router (`intentRouting:true`) yet ranked out
 * of the base hybrid top-K (`intentRouting:false`). Better retrieval ⇒ the answer is
 * in context ⇒ the agent quotes it ⇒ higher score; worse retrieval ⇒ `unknown` ⇒ 0.
 *
 * VAULT-GROUNDED, ADVISORY: the discriminating tokens depend on the live vault. The
 * `BROKER_DB_PATH` separation was verified live on 2026-06-27 against the production
 * hybrid base (routed-ON context contains it, base-hybrid top-5 does not). The gate
 * is opt-in and re-measured per run; re-ground these tokens as memory evolves. The
 * set is fully overridable via `behavioralGate.valTasks`.
 */
export const DEFAULT_RETRIEVAL_VAL_TASKS: readonly TaskRecord[] = [
  retrievalTask(
    'retrieval_broker_db_path',
    'According to the provided SCNS memories, which environment variable does the broker read ' +
      'for its database path? Quote the exact variable name.',
    'Tell me about the broker component',
    [{ op: 'contains', arg: 'BROKER_DB_PATH' }],
  ),
]

/**
 * THE BRIDGE — WHY-intent (causal) retrieval val set. Where {@link DEFAULT_RETRIEVAL_VAL_TASKS}
 * exercises the ENTITY router, these exercise the CAUSAL router: the `retrievalQuery` is a WHY
 * question, so `intentRouting:true` routes it through `intentAwareSearch`'s WHY branch
 * (`causalNeighborhood` → cause→effect chains) while `intentRouting:false` falls back to the base
 * hybrid. The asked-for token lives ONLY in an inferred causal edge's `rationale` (which is never a
 * chunk), so the base hybrid can NEVER surface it — a candidate with causal readers + a persisted
 * edge quotes it; the baseline answers `unknown`.
 *
 * GROUNDED-WHEN-CAUSAL-EDGES-EXIST (advisory, inert by default): the discriminating token
 * `DEFAULT_GIT_EXEC_TIMEOUT_MS` is a REAL SCNS identifier (commit bc32666 raised the git exec
 * timeout 10s→30s to fix the broker's first-poll startup contention — Gap 3). It is surfaced only
 * via the causal edge linking that contention (cause) to the timeout fix (effect). On a vault with
 * `memory_causal = 0` this task is INERT (the WHY branch falls back to base ⇒ baseline and candidate
 * both answer `unknown` ⇒ delta 0, never a false veto); it activates the moment a matching causal
 * edge is persisted. Verified 2026-06-27 + re-verified 2026-06-30 (D4): the token appears in 0 live
 * vault chunks (hybrid-unreachable) AND `memory_causal=0` (R=60 raw candidates → real opus `--acp`
 * judge inferred 2, both <0.7 confidence gate → 0 persisted), so the WHY branch falls back to base ⇒
 * delta 0, never a false veto. Fully overridable via `behavioralGate.valTasks`.
 */
export const DEFAULT_WHY_RETRIEVAL_VAL_TASKS: readonly TaskRecord[] = [
  retrievalTask(
    'retrieval_why_git_first_poll',
    'According to the provided SCNS memories, which constant was raised to stop the broker first ' +
      'git poll being killed under startup contention? Quote the exact identifier.',
    'Why was the broker first git poll failing under startup contention?',
    [{ op: 'contains', arg: 'DEFAULT_GIT_EXEC_TIMEOUT_MS' }],
    ['causal'],
  ),
]

/**
 * Combined retrieval gate set — both MAGMA retrieval levers (ENTITY + WHY/causal). This is what the
 * cli wires for retrieval-mode so a candidate is measured against every routed intent; each task is
 * inert (delta 0) until its grounding exists, so adding the WHY task can never produce a false veto.
 */
export const ALL_RETRIEVAL_VAL_TASKS: readonly TaskRecord[] = [
  ...DEFAULT_RETRIEVAL_VAL_TASKS,
  ...DEFAULT_WHY_RETRIEVAL_VAL_TASKS,
]

export interface BehavioralGateInput {
  /** Rule-judged held-out tasks. Default {@link DEFAULT_BEHAVIORAL_VAL_TASKS}. */
  readonly valTasks?: readonly TaskRecord[]
  /** Backend representing CURRENT (HEAD) behavior. Default a `MockBackend`. */
  readonly baselineBackend?: ReplayBackend
  /** Backend representing the CANDIDATE (post-diff) behavior. Default a `MockBackend`. */
  readonly candidateBackend?: ReplayBackend
  /** Non-regression tolerance. Default {@link DEFAULT_NONREGRESSION_EPSILON}. */
  readonly epsilon?: number
  /** Metric projecting (hard, soft) to one score. Default 'hard'. */
  readonly metric?: GateMetric
  /** Which split in `valTasks` forms the gate set. Default 'val'. */
  readonly split?: TaskSplit
}

export interface BehavioralGateResult {
  /** True iff the gate actually replayed a non-empty held-out set. */
  readonly ran: boolean
  /** Why the gate was skipped (when `ran === false`). */
  readonly skipReason?: string
  readonly nTasks: number
  /** Aggregate score of the held-out set under the baseline backend. */
  readonly baselineScore: number
  /** Aggregate score of the held-out set under the candidate backend. */
  readonly candidateScore: number
  /** `candidateScore - baselineScore`. Positive = improvement. */
  readonly delta: number
  /** True iff `delta < -epsilon` (a measured behavioral regression). */
  readonly regressed: boolean
  readonly epsilon: number
  readonly metric: GateMetric
  readonly perTask: ReadonlyArray<{
    readonly id: string
    readonly baselineHard: number
    readonly candidateHard: number
  }>
  /** Plain-language note on what this signal can and cannot do. */
  readonly disclosure: string
}

const DISCLOSURE =
  'Behavioral non-regression over rule-judged held-out tasks. It can only DOWNGRADE an ' +
  'otherwise-PASS verdict on a measured regression; it never upgrades FAIL→PASS. Under a ' +
  'deterministic/symmetric backend (e.g. MockBackend) the baseline and candidate responses ' +
  'are identical, so delta is 0 by construction and it cannot veto.'

/**
 * Replay the held-out rule-judged set against the baseline and candidate backends
 * and return the behavioral non-regression result. Pure: deterministic given its
 * inputs, constructs no real-agent backend, performs no I/O.
 */
export async function evaluateBehavioralGate(
  input: BehavioralGateInput = {},
): Promise<BehavioralGateResult> {
  const epsilon = input.epsilon ?? DEFAULT_NONREGRESSION_EPSILON
  const metric = input.metric ?? 'hard'
  const split = input.split ?? 'val'
  const valTasks = input.valTasks ?? DEFAULT_BEHAVIORAL_VAL_TASKS
  const baselineBackend = input.baselineBackend ?? new MockBackend()
  const candidateBackend = input.candidateBackend ?? new MockBackend()

  const selected = valTasks.filter((t) => t.split === split)
  if (selected.length === 0) {
    return {
      ran: false,
      skipReason: 'no-val-tasks',
      nTasks: 0,
      baselineScore: 0,
      candidateScore: 0,
      delta: 0,
      regressed: false,
      epsilon,
      metric,
      perTask: [],
      disclosure: DISCLOSURE,
    }
  }

  const baseline = await computeBaseline(selected, { split, backend: baselineBackend, metric })
  const candidate = await computeBaseline(selected, { split, backend: candidateBackend, metric })

  const delta = candidate.score - baseline.score
  const regressed = delta < -epsilon

  const candById = new Map(candidate.perTask.map((p) => [p.id, p]))
  const perTask = baseline.perTask.map((b) => ({
    id: b.id,
    baselineHard: b.hard,
    candidateHard: candById.get(b.id)?.hard ?? 0,
  }))

  return {
    ran: true,
    nTasks: selected.length,
    baselineScore: baseline.score,
    candidateScore: candidate.score,
    delta,
    regressed,
    epsilon,
    metric,
    perTask,
    disclosure: DISCLOSURE,
  }
}
