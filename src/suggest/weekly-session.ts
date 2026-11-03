/**
 * THE WEEKLY REVIEW SESSION — SCNS brings the review to John, not the other way round.
 *
 * The measured gap this closes is not a missing field. The human-reason channel already existed end
 * to end (`reviewReason` → `suggestion-store.updateStatus` → `suggestion-file` → `outcome-writer`'s
 * `rationale` → the learner). What was missing was **initiative and a reviewable object**: nothing
 * ever brought John to the queue. Across all 138 on-disk suggestions there were exactly 12 reasons
 * and 100% were machine-written.
 *
 * Step 2 (2026-08-15): the session no longer raises an "arm promotion" proposal. Under the purpose
 * frame (NORTH_STAR "Retrieval design intent", 2026-08-14) the retrieval tools are purpose-routed,
 * not rivals, so there is nothing to promote; the weekly report renders routing accuracy instead
 * (`weekly-report.ts`). The `arm-promotion` suggestion TYPE remains in `types.ts` so any historic
 * on-disk item still parses; nothing creates one any more.
 *
 * This module is the assembly point. It deliberately owns no storage and no second review path: it
 * reads through the existing store and writes through the existing `updateStatus` → outcome-writer
 * path, so a weekly verdict is indistinguishable downstream from a `scns review reject --reason` one.
 * (The `__fleet__` precedent: a parallel lane that duplicates an existing capability is a defect even
 * when it works.)
 */

import { randomUUID } from 'node:crypto'
import type { createSuggestionStore } from './suggestion-store.js'
import { type Suggestion, type SuggestionStatus } from './types.js'
import { selectWeeklyPacket, type WeeklyPacket } from './weekly-review.js'
import { isGateExhausted as isGateExhaustedItem } from './escalation.js'
import {
  formatReviewReason,
  parseReviewReason,
  isHumanReason,
  hasHumanRationale,
  hasSubstance,
  isDecision,
  type ReviewVerdict,
  type ReasonCode,
} from './review-reason.js'
import { assessEngagement, type EngagementAssessment, type ReviewRecord } from './rubber-stamp.js'
import { recordDecisionRationale } from '../memory/decision-rationale.js'
import type { Vault } from '../memory/vault.js'
import type { Database as DatabaseHandle } from 'better-sqlite3'

type Store = ReturnType<typeof createSuggestionStore>

/** Statuses that represent a decision the human has already made. */
const TERMINAL_STATUSES: readonly SuggestionStatus[] = [
  'rejected',
  'approved',
  'implemented',
  'needs-human',
]

export interface WeeklySessionInput {
  readonly store: Store
  readonly now: Date
  readonly budget?: number
}

export interface WeeklySession {
  readonly packet: WeeklyPacket
  readonly engagement: EngagementAssessment
  /** True when there is anything worth interrupting John for. */
  readonly hasWork: boolean
}

/**
 * Reconstruct the human's review history from the suggestions themselves.
 *
 * The store is the record — there is no separate review log, and adding one would create exactly the
 * dual-source-of-truth drift this codebase has been bitten by. Machine-written reasons (`qg-fail:*`,
 * `qg-pass`, executor notes) are excluded: counting them as engagement would let the quality gate's
 * own bookkeeping certify that the human is paying attention.
 */
