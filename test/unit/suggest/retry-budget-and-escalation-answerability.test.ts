/**
 * Retrying a failed build must terminate, and whatever it escalates must be answerable.
 *
 * The retry budget has two failure modes that are mirror images of each other: a guard that stops
 * the work but leaves the item permanently promotable (an unbounded loop with no ceiling), and a
 * ceiling that escalates an item John can then do nothing with. Both are pinned here, along with
 * the rule that a build failure must never un-ship already-implemented work.
 *
 * Every test runs against real collaborators — a real `createSuggestionStore` over `mkdtempSync`,
 * the real promoter, the real weekly session — so none of them asserts an implementation back to
 * itself.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createSuggestionStore,
  MAX_ATTEMPTS_BEFORE_FAILED,
} from '../../../src/suggest/suggestion-store.js'
import type { Suggestion, SuggestionType } from '../../../src/suggest/types.js'
import { promoteSuggestions } from '../../../src/brain/suggestion-promoter.js'
import { recordWeeklyVerdict, buildWeeklySession } from '../../../src/suggest/weekly-session.js'

let dir: string
let store: ReturnType<typeof createSuggestionStore>

const JOHN_APPROVED = 'human:cheap-win:small and unblocks the weekly loop'

function mk(id: string, over: Partial<Suggestion> = {}): Suggestion {
  return {
    id,
    type: 'skill' as SuggestionType,
    title: `proposal ${id.slice(0, 8)}`,
    rationale: 'because',
    confidence: 0.9,
    status: 'pending',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    attemptCount: 0,
    evidence: [],
    tags: [],
    actionable: true,
    ...over,
  } as unknown as Suggestion
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scns-regrade-'))
  store = createSuggestionStore({ rootDir: join(dir, 'suggestions') })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** The brain's promotion decision, with the real promoter. */
function promotable(s: Suggestion, nowMs: number): boolean {
  const res = promoteSuggestions({
    suggestions: [s],
    autonomyLevel: 1,
    maxConcurrentSessions: 5,
    activeSessions: 0,
    inflightTasks: [],
    nowMs,
  })
  return res.promoted.length > 0
}

describe('the humanOwnsOutcome guard must not create an unbounded retry loop', () => {
  /**
   * The guard was added so a gate failure could not move a human-REJECTED item back to `approved`
   * and have the brain rebuild work he declined, up to five times. It did that by holding the
   * current status, nulling `nextRetryAt` and skipping the terminal transition.
   *
   * For `status: approved` + `reviewVerdict: reject` — which the weekly review produces, because
   * `approved` is in `TERMINAL_STATUSES` and a reject there preserved the status — all three
   * clauses fire together and the item is left PROMOTABLE, with no backoff and no ceiling. The
   * five-attempt bound the guard was defending became unbounded.
   */
  it('does not leave a rejected-but-approved item permanently promotable', () => {
    const id = 'aaaaaaaa-0000-0000-0000-000000000001'
    store.save(mk(id))
    store.updateStatus(id, 'approved', JOHN_APPROVED, undefined, { reviewVerdict: 'approve' })

    // John changes his mind in the weekly review.
    const rec = recordWeeklyVerdict(store, id, {
      verdict: 'reject',
      code: 'not-valuable',
      text: 'on reflection, not worth it',
    })
    expect(rec.ok).toBe(true)

    let now = 1_000_000
    for (let i = 0; i < MAX_ATTEMPTS_BEFORE_FAILED + 3; i++) {
      store.recordQualityGateFailure(id, 'qg-fail:tests-failed', now)
      now += 24 * 60 * 60 * 1000
    }

    const after = store.get(id)!
    expect(after.status).toBe('rejected')
    expect(promotable(after, now)).toBe(false)
  })

  it('keeps his verdict and his words while it stops the work', () => {
    const id = 'aaaaaaaa-0000-0000-0000-000000000002'
    store.save(mk(id))
    store.updateStatus(id, 'approved', JOHN_APPROVED, undefined, { reviewVerdict: 'approve' })
    store.updateStatus(id, 'approved', 'human:not-valuable:changed my mind', undefined, {
      reviewVerdict: 'reject',
    })

    store.recordQualityGateFailure(id, 'qg-fail:tests-failed', 1_000_000)

    const after = store.get(id)!
    expect(after.reviewVerdict).toBe('reject')
    expect(after.reviewReason).toBe('human:not-valuable:changed my mind')
    expect(after.machineReason).toBe('qg-fail:tests-failed')
    expect(after.status).toBe('rejected')
  })

  it('still escalates a genuinely APPROVED proposal at the ceiling, unchanged', () => {
    const id = 'aaaaaaaa-0000-0000-0000-000000000003'
    store.save(mk(id))
    store.updateStatus(id, 'approved', JOHN_APPROVED, undefined, { reviewVerdict: 'approve' })

    let now = 1_000_000
    for (let i = 0; i < MAX_ATTEMPTS_BEFORE_FAILED; i++) {
      store.recordQualityGateFailure(id, 'qg-fail:tests-failed', now)
      now += 24 * 60 * 60 * 1000
    }

    const after = store.get(id)!
    expect(after.status).toBe('needs-human')
    expect(after.reviewVerdict).toBe('approve')
  })

  it('does not disturb an already-implemented proposal', () => {
    const id = 'aaaaaaaa-0000-0000-0000-000000000004'
    store.save(mk(id))
    store.updateStatus(id, 'implemented', JOHN_APPROVED, undefined, { reviewVerdict: 'approve' })

    store.recordQualityGateFailure(id, 'qg-fail:tests-failed', 1_000_000)

    expect(store.get(id)!.status).toBe('implemented')
  })
})

