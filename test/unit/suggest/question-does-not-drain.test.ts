/**
 * FR-071b — a QUESTION must not delete the item (issue #31).
 *
 * ## The defect
 *
 * `explain` and `defer` are non-decisions: `recordWeeklyVerdict` takes an early return for both that
 * deliberately preserves `status` while writing `reviewVerdict` and a `human:<code>: <prose>` reason
 * (`weekly-session.ts:257-267`). That single write trips TWO independent exclusions at once:
 *
 *  1. `matchesCensusSignature` required `reviewVerdict === undefined`, so any verdict — including a
 *     question — drained the reserved lane FR-071 built to hold the item.
 *  2. The backfill filter drops rows where `hasHumanRationale(reviewReason)` is true, and a question
 *     is prose, so it reads as explained.
 *
 * Both fire on the same keystroke, so the item leaves BOTH lanes simultaneously and never returns.
 * Measured before this change (T195 matrix, `files/t195-B-head-before-fix.txt`), a signature item
 * answered `explain` was `lane=NONE` at `rejected`, `implemented` AND `needs-human`.
 *
 * ## Why it is a policy, not a nit
 *
 * `weekly-review.ts:87` already documents the intent — *"Only `approve` and `reject` drain this pool;
 * `explain` and `skip` leave the item escalated"* — and four readers already agree that `defer` and
 * `explain` decide nothing (`review-reason.ts:58` `isDecision`, `weekly-session.ts:144`,
 * `weekly-review.ts:223`, `weekly-review.ts:182`). The two predicates above were the dissenters. The
 * first live review is on record as John answering every proposal with a question, so the seam closed
 * on the single most likely thing he does.
 *
 * ## The hole PRE-DATES Phase 11
 *
 * Verified in T195 against a pre-Phase-11 build (`51b36b9`): `rejected` + `explain` was already
 * INVISIBLE there. No cell went visible→invisible across PR #30. This is not a Phase 11 regression.
 */
import { describe, it, expect } from 'vitest'
import { selectWeeklyPacket, DEFAULT_BACKFILL_SLOTS } from '../../../src/suggest/weekly-review.js'
import { matchesCensusSignature } from '../../../src/suggest/escalation.js'
import type { Suggestion } from '../../../src/suggest/types.js'

let seq = 0
function sug(overrides: Partial<Suggestion> = {}): Suggestion {
  seq += 1
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    type: 'skill',
    title: `Suggestion ${seq}`,
    description: 'd',
    status: 'implemented',
    confidence: 0.5,
    evidence: [],
    tags: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    actionable: true,
    estimatedComplexity: 'solo',
    attemptCount: 0,
    lastError: null,
    lastAttemptAt: null,
    nextRetryAt: null,
    inflightTeamId: null,
    ...overrides,
  } as Suggestion
}

const NOW = new Date('2026-08-06T00:00:00.000Z')

/** A row carrying the SC-029 signature: a `qg-fail:*` machine verdict John has not re-decided. */
function signatureItem(overrides: Partial<Suggestion> = {}): Suggestion {
  return sug({
    status: 'rejected',
    machineReason: 'qg-fail:tests-failed',
    attemptCount: 0,
    ...overrides,
  })
}

/**
 * Exactly what the non-decision branch of `recordWeeklyVerdict` persists.
 *
 * `hasSubstance` gates that branch (`weekly-session.ts:258`), so a stored non-decision ALWAYS carries
 * prose — which is why `hasHumanRationale` returns true for it and why the backfill filter drops it.
 * `reviewedAt` is stamped because the author is human (`suggestion-store.ts:397`).
 */
