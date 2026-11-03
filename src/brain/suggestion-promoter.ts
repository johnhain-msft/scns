/**
 * Phase 13.3 — Suggestion → PendingTask promoter.
 *
 * Bridges the suggestion pipeline (which today just accumulates
 * `pending` records forever) to the brain's PendingTask queue, which
 * the decision tree consumes.
 *
 * Pure function: given suggestions, current in-flight tasks, and
 * autonomy level, emit the subset of suggestions that should become
 * tasks on this tick plus the subset that should be auto-approved.
 * All side effects (enqueueing, status updates) happen in the caller.
 */

import { DecisionPriority, type PendingTask } from './state-types.js'
import type { Suggestion } from '../suggest/types.js'

// ── Types ────────────────────────────────────────────────────────────

export interface PromoterInput {
  readonly autonomyLevel: number
  readonly maxConcurrentSessions: number
  readonly activeSessions: number
  readonly inflightTasks: readonly PendingTask[]
  readonly suggestions: readonly Suggestion[]
  /**
   * Minimum confidence for a `pending` suggestion to be auto-approved at
   * autonomy L2+. Defaults to {@link DEFAULT_AUTO_APPROVE_CONFIDENCE_THRESHOLD}
   * (0.85). Wired from `SCNS_SUGGEST_AUTO_APPROVE_THRESHOLD` via cli.ts →
   * BrainAgentOptions; kept as input (not read here) so this stays pure.
   */
  readonly autoApproveThreshold?: number
  /**
   * Clock for retry-backoff evaluation, in epoch ms. Injectable so the skip stays deterministically
   * testable; defaults to `Date.now()`. Added with the FR-057 backoff skip below.
   */
  readonly nowMs?: number
}

export interface PromotedTask {
  readonly task: PendingTask
  readonly sourceSuggestionId: string
}

export interface PromoterResult {
  readonly promoted: readonly PromotedTask[]
  /** Suggestion ids that should be transitioned from `pending` → `approved`. */
  readonly autoApprovedIds: readonly string[]
  /** Debug info: suggestions considered but not promoted this tick. */
  readonly skipped: readonly { readonly id: string; readonly reason: string }[]
}

// ── Policy constants ─────────────────────────────────────────────────

/**
 * Default minimum confidence for auto-approving a `pending` suggestion at
 * autonomy L2+. Overridable per-call via {@link PromoterInput.autoApproveThreshold}
 * (sourced from the `SCNS_SUGGEST_AUTO_APPROVE_THRESHOLD` env in cli.ts).
 */
const DEFAULT_AUTO_APPROVE_CONFIDENCE_THRESHOLD = 0.85

// ── Helpers ──────────────────────────────────────────────────────────

function complexityToStrategy(
  c: Suggestion['estimatedComplexity'],
): 'solo' | 'parallel' | 'hybrid' {
  switch (c) {
    case 'team':
      return 'parallel'
    case 'complex':
      return 'hybrid'
    case 'solo':
    default:
      return 'solo'
  }
}

function taskDescriptionFor(s: Suggestion): string {
  const head = `[${s.type}] ${s.title}`
  return s.description ? `${head}\n\n${s.description}` : head
}

function taskIdFor(s: Suggestion): string {
  return `task-sugg-${s.id}`
}

// ── Factory ──────────────────────────────────────────────────────────