function historyFrom(store: Store): ReviewRecord[] {
  const out: ReviewRecord[] = []
  for (const status of TERMINAL_STATUSES) {
    for (const s of store.list(status)) {
      // PROVENANCE, not content — `isHumanReason`, deliberately. A verdict code with no prose
      // after it (`human:cheap-win:`) is still a review that HAPPENED, and it is the strongest
      // rubber-stamp evidence there is: `assessEngagement` folds `text` into `meanReasonLength`
      // and `reasonEntropy`, so a wordless verdict drags the mean toward `lowEffort` — the exact
      // signal the anti-rubber-stamp guard exists to catch. Switching this to `hasHumanRationale`
      // would delete the CHEAPEST reviews from the sample and flatter the engagement statistics.
      //
      // RE-GRADE 2026-08-05 — correcting the claim made when the split was introduced. That commit
      // said this site "always fails safe toward blocking autonomy". It does NOT. `readyToEscalate`
      // is `sufficientData && !rubberStamping && disagreedRecently`, and `sufficientData` is
      // `n >= MIN_ASSESSABLE_REVIEWS` (5) — so at the boundary the wordless verdict is the 5th
      // record: n=4 EXCLUDED → `readyToEscalate: false`, n=5 INCLUDED → `readyToEscalate: true`.
      // Including it can UNBLOCK autonomy. The site is kept on provenance anyway because the
      // effect is two-sided and the balance favours it: past that boundary the same record pulls
      // `meanReasonLength` down toward `lowEffort`, which is the rubber-stamp evidence. Pinned by
      // "a wordless human verdict still counts as a review" in test/unit/suggest/weekly-session.
      if (!isHumanReason(s.reviewReason)) continue
      // RE-GRADE 2026-08-04 — read the verdict he gave, do not infer one from where the file sits.
      //
      // This was `status === 'rejected' ? 'reject' : 'approve'`, with `reviewVerdict` sitting on
      // the same file. Any refusal recorded against a status that cannot move — every escalated
      // reject, and every backfilled reject on already-shipped work — was counted as an APPROVAL.
      // `approvalRate` and `disagreedRecently` are the two inputs that block an autonomy raise, so
      // his refusals were pushing the system toward MORE autonomy. That is this phase's own defect
      // (a human decision read back as its opposite) surviving in a reader.
      //
      // `defer`/`explain` write a human reason too, but they are not decisions — banking them as
      // approvals inflates the very rate the anti-rubber-stamp guard exists to watch.
      const recorded = s.reviewVerdict
      if (recorded === 'defer' || recorded === 'explain') continue
      const verdict: ReviewRecord['verdict'] =
        recorded === 'reject' || recorded === 'approve'
          ? recorded
          : status === 'rejected'
            ? 'reject'
            : 'approve'
      const parsed = parseReviewReason(s.reviewReason!)
      out.push({
        verdict,
        code: parsed?.code ?? null,
        text: parsed?.text ?? '',
        at: s.reviewedAt ?? s.updatedAt,
      })
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at))
}

/**
 * Assemble everything worth John's attention this week. READ-ONLY over the store: it selects the
 * packet and assesses engagement; nothing is written until he answers.
 */
export function buildWeeklySession(input: WeeklySessionInput): WeeklySession {
  const { store, now } = input

  const pending = store.list('pending')
  const terminal = TERMINAL_STATUSES.flatMap((s) => store.list(s))
  const packet = selectWeeklyPacket({
    pending,
    terminal,
    now,
    ...(input.budget !== undefined ? { budget: input.budget } : {}),
  })
  const engagement = assessEngagement(historyFrom(store))

  return {
    packet,
    engagement,
    hasWork: packet.items.length > 0,
  }
}

export interface WeeklyReply {
  readonly verdict: ReviewVerdict
  readonly code: ReasonCode | null
  readonly text: string
}

export interface RecordResult {
  readonly ok: boolean
  readonly error?: string
  /**
   * FR-053: problems saving the rationale, surfaced to the caller so the review loop can tell John
   * WHILE HE IS STILL THERE. He has already spent the effort of typing; a silent infrastructure
   * failure is the same data loss by another route, arriving without the chance to retype.
   */
  readonly rationaleWarnings?: readonly string[]
  /**
   * FR-051a: his answer was recorded verbatim but will NOT reach the learning signal, because the
   * status it landed on denies it. Dropping it silently would be a quieter version of the bug this
   * epic exists to remove — he'd believe he had taught the system something he had not.
   */
  readonly verdictWarnings?: readonly string[]
  /** Where the verbatim rationale was saved, when it was. */
  readonly rationalePath?: string
}

/**
 * Where the rationale goes. Optional and INJECTED — `recordWeeklyVerdict` stays unit-testable and
 * the review loop keeps working when the vault is unavailable. An absent dependency produces an
 * explicit warning, never a silent skip.
 */
export interface WeeklyVerdictDeps {
  readonly vault?: Vault
  readonly db?: DatabaseHandle
  readonly now?: () => Date
}

