/**
 * Self-issue completion/verdict handlers — decide when a self-issue signal's
 * lease resolves, and (critically) when it must NOT be released.
 *
 * ## scns#36 — the lease must honor the GATE, not the member exit
 *
 * Historically `team_completed` with `aggregateOutcome === 'success'` resolved
 * the lease. But the quality gate runs on the staged diff AFTER
 * `team_completed`, and its verdict never fed back. Observed live on the
 * Cosmere child 2026-08-10 (issue #13, team
 * team-selfissue-task-1786401919067-g6w074):
 *
 *     22:50:21  self-issue resolved — team completed successfully   (lease → done)
 *     22:5x     quality_gate_verdict {passed:false, reason:'build-failed'}
 *
 * The lease said "done" while zero artifacts reached GitHub; the ingest dedup
 * (`isActive`) then skipped the "done" signal forever. Gate-failed attempts
 * permanently burned their issues with no retry.
 *
 * ## The rule (verdict-keyed, first-PASS-wins)
 *
 * - `team_completed` NEVER mutates the lease. It only observes — the gate
 *   verdict for that wave's diff is still coming.
 * - `quality_gate_verdict` is the ONLY resolver: PASS ⇒ `markDone`;
 *   FAIL ⇒ the lease is deliberately KEPT. A team emits one completion (and
 *   therefore one verdict) per exit wave, and a later wave's diff can still
 *   pass, so a FAIL must never terminally close the signal. Genuinely
 *   stranded leases are recovered by the tracker's stale-TTL sweep, and the
 *   attempt cap stops a signal that keeps failing from retrying forever.
 * - When the cap is exhausted, the signal is marked `abandoned` — the HONEST
 *   terminal state (`done` would claim the work landed). That write happens in
 *   {@link evaluateSelfIssueSignalForEnqueue}, at ingest time, because that is
 *   where the system actually decides never to retry.
 *
 * ## The runaway-loop bug this must stay correct against
 *
 * A single self-issue team emits MORE THAN ONE `team_completed` event — one
 * per wave of member sessions that exits (observed live 2026-07-30: every team
 * emitted a `failed` first and a `success` ~15 minutes later). Releasing the
 * lease on a non-final signal re-spawned ~4 teams/hour for one GitHub issue.
 * Both handlers here are monotone under replays and multiple waves: only a
 * PASS transitions state, and it transitions to a terminal status.
 */

import type { SelfIssueTracker } from './self-issue-tracker.js'

/** The subset of the tracker the completion observer needs. */
export type SelfIssueCompletionTracker = Pick<SelfIssueTracker, 'findInProgressByTeam'>

/** The subset of the tracker the verdict handler needs. */
export type SelfIssueVerdictTracker = Pick<SelfIssueTracker, 'findInProgressByTeam' | 'markDone'>

/** The subset of the tracker the ingest-time enqueue evaluation needs. */
export type SelfIssueEnqueueTracker = Pick<
  SelfIssueTracker,
  'isActive' | 'isExhausted' | 'markAbandoned'
>

export interface SelfIssueTeamCompletionPayload {
  readonly teamId?: string
  readonly aggregateOutcome?: string
}

export interface SelfIssueGateVerdictPayload {
  /** `quality_gate_verdict` events carry the team id as `team_id`. */
  readonly team_id?: string
  readonly passed?: boolean
}

export type SelfIssueCompletionAction =
  /**
   * The team holds a self-issue lease and a wave of members exited. The lease
   * is deliberately untouched — the gate verdict for this wave's diff decides.
   */
  | 'awaiting-gate-verdict'
  /** The team holds no self-issue lease (suggestion/A2A team, or a stale team id). */
  | 'not-a-self-issue-team'

export type SelfIssueVerdictAction =
  /** Gate PASS — the signal is now terminal and will never be re-enqueued. */
  | 'resolved'
  /**
   * Gate FAIL — the lease is deliberately KEPT so a later wave's verdict can
   * still resolve it; the stale-lease sweep + attempt cap bound the retries.
   */
  | 'lease-retained'
  /** The team holds no self-issue lease (suggestion/A2A team, or a stale team id). */
  | 'not-a-self-issue-team'

export interface SelfIssueCompletionResult {
  readonly action: SelfIssueCompletionAction
  readonly signalKey: string | null
}

export interface SelfIssueVerdictResult {
  readonly action: SelfIssueVerdictAction
  readonly signalKey: string | null
}

/**
 * Observe a `team_completed` event. Never mutates the lease (scns#36): a
 * member exit — clean or not — says nothing about whether the diff survives
 * the quality gate, which runs after this event.
 */
export function handleSelfIssueTeamCompletion(
  tracker: SelfIssueCompletionTracker,
  payload: SelfIssueTeamCompletionPayload,
): SelfIssueCompletionResult {
  if (!payload.teamId) return { action: 'not-a-self-issue-team', signalKey: null }

  const signalKey = tracker.findInProgressByTeam(payload.teamId)
  if (!signalKey) return { action: 'not-a-self-issue-team', signalKey: null }

  return { action: 'awaiting-gate-verdict', signalKey }
}

/**
 * Apply a `quality_gate_verdict` event to the lease. PASS resolves
 * (first-PASS-wins across waves); FAIL retains. A verdict for a team whose
 * lease was already resolved, swept, or re-taken by a newer team finds no
 * `in-progress` match and no-ops.
 */
export function handleSelfIssueGateVerdict(
  tracker: SelfIssueVerdictTracker,
  payload: SelfIssueGateVerdictPayload,
): SelfIssueVerdictResult {
  if (!payload.team_id) return { action: 'not-a-self-issue-team', signalKey: null }

  const signalKey = tracker.findInProgressByTeam(payload.team_id)
  if (!signalKey) return { action: 'not-a-self-issue-team', signalKey: null }

  if (payload.passed === true) {
    tracker.markDone(signalKey)
    return { action: 'resolved', signalKey }
  }

  return { action: 'lease-retained', signalKey }
}

export type SelfIssueSignalDisposition =
  /** Holds a durable record (`in-progress`/`done`/`abandoned`) — skip. */
  | 'leased-or-done'
  /** Already sitting in the in-memory brain queue — skip. */
  | 'queued'
  /**
   * The attempt cap is exhausted: the signal was durably marked `abandoned`
   * by THIS call (the honest terminal state — not `done`). Skip, and log
   * loudly: this disposition is returned exactly once per signal.
   */
  | 'abandoned'
  /** No record, no queue entry, attempts under the cap — enqueue it. */
  | 'enqueueable'

/**
 * Ingest-time enqueue decision for one signal. This is where abandonment
 * becomes DURABLE: the moment the cap check refuses a retry, the refusal is
 * written as status `abandoned` so the record can never be mistaken for
 * "done" (scns#36's honesty requirement) and the loud operator log fires
 * exactly once — subsequent ticks (and restarts) short-circuit on the
 * durable record.
 */
export function evaluateSelfIssueSignalForEnqueue(
  tracker: SelfIssueEnqueueTracker,
  signalKey: string,
  maxAttempts: number,
  queuedInMemory: boolean,
): SelfIssueSignalDisposition {
  if (tracker.isActive(signalKey)) return 'leased-or-done'
  if (queuedInMemory) return 'queued'
  if (tracker.isExhausted(signalKey, maxAttempts)) {
    tracker.markAbandoned(signalKey)
    return 'abandoned'
  }
  return 'enqueueable'
}