const ANSWERED = {
  explain: {
    reviewVerdict: 'explain' as const,
    reviewReason: 'human:needs-explanation: why did the gate fail?',
    reviewedAt: '2026-08-05T00:00:00.000Z',
  },
  defer: {
    reviewVerdict: 'defer' as const,
    reviewReason: 'human:premature: not this week',
    reviewedAt: '2026-08-05T00:00:00.000Z',
  },
  approve: {
    reviewVerdict: 'approve' as const,
    reviewReason: 'human:cheap-win: worth shipping, do it',
    reviewedAt: '2026-08-05T00:00:00.000Z',
  },
  reject: {
    reviewVerdict: 'reject' as const,
    reviewReason: 'human:not-valuable: this will never pay off',
    reviewedAt: '2026-08-05T00:00:00.000Z',
  },
}

/** Every lane the packet can put an item in, or `NONE` when it surfaced nowhere. */
function laneOf(item: Suggestion, terminal: readonly Suggestion[] = []): string {
  const packet = selectWeeklyPacket({ pending: [], terminal: [item, ...terminal], now: NOW })
  return packet.items.find((i) => i.id === item.id)?.kind ?? 'NONE'
}

describe('FR-071b — the predicate agrees with the other four readers about non-decisions', () => {
  it('treats a QUESTION as leaving the signature standing', () => {
    // `isDecision` (review-reason.ts:58) has said this since the first live review produced five
    // questions and zero decisions. This predicate was the only reader that disagreed.
    expect(matchesCensusSignature(signatureItem(ANSWERED.explain))).toBe(true)
    expect(matchesCensusSignature(signatureItem(ANSWERED.defer))).toBe(true)
  })

  it('still treats a real DECISION as draining it (NEGATIVE CONTROL)', () => {
    // Without this the lane becomes one nothing ever leaves, and John is asked to re-decide things
    // he has already decided — FR-051/SC-025's failure, running in the opposite direction.
    expect(matchesCensusSignature(signatureItem(ANSWERED.approve))).toBe(false)
    expect(matchesCensusSignature(signatureItem(ANSWERED.reject))).toBe(false)
  })

  it('still requires the machine signature at all (NEGATIVE CONTROL)', () => {
    // A question about an ordinary proposal is not a census violation. Widening on the verdict must
    // not widen on the machineReason too.
    expect(matchesCensusSignature(sug({ machineReason: 'qg-pass', ...ANSWERED.explain }))).toBe(false)
    expect(matchesCensusSignature(sug({ machineReason: undefined, ...ANSWERED.explain }))).toBe(false)
  })
})

describe('FR-071b — a signature item answered with a QUESTION is still surfaced', () => {
  it('survives `explain` at every status the signature can sit in', () => {
    // Measured INVISIBLE at all three before this change (T195).
    expect(laneOf(signatureItem({ status: 'rejected', ...ANSWERED.explain }))).toBe('escalated')
    expect(laneOf(signatureItem({ status: 'implemented', ...ANSWERED.explain }))).toBe('escalated')
  })

  it('survives `defer` at every status the signature can sit in', () => {
    expect(laneOf(signatureItem({ status: 'rejected', ...ANSWERED.defer }))).toBe('escalated')
    expect(laneOf(signatureItem({ status: 'implemented', ...ANSWERED.defer }))).toBe('escalated')
  })

  it('survives a question on a `needs-human` row, which the lane predicate cannot reach', () => {
    // `escalationKindOf` classifies EVERY `needs-human` row, so `isGateEscalated` never consults
    // `matchesCensusSignature` for one (`weekly-review.ts:248`). A `gate-refused` row therefore
    // depends entirely on the BACKFILL filter, and a question drops it there. Fixing only the lane
    // predicate leaves this cell invisible — which is why the fix must land in both places.
    expect(laneOf(signatureItem({ status: 'needs-human' }))).toBe('backfill')
    expect(laneOf(signatureItem({ status: 'needs-human', ...ANSWERED.explain }))).toBe('backfill')
    expect(laneOf(signatureItem({ status: 'needs-human', ...ANSWERED.defer }))).toBe('backfill')
  })

  it('comes back on the NEXT sitting, not just the one he asked in', () => {
    // The defect's actual harm is permanence: the item never returns. Two consecutive selections a
    // week apart must both hold it.
    const asked = signatureItem(ANSWERED.explain)
    const nextWeek = new Date('2026-08-13T00:00:00.000Z')
    const packet = selectWeeklyPacket({ pending: [], terminal: [asked], now: nextWeek })

    expect(packet.items.map((i) => i.id)).toEqual([asked.id])
    expect(packet.totalEscalated).toBe(1)
  })

  it('is still counted exactly once across the two pools', () => {
    // The lane and the backfill pool must not both claim it — the CLI walks `items` by index, so a
    // duplicate means John answers the same proposal twice and the second answer overwrites the first.
    const asked = signatureItem(ANSWERED.explain)
    const packet = selectWeeklyPacket({ pending: [], terminal: [asked], now: NOW })

    expect(packet.items.filter((i) => i.id === asked.id)).toHaveLength(1)
    expect(packet.selectedEscalated).toBe(1)
    expect(packet.selectedBackfill).toBe(0)
    expect(packet.totalUnexplained).toBe(0)
  })
})