/**
 * Record one verdict + reason through the EXISTING review path.
 *
 * Three rules are load-bearing:
 *
 * 1. **A verdict with no reason is refused.** The defining problem of the current corpus is 20
 *    rejections with no explanation; silently accepting a bare yes/no would add a 21st. Refusing is
 *    the honest outcome — the point of the whole exercise is the *why*, not the tally.
 * 2. **Backfill never re-decides SHIPPED work.** When the suggestion is `implemented`, its status is
 *    preserved and only the reason is attached: the work landed and no later verdict can un-ship it,
 *    so reopening it to record why it was settled would corrupt the very history being explained.
 *    This rule is deliberately narrower than "already terminal" — see the FR-058 comment below.
 *    `approved` and gate-escalated `needs-human` are both terminal-for-*listing* yet still live
 *    questions, and swallowing an answer to a live question is how an escalation became a dead end.
 * 3. **Approve and reject are captured SYMMETRICALLY** (FR-047). They are two halves of one
 *    measurement. A corpus holding only rejections teaches the learner what John dislikes and leaves
 *    it inferring why he accepted — and that inference is the specific harm he named.
 */
export function recordWeeklyVerdict(
  store: Store,
  id: string,
  reply: WeeklyReply,
  deps: WeeklyVerdictDeps = {},
): RecordResult {
  const existing = store.get(id)
  if (!existing) return { ok: false, error: `suggestion not found: ${id}` }

  // A NON-DECISION (`defer`, `explain`) changes no status and is never banked as an outcome.
  // Recording one as a rejection would teach the learner the idea was bad when the proposal text
  // was bad — the exact inversion the first live review exposed.
  if (!isDecision(reply.verdict)) {
    if (!hasSubstance(reply)) return { ok: true }
    const code = reply.verdict === 'explain' ? (reply.code ?? 'needs-explanation') : reply.code
    const note = formatReviewReason({ verdict: reply.verdict, code, text: reply.text })
    const updated = store.updateStatus(id, existing.status, note, undefined, {
      reviewVerdict: reply.verdict,
    })
    if (!updated) return { ok: false, error: `could not update suggestion: ${id}` }

    // Captured too — "all of my responses", not just the decisions. The suggestion stays pending,
    // so it comes round again, and the next verdict is ALSO a human reason and therefore overwrites
    // this one in the single `reviewReason` slot. Without this the explanation is gone the moment he
    // finally rules on it, which is the same erasure as the approvals, one seam over. Filed under
    // its own verdict so no consumer counting approvals or rejections can ever pick it up.
    const note_ = recordDecisionRationale(
      { ...(deps.vault ? { vault: deps.vault } : {}), ...(deps.db ? { db: deps.db } : {}), ...(deps.now ? { now: deps.now } : {}) },
      {
        suggestionId: id,
        title: existing.title,
        text: reply.text,
        author: 'human',
        reviewVerdict: 'explain',
        suggestionStatus: updated.status,
        code: reply.code ?? null,
      },
    )
    return {
      ok: true,
      ...(note_.markdownPath ? { rationalePath: note_.markdownPath } : {}),
      ...(note_.errors.length > 0 ? { rationaleWarnings: note_.errors } : {}),
    }
  }

  if (!hasSubstance(reply)) {
    return {
      ok: false,
      error: 'a verdict needs a reason — recording it without one would add another unexplained decision',
    }
  }
  const reason = formatReviewReason({
    verdict: reply.verdict,
    code: reply.code,
    text: reply.text,
  })

  // FR-058 / re-grade 2026-08-04 — an escalated proposal is a QUESTION ("retry it or close it"),
  // and a question is only answerable if both answers do something.
  //
  // The previous rule was `TERMINAL_STATUSES.includes(existing.status) ? existing.status : ...`.
  // `needs-human` and `approved` are both members, so BOTH answers were swallowed: approve printed
  // a success line and retried nothing; reject printed a success line and closed nothing, leaving
  // the item pinned at `priority: MAX_SAFE_INTEGER` — first — in every future packet, forever. The
  // pool was uncapped, so it could only grow.
  //
  // What is genuinely un-flippable is `implemented`: the work shipped and no verdict can un-ship
  // it, so a reject there is a backfilled opinion, recorded but not acted on. Everything else can
  // still move, and a REFUSAL must always be able to stop work — that is the same defect as
  // finding 1, one seam up.
  const isGateExhausted = isGateExhaustedItem(existing)

  const status: SuggestionStatus =
    existing.status === 'implemented'
      ? 'implemented'
      : reply.verdict === 'reject'
        ? 'rejected'
        : existing.status === 'rejected'
          ? // An approve on something he already refused does NOT silently reopen it; his earlier
            // refusal stands and the caller is warned (`contradicted`, below). Reviewed behaviour
            // under T130/FR-051b — preserved deliberately.
            'rejected'
          : isGateExhausted
            ? 'approved'
            : TERMINAL_STATUSES.includes(existing.status)
              ? existing.status
              : 'approved'

  const written = store.updateStatus(id, status, reason, undefined, {
    reviewVerdict: reply.verdict,
  })
  if (!written) return { ok: false, error: `could not update suggestion: ${id}` }

  // "Retry it" has to restore the retry BUDGET as well as the status. Without this the item comes
  // back at `attemptCount: 5` and goes terminal again on its next single failure — "terminal on
  // attempt one" through the back door, which is the harm this whole phase exists to remove.
  const updated =
    isGateExhausted && reply.verdict === 'approve' ? (store.clearBackoff(id) ?? written) : written

  // FR-045/FR-046/FR-047 — the durable capture, for APPROVE and REJECT alike.
  //
  // This is the moment the words exist and nothing else in the system will ever have them again:
  // `reviewReason` on the suggestion file is a single mutable slot (a later transition used to wipe
  // it outright, and `repromote()` still clears it by design), and `proposal_outcomes` only learns
  // of an approval if the proposal is later implemented. Capturing HERE makes the record independent
  // of whether the proposal ever ships — which is exactly FR-045's point.
  const rationale = recordDecisionRationale(
    { ...(deps.vault ? { vault: deps.vault } : {}), ...(deps.db ? { db: deps.db } : {}), ...(deps.now ? { now: deps.now } : {}) },
    {
      suggestionId: id,
      title: existing.title,
      text: reply.text,
      author: 'human',
      reviewVerdict: reply.verdict === 'approve' ? 'approve' : 'reject',
      // Stored ALONGSIDE the verdict because they diverge: a backfill onto an already-terminal item
      // keeps `implemented` as its status while the verdict John gave is `approve`. Counting
      // approvals by status would report zero on a week he approved everything.
      suggestionStatus: updated.status,
      code: reply.code ?? null,
    },
  )

  // FR-051a: he approved something the record already has as rejected — a backfill never re-decides,
  // so the status cannot move and nothing will be banked. Say so now, while he can act on it.
  const contradicted = reply.verdict === 'approve' && updated.status === 'rejected'

  return {
    ok: true,
    ...(rationale.markdownPath ? { rationalePath: rationale.markdownPath } : {}),
    ...(rationale.errors.length > 0 ? { rationaleWarnings: rationale.errors } : {}),
    ...(contradicted
      ? {
          verdictWarnings: [
            `this proposal is already recorded as rejected, so your approval will not count toward what the system learns — it is saved in full, but the earlier rejection stands. Re-run it as a fresh proposal if you want the approval to teach anything.`,
          ],
        }
      : {}),
  }
}