export function promoteSuggestions(input: PromoterInput): PromoterResult {
  const { autonomyLevel, maxConcurrentSessions, activeSessions, inflightTasks, suggestions } =
    input

  const autoApproveThreshold =
    input.autoApproveThreshold ?? DEFAULT_AUTO_APPROVE_CONFIDENCE_THRESHOLD
  const nowMs = input.nowMs ?? Date.now()

  const promoted: PromotedTask[] = []
  const autoApprovedIds: string[] = []
  const skipped: { id: string; reason: string }[] = []

  // L0 (Observer) never promotes.
  if (autonomyLevel < 1) {
    for (const s of suggestions) skipped.push({ id: s.id, reason: 'autonomy-L0' })
    return { promoted, autoApprovedIds, skipped }
  }

  // Slot cap: don't promote more tasks than we have headroom to run.
  const slots = Math.max(
    0,
    maxConcurrentSessions - activeSessions - inflightTasks.length,
  )
  if (slots === 0) {
    for (const s of suggestions) skipped.push({ id: s.id, reason: 'no-slots' })
    return { promoted, autoApprovedIds, skipped }
  }

  const inflightSuggestionIds = new Set(
    inflightTasks.map((t) => t.sourceSuggestionId).filter((v): v is string => !!v),
  )

  // Rank: highest confidence first, oldest suggestion as tiebreaker so
  // we don't starve older items behind a stream of fresh ones.
  const ranked = [...suggestions].sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence
    return a.createdAt.localeCompare(b.createdAt)
  })

  for (const s of ranked) {
    if (promoted.length >= slots) {
      skipped.push({ id: s.id, reason: 'slot-cap' })
      continue
    }

    if (!s.actionable) {
      skipped.push({ id: s.id, reason: 'not-actionable' })
      continue
    }

    if (inflightSuggestionIds.has(s.id)) {
      skipped.push({ id: s.id, reason: 'duplicate-inflight' })
      continue
    }

    // FR-057 — honour the retry backoff. `ApprovedSuggestions` (`agent-loop.ts:640`) already skips
    // items whose `nextRetryAt` has not arrived; this path lists the SAME `approved` items and did
    // not, so on any tick where that path backed off, this one re-promoted immediately and the
    // exponential curve never applied.
    //
    // That was not a theoretical gap. Phase 10f parks a gate-failed proposal back in `approved`
    // between attempts, and the item that motivated the phase (`65a914f4`) is
    // `estimatedComplexity: "solo"` with no `suggestedRoles`, so `handledByApprovedSuggestions` is
    // false for it — it is promoter-eligible, and this is the only path it takes. Without this
    // skip a retry budget of 5 burns in minutes and a transient failure escalates straight to
    // `needs-human`, which is exactly the "terminal on attempt one" harm the phase set out to fix.
    if (s.nextRetryAt) {
      const retryAtMs = new Date(s.nextRetryAt).getTime()
      if (Number.isFinite(retryAtMs) && nowMs < retryAtMs) {
        skipped.push({ id: s.id, reason: 'retry-backoff' })
        continue
      }
    }

    // Decide whether this suggestion is eligible to become a task.
    //   L2+: auto-approve if status==='pending' AND confidence high enough;
    //        also allow already-approved items.
    //   L1:  only already-human-approved items.
    let autoApprove = false
    if (s.status === 'approved') {
      // already human-accepted; fine at any eligible level
    } else if (s.status === 'pending') {
      if (autonomyLevel >= 2 && s.confidence >= autoApproveThreshold) {
        autoApprove = true
      } else {
        skipped.push({
          id: s.id,
          reason:
            autonomyLevel < 2
              ? 'needs-human-approval'
              : 'below-auto-approve-threshold',
        })
        continue
      }
    } else {
      // rejected / implemented — never promote
      skipped.push({ id: s.id, reason: `status-${s.status}` })
      continue
    }

    const strategy = complexityToStrategy(s.estimatedComplexity)
    const subtaskCount = Math.max(1, s.suggestedRoles?.length ?? 1)

    // Phase 13.12.20: team-complexity suggestions with suggestedRoles are
    // handled directly by the brain's ApprovedSuggestions action via
    // onSpawnTeam (Path A), which spawns one agent per role against a
    // `team-sugg-<short>` team. Enqueuing them here would create a second,
    // duplicate team (`team-task-sugg-<full>` via Path B) with a generic
    // `implementer` role — exactly the double-spawn bug documented in
    // DOGFOOD-EVIDENCE-13-12-20.md. We still auto-approve pending team
    // suggestions (so ApprovedSuggestions can see them) but do NOT enqueue
    // them as tasks.
    const handledByApprovedSuggestions =
      s.estimatedComplexity === 'team' && (s.suggestedRoles?.length ?? 0) > 0

    if (handledByApprovedSuggestions) {
      if (autoApprove) autoApprovedIds.push(s.id)
      skipped.push({ id: s.id, reason: 'team-handled-by-approved-suggestions' })
      continue
    }

    const task: PendingTask = {
      id: taskIdFor(s),
      description: taskDescriptionFor(s),
      priority: DecisionPriority.Normal,
      strategy,
      subtaskCount,
      createdAt: new Date().toISOString(),
      sourceSuggestionId: s.id,
    }

    promoted.push({ task, sourceSuggestionId: s.id })
    if (autoApprove) autoApprovedIds.push(s.id)
  }

  return { promoted, autoApprovedIds, skipped }
}
