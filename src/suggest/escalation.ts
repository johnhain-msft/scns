/**
 * Which KIND of `needs-human` an item is — the single place that decides.
 *
 * `needs-human` carries two unrelated meanings:
 *
 *   `gate-refused`   — a safety gate declined to run this (13.12.16, `executor.ts:522`). The plan
 *                      needs re-judging, so `repromote` sends it back to `pending` for triage.
 *   `gate-exhausted` — the quality gate burned its retry budget trying to BUILD it (FR-056b, Phase
 *                      10f). The idea was already approved and never judged badly; only the
 *                      implementation failed, so `runRetry`/`clearBackoff` resume it at `approved`.
 *
 * Before this module the difference was recovered by sniffing two unrelated fields —
 * `machineReason.startsWith('qg-fail:') && attemptCount > 0` — inline at five separate readers.
 * That is fragile in three distinct ways, and all three are live:
 *
 *  1. **Duplicated**, so readers can drift and disagree about the same file.
 *  2. **Implicit**, so a producer that forgets to set the right shape fails silently rather than
 *     loudly — and a silent misclassification here routes a proposal down the wrong path.
 *  3. **Wrong for the motivating artefact.** `65a914f4` carries `machineReason: qg-fail:tests-failed`
 *     with `attemptCount: 0`, because it was written before this phase started counting attempts.
 *     The sniff calls it "not exhausted" and it drops out of the escalated pool entirely.
 *
 * John's ruling (2026-08-04): make it two categories. The tag is a FIELD rather than two new
 * statuses, because `status` is the on-disk directory name and new statuses would mean relabelling
 * live files — the "rewriting history" T149 explicitly forbids.
 */

import type { EscalationKind, Suggestion } from './types.js'
import { isNonDecision } from './review-reason.js'

/**
 * The machine-reason prefix the quality gate writes on a failure.
 *
 * Exported because it was copy-pasted into three modules that must agree about the same bytes —
 * this file, `qg-mislabel-census.ts` and `qg-mislabel-repair.ts`. A census that stops counting a
 * shape the repair still rewrites is the drift failure #1 below, in the one place where drift would
 * be silent: both sides would keep working, and only the number connecting them would be wrong.
 */
export const QG_FAIL_PREFIX = 'qg-fail:'

/**
 * The legacy discriminator, kept ONLY as a fallback for files written before the split.
 *
 * `~/.scns/suggestions/needs-human/` holds real files with no `escalation` field. If the new
 * predicate read the tag alone, every one of them would silently leave the escalated pool the
 * moment this shipped — an invisible regression on live data, which is the failure class this
 * whole phase exists to remove. So: trust the tag when present, fall back when it is not.
 */
function legacyKind(s: Suggestion): EscalationKind {
  return s.machineReason?.startsWith(QG_FAIL_PREFIX) === true && (s.attemptCount ?? 0) > 0
    ? 'gate-exhausted'
    : 'gate-refused'
}

/**
 * Classify a `needs-human` item, or `null` when it is not one.
 *
 * Returning `null` for every other status is deliberate: the question "which kind of escalation is
 * this" is meaningless for a `pending` or `implemented` item, and answering it anyway is how a
 * predicate starts matching things it was never meant to.
 */
export function escalationKindOf(s: Suggestion): EscalationKind | null {
  if (s.status !== 'needs-human') return null
  return s.escalation ?? legacyKind(s)
}

/** The quality gate exhausted its retry budget building this (FR-056b). */
export function isGateExhausted(s: Suggestion): boolean {
  return escalationKindOf(s) === 'gate-exhausted'
}

/** A safety gate refused to run this; it needs re-judging (13.12.16). */
export function isGateRefused(s: Suggestion): boolean {
  return escalationKindOf(s) === 'gate-refused'
}

/**
 * Does this row carry the SC-029 census signature, whatever status directory it sits in?
 *
 * The signature is "a `qg-fail:*` machine verdict with no standing human DECISION" — the shape of an
 * item the quality gate labelled on John's behalf and that he has not since re-decided.
 *
 * DELIBERATELY status-agnostic, and that is the whole reason it exists. {@link escalationKindOf}
 * answers "which kind of `needs-human` is this" and correctly returns `null` for every other status,
 * while `qg-mislabel-census.ts` scopes the census to `status: rejected` (`HUMAN_REFUSAL_STATUS`).
 * The two are therefore **disjoint by construction**: a census violation could never be classified
 * by the escalation predicate, at any time, for any row. That gap is not academic — it is exactly
 * why T149 recorded "there is no seam that puts it back in front of John" about a live artefact.
 *
 * This is a description of the SHAPE, not a routing decision. Callers compose it with
 * {@link escalationKindOf} rather than replacing it, so a `needs-human` row keeps the classification
 * `repromote` and proposal triage depend on.
 *
 * **A QUESTION IS NOT A STANDING VERDICT (FR-071b, issue #31).** This read `s.reviewVerdict ===
 * undefined`, so ANY verdict drained the lane — including `explain` and `defer`, which
 * `recordWeeklyVerdict` writes while deliberately preserving the status because they decide nothing
 * (`weekly-session.ts:257-267`). The item therefore left this lane on the same keystroke that made
 * the backfill filter drop it for having a human reason, and it never came back. Four other readers
 * — `isDecision`, `historyFrom`, `wasHumanApproved`, `lastHumanDecisionAt` — already agreed that
 * `defer`/`explain` are non-decisions, and `weekly-review.ts:87` already documented the intended
 * behaviour (*"only `approve` and `reject` drain this pool"*). This predicate was the lone dissenter,
 * and the disagreement lived inside the module written to stop readers disagreeing about one file.
 * Verified pre-existing on `main` @ `51b36b9`, not a Phase 11 regression
 * (`docs/evidence/003-T195-T198-explain-defer-hole-2026-08-06.md` §2).
 */
export function matchesCensusSignature(s: Suggestion): boolean {
  return (
    s.machineReason?.startsWith(QG_FAIL_PREFIX) === true &&
    (s.reviewVerdict === undefined || isNonDecision(s.reviewVerdict))
  )
}