/** Stable id for one weekly review run, for correlating log lines. */
export function weeklyRunId(): string {
  return randomUUID()
}

/** How long the nudge stays quiet after a real, explained review. */
export const NUDGE_QUIET_DAYS = 7

/**
 * Terminal suggestions carrying a reason John actually wrote.
 *
 * This is the bridge that was missing. `reviewReason` reaches the LEARNER through
 * `recordSuggestionOutcome`, which — before this sweep existed — had exactly ONE caller: the
 * team-completion callback (`cli.ts:541`), which fires only after a suggestion was promoted and a
 * team RAN. A human rejection is never promoted, so no team ever runs, so the reason he took the
 * trouble to write stopped at the markdown file. Live evidence: the vault's `proposal_outcomes`
 * held exactly ONE row, and its rationale was `qg-fail:tests-failed` — the quality gate's, not a
 * human's.
 *
 * The sweep runs in the BROKER (which already owns the vault handle) rather than in the review CLI,
 * so there is no second writer on the vault, and `recordProposalOutcome` is idempotent on
 * (suggestion_id, entity, family), so re-sweeping the same history is a no-op.
 *
 * ⚠ KNOWN GAP, JUDGE 2026-08-05 (finding 4) — this sweep is now the SECOND caller, and the
 * `hasHumanRationale` filter below guards ONLY this one. The team-completion callback at
 * `cli.ts:541` is ungated and writes the same field through the same
 * `outcome-writer.ts:239  rationale: suggestion.reviewReason ?? null`. That matters specifically
 * because `cheap-win` is an APPROVE code: an approved wordless verdict IS promoted, a team DOES
 * run, `onOutcome` fires, and `'human:cheap-win:'` lands in `proposal_outcomes` raw — permanently,
 * by the same `ON CONFLICT … DO NOTHING` argued below. So the irreversibility invariant this
 * function enforces is not enforced on the path an approved wordless verdict actually takes.
 * Closing it is a BEHAVIOUR change with a real cost — that path also carries the team's `verdict`
 * and `score`, so suppressing the row would discard a genuine accept-vs-waste OUTCOME to avoid a
 * prose-free rationale. Escalated to John rather than decided here; deliberately left open.
 *
 * Note the existing contract this deliberately does not change: `statusToVerdict` treats `approved`
 * as non-terminal, so an approval reaches the learner when it is implemented or fails, not at the
 * moment of approval. Rejections — the reasons with the most information in them — land immediately.
 */
