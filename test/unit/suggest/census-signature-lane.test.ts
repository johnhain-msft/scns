/**
 * FR-071 — the reserved lane for the SC-029 census signature, and the tie-break behind it.
 *
 * ## Why this widens the EXISTING lane instead of adding one
 *
 * T155 reads "reserved lane … surface items whose `machineReason` begins `qg-fail:` with no standing
 * human verdict, regardless of score". A lane that does that already exists: `weekly-review.ts`
 * surfaces `isGateEscalated` items at `Number.MAX_SAFE_INTEGER` with a deterministic tie-break and a
 * disclosed cap. Measured 2026-08-06, all 9 rows carrying the signature in the live store were
 * already in it (`docs/evidence/003-T150-backfill-baseline-2026-08-06.md` §2.3). Building a second
 * lane would serve a population of zero while reintroducing the "duplicated readers drift and
 * disagree about the same file" failure `escalation.ts:14-18` exists to eliminate.
 *
 * The real hole is narrower and structural: `escalationKindOf` returns `null` for every
 * `status !== 'needs-human'`, while the census defines the signature ONLY at `status: rejected`
 * (`qg-mislabel-census.ts:31`). The two predicates are disjoint by construction, so a census
 * violation could never reach the lane — which is exactly why T149 was unsatisfiable. These tests
 * pin the widening, and pin that it does not disturb the `needs-human` classification `repromote`
 * and triage depend on.
 *
 * ## The tie-break
 *
 * FR-070 moves more items to the staleness cap, so ties get bigger, not smaller. Measured on the
 * live store BEFORE any change here: 20 backfill items already sit at priority exactly 1.350000
 * against 2 slots, ordered by `id.localeCompare` — a random v4 UUID that never changes — so the same
 * two win every week and 18 are unreachable. That is the same defect the escalated lane's own
 * "FOURTH PASS" note fixed (`weekly-review.ts:317-323`), still live one pool over.
 */
import { describe, it, expect } from 'vitest'
import { selectWeeklyPacket, DEFAULT_BACKFILL_SLOTS } from '../../../src/suggest/weekly-review.js'
import { escalationKindOf, isGateExhausted, matchesCensusSignature } from '../../../src/suggest/escalation.js'
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

/** The exact live shape T149 was blocked on: the gate wrote `rejected` over John's approval. */
function censusViolation(overrides: Partial<Suggestion> = {}): Suggestion {
  return sug({
    status: 'rejected',
    machineReason: 'qg-fail:tests-failed',
    reviewReason: 'human:cheap-win:',
    reviewVerdict: undefined,
    attemptCount: 0,
    ...overrides,
  })
}

describe('FR-071 — the census signature is one predicate, not five inline sniffs', () => {
  it('matches the signature regardless of which status directory the row sits in', () => {
    expect(matchesCensusSignature(censusViolation({ status: 'rejected' }))).toBe(true)
    expect(matchesCensusSignature(censusViolation({ status: 'needs-human' }))).toBe(true)
    expect(matchesCensusSignature(censusViolation({ status: 'implemented' }))).toBe(true)
  })

  it('does NOT match a row carrying a standing human verdict (NEGATIVE CONTROL)', () => {
    // John really did reject it after the gate failed. Re-surfacing that would ask him to decide
    // something he has already decided, and FR-051/SC-025 forbid re-deriving what he meant.
    expect(matchesCensusSignature(censusViolation({ reviewVerdict: 'reject' }))).toBe(false)
    expect(matchesCensusSignature(censusViolation({ reviewVerdict: 'approve' }))).toBe(false)
  })

  it('does NOT match a row the machine never failed on (NEGATIVE CONTROL)', () => {
    expect(matchesCensusSignature(censusViolation({ machineReason: 'qg-pass' }))).toBe(false)
    expect(matchesCensusSignature(censusViolation({ machineReason: undefined }))).toBe(false)
  })

  it('leaves the needs-human classification untouched', () => {
    // `repromote` and proposal triage branch on this; widening the LANE must not widen this.
    expect(escalationKindOf(censusViolation({ status: 'rejected' }))).toBeNull()
    expect(escalationKindOf(censusViolation({ status: 'implemented' }))).toBeNull()
    expect(escalationKindOf(sug({ status: 'needs-human', escalation: 'gate-refused' }))).toBe('gate-refused')
    expect(isGateExhausted(censusViolation({ status: 'rejected' }))).toBe(false)
  })
})

