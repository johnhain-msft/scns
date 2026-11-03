import { describe, it, expect } from 'vitest'
import { selectWeeklyPacket, DEFAULT_WEEKLY_BUDGET } from '../../../src/suggest/weekly-review.js'
import type { Suggestion } from '../../../src/suggest/types.js'

let seq = 0
function sug(overrides: Partial<Suggestion> = {}): Suggestion {
  seq += 1
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    type: 'skill',
    title: `Suggestion ${seq}`,
    description: 'd',
    status: 'pending',
    confidence: 0.5,
    evidence: [],
    tags: [],
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
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

const NOW = new Date('2026-07-28T12:00:00.000Z')

describe('selectWeeklyPacket — budget', () => {
  it('never exceeds the weekly attention budget', () => {
    const pending = Array.from({ length: 40 }, () => sug())
    const p = selectWeeklyPacket({ pending, terminal: [], now: NOW })
    expect(p.items.length).toBeLessThanOrEqual(DEFAULT_WEEKLY_BUDGET)
    expect(DEFAULT_WEEKLY_BUDGET).toBeLessThanOrEqual(7)
  })

  it('honours an explicit smaller budget', () => {
    const pending = Array.from({ length: 10 }, () => sug())
    expect(selectWeeklyPacket({ pending, terminal: [], now: NOW, budget: 2 }).items).toHaveLength(2)
  })

  it('returns an empty packet for empty inputs (NEGATIVE CONTROL)', () => {
    const p = selectWeeklyPacket({ pending: [], terminal: [], now: NOW })
    expect(p.items).toHaveLength(0)
    expect(p.totalPending).toBe(0)
  })
})

describe('selectWeeklyPacket — uncertainty sampling', () => {
  it('prefers proposals nearest the auto-approve decision boundary', () => {
    const boundary = sug({ confidence: 0.8, title: 'BOUNDARY' })
    const obvious = sug({ confidence: 0.05, title: 'OBVIOUS-NO' })
    const certain = sug({ confidence: 0.99, title: 'OBVIOUS-YES' })
    const p = selectWeeklyPacket({
      pending: [obvious, certain, boundary],
      terminal: [],
      now: NOW,
      budget: 1,
      autoApproveThreshold: 0.8,
    })
    expect(p.items[0]?.title).toBe('BOUNDARY')
  })
})

describe('selectWeeklyPacket — category coverage (epistemic priority)', () => {
  it('prefers a type with NO human-labelled history over a well-covered one', () => {
    const covered = Array.from({ length: 6 }, () =>
      sug({ status: 'rejected', type: 'skill', reviewReason: 'human:already-exists: we have it' }),
    )
    const p = selectWeeklyPacket({
      pending: [sug({ type: 'skill', confidence: 0.8 }), sug({ type: 'mcp', confidence: 0.8 })],
      terminal: covered,
      now: NOW,
      budget: 1,
      autoApproveThreshold: 0.8,
    })
    expect(p.items[0]?.type).toBe('mcp')
  })
})

describe('selectWeeklyPacket — staleness (streaming-pool adaptation)', () => {
  it('prioritises a long-pending proposal over an identical fresh one', () => {
    const stale = sug({ createdAt: '2026-04-01T00:00:00.000Z', title: 'STALE', confidence: 0.8 })
    const fresh = sug({ createdAt: '2026-07-27T00:00:00.000Z', title: 'FRESH', confidence: 0.8 })
    const p = selectWeeklyPacket({
      pending: [fresh, stale],
      terminal: [],
      now: NOW,
      budget: 1,
      autoApproveThreshold: 0.8,
    })
    expect(p.items[0]?.title).toBe('STALE')
  })
})

describe('selectWeeklyPacket — backfill of unexplained history (FM-3)', () => {
  it('reserves slots for terminal proposals that carry NO human reason', () => {
    const unexplained = Array.from({ length: 5 }, () => sug({ status: 'rejected' }))
    const p = selectWeeklyPacket({
      pending: Array.from({ length: 10 }, () => sug()),
      terminal: unexplained,
      now: NOW,
      budget: 5,
      backfillSlots: 2,
    })
    expect(p.items.filter((i) => i.kind === 'backfill')).toHaveLength(2)
    expect(p.items.filter((i) => i.kind === 'pending')).toHaveLength(3)
  })

  it('NEVER re-asks about a proposal that already has a human reason (NEGATIVE CONTROL)', () => {
    const explained = sug({ status: 'rejected', reviewReason: 'human:premature: not yet' })
    const p = selectWeeklyPacket({ pending: [], terminal: [explained], now: NOW, backfillSlots: 3 })
    expect(p.items).toHaveLength(0)
  })

  it('treats a MACHINE reason as still unexplained — the gate is not John', () => {
    const machine = sug({ status: 'rejected', reviewReason: 'qg-fail:tests-failed' })
    const p = selectWeeklyPacket({ pending: [], terminal: [machine], now: NOW, backfillSlots: 3 })
    expect(p.items).toHaveLength(1)
    expect(p.items[0]?.kind).toBe('backfill')
  })

  it('prefers unexplained REJECTIONS over unexplained implementations', () => {
    const p = selectWeeklyPacket({
      pending: [],
      terminal: [sug({ status: 'implemented' }), sug({ status: 'rejected', title: 'REJ' })],
      now: NOW,
      backfillSlots: 1,
    })
    expect(p.items[0]?.title).toBe('REJ')
  })

  it('gives unused backfill slots back to pending items', () => {
    const p = selectWeeklyPacket({
      pending: Array.from({ length: 6 }, () => sug()),
      terminal: [],
      now: NOW,
      budget: 5,
      backfillSlots: 2,
    })
    expect(p.items).toHaveLength(5)
    expect(p.items.every((i) => i.kind === 'pending')).toBe(true)
  })
})

describe('selectWeeklyPacket — transparency + determinism', () => {
  it('explains why each item was selected (Amershi G14)', () => {
    const p = selectWeeklyPacket({ pending: [sug()], terminal: [], now: NOW })
    expect(p.items[0]?.why.length).toBeGreaterThan(0)
  })

  it('reports the queue size so the budget cap is explicit, not hidden (Settles 5.3)', () => {
    const p = selectWeeklyPacket({ pending: Array.from({ length: 43 }, () => sug()), terminal: [], now: NOW })
    expect(p.totalPending).toBe(43)
    expect(p.budget).toBe(DEFAULT_WEEKLY_BUDGET)
  })

  it('is deterministic — same input yields the same packet', () => {
    const pending = Array.from({ length: 12 }, (_, i) => sug({ confidence: i / 12 }))
    const a = selectWeeklyPacket({ pending, terminal: [], now: NOW })
    const b = selectWeeklyPacket({ pending, terminal: [], now: NOW })
    expect(a.items.map((i) => i.id)).toEqual(b.items.map((i) => i.id))
  })

  it('skips non-actionable advisory noise (NEGATIVE CONTROL)', () => {
    const p = selectWeeklyPacket({
      pending: [sug({ actionable: false })],
      terminal: [],
      now: NOW,
    })
    expect(p.items).toHaveLength(0)
  })
})

describe('selectWeeklyPacket — FR-041 population integrity (T096)', () => {
  it('sizes the pending queue with the SAME predicate the selection uses', () => {
    // Selection draws from `actionable !== false`; a denominator over the raw queue describes a
    // population the numerator was never taken from. The excluded items are DISCLOSED, not hidden —
    // hiding the count would defeat the disclosed-cap mechanism rather than fix it.
    const p = selectWeeklyPacket({
      pending: [
        ...Array.from({ length: 3 }, () => sug()),
        ...Array.from({ length: 2 }, () => sug({ actionable: false })),
      ],
      terminal: [],
      now: NOW,
      budget: 5,
    })
    expect(p.totalPending).toBe(3)
    expect(p.nonActionablePending).toBe(2)
    expect(p.items).toHaveLength(3)
  })

  it('never counts backfill items against the pending denominator (the "5 of 13" defect)', () => {
    // The live 2026-08-02 header read "5 of 13": 3 pending + 2 backfill over a pending-only
    // denominator. Numerator and denominator came from different populations — FR-041 exactly.
    const p = selectWeeklyPacket({
      pending: Array.from({ length: 13 }, () => sug()),
      terminal: Array.from({ length: 6 }, () =>
        sug({ status: 'rejected', reviewReason: undefined }),
      ),
      now: NOW,
      budget: 5,
      backfillSlots: 2,
    })
    expect(p.items).toHaveLength(5)
    expect(p.selectedPending).toBe(3)
    expect(p.selectedBackfill).toBe(2)
    expect(p.totalPending).toBe(13)
    expect(p.totalUnexplained).toBe(6)
    // The invariant, stated once: each numerator is a subset of the denominator it is printed against.
    expect(p.selectedPending).toBeLessThanOrEqual(p.totalPending)
    expect(p.selectedBackfill).toBeLessThanOrEqual(p.totalUnexplained)
    expect(p.selectedPending + p.selectedBackfill).toBe(p.items.length)
  })

  it('counts a non-actionable item in NEITHER numerator nor denominator (NEGATIVE CONTROL)', () => {
    const p = selectWeeklyPacket({
      pending: [sug({ actionable: false })],
      terminal: [],
      now: NOW,
    })
    expect(p.totalPending).toBe(0)
    expect(p.selectedPending).toBe(0)
    expect(p.nonActionablePending).toBe(1)
  })
})

/**
 * Live artefact `65a914f4`: John approved it (`human:cheap-win:`), the quality gate's build failed
 * (`machineReason: qg-fail:tests-failed`), and it ended terminal. The approve CODE survived but he
 * never wrote prose, so nothing on that file records WHY — which is exactly what the backfill pool
 * exists to collect. It counted as explained and was therefore never asked about again.
 *
 * FR-071 (2026-08-06) changed WHICH surface asks. That combination — a `qg-fail:*` machine verdict
 * with no standing human verdict — is the SC-029 census signature, and it is now taken out of the
 * backfill pool and put in the reserved lane instead. The reason is measured, not stylistic: in the
 * backfill pool this row scored 1.35, tied with 19 others at the staleness cap against 2 slots a
 * week, and the tie was broken by UUID. Being "in the pool" was not the same as being asked
 * (`docs/evidence/003-T150-backfill-baseline-2026-08-06.md` §2.5).
 *
 * Both halves are pinned below, because only one of them moved: a wordless verdict is STILL not an
 * explanation, and that is what made the item eligible for either surface in the first place.
 */
describe('the backfill pool asks about wordless verdicts (65a914f4 replay)', () => {
  it('treats a terminal item whose only reason is a wordless verdict as unexplained', () => {
    // No `qg-fail:` machine reason, so the reserved lane does not claim it and the original
    // invariant is asserted on its own: a verdict code with no prose explains nothing.
    const wordless = sug({
      status: 'rejected',
      reviewReason: 'human:cheap-win:',
      machineReason: 'machine:applied-and-verified: …',
    })
    const p = selectWeeklyPacket({ pending: [], terminal: [wordless], now: NOW })
    expect(p.items.filter((i) => i.kind === 'backfill').map((i) => i.id)).toContain(wordless.id)
    expect(p.totalUnexplained).toBe(1)
  })

  it('routes the full 65a914f4 shape to the reserved lane instead of the backfill queue (FR-071)', () => {
    const censusShape = sug({
      status: 'rejected',
      reviewReason: 'human:cheap-win:',
      machineReason: 'qg-fail:tests-failed',
    })
    const p = selectWeeklyPacket({ pending: [], terminal: [censusShape], now: NOW })

    expect(p.items.filter((i) => i.kind === 'escalated').map((i) => i.id)).toContain(censusShape.id)
    // Asked ONCE. The pools deliberately do not both claim it — answering the same proposal twice
    // in one sitting is how the second answer overwrote the first.
    expect(p.items.filter((i) => i.id === censusShape.id)).toHaveLength(1)
    expect(p.totalUnexplained).toBe(0)
    expect(p.totalEscalated).toBe(1)
  })

  it('still excludes an item he genuinely explained (NEGATIVE CONTROL)', () => {
    const explained = sug({
      status: 'rejected',
      reviewReason: 'human:none: not valuable, the harness already remembers the last model',
    })
    const p = selectWeeklyPacket({ pending: [], terminal: [explained], now: NOW })
    expect(p.items.map((i) => i.id)).not.toContain(explained.id)
    expect(p.totalUnexplained).toBe(0)
  })
})