describe('FR-071b — a DECISION still drains both pools (NEGATIVE CONTROL)', () => {
  it('drops a signature item John approved', () => {
    expect(laneOf(signatureItem({ status: 'rejected', ...ANSWERED.approve }))).toBe('NONE')
    expect(laneOf(signatureItem({ status: 'implemented', ...ANSWERED.approve }))).toBe('NONE')
    expect(laneOf(signatureItem({ status: 'needs-human', ...ANSWERED.approve }))).toBe('NONE')
  })

  it('drops a signature item John rejected', () => {
    expect(laneOf(signatureItem({ status: 'rejected', ...ANSWERED.reject }))).toBe('NONE')
    expect(laneOf(signatureItem({ status: 'implemented', ...ANSWERED.reject }))).toBe('NONE')
    expect(laneOf(signatureItem({ status: 'needs-human', ...ANSWERED.reject }))).toBe('NONE')
  })

  it('still drops an item explained through the VERDICT-ABSENT seam', () => {
    // A human reason with no verdict field is a real, live shape — `lastHumanDecisionAt` treats it
    // as a decision (`weekly-review.ts:186`). Widening on non-decisions must not accidentally widen
    // to "any human prose", or every explained item in the store re-enters the queue forever.
    const explained = sug({
      status: 'rejected',
      reviewVerdict: undefined,
      reviewReason: 'human:not-valuable: we tried this in April and it went nowhere',
    })

    expect(laneOf(explained)).toBe('NONE')
  })

  it('does not turn the backfill pool into one nothing ever leaves', () => {
    // Positive control on the negative: ordinary decided rows must still drain, so the pool that
    // holds the questions is not simply every terminal row in the store.
    const decided = Array.from({ length: 5 }, () => sug({ status: 'rejected', ...ANSWERED.reject }))
    const packet = selectWeeklyPacket({ pending: [], terminal: decided, now: NOW })

    expect(packet.totalUnexplained).toBe(0)
    expect(packet.totalEscalated).toBe(0)
    expect(packet.items).toHaveLength(0)
  })

  it('does not let the questions starve the ordinary pools', () => {
    // T155's warning, one layer over: a lane that only grows eventually holds the whole window.
    const packet = selectWeeklyPacket({
      pending: [sug({ status: 'pending' }), sug({ status: 'pending' }), sug({ status: 'pending' })],
      terminal: [
        signatureItem(ANSWERED.explain),
        sug({ status: 'rejected' }),
        sug({ status: 'rejected' }),
      ],
      now: NOW,
    })

    expect(packet.selectedEscalated).toBe(1)
    expect(packet.selectedBackfill).toBe(DEFAULT_BACKFILL_SLOTS)
    expect(packet.selectedPending).toBeGreaterThan(0)
  })
})