export function explainedTerminalSuggestions(store: Store): readonly Suggestion[] {
  // `hasHumanRationale`, not `isHumanReason`: a verdict code with no prose after it (`65a914f4`'s
  // `human:cheap-win:`) would otherwise land in `proposal_outcomes` attributed to John. Note what
  // would actually be stored — `outcome-writer.ts:239` writes `rationale: suggestion.reviewReason
  // ?? null`, i.e. the RAW string `'human:cheap-win:'`, not `''`.
  //
  // The reason to withhold it is not "training on nothing is worse than training on less" — it is
  // that the write is IRREVERSIBLE. `recordProposalOutcome` is
  // `ON CONFLICT(suggestion_id, entity, family) DO NOTHING` (memory/proposal-outcomes.ts:157), so
  // it is first-write-wins: sweeping now would lock a prose-free rationale in PERMANENTLY, and the
  // real explanation — the one the backfill pool exists to go and ask him for — could never
  // replace it. Withholding is the reversible choice; sweeping is not.
  //
  // The trade-off, stated plainly: this withholds a genuine accept-vs-waste LABEL, not merely the
  // prose. Impact today is ONE row. Live `proposal_outcomes` at 2026-08-05: 1 row, 0 blank
  // rationales, no row for `65a914f4` — nothing was poisoned, so there is nothing to remediate.
  return TERMINAL_STATUSES.flatMap((s) => store.list(s)).filter((s) =>
    hasHumanRationale(s.reviewReason),
  )
}

/**
 * A one-line prompt on the briefing when a review is genuinely due.
 *
 * Two conditions, both necessary. There must be pending work — nudging toward an empty queue trains
 * the human to ignore the line. And the last **human-explained** review must be at least a week old:
 * a machine reason (`qg-fail:*`) resets nothing, because the quality gate's bookkeeping is not
 * evidence that anyone looked. Returns null the rest of the time, which is most of the time — the
 * cost of an ignorable nudge is that the next real one is ignored too.
 */
export function buildWeeklyNudge(store: Store, now: Date): string | null {
  const pending = store.list('pending')
  if (pending.length === 0) return null

  const history = historyFrom(store)
  const last = history.at(-1)
  if (last) {
    const ageDays = (now.getTime() - new Date(last.at).getTime()) / 86_400_000
    if (ageDays < NUDGE_QUIET_DAYS) return null
  }

  const n = pending.length
  return `📋 ${n} proposal${n === 1 ? '' : 's'} waiting on your judgement — \`scns review weekly\` (I'll explain why I picked each one; telling me I'm wrong is the useful part).`
}