describe('an escalated proposal must be answerable', () => {
  function escalate(id: string): void {
    store.save(mk(id))
    store.updateStatus(id, 'approved', JOHN_APPROVED, undefined, { reviewVerdict: 'approve' })
    let now = 1_000_000
    for (let i = 0; i < MAX_ATTEMPTS_BEFORE_FAILED; i++) {
      store.recordQualityGateFailure(id, 'qg-fail:tests-failed', now)
      now += 24 * 60 * 60 * 1000
    }
    expect(store.get(id)!.status).toBe('needs-human')
  }

  /**
   * The packet says "retry it or close it". Both answers went nowhere: `needs-human` is in
   * `TERMINAL_STATUSES`, so the status was preserved either way. Approve printed a success line and
   * retried nothing; reject printed a success line and closed nothing, leaving the item pinned at
   * `priority: MAX_SAFE_INTEGER` — first — in every future packet, forever.
   */
  it('APPROVE on an escalated item actually retries it, with the budget restored', () => {
    const id = 'bbbbbbbb-0000-0000-0000-000000000001'
    escalate(id)

    const rec = recordWeeklyVerdict(store, id, {
      verdict: 'approve',
      code: 'cheap-win',
      text: 'yes, try again',
    })
    expect(rec.ok).toBe(true)

    const after = store.get(id)!
    expect(after.status).toBe('approved')
    expect(after.attemptCount).toBe(0)
    expect(after.nextRetryAt).toBeNull()
    expect(promotable(after, 9_999_999_999)).toBe(true)
  })

  it('REJECT on an escalated item actually closes it', () => {
    const id = 'bbbbbbbb-0000-0000-0000-000000000002'
    escalate(id)

    const rec = recordWeeklyVerdict(store, id, {
      verdict: 'reject',
      code: 'not-valuable',
      text: 'close it, not worth it',
    })
    expect(rec.ok).toBe(true)
    expect(store.get(id)!.status).toBe('rejected')
  })

  it('drains the escalated pool — a closed item is not re-presented next week', () => {
    const id = 'bbbbbbbb-0000-0000-0000-000000000003'
    escalate(id)
    recordWeeklyVerdict(store, id, {
      verdict: 'reject',
      code: 'not-valuable',
      text: 'close it, not worth it',
    })

    const { packet } = buildWeeklySession({ store, now: new Date('2026-08-04T12:00:00Z') })
    expect(packet.items.map((i) => i.id)).not.toContain(id)
    expect(packet.selectedEscalated).toBe(0)
  })
})

