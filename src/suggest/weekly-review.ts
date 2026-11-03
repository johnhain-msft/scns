/**
 * THE WEEKLY REVIEW PACKET — choosing the handful of proposals worth John's attention.
 *
 * SCNS has 43 pending suggestions and a human with finite patience. Showing him all of them is the
 * same as showing him none, so this module is the query strategy: which few, this week, teach the
 * system the most per unit of his attention?
 *
 * ## What this implements, and what it honestly does NOT
 *
 * - **Uncertainty sampling (Settles 2009, *Active Learning Literature Survey*, §3.1).** The most
 *   informative proposal is the one nearest the decision boundary — here, the auto-approve
 *   threshold. A proposal at confidence 0.05 or 0.99 is one SCNS already effectively decides on its
 *   own; a proposal sitting on the threshold is one where John's label actually changes an outcome.
 * - **Coverage of under-labelled regions (the epistemic half of Houlsby et al. 2011, BALD,
 *   arXiv:1112.5745).** Priority goes to proposal types about which SCNS holds *no* human-labelled
 *   evidence at all.
 *   ⚠ **This is NOT BALD.** True BALD needs a posterior over model parameters and mutual information
 *   between predictions and that posterior. SCNS has no such model and no suggestion embeddings, so
 *   what is implemented is category-coverage as a computable stand-in for epistemic uncertainty. It
 *   is named honestly here rather than dressed in the paper's authority.
 * - **A hard, DISCLOSED attention budget (Settles 2009 §5.3).** {@link DEFAULT_WEEKLY_BUDGET} items.
 *   {@link WeeklyPacket.totalPending} is reported alongside so the cap is visible to John rather
 *   than silently hiding a 43-deep queue. Because that disclosure is the mechanism, its numerator and
 *   denominator must describe the SAME population — see {@link WeeklyPacket.selectedPending}.
 * - **Staleness weighting — an acknowledged INVENTION.** The active-learning literature assumes a
 *   static unlabelled pool; SCNS's queue is a stream where items age and rot. The research pass
 *   flagged this as a gap with no published answer, so the recency bonus below is our own
 *   construction, marked as such.
 * - **Backfill of unexplained history (KTO, Ethayarajh et al. 2024, FM-3).** Training on the
 *   existing reason-free, imbalanced corpus would teach spurious correlations, so a reserved slice
 *   of each week goes to *old* terminal proposals that never got a human reason — 30 rejections
 *   exist and 20 have no recorded why at all.
 *
 * Everything here is pure and deterministic: same inputs, same packet. No LLM, no network, no clock
 * beyond the injected `now`.
 */

import { escalationKindOf, isGateExhausted, matchesCensusSignature } from './escalation.js'
import type { Suggestion } from './types.js'
import { hasHumanRationale, isHumanReason, isNonDecision } from './review-reason.js'

/** How many proposals one weekly session may ask about. Small on purpose — attention is the budget. */
export const DEFAULT_WEEKLY_BUDGET = 5

/** How many of those slots are reserved for unexplained history rather than new proposals. */
export const DEFAULT_BACKFILL_SLOTS = 2

/** The auto-approve confidence gate this instance runs with (`SCNS_SUGGEST_AUTO_APPROVE_THRESHOLD`). */
export const DEFAULT_AUTO_APPROVE_THRESHOLD = 0.85

/** A proposal is "stale" — and starts earning the recency bonus — after this long unreviewed. */
export const STALE_AFTER_DAYS = 30

export type ReviewItemKind = 'pending' | 'backfill' | 'escalated'

export interface ReviewPacketItem {
  readonly id: string
  readonly kind: ReviewItemKind
  readonly type: string
  readonly title: string
  readonly status: string
  readonly confidence: number
  readonly createdAt: string
  /** The score that earned this slot — kept for auditability, not display. */
  readonly priority: number
  /** Why THIS item is in front of John this week (Amershi et al. 2019, guideline G14). */
  readonly why: string
}

