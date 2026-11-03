/**
 * FR-070 — backfill staleness is measured from the last SURVIVING HUMAN DECISION.
 *
 * The defect this file pins, measured on the live store on 2026-08-06
 * (`docs/evidence/003-T150-backfill-baseline-2026-08-06.md`): the quality gate's own machine write
 * bumped `65a914f4`'s `updatedAt`, the backfill scorer read `updatedAt` as its staleness input, and
 * the one item most in need of John's judgement scored as freshly attended — rank 107 of 107,
 * priority 0.00156, a ~54-week wait against `DEFAULT_BACKFILL_SLOTS = 2`.
 *
 * Two writers reset that clock and BOTH are pinned here, because fixing either alone is cosmetic:
 *
 *   1. `weekly-review.ts` scored staleness from `updatedAt` — bumped by every write (T151/T152/T153).
 *   2. `suggestion-store.ts` `updateStatus` set `reviewedAt` on every call, machine writes included,
 *      so switching the scorer to `reviewedAt` would have read the same machine timestamp under a
 *      more honest name (the `updateStatus` describe below).
 *
 * Deliberately NOT in the same file as the tie-break/reserved-lane assertions (FR-071): those defend
 * a different invariant and a change that satisfies one must be able to fail the other loudly.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { selectWeeklyPacket, DEFAULT_BACKFILL_SLOTS } from '../../../src/suggest/weekly-review.js'
import { createSuggestionStore } from '../../../src/suggest/suggestion-store.js'
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
const DAY = 86_400_000
const ago = (days: number): string => new Date(NOW.getTime() - days * DAY).toISOString()

/** Score one backfill item in isolation, so a priority can be read off directly. */
function backfillPriorityOf(s: Suggestion): number {
  const packet = selectWeeklyPacket({ pending: [], terminal: [s], now: NOW })
  const item = packet.items.find((i) => i.id === s.id)
  expect(item, `${s.id} was not in the packet at all`).toBeDefined()
  expect(item!.kind).toBe('backfill')
  return item!.priority
}

describe('FR-070b — a machine write must not reset the staleness clock', () => {
  it('does not score an item as freshly attended because a machine touched it', () => {
    // The live shape of `65a914f4`: John decided it 120 days ago, the quality gate wrote to it
    // an hour ago. `updatedAt` says "fresh"; nothing a human did says that.
    const machineTouched = sug({
      reviewVerdict: 'approve',
      reviewReason: 'human:cheap-win:',
      reviewedAt: ago(120),
      updatedAt: ago(0.04),
      machineReason: 'qg-fail:tests-failed',
    })
    // Same human decision date, no machine write since. These two differ ONLY in machine activity,
    // so any difference in score is the machine's write leaking into the ranking.
    const untouched = sug({
      reviewVerdict: 'approve',
      reviewReason: 'human:cheap-win:',
      reviewedAt: ago(120),
      updatedAt: ago(120),
    })

    expect(backfillPriorityOf(machineTouched)).toBe(backfillPriorityOf(untouched))
  })

  it('ranks a machine-touched item ABOVE one John genuinely decided yesterday', () => {
    const machineTouched = sug({
      reviewVerdict: 'approve',
      reviewReason: 'human:cheap-win:',
      reviewedAt: ago(120),
      updatedAt: ago(0.04),
      machineReason: 'qg-fail:tests-failed',
    })
    const decidedYesterday = sug({
      reviewVerdict: 'approve',
      reviewReason: 'human:cheap-win:',
      reviewedAt: ago(1),
      updatedAt: ago(1),
    })

    expect(backfillPriorityOf(machineTouched)).toBeGreaterThan(backfillPriorityOf(decidedYesterday))
  })
})

describe('FR-070a — no surviving human decision ranks as maximally stale', () => {
  it('scores an item whose verdict was destroyed as maximally stale', () => {
    // The 2026-08-04 shape of `65a914f4`, minus the census signature: the verdict is gone, so
    // nothing on the file records that a human ever decided it. Created and touched TODAY, so every
    // timestamp on it says "fresh" — only the missing decision says otherwise.
    //
    // `machineReason` is deliberately NOT `qg-fail:*`. A destroyed verdict alongside a gate failure
    // is the census signature, and FR-071 routes that to the reserved lane instead — which is the
    // point of the routing assertion below. This fixture isolates FR-070a on its own.
    const verdictDestroyed = sug({
      status: 'rejected',
      createdAt: ago(0),
      updatedAt: ago(0),
      reviewedAt: ago(0),
      reviewVerdict: undefined,
      reviewReason: undefined,
      machineReason: 'machine:applied-and-verified: …',
    })
    // A rejection John decided 120 days ago — the oldest thing a surviving decision can be. Maximal
    // staleness must be at least this, or "no decision" would rank below "a decision long ago".
    const decidedLongAgo = sug({
      status: 'rejected',
      reviewVerdict: 'reject',
      reviewReason: 'human:not-useful:',
      reviewedAt: ago(120),
      updatedAt: ago(120),
    })

    expect(backfillPriorityOf(verdictDestroyed)).toBe(backfillPriorityOf(decidedLongAgo))
  })

  it('routes a destroyed verdict that ALSO carries a gate failure to the reserved lane (FR-071)', () => {
    // The two rules must not fight over the same file: FR-070a raises it inside the backfill pool,
    // FR-071 takes it out of that pool entirely. Pinned so a change to either notices the other.
    const withGateFailure = sug({
      status: 'rejected',
      reviewVerdict: undefined,
      reviewReason: undefined,
      machineReason: 'qg-fail:tests-failed',
    })
    const packet = selectWeeklyPacket({ pending: [], terminal: [withGateFailure], now: NOW })

    expect(packet.items.filter((i) => i.id === withGateFailure.id)).toHaveLength(1)
    expect(packet.items.find((i) => i.id === withGateFailure.id)!.kind).toBe('escalated')
    expect(packet.totalUnexplained).toBe(0)
  })

  it('surfaces it in a slot for a pool shaped like the live one (116 items, 2 slots)', () => {
    // The projection this assertion exists to close: rank 107 of 107, ~54 weeks at 2 slots/week.
    // Every filler is an implemented item John decided recently, so the ONLY thing that can lift
    // the destroyed-verdict item into a slot is FR-070a.
    const filler = Array.from({ length: 115 }, () =>
      sug({
        status: 'implemented',
        reviewVerdict: 'approve',
        reviewReason: 'human:cheap-win:',
        reviewedAt: ago(1),
        updatedAt: ago(1),
      }),
    )
    const verdictDestroyed = sug({
      status: 'implemented',
      createdAt: ago(0),
      updatedAt: ago(0),
      reviewedAt: ago(0),
      reviewVerdict: undefined,
      reviewReason: undefined,
      machineReason: 'machine:applied-and-verified: …',
    })

    const packet = selectWeeklyPacket({
      pending: [],
      terminal: [...filler, verdictDestroyed],
      now: NOW,
    })

    expect(packet.totalUnexplained).toBe(116)
    expect(packet.selectedBackfill).toBe(DEFAULT_BACKFILL_SLOTS)
    expect(packet.items.map((i) => i.id)).toContain(verdictDestroyed.id)
  })
})