describe('a rejection must not be read back as an approval', () => {
  /**
   * `historyFrom` derived the verdict from STATUS (`status === 'rejected' ? 'reject' : 'approve'`)
   * while `reviewVerdict` sat on the same file. Any decision that does not land in the `rejected`
   * directory — every escalated reject, before the finding-2 fix — was fed to the anti-rubber-stamp
   * guard as an APPROVAL, moving both `approvalRate` and `disagreedRecently` in the wrong direction.
   * Those two inputs are what block an autonomy raise.
   */
  it('counts a reject recorded against a non-rejected status as a REJECT', () => {
    const id = 'cccccccc-0000-0000-0000-000000000001'
    store.save(mk(id))
    store.updateStatus(id, 'implemented', JOHN_APPROVED, undefined, { reviewVerdict: 'approve' })
    // Backfill: he says "I would not have approved that" about shipped work. Status cannot move.
    store.updateStatus(id, 'implemented', 'human:not-valuable:should not have shipped', undefined, {
      reviewVerdict: 'reject',
    })

    const { engagement } = buildWeeklySession({ store, now: new Date('2026-08-04T12:00:00Z') })
    expect(engagement.approvalRate).toBe(0)
    expect(engagement.n).toBe(1)
  })

  it('a non-decision (defer/explain) is not banked as a review decision at all', () => {
    const id = 'cccccccc-0000-0000-0000-000000000002'
    store.save(mk(id))
    store.updateStatus(id, 'approved', 'human:needs-explanation:what does this do?', undefined, {
      reviewVerdict: 'explain',
    })

    const { engagement } = buildWeeklySession({ store, now: new Date('2026-08-04T12:00:00Z') })
    expect(engagement.n).toBe(0)
  })
})

/**
 * THIRD-PASS grading findings (2026-08-04). Two of the three were defects in the code written to
 * fix the SECOND pass — the same recurrence §12.11 named, now observed a third time.
 */
describe('a build failure must not un-ship shipped work', () => {
  /**
   * `humanRefused` was evaluated BEFORE the `implemented` clause and its branch hard-coded
   * `'rejected'`, so `humanOwnsOutcome`'s `status === 'implemented'` test was unreachable whenever
   * a reject verdict was present. That pairing is exactly what the finding-2 fix produces: a
   * backfill reject on already-shipped work keeps `status: implemented` and writes
   * `reviewVerdict: reject`. The next machine failure then moved the file out of `implemented/`.
   *
   * It also contradicts the invariant the finding-2 fix is built on — that `implemented` is the one
   * status a verdict cannot flip — and it is the phase's own subject: a BUILD FAILURE deciding
   * whether "the human declined this" gets written.
   */
  it('a gate failure does not move an implemented+reject-backfilled proposal to rejected', () => {
    const id = 'dddddddd-0000-0000-0000-000000000001'
    store.save(mk(id))
    store.updateStatus(id, 'implemented', JOHN_APPROVED, undefined, { reviewVerdict: 'approve' })
    store.updateStatus(id, 'implemented', 'human:not-valuable:should not have shipped', undefined, {
      reviewVerdict: 'reject',
    })

    store.recordQualityGateFailure(id, 'qg-fail:tests-failed', 1_000_000)

    expect(store.get(id)!.status).toBe('implemented')
  })

  it('the executor failure path is protected the same way', () => {
    const id = 'dddddddd-0000-0000-0000-000000000002'
    store.save(mk(id))
    store.updateStatus(id, 'implemented', 'human:not-valuable:regret', undefined, {
      reviewVerdict: 'reject',
    })

    store.recordFailure(id, 'boom', 1_000_000)

    expect(store.get(id)!.status).toBe('implemented')
  })
})

describe('the headline regression test must actually bite', () => {
  /**
   * The test named for the §12.1 unbounded-loop defect built its fixture through the weekly review
   * — and the finding-2 fix changed that path so a reject on an `approved` item now lands in
   * `rejected` directly. The setup therefore stopped producing the `approved` + `reviewVerdict:
   * reject` shape the defect needs, and the test kept passing with the DEFECTIVE guard restored.
   *
   * A regression test whose fixture depends on a second, later fix is not defending its invariant.
   * This one constructs the shape directly at the store seam, which is where the guard lives.
   */
  it('constructs the contradictory shape directly and proves the item is not promotable', () => {
    const id = 'dddddddd-0000-0000-0000-000000000003'
    store.save(mk(id))
    store.updateStatus(id, 'approved', JOHN_APPROVED, undefined, { reviewVerdict: 'approve' })
    // Written directly: this is the shape ANY concurrent path can leave behind, independent of
    // whether the weekly review still produces it.
    store.updateStatus(id, 'approved', 'human:not-valuable:no', undefined, {
      reviewVerdict: 'reject',
    })
    expect(store.get(id)!.status).toBe('approved')
    expect(store.get(id)!.reviewVerdict).toBe('reject')

    let now = 1_000_000
    for (let i = 0; i < MAX_ATTEMPTS_BEFORE_FAILED + 3; i++) {
      store.recordQualityGateFailure(id, 'qg-fail:tests-failed', now)
      now += 24 * 60 * 60 * 1000
    }

    const after = store.get(id)!
    expect(after.status).toBe('rejected')
    expect(after.nextRetryAt).toBeNull()
    expect(promotable(after, now)).toBe(false)
  })
})