export interface WeeklyPacket {
  readonly items: readonly ReviewPacketItem[]
  /**
   * Items taken from the PENDING pool — the numerator that belongs with {@link totalPending}.
   *
   * FR-041: `items` merges two populations, so `items.length` is not a fraction of anything. The
   * 2026-08-02 artefact read "5 of 13 pending item(s)" where the 5 was 3 pending + 2 backfill; it
   * escaped notice only because 5 <= 13. Each pool now carries its own numerator.
   */
  readonly selectedPending: number
  /** Items taken from the BACKFILL pool — the numerator that belongs with {@link totalUnexplained}. */
  readonly selectedBackfill: number
  /** FR-058 — proposals the gate exhausted its retry budget on, awaiting John's decision. */
  readonly selectedEscalated: number
  /**
   * Escalated queue depth — the denominator for {@link selectedEscalated}.
   *
   * Only `approve` and `reject` drain this pool; `explain` and `skip` leave the item escalated, and
   * auto-approval can produce escalations with no human involved. So the queue can exceed what one
   * sitting shows, and FR-041 requires saying so rather than printing a capped numerator alone.
   */
  readonly totalEscalated: number
  /**
   * Pending queue depth over the SAME predicate the selection uses (`actionable !== false`), so the
   * disclosed cap reads as a true fraction of the queue it was drawn from (FR-041).
   */
  readonly totalPending: number
  /**
   * Pending proposals excluded from selection as non-actionable.
   *
   * Reported rather than dropped: narrowing the denominator without saying what left it would trade
   * one silent count for another, and the disclosed cap is the only thing that makes a capped packet
   * honest.
   */
  readonly nonActionablePending: number
  /** How many terminal proposals still carry no human reason. */
  readonly totalUnexplained: number
  readonly budget: number
}

export interface WeeklyPacketInput {
  readonly pending: readonly Suggestion[]
  /** Terminal proposals (implemented / rejected / needs-human) — the backfill pool. */
  readonly terminal: readonly Suggestion[]
  readonly now: Date
  readonly budget?: number
  readonly backfillSlots?: number
  readonly autoApproveThreshold?: number
}

function daysBetween(now: Date, iso: string): number {
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return 0
  return Math.max(0, (now.getTime() - then) / 86_400_000)
}

/**
 * How much human-labelled evidence exists for a proposal type. Only reasons John actually wrote
 * count: a `qg-fail:*` reason is the quality gate's opinion, and treating it as human coverage would
 * convince SCNS it had been taught about a category nobody ever discussed with it.
 */
function humanLabelCountsByType(terminal: readonly Suggestion[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const s of terminal) {
    if (!hasHumanRationale(s.reviewReason)) continue
    counts.set(s.type, (counts.get(s.type) ?? 0) + 1)
  }
  return counts
}

/** Uncertainty sampling: 1 at the decision boundary, decaying to 0 at the extremes. */
function boundaryProximity(confidence: number, threshold: number): number {
  const span = Math.max(threshold, 1 - threshold, 1e-6)
  return Math.max(0, 1 - Math.abs(confidence - threshold) / span)
}

/** Coverage priority: full weight for a type SCNS has never been taught about, decaying with each label. */
function coverageNeed(type: string, counts: Map<string, number>): number {
  return 1 / (1 + (counts.get(type) ?? 0))
}

/** INVENTED (see module header): linear ramp from 0 to 1 over {@link STALE_AFTER_DAYS}, then capped. */
function staleness(now: Date, createdAt: string): number {
  return Math.min(1, daysBetween(now, createdAt) / STALE_AFTER_DAYS)
}