describe('FR-071 — the reserved lane surfaces the signature regardless of score', () => {
  it('surfaces a rejected census violation that the backfill ranking buries', () => {
    // 200 rejections that all outrank it on score. Only a reserved lane can reach it.
    const noise = Array.from({ length: 200 }, () => sug({ status: 'rejected' }))
    const buried = censusViolation({ createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() })

    const packet = selectWeeklyPacket({ pending: [], terminal: [...noise, buried], now: NOW })
    const item = packet.items.find((i) => i.id === buried.id)

    expect(item, 'the census violation never reached the packet').toBeDefined()
    expect(item!.kind).toBe('escalated')
    expect(item!.priority).toBe(Number.MAX_SAFE_INTEGER)
    expect(packet.totalEscalated).toBe(1)
  })

  it('counts it once — the lane and the backfill pool must not both claim it', () => {
    const buried = censusViolation()
    const packet = selectWeeklyPacket({ pending: [], terminal: [buried], now: NOW })

    expect(packet.items.filter((i) => i.id === buried.id)).toHaveLength(1)
    expect(packet.totalUnexplained).toBe(0)
    expect(packet.selectedBackfill).toBe(0)
    expect(packet.selectedEscalated).toBe(1)
  })

  it('renders honestly when the lane is EMPTY (NEGATIVE CONTROL)', () => {
    const packet = selectWeeklyPacket({
      pending: [],
      terminal: [sug({ status: 'rejected' }), sug({ status: 'implemented' })],
      now: NOW,
    })

    expect(packet.selectedEscalated).toBe(0)
    expect(packet.totalEscalated).toBe(0)
    expect(packet.items.filter((i) => i.kind === 'escalated')).toHaveLength(0)
  })

  it('discloses the remainder when it holds MORE items than slots', () => {
    // The live shape: 9 signature rows against a 5-item budget. A capped numerator printed without
    // its denominator is FR-041's wrong-denominator defect one layer up.
    const nine = Array.from({ length: 9 }, (_, i) =>
      censusViolation({ status: 'needs-human', escalation: 'gate-exhausted', updatedAt: `2026-0${i + 1}-01T00:00:00.000Z` }),
    )
    const packet = selectWeeklyPacket({ pending: [], terminal: nine, now: NOW, budget: 5 })

    expect(packet.totalEscalated).toBe(9)
    expect(packet.selectedEscalated).toBe(5)
    expect(packet.totalEscalated).toBeGreaterThan(packet.selectedEscalated)
  })

  it('orders the lane longest-waiting first, not by UUID', () => {
    const oldest = censusViolation({ id: 'ffffffff-0000-4000-8000-000000000001', updatedAt: '2026-01-01T00:00:00.000Z' })
    const newest = censusViolation({ id: '00000000-0000-4000-8000-0000000000ff', updatedAt: '2026-07-01T00:00:00.000Z' })

    const packet = selectWeeklyPacket({ pending: [], terminal: [newest, oldest], now: NOW, budget: 1 })

    expect(packet.items.filter((i) => i.kind === 'escalated').map((i) => i.id)).toEqual([oldest.id])
  })
})

describe('FR-071 — ties between maximally stale items are explainable, not UUID order', () => {
  it('drains the tied bucket oldest-first', () => {
    // Measured live: 20 items tie at priority 1.350000 against 2 slots, and `id.localeCompare`
    // picked the same two every week while the genuinely oldest item was unreachable. UUID order
    // and age order are deliberately opposed here, so only an age tie-break can pass.
    const tied = Array.from({ length: 20 }, (_, i) =>
      sug({
        // Ascending UUID == DESCENDING age: the youngest item sorts first by id.
        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        status: 'rejected',
        reviewVerdict: undefined,
        reviewReason: undefined,
        createdAt: new Date(Date.UTC(2026, 0, 20 - i)).toISOString(),
        updatedAt: new Date(Date.UTC(2026, 0, 20 - i)).toISOString(),
      }),
    )

    const packet = selectWeeklyPacket({ pending: [], terminal: tied, now: NOW })
    const chosen = packet.items.filter((i) => i.kind === 'backfill').map((i) => i.id)

    expect(chosen).toHaveLength(DEFAULT_BACKFILL_SLOTS)
    // The two OLDEST are the last two by id — the exact pair UUID order could never reach.
    expect(chosen).toEqual([tied[19]!.id, tied[18]!.id])
  })

  it('is still total and deterministic when ages tie exactly (POSITIVE CONTROL)', () => {
    const same = { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }
    const a = sug({ id: '00000000-0000-4000-8000-00000000000b', status: 'rejected', ...same })
    const b = sug({ id: '00000000-0000-4000-8000-00000000000a', status: 'rejected', ...same })

    const first = selectWeeklyPacket({ pending: [], terminal: [a, b], now: NOW, budget: 1 })
    const second = selectWeeklyPacket({ pending: [], terminal: [b, a], now: NOW, budget: 1 })

    expect(first.items.map((i) => i.id)).toEqual(second.items.map((i) => i.id))
    expect(first.items.map((i) => i.id)).toEqual([b.id])
  })

  it('does not let the lane starve the ordinary pools (NEGATIVE CONTROL)', () => {
    const packet = selectWeeklyPacket({
      pending: [sug({ status: 'pending' }), sug({ status: 'pending' }), sug({ status: 'pending' })],
      terminal: [censusViolation(), sug({ status: 'rejected' }), sug({ status: 'rejected' })],
      now: NOW,
    })

    expect(packet.selectedEscalated).toBe(1)
    expect(packet.selectedBackfill).toBe(DEFAULT_BACKFILL_SLOTS)
    expect(packet.selectedPending).toBeGreaterThan(0)
  })
})