describe('an escalated proposal is asked about exactly once', () => {
  /**
   * The dedup fix shipped with no coverage: reverting it left the FULL suite green
   * (`502 passed | 2 skipped`), which is precisely the failure mode the previous pass filed as
   * High for the Critical wiring fix.
   *
   * The shape is an AUTO-approved proposal — it has no human reason, only `qg-fail:*`, so it
   * satisfied the backfill predicate ("terminal, no human reason") AND the escalated predicate.
   * The CLI walks `items` by index, so John was asked the same proposal twice in one sitting and
   * his second answer overwrote his first.
   */
  it('an auto-approved escalation appears once, and only in the escalated pool', () => {
    const id = 'eeeeeeee-0000-0000-0000-000000000001'
    store.save(mk(id))
    store.updateStatus(id, 'approved', undefined, undefined, {})
    let now = 1_000_000
    for (let i = 0; i < MAX_ATTEMPTS_BEFORE_FAILED; i++) {
      store.recordQualityGateFailure(id, 'qg-fail:no-diff', now)
      now += 24 * 60 * 60 * 1000
    }
    const seeded = store.get(id)!
    expect(seeded.status).toBe('needs-human')
    expect(seeded.reviewReason ?? '').not.toMatch(/^human:/)

    const { packet } = buildWeeklySession({ store, now: new Date('2026-08-04T12:00:00Z') })
    const occurrences = packet.items.filter((i) => i.id === id)
    expect(occurrences).toHaveLength(1)
    expect(occurrences[0]!.kind).toBe('escalated')
    expect(packet.selectedBackfill).toBe(0)
    expect(packet.totalUnexplained).toBe(0)
  })
})

describe('the escalated pool is bounded, and says so honestly', () => {
  function seedEscalated(n: number): void {
    for (let i = 0; i < n; i++) {
      const id = `ffffffff-0000-0000-0000-${String(i).padStart(12, '0')}`
      store.save(mk(id))
      store.updateStatus(id, 'approved', JOHN_APPROVED, undefined, { reviewVerdict: 'approve' })
      let now = 1_000_000
      for (let a = 0; a < MAX_ATTEMPTS_BEFORE_FAILED; a++) {
        store.recordQualityGateFailure(id, 'qg-fail:tests-failed', now)
        now += 24 * 60 * 60 * 1000
      }
    }
  }

  /**
   * The pool was left uncapped on the stated grounds that "both answers now DRAIN it". The CLI
   * offers FOUR answers — approve / reject / explain / skip — and only two drain. `skip` never
   * calls `recordWeeklyVerdict`; `explain` takes the non-decision early return, which preserves the
   * status. Meanwhile auto-approval is live on the plist, so escalations are PRODUCED with no human
   * in the loop while draining requires one. The pool could only grow.
   */
  it('caps the escalated pool rather than rendering an unbounded list', { timeout: 30_000 }, () => {
    seedEscalated(41)
    const { packet } = buildWeeklySession({
      store,
      now: new Date('2026-08-04T12:00:00Z'),
      budget: 5,
    })
    expect(packet.selectedEscalated).toBe(5)
    expect(packet.totalEscalated).toBe(41)
  })

  it('an item answered with `explain` is NOT drained, and the count discloses it', () => {
    seedEscalated(1)
    const id = 'ffffffff-0000-0000-0000-000000000000'

    const rec = recordWeeklyVerdict(store, id, {
      verdict: 'explain',
      code: 'needs-explanation',
      text: 'what does this even do?',
    })
    expect(rec.ok).toBe(true)

    // Deliberately pinned as PERSISTING: an explain is a request for more information, not a
    // decision, so the item must come back. What was wrong was claiming it could not.
    const { packet } = buildWeeklySession({ store, now: new Date('2026-08-04T12:00:00Z') })
    expect(packet.totalEscalated).toBe(1)
    expect(packet.items.map((i) => i.id)).toContain(id)
  })
})