/**
 * When did a HUMAN last DECIDE this — or `null` if no such decision survives on the file (FR-070).
 *
 * The backfill pool asks "why did you decide this?", so the clock it runs is "how long has that
 * answer been missing". Reading `updatedAt` instead measured something else entirely: how long since
 * ANY writer touched the file. Measured on the live store 2026-08-06, that is not a subtle
 * difference — the quality gate's own write bumped `65a914f4`'s `updatedAt` to an hour before the
 * probe, scoring the one item most in need of John's judgement as freshly attended and ranking it
 * **107 of 107**, a ~54-week wait against two slots a week
 * (`docs/evidence/003-T150-backfill-baseline-2026-08-06.md`).
 *
 * Three rules, and each one is a requirement rather than a taste:
 *
 *  - **A machine write is not a decision (FR-070b).** A1 names "a machine judgement standing in for
 *    a human one" as this feature's defining failure class, and a gate's write is precisely *not*
 *    evidence that John attended to the item. `updateStatus` no longer stamps `reviewedAt` for a
 *    machine author, so this field now means what its name says.
 *  - **`defer` and `explain` are not decisions.** `recordWeeklyVerdict` preserves the status for
 *    both (`weekly-session.ts`) exactly because they are the human saying he has NOT decided. Same
 *    rule `historyFrom` already applies when reconstructing his review history; stating it twice in
 *    two ways is how two readers start disagreeing about one file.
 *  - **No verdict and no human reason ⇒ `null` ⇒ maximally stale (FR-070a).** A destroyed verdict
 *    means the human has, in effect, never decided it. Returning `null` rather than falling back to
 *    `createdAt` is the difference between "he has not looked at this in a while" and "there is no
 *    record he ever looked at it", and only the second one belongs at the top of this queue.
 */
function lastHumanDecisionAt(s: Suggestion): string | null {
  const decided =
    s.reviewVerdict === 'approve' ||
    s.reviewVerdict === 'reject' ||
    (s.reviewVerdict === undefined && isHumanReason(s.reviewReason))
  if (!decided) return null
  // A decision with no timestamp is a decision we cannot date. Treating an unknown date as "now"
  // would let a missing field buy an item a fresh clock, which is the defect running backwards.
  return s.reviewedAt ?? null
}

/** Staleness for the backfill pool: measured from the last surviving human decision (FR-070). */
function decisionStaleness(now: Date, s: Suggestion): number {
  const at = lastHumanDecisionAt(s)
  return at === null ? 1 : staleness(now, at)
}

const W_UNCERTAINTY = 1.0
const W_COVERAGE = 0.6
const W_STALENESS = 0.35

/**
 * Did a HUMAN approve this, or did auto-approval?
 *
 * `SCNS_SUGGEST_AUTO_APPROVE_THRESHOLD` is live on the plist and auto-approval writes
 * `updateStatus(id, 'approved')` with no verdict and no reason (`agent-loop.ts:1102`), so an
 * escalated proposal can reach John's packet with nobody having looked at it. Telling him "you
 * approved this" about that item is a false attributed endorsement, delivered exactly when he is
 * deciding whether to spend more machine time on it — and it is the same who-decided-what
 * conflation this phase exists to remove, running in the opposite direction.
 *
 * Pass 5: the `human:` disjunct existed for a real case — a human reason written through a seam
 * with no verdict field — but on its own it also captured a QUESTION. `recordWeeklyVerdict`'s
 * non-decision branch (`weekly-session.ts:243`) writes `human:needs-explanation: …` for `explain`
 * and `human:<code>: …` for `defer` while deliberately leaving the status alone, so an item John
 * merely asked about was rendered back to him as an endorsement he never gave. That is the same
 * defect this docblock describes, reintroduced one line below it — and it is not hypothetical: the
 * first live review is on record as him answering every proposal with a question. The reason-sniff
 * now applies only when the verdict is ABSENT; a present verdict speaks for itself, and a
 * non-decision verdict says plainly that he did not decide.
 */
function wasHumanApproved(s: Suggestion): boolean {
  if (s.reviewVerdict !== undefined) return s.reviewVerdict === 'approve'
  return s.reviewReason?.startsWith('human:') === true
}