describe('FR-070c — a recently decided item does NOT jump the queue (NEGATIVE CONTROL)', () => {
  it('scores an item John decided this week as not stale', () => {
    // Without this the "fix" degrades into promoting everything and the suite would not notice.
    const decidedThisWeek = sug({
      reviewVerdict: 'reject',
      reviewReason: 'human:not-useful:',
      reviewedAt: ago(2),
      updatedAt: ago(2),
    })
    const neverDecided = sug({
      reviewVerdict: undefined,
      reviewReason: undefined,
      reviewedAt: undefined,
      updatedAt: ago(2),
    })

    expect(backfillPriorityOf(decidedThisWeek)).toBeLessThan(backfillPriorityOf(neverDecided))
  })

  it('keeps a recently decided item out of the slots a stale pool is competing for', () => {
    const decidedThisWeek = sug({
      status: 'rejected',
      reviewVerdict: 'reject',
      reviewReason: 'human:not-useful:',
      reviewedAt: ago(2),
      updatedAt: ago(2),
    })
    const stale = Array.from({ length: 4 }, () =>
      sug({ status: 'rejected', reviewVerdict: undefined, reviewReason: undefined }),
    )

    const packet = selectWeeklyPacket({
      pending: [],
      terminal: [decidedThisWeek, ...stale],
      now: NOW,
    })

    expect(packet.selectedBackfill).toBe(DEFAULT_BACKFILL_SLOTS)
    expect(packet.items.map((i) => i.id)).not.toContain(decidedThisWeek.id)
  })
})

describe('FR-070b at its source — updateStatus must not stamp reviewedAt for a machine', () => {
  const roots: string[] = []
  function store() {
    const rootDir = mkdtempSync(join(tmpdir(), 'scns-fr070-'))
    roots.push(rootDir)
    return createSuggestionStore({ rootDir })
  }
  afterEach(() => {
    // The previous review flagged an uncleaned mkdtempSync root; do not repeat it.
    while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
  })

  it('leaves the human review timestamp standing when the quality gate writes', () => {
    const s = store()
    const HUMAN_REVIEWED_AT = '2026-04-01T00:00:00.000Z'
    s.save(sug({ id: 'aaaaaaaa-0000-4000-8000-000000000001', status: 'pending' }))
    const reviewed = s.updateStatus(
      'aaaaaaaa-0000-4000-8000-000000000001',
      'approved',
      'human:cheap-win: worth it',
      undefined,
      { reviewVerdict: 'approve', author: 'human' },
    )
    expect(reviewed?.reviewedAt).toBeDefined()

    // Force a known, unambiguously-old human timestamp so the machine write below cannot be
    // mistaken for "the clock happened not to move within the same millisecond".
    s.save({ ...reviewed!, reviewedAt: HUMAN_REVIEWED_AT, status: 'approved' })

    const afterMachine = s.updateStatus(
      'aaaaaaaa-0000-4000-8000-000000000001',
      'needs-human',
      'qg-fail:tests-failed',
      undefined,
      { author: 'machine' },
    )

    expect(afterMachine?.reviewedAt).toBe(HUMAN_REVIEWED_AT)
    // A machine write is still recorded — it just is not recorded as a REVIEW.
    expect(afterMachine?.updatedAt).not.toBe(HUMAN_REVIEWED_AT)
    expect(afterMachine?.machineReason).toBe('qg-fail:tests-failed')
  })

  it('still stamps reviewedAt when a HUMAN writes (POSITIVE CONTROL)', () => {
    const s = store()
    s.save(sug({ id: 'aaaaaaaa-0000-4000-8000-000000000002', status: 'pending' }))
    const before = new Date().toISOString()
    const reviewed = s.updateStatus(
      'aaaaaaaa-0000-4000-8000-000000000002',
      'rejected',
      'human:not-useful: no thanks',
      undefined,
      { reviewVerdict: 'reject', author: 'human' },
    )
    expect(reviewed?.reviewedAt).toBeDefined()
    expect(reviewed!.reviewedAt! >= before).toBe(true)
  })
})
