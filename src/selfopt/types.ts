/**
 * SCNS selfopt — Phase 0 core data types (the measurement substrate).
 *
 * These types are the SCNS-native port of the MIT SkillOpt-Sleep semantics
 * (`skillopt_sleep/types.py`). They are the interfaces between the Phase-0
 * stages: mine (broker events -> TaskRecord) -> replay (TaskRecord + candidate
 * artifact -> ReplayResult) -> gate (scores -> accept/reject).
 *
 * Field names are camelCase per SCNS TypeScript convention; the semantics are
 * kept behaviourally identical to the vendored Python so the two stay aligned.
 */

// ── Mining: outcomes correlated from broker event history ─────────────────────

/**
 * One completed team run, correlated from a `team_completed` event paired with
 * its `quality_gate_verdict` event. This is the labelled-outcome unit mined from
 * SCNS's own broker history — the only source that carries a real, computed
 * pass/fail label (`passed`) and a continuous quality score (`score` in [0,1]).
 */
export interface TeamOutcome {
  readonly teamId: string
  readonly branch: string | null
  readonly sourceSuggestionId: string | null
  /** The quality-gate arbiter's own verdict — the hard label. */
  readonly passed: boolean
  /** The quality-gate score in [0,1] — the continuous label / loss signal. */
  readonly score: number
  readonly reason: string
  /** `team_completed.aggregateOutcome` (e.g. "failed" | "completed"). */
  readonly aggregateOutcome: string
  /** Bounded summary of the staged diff (changed-file list + first hunk). */
  readonly stagedDiffSummary: string
  readonly changedFiles: readonly string[]
  readonly memberSessionIds: readonly string[]
  readonly completedAt: string | null
  /** The quality-gate verdict's unique id — the stable mining identity key. */
  readonly qualityCheckId: string
}

// ── Mining: the training unit ─────────────────────────────────────────────────

export type TaskOutcome = 'success' | 'fail' | 'mixed' | 'unknown'
export type ReferenceKind = 'exact' | 'rubric' | 'rule' | 'recorded' | 'none'
export type TaskSplit = 'train' | 'val' | 'test'
export type TaskOrigin = 'real' | 'dream'

/** One programmatic check of a gbrain-style rule judge. */
export interface RuleCheck {
  readonly op: string
  readonly arg?: string | number
}

export interface RuleJudge {
  readonly kind: 'rule'
  readonly checks: readonly RuleCheck[]
}

/**
 * A self-contained recurring task mined from one or more real outcomes — the
 * training unit of the loss function (the analogue of a SkillOpt benchmark item).
 *
 * `split` ∈ {train, val, test}: val + test come ONLY from real mined tasks
 * (origin==='real') and never overlap — val gates updates, test is the final
 * held-out measure. `train` may be dream-augmented; dream tasks are NEVER placed
 * in val/test (the anti-overfitting guarantee).
 */
export interface TaskRecord {
  readonly id: string
  readonly project: string
  /** What was wanted (the "question"). */
  readonly intent: string
  /** Minimal context needed to attempt it. */
  readonly contextExcerpt: string
  /** What the agent produced before (bounded staged-diff summary). */
  readonly attemptedSolution: string
  readonly outcome: TaskOutcome
  readonly referenceKind: ReferenceKind
  /** Exact answer, or rubric text, or empty. */
  readonly reference: string
  /**
   * The recorded numeric label in [0,1] when `referenceKind === 'recorded'`
   * (i.e. the historical quality-gate score). `null` otherwise.
   */
  readonly recordedScore: number | null
  /** gbrain-style rule judge, when `referenceKind === 'rule'`. */
  readonly judge: RuleJudge | null
  readonly tags: readonly string[]
  readonly sourceSessions: readonly string[]
  readonly split: TaskSplit
  readonly origin: TaskOrigin
  /** For dream tasks: the real task id this varies. */
  readonly derivedFrom: string
  /**
   * THE BRIDGE (optional): the query used to fetch INJECTED MEMORY context for this
   * task via the real retrieval path, when the behavioral gate runs in retrieval
   * mode. Decoupled from `intent` on purpose: the retrieval query is a vague,
   * entity-named probe (so the MAGMA entity/temporal router — not lexical overlap —
   * decides what is surfaced), while `intent` is the explicit question put to the
   * agent. Defaults to `intent` when omitted, so every existing task is unchanged.
   */
  readonly retrievalQuery?: string
}

// ── Replay: outcome of re-running one TaskRecord under a candidate ────────────

export interface ReplayResult {
  readonly id: string
  /** 0/1 exact, or continuous reward. */
  readonly hard: number
  /** Partial credit / judge score in [0,1]. */
  readonly soft: number
  readonly response: string
  readonly failReason: string
  readonly taskType: string
  readonly judgeRationale: string
  readonly toolsCalled: readonly string[]
  /** Approximate tokens this rollout cost (token objective). */
  readonly tokens: number
  /** Wall-clock for this rollout in ms (latency objective). */
  readonly latencyMs: number
}

// ── Gate: the strict-improve decision ─────────────────────────────────────────

export type GateAction = 'accept_new_best' | 'accept' | 'reject'
export type GateMetric = 'hard' | 'soft' | 'mixed'

export interface GateResult {
  readonly action: GateAction
  readonly currentSkill: string
  readonly currentScore: number
  readonly bestSkill: string
  readonly bestScore: number
  readonly bestStep: number
}