/**
 * A proposal the quality gate GAVE UP on, or one it labelled on John's behalf (FR-056b, FR-071).
 *
 * Two predicates, composed rather than merged, and the order matters:
 *
 *  - {@link escalationKindOf} owns every row it can classify — that is, every `needs-human` row.
 *    `needs-human` carries two meanings and only `gate-exhausted` belongs in this pool; widening
 *    that classification would change what `repromote` and proposal triage do with the same file.
 *  - For every OTHER status it returns `null`, and that is the hole FR-071 exists to close. The
 *    SC-029 census defines its signature at `status: rejected` (`qg-mislabel-census.ts`), so a
 *    census violation was disjoint from this pool by construction — "there is no seam that puts it
 *    back in front of John", as T149 recorded about a live artefact. {@link matchesCensusSignature}
 *    is that seam.
 *
 * A second, parallel lane was rejected deliberately: the escalated pool below already surfaces at
 * `Number.MAX_SAFE_INTEGER` with a deterministic tie-break and a disclosed cap, and every row
 * carrying the signature in the live store on 2026-08-06 was already in it. Duplicating it would
 * reintroduce the "readers drift and disagree about the same file" failure `escalation.ts` was
 * created to remove, to serve a population of zero.
 */
function isGateEscalated(s: Suggestion): boolean {
  return escalationKindOf(s) !== null ? isGateExhausted(s) : matchesCensusSignature(s)
}

/**
 * Has a HUMAN DECISION explained this row? (FR-071b, issue #31)
 *
 * The backfill pool's whole job is finding terminal items John never explained, and it read
 * `hasHumanRationale(s.reviewReason)` alone. That is the right question about the reason and the
 * wrong question about the item: `recordWeeklyVerdict` writes a `human:<code>: <prose>` reason for
 * `explain` and `defer` too (`weekly-session.ts:257-267`), so ASKING about an item made it read as
 * explained and dropped it from the one pool built to bring unexplained items back.
 *
 * That is the second half of the disappearance. {@link matchesCensusSignature} covers the reserved
 * lane, but `isGateEscalated` never consults it for a `needs-human` row — `escalationKindOf`
 * classifies every one of those — so a `gate-refused` row answered with a question depends entirely
 * on this filter. Fixing only the lane predicate leaves those rows invisible; measured in
 * `docs/evidence/003-T195-T198-explain-defer-hole-2026-08-06.md` §3.1.
 *
 * The verdict-ABSENT case is deliberately still explained. A `human:` reason with no `reviewVerdict`
 * is a real live shape written through a seam that has no verdict field, and {@link
 * lastHumanDecisionAt} already banks it as a decision (`:186`). Widening to "any human prose is only
 * an explanation when a verdict says so" would put every one of those rows back in the queue
 * permanently — a pool nothing ever leaves, which is T155's starvation warning one layer over.
 */
function isExplainedByHuman(s: Suggestion): boolean {
  return hasHumanRationale(s.reviewReason) && !isNonDecision(s.reviewVerdict)
}

/**
 * Choose this week's proposals.
 *
 * Non-actionable suggestions are excluded outright — the existing pipeline already treats them as
 * advisory noise that the promoter ignores, and spending John's scarce attention on something the
 * system will never act on is the worst possible use of the budget.
 */
