/**
 * Brain Agent state and action type definitions.
 * Pure data types — no logic, no side effects.
 */

// ── Actions ──────────────────────────────────────────────────────────

/** Actions the Brain Agent can take */
export const BrainAction = {
  Idle: 'idle',
  Observe: 'observe',
  Suggest: 'suggest',
  SpawnSolo: 'spawn-solo',
  SpawnTeam: 'spawn-team',
  HandleSolo: 'handle-solo',
  Consolidate: 'consolidate',
  RotateContext: 'rotate-context',
  YieldToUser: 'yield-to-user',
  ApprovedSuggestions: 'approved-suggestions',
  QualityCheck: 'quality-check',
  /**
   * Phase 13.12.19: runs AFTER a suggestion is successfully executed and
   * QualityCheck has passed, BEFORE marking the suggestion `implemented`.
   * Spawns a fresh ephemeral critic that inspects the suggestion + team
   * output and returns a JSON verdict (pass | fail | needs-evidence).
   * Brain uses the verdict to decide the final state transition.
   */
  SelfCritique: 'self-critique',
} as const
export type BrainAction = (typeof BrainAction)[keyof typeof BrainAction]

// ── Decision priority ────────────────────────────────────────────────

export const DecisionPriority = {
  Critical: 'critical',
  High: 'high',
  Normal: 'normal',
  Low: 'low',
} as const
export type DecisionPriority = (typeof DecisionPriority)[keyof typeof DecisionPriority]

// ── Decision result ──────────────────────────────────────────────────

export interface Decision {
  readonly action: BrainAction
  readonly reason: string
  readonly confidence: number
  readonly taskId?: string
  readonly teamSize?: number
  readonly priority: DecisionPriority
}

// ── OTel metrics summary ─────────────────────────────────────────────

export interface OtelMetricsSummary {
  readonly totalSpansIngested: number
  readonly lastIngestTime?: string
  readonly activeOtelSessions: number
  readonly patternsExtracted: number
}

// ── Brain state snapshot ─────────────────────────────────────────────

export interface BrainState {
  readonly autonomyLevel: number
  readonly userActive: boolean
  readonly yieldToUser: boolean

  readonly pendingTasks: readonly PendingTask[]
  readonly activeSessions: number
  readonly maxConcurrentSessions: number

  readonly contextUsagePercent: number
  readonly contextRotationThreshold: number

  readonly recentObservationCount: number
  readonly lastConsolidationAge: number
  readonly consolidationThreshold: number
  /**
   * R1 (consolidate-livelock fix): whether the dream executor's own run gates
   * (time/count/lock) would let a consolidation actually execute right now.
   * `false` ⇒ the Consolidate branch must fall through to task processing —
   * deciding Consolidate would only produce a gate-skip and starve the queue.
   * Omitted ⇒ unknown (no gate sensor wired); treated as open.
   */
  readonly consolidationGateOpen?: boolean

  readonly approvedSuggestionCount: number
  readonly pendingQualityChecks: number

  readonly otelMetrics?: OtelMetricsSummary

  readonly patterns: {
    readonly workSchedule: {
      readonly peakHour: number
      readonly activeHours: readonly number[]
    } | null
    readonly isCurrentlyPeakHours: boolean
  } | null
}

// ── Pending task ─────────────────────────────────────────────────────

export interface PendingTask {
  readonly id: string
  readonly description: string
  readonly priority: DecisionPriority
  readonly strategy?: string
  readonly subtaskCount?: number
  readonly createdAt: string
  /**
   * Phase 13.3: id of the suggestion this task was promoted from.
   * Lets the brain update the source suggestion's status on success/failure.
   */
  readonly sourceSuggestionId?: string
  /**
   * Bug 2 fix: stable self-issue signal key (e.g. `github-issue:42`) when this
   * task was authored from a self-issue signal. Lets the brain lease the signal
   * to a unique team on spawn (durable, survives restart) and lets the ingest
   * run skip re-enqueuing a signal already sitting in this in-memory queue.
   */
  readonly signalKey?: string
}