export function selectWeeklyPacket(input: WeeklyPacketInput): WeeklyPacket {
  const budget = Math.max(0, input.budget ?? DEFAULT_WEEKLY_BUDGET)
  const backfillSlots = Math.max(0, input.backfillSlots ?? DEFAULT_BACKFILL_SLOTS)
  const threshold = input.autoApproveThreshold ?? DEFAULT_AUTO_APPROVE_THRESHOLD
  const counts = humanLabelCountsByType(input.terminal)

  const actionablePending = input.pending.filter((s) => s.actionable !== false)

  const pendingScored = actionablePending
    .map((s) => {
      const u = boundaryProximity(s.confidence, threshold)
      const c = coverageNeed(s.type, counts)
      const st = staleness(input.now, s.createdAt)
      const reasons: string[] = []
      if (u > 0.75) reasons.push('sits on the auto-approve boundary — your call actually changes the outcome')
      if ((counts.get(s.type) ?? 0) === 0) reasons.push(`no human-labelled history for type "${s.type}" yet`)
      if (st >= 1) reasons.push(`pending ${Math.round(daysBetween(input.now, s.createdAt))} days`)
      return {
        item: {
          id: s.id,
          kind: 'pending' as const,
          type: s.type,
          title: s.title,
          status: s.status,
          confidence: s.confidence,
          createdAt: s.createdAt,
          priority: W_UNCERTAINTY * u + W_COVERAGE * c + W_STALENESS * st,
          why: reasons.length > 0 ? reasons.join('; ') : 'next in the pending queue',
        },
      }
    })
    .sort((a, b) => b.item.priority - a.item.priority || a.item.id.localeCompare(b.item.id))

  // Backfill pool: terminal proposals with NO human reason. A machine `qg-fail:*` reason does not
  // count as explained — that is the quality gate's verdict, not John's, and conflating the two is
  // exactly how the learner would end up modelling the test suite instead of the human. Neither
  // does a QUESTION: `explain`/`defer` write prose and decide nothing, so `isExplainedByHuman`
  // reads the verdict beside the reason rather than the reason alone (FR-071b).
  //
  // Escalated items are excluded even when they have no human reason. An AUTO-approved proposal
  // that exhausts its budget has only `qg-fail:*` on it, so it qualified for both pools and was
  // presented TWICE in one sitting — the CLI walks `items` by index, so John answered the same
  // proposal twice and the second answer overwrote the first, while `selectedBackfill` and
  // `totalUnexplained` both double-counted it. They are one question, and the escalated pool asks
  // the better version of it.
  const escalatedIds = new Set(input.terminal.filter(isGateEscalated).map((s) => s.id))
  const unexplained = input.terminal.filter(
    (s) => !isExplainedByHuman(s) && !escalatedIds.has(s.id),
  )
  const backfillScored = unexplained
    .map((s) => {
      // Rejections first: an unexplained "no" is the single most informative missing label, and the
      // corpus is already skewed toward implementations.
      const rejectionBonus = s.status === 'rejected' ? 1 : 0
      const age = decisionStaleness(input.now, s)
      const undecided = lastHumanDecisionAt(s) === null
      return {
        item: {
          id: s.id,
          kind: 'backfill' as const,
          type: s.type,
          title: s.title,
          status: s.status,
          confidence: s.confidence,
          createdAt: s.createdAt,
          priority: rejectionBonus + W_STALENESS * age,
          why: undecided
            ? `no decision of yours survives on this — ${Math.round(daysBetween(input.now, s.createdAt))} days since it was raised`
            : s.status === 'rejected'
              ? 'you rejected this and never said why — that missing reason is the strongest signal we lack'
              : 'this landed without a recorded reason',
        },
      }
    })
    // THIRD KEY IS THE FIX, and it is not cosmetic. `priority` saturates: staleness caps at
    // STALE_AFTER_DAYS and FR-070 puts every undecided item at the cap, so large groups score
    // IDENTICALLY. Measured on the live store 2026-08-06, before this change: 20 items tied at
    // exactly 1.350000 against DEFAULT_BACKFILL_SLOTS = 2, ordered by `id` — a random v4 UUID that
    // never changes — so the same two won every week and the other 18 were unreachable, including
    // the genuinely oldest item in the pool. That is the escalated lane's own "FOURTH PASS" defect
    // (see its `sortKey` note below) living one pool over, and FR-070 makes the ties BIGGER.
    //
    // `createdAt` rather than `updatedAt`: `updatedAt` is bumped by machine writes, which is the
    // very input FR-070 just removed from the score. Reintroducing it as the tie-break would hand
    // the ordering back to the quality gate. `id` remains last so the sort stays total.
    .sort(
      (a, b) =>
        b.item.priority - a.item.priority ||
        a.item.createdAt.localeCompare(b.item.createdAt) ||
        a.item.id.localeCompare(b.item.id),
    )

  const backfillTake = Math.min(backfillSlots, backfillScored.length, budget)
  const chosenBackfill = backfillScored.slice(0, backfillTake).map((x) => x.item)

  // FR-058 — proposals the gate gave up on. These need a DECISION ("try again" or "close it"),
  // not a backfilled reason, so they are their own pool rather than part of the backfill one.
  //
  // They would otherwise be invisible, and invisible for an actively perverse reason: the backfill
  // pool selects terminal items with NO human reason, and an escalated item HAS one — John's
  // original approval, which Phase 10f exists to preserve. Succeeding at protecting his words was
  // therefore enough to hide the item from the surface built to show him things. `hasWork` gates
  // whether the review window opens at all, so nothing would have opened.
  //
  // CAPPED, with the remainder disclosed. An earlier version left this pool unbounded on the
  // grounds that "both answers now drain it" — which was false: the CLI offers FOUR answers
  // (approve / reject / explain / skip) and only two drain. `skip` never records a verdict at all
  // and `explain` takes the non-decision early return, which preserves the status, so the item
  // stays escalated. Auto-approval is live on the plist, so escalations are PRODUCED with no human
  // in the loop while draining requires one — the pool grows on its own. Measured at 41 items, all
  // rendered ahead of the budget-capped pools.
  //
  // The cap is not silent: `totalEscalated` is reported and printed beside it, because silently
  // truncating "the machine gave up on your approved work" is the failure this pool exists to fix.
  const allEscalated: readonly Suggestion[] = input.terminal.filter(isGateEscalated)
  const escalated: ReviewPacketItem[] = allEscalated
    .map((s) => ({
      id: s.id,
      kind: 'escalated' as const,
      type: s.type,
      title: s.title,
      status: s.status,
      confidence: s.confidence,
      createdAt: s.createdAt,
      priority: Number.MAX_SAFE_INTEGER,
      why: wasHumanApproved(s)
        ? `you approved this and the build failed ${s.attemptCount ?? 0}× (${s.machineReason ?? 'qg-fail'}) — retry it or close it`
        : `auto-approved at confidence ${s.confidence.toFixed(2)} — nobody reviewed it — and the build failed ${s.attemptCount ?? 0}× (${s.machineReason ?? 'qg-fail'}) — retry it or close it`,
      // FOURTH PASS — longest-waiting first, then id purely to break ties deterministically.
      //
      // This was `.sort(by id)`, and an id is a random v4 UUID that never changes. Combined with
      // the cap and the fact that `explain`/`skip` do NOT drain this pool, the same `budget` items
      // held the entire window every single week and everything behind them was unreachable —
      // §10.6's "the escalation had no delivery path", restored for the tail. `updatedAt` moves
      // whenever John records anything against an item, so answering rotates it to the back and the
      // queue drains in age order instead of UUID order.
      sortKey: s.updatedAt,
    }))
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey) || a.id.localeCompare(b.id))
    .slice(0, budget)
    .map(({ sortKey: _sortKey, ...item }) => item)

  // Unused backfill slots are NOT wasted — they revert to pending proposals.
  const pendingTake = Math.max(0, budget - chosenBackfill.length)
  const chosenPending = pendingScored.slice(0, pendingTake).map((x) => x.item)

  // FR-041: every printed count comes from the population it claims to describe. `items` spans two
  // pools, so each pool reports its own numerator, and the pending denominator is the ACTIONABLE
  // queue — the one selection actually drew from — with the excluded remainder disclosed beside it.
  return {
    items: [...escalated, ...chosenPending, ...chosenBackfill],
    selectedPending: chosenPending.length,
    selectedBackfill: chosenBackfill.length,
    selectedEscalated: escalated.length,
    totalEscalated: allEscalated.length,
    totalPending: actionablePending.length,
    nonActionablePending: input.pending.length - actionablePending.length,
    totalUnexplained: unexplained.length,
    budget,
  }
}
