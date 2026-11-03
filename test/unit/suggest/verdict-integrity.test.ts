/**
 * RED tests for the verdict-integrity defect (feature 003, found by independent grading).
 *
 * This is a WORSE class than the loss bugs that came before it. John's words were being kept —
 * but married to the WRONG label, and in one case to the OPPOSITE one.
 *
 * `recordSuggestionOutcome` derives the banked verdict from `suggestion.status`
 * (`outcome-writer.ts` → `statusToVerdict`) while attaching `suggestion.reviewReason` — the last
 * thing the human typed — as its justification. Those two disagree whenever the status was NOT set
 * by the verdict he just gave, which is exactly the backfill case the weekly review deliberately
 * supports (`weekly-session.ts`: a terminal suggestion keeps its status and only gains a reason).
 *
 * Measured on the built dist before this fix:
 *
 *     status: implemented | John typed: reject
 *     banked verdict: implemented | gradient: 1        <- the ACCEPTED end
 *
 * `humanOutcomeOfVerdict('implemented')` is `accepted` (1) and feeds `settleHumanOutcomeForEntity`,
 * so a REJECTION was being written onto the retrieval experiences as a maximal ACCEPT, with his
 * rejection sentence filed as the supporting evidence. That is a sign flip on human accept-vs-waste
 * — the single metric `docs/NORTH_STAR.md` names.
 *
 * The rule these tests pin: when the human has given an explicit verdict, the banked label must
 * follow HIS verdict, never a stale mechanical status — and when his answer carries no accept/waste
 * information at all (`explain`, `defer`) nothing is banked rather than something invented.
 *
 * Isolated store dir + temp SQLite. Nothing touches `~/.scns`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSuggestionStore } from '../../../src/suggest/suggestion-store.js'
import { recordWeeklyVerdict } from '../../../src/suggest/weekly-session.js'
import {
  humanVerdictToProposalVerdict,
  recordSuggestionOutcome,
} from '../../../src/suggest/outcome-writer.js'
import { humanOutcomeOfVerdict, HUMAN_OUTCOME_GRADIENT } from '../../../src/memory/human-outcome.js'
import type { ReviewVerdict } from '../../../src/suggest/review-reason.js'
import { openMemoryDb, closeMemoryDb } from '../../../src/memory/db.js'
import { SuggestionType, type Suggestion, type SuggestionStatus } from '../../../src/suggest/types.js'
import type Database from 'better-sqlite3'

let dir: string
let db: Database.Database

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scns-verdict-integrity-'))
  db = openMemoryDb(join(dir, 'vault.db'))
})

afterEach(() => {
  closeMemoryDb(db)
  rmSync(dir, { recursive: true, force: true })
})

let nextId = 0
function seed(store: ReturnType<typeof createSuggestionStore>, over: Partial<Suggestion> = {}) {
  const id = `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}`
  const s = {
    id,
    type: SuggestionType.Workflow,
    title: 'Document + test the broker port override precedence',
    description: 'a description',
    confidence: 0.9,
    status: 'pending',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    evidence: [],
    tags: ['self-improvement', 'scns-self-improvement', 'broker', 'broker-port-precedence'],
    ...over,
  } as Suggestion
  store.save(s)
  return s
}

describe('humanVerdictToProposalVerdict — the human verdict outranks a stale status', () => {
  it('T142: a REJECTION of an already-implemented item is never banked as an accept', () => {
    // The sign inversion. `statusToVerdict('implemented')` is 'implemented' (gradient 1).
    expect(humanVerdictToProposalVerdict('reject', 'implemented')).toBe('rejected')
    expect(humanOutcomeOfVerdict(humanVerdictToProposalVerdict('reject', 'implemented')!)).toBe(
      HUMAN_OUTCOME_GRADIENT.waste,
    )
  })

  it('T143: "explain" carries no accept/waste signal and is banked as nothing', () => {
    // "I cannot judge this" is evidence about the WRITE-UP, not the IDEA.
    expect(humanVerdictToProposalVerdict('explain', 'rejected')).toBeNull()
    expect(humanVerdictToProposalVerdict('explain', 'implemented')).toBeNull()
    expect(humanVerdictToProposalVerdict('defer', 'rejected')).toBeNull()
  })

  it('T144: an approval only becomes an accept once the work actually happened', () => {
    expect(humanVerdictToProposalVerdict('approve', 'implemented')).toBe('implemented')
    // unchanged from today: `approved` alone is not an outcome yet
    expect(humanVerdictToProposalVerdict('approve', 'approved')).toBeNull()
    expect(humanVerdictToProposalVerdict('approve', 'needs-human')).toBe('needs-human')
  })

  it('T145: an approval contradicted by a rejected status banks nothing, not a false accept', () => {
    // The "changed his mind in one sitting" case: status is stuck at the first verdict.
    expect(humanVerdictToProposalVerdict('approve', 'rejected')).toBeNull()
  })
})

describe('the verdict John gave is persisted on the suggestion', () => {
  it('T146: recordWeeklyVerdict records the verdict, not just the reason', () => {
    const store = createSuggestionStore({ rootDir: join(dir, 'suggestions') })
    const s = seed(store)
    const r = recordWeeklyVerdict(store, s.id, {
      verdict: 'reject',
      code: 'wrong-target',
      text: 'this edits the wrong file and would break the broker',
    })
    expect(r.ok).toBe(true)
    expect(store.get(s.id)?.reviewVerdict).toBe('reject')
  })

  it('T147: a later reason-less transition preserves the recorded verdict', () => {
    const store = createSuggestionStore({ rootDir: join(dir, 'suggestions') })
    const s = seed(store)
    recordWeeklyVerdict(store, s.id, {
      verdict: 'approve',
      code: 'unblocks',
      text: 'this unblocks the loop, ship it',
    })
    // the auto-execute path: `review.ts` marks it implemented with NO reason
    store.updateStatus(s.id, 'implemented')
    expect(store.get(s.id)?.reviewVerdict).toBe('approve')
  })

  it('T148: a backfill verdict on a terminal item records HIS verdict while keeping the status', () => {
    const store = createSuggestionStore({ rootDir: join(dir, 'suggestions') })
    const s = seed(store)
    store.updateStatus(s.id, 'implemented')
    const r = recordWeeklyVerdict(store, s.id, {
      verdict: 'reject',
      code: 'wrong-target',
      text: 'this was a mistake, it edits the wrong file',
    })
    expect(r.ok).toBe(true)
    const after = store.get(s.id)
    expect(after?.status).toBe('implemented') // backfill never re-decides
    expect(after?.reviewVerdict).toBe('reject') // but we know what he actually said
  })
})

describe('recordSuggestionOutcome honours the human verdict', () => {
  it('T149: banks his rejection as waste even though the status says implemented', () => {
    const store = createSuggestionStore({ rootDir: join(dir, 'suggestions') })
    const s = seed(store)
    store.updateStatus(s.id, 'implemented')
    recordWeeklyVerdict(store, s.id, {
      verdict: 'reject',
      code: 'wrong-target',
      text: 'this was a mistake, it edits the wrong file',
    })
    const item = store.get(s.id)!

    const res = recordSuggestionOutcome({ db }, item, item.status)
    expect(res.recorded).toBe(true)
    expect(res.row?.verdict).toBe('rejected')
    expect(humanOutcomeOfVerdict(res.row!.verdict)).toBe(HUMAN_OUTCOME_GRADIENT.waste)
  })

  it('T150: banks nothing at all for an "explain"', () => {
    const store = createSuggestionStore({ rootDir: join(dir, 'suggestions') })
    const s = seed(store)
    store.updateStatus(s.id, 'rejected')
    recordWeeklyVerdict(store, s.id, {
      verdict: 'explain',
      code: 'needs-explanation',
      text: 'I genuinely cannot tell what this proposal does',
    })
    const item = store.get(s.id)!

    const res = recordSuggestionOutcome({ db }, item, item.status)
    expect(res.recorded).toBe(false)
    expect(res.skipReason).toBe('human-verdict-carries-no-signal')
    const rows = db.prepare('SELECT COUNT(*) AS n FROM proposal_outcomes').get() as { n: number }
    expect(rows.n).toBe(0)
  })

  it('T151: an item with no recorded human verdict is unchanged (legacy corpus)', () => {
    const store = createSuggestionStore({ rootDir: join(dir, 'suggestions') })
    const s = seed(store)
    store.updateStatus(s.id, 'implemented', 'qg-pass')
    const item = store.get(s.id)!
    expect(item.reviewVerdict).toBeUndefined()

    const res = recordSuggestionOutcome({ db }, item, item.status)
    expect(res.recorded).toBe(true)
    expect(res.row?.verdict).toBe('implemented')
  })

  it('T152: he changes his mind in one sitting — no contradictory label reaches the learner', () => {    // The status is stuck at the FIRST verdict (a terminal status is never re-decided), so before
    // this fix the learner got `rejected` carrying his APPROVAL sentence.
    const store = createSuggestionStore({ rootDir: join(dir, 'suggestions') })
    const s = seed(store)
    recordWeeklyVerdict(store, s.id, {
      verdict: 'reject',
      code: 'too-risky',
      text: 'first answer: this is too risky to run unattended',
    })
    recordWeeklyVerdict(store, s.id, {
      verdict: 'approve',
      code: 'unblocks',
      text: 'second answer: actually I changed my mind, it is fine',
    })
    const item = store.get(s.id)!
    expect(item.status).toBe('rejected') // backfill still never re-decides
    expect(item.reviewVerdict).toBe('approve') // but his LATEST answer is known
    expect(item.reviewReason).toContain('second answer')

    const res = recordSuggestionOutcome({ db }, item, item.status)
    expect(res.recorded).toBe(false)
    const rows = db.prepare('SELECT COUNT(*) AS n FROM proposal_outcomes').get() as { n: number }
    expect(rows.n).toBe(0)
  })
})

/**
 * SC-026 — the systematic control.
 *
 * The eleven cases above are hand-picked, and hand-picked cases are exactly how the first two
 * versions of this feature shipped green with a live defect in them. This drives the FULL
 * cross-product of what John can say against every state a proposal can be in, and asserts on the
 * GRADIENT rather than the verdict string — the gradient is what reaches the north-star metric, so
 * the gradient is what has to be right.
 */
describe('SC-026: no banked label ever contradicts the verdict John gave', () => {
  const VERDICTS: readonly ReviewVerdict[] = ['approve', 'reject', 'explain', 'defer']
  const STATUSES: readonly SuggestionStatus[] = [
    'pending',
    'approved',
    'implemented',
    'rejected',
    'needs-human',
  ]

  it('a rejection is never banked at the accepted end of the gradient', () => {
    const offenders: string[] = []
    for (const status of STATUSES) {
      const banked = humanVerdictToProposalVerdict('reject', status)
      if (banked === null) continue
      const gradient = humanOutcomeOfVerdict(banked)
      if (gradient !== null && gradient > HUMAN_OUTCOME_GRADIENT.partiallyUsed) {
        offenders.push(`reject+${status} -> ${banked} (gradient ${gradient})`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('an "explain" or "defer" never banks anything, in any state', () => {
    const banked = STATUSES.flatMap((status) =>
      (['explain', 'defer'] as const)
        .map((v) => ({ v, status, out: humanVerdictToProposalVerdict(v, status) }))
        .filter((r) => r.out !== null)
        .map((r) => `${r.v}+${r.status} -> ${r.out}`),
    )
    expect(banked).toEqual([])
  })

  it('every combination is total, and an approval never lands at the waste end', () => {
    const offenders: string[] = []
    for (const verdict of VERDICTS) {
      for (const status of STATUSES) {
        // must not throw and must return a value of the declared type
        const banked = humanVerdictToProposalVerdict(verdict, status)
        expect(banked === null || typeof banked === 'string').toBe(true)
        if (verdict !== 'approve' || banked === null) continue
        const gradient = humanOutcomeOfVerdict(banked)
        if (gradient !== null && gradient < HUMAN_OUTCOME_GRADIENT.partiallyUsed) {
          offenders.push(`approve+${status} -> ${banked} (gradient ${gradient})`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})

/**
 * Round 3 of independent grading found two seams where the NEW field re-opened the inversion in
 * mirror form. The rule "absence means no verdict in this transition" is right for MACHINE
 * transitions and wrong for HUMAN ones that cannot express a verdict: `reviewVerdict` is sticky, so
 * a stale verdict outranked the truth.
 */
describe('a stale verdict must never outrank a later decision', () => {
  it('T153: repromote clears the verdict, not just the reason', () => {
    // He rejects v1 meaning "start over". The machine rebuilds it and it LANDS. Before this fix the
    // successful replacement was banked as waste, carrying a verdict about a discarded version —
    // with `reviewReason` already blank, so nothing explained it.
    const store = createSuggestionStore({ rootDir: join(dir, 'suggestions') })
    const s = seed(store)
    store.updateStatus(s.id, 'needs-human', 'human:too-risky: start this one over', undefined, {
      reviewVerdict: 'reject',
    })
    expect(store.get(s.id)?.reviewVerdict).toBe('reject')

    store.repromote(s.id)
    const after = store.get(s.id)
    expect(after?.status).toBe('pending')
    expect(after?.reviewReason).toBeUndefined()
    expect(after?.reviewVerdict).toBeUndefined()
  })

  it('T154: a verdict-less transition that CONTRADICTS the recorded verdict clears it', () => {
    // The dashboard Approve/Reject buttons cannot express a verdict. He rejects on Monday, clicks
    // Approve on Tuesday, it ships — and his older answer used to win, banking a rejection.
    const store = createSuggestionStore({ rootDir: join(dir, 'suggestions') })
    const s = seed(store)
    store.updateStatus(s.id, 'rejected', 'human:too-risky: not yet', undefined, {
      reviewVerdict: 'reject',
    })
    store.updateStatus(s.id, 'approved') // the dashboard button: no reason, no verdict
    expect(store.get(s.id)?.reviewVerdict).toBeUndefined()

    store.updateStatus(s.id, 'implemented')
    const item = store.get(s.id)!
    const res = recordSuggestionOutcome({ db }, item, item.status)
    expect(res.row?.verdict).toBe('implemented')
    expect(humanOutcomeOfVerdict(res.row!.verdict)).toBe(HUMAN_OUTCOME_GRADIENT.accepted)
  })

  it('T155: a NON-contradicting verdict-less transition still preserves the verdict', () => {
    // The auto-execute path (approved -> implemented) must keep his approval.
    const store = createSuggestionStore({ rootDir: join(dir, 'suggestions') })
    const s = seed(store)
    store.updateStatus(s.id, 'approved', 'human:unblocks: ship it', undefined, {
      reviewVerdict: 'approve',
    })
    store.updateStatus(s.id, 'implemented')
    expect(store.get(s.id)?.reviewVerdict).toBe('approve')
  })

  it('T156 (SUPERSEDED 2026-08-04, FR-059): an approved item that FAILED banks the FACT but no gradient', () => {
    // ⚠️ DISCLOSED CHANGE — read this before touching the value again.
    //
    // T156 originally asserted `humanOutcomeOfVerdict('failed') === waste (0.2)`. It was written
    // after a previous pass SILENTLY made `approve + failed` bank nothing, and it existed to catch
    // exactly that edit. Phase 10f's third pass proposed the same change again and REFUSED to make
    // it, escalating instead (§11), precisely because retiring a named invariant quietly is the
    // pattern the invariant was written to stop.
    //
    // John ruled on 2026-08-04: move it to NEUTRAL. So the change is now made ON THE RECORD, by the
    // person whose preference the gradient is supposed to measure. Rationale: FR-059 removed
    // `failed` from `FAILED_VERDICTS` because a build failure says nothing about whether the human
    // wanted the outcome — and scoring it 0.2 waste on the north-star metric contradicted that in
    // the one place it matters most. Neutral is `null`, not 0.5: the honest statement is "this is
    // not evidence", and `null` settles nothing (`outcome-writer.ts:256`) rather than injecting a
    // midpoint datum that would still move the mean.
    //
    // T156's OTHER half is deliberately preserved below: the ledger still records that the build
    // failed. The fact is kept; only its interpretation as human displeasure is dropped. See
    // `docs/evidence/003-phase-10f-failure-branch-2026-08-04.md` §16.
    expect(humanVerdictToProposalVerdict('approve', 'failed')).toBe('failed')
    expect(humanOutcomeOfVerdict('failed')).toBeNull()
    // Positive control: a real human refusal still carries the waste signal it always did.
    expect(humanOutcomeOfVerdict('rejected')).toBe(HUMAN_OUTCOME_GRADIENT.waste)
  })
})

describe('a contradicted verdict is never silently dropped', () => {
  it('T157: recordWeeklyVerdict warns when the status cannot carry his answer', () => {
    // He rejects, then approves in the same sitting. The terminal status cannot move (backfill never
    // re-decides), so the approval is recorded in the corpus but excluded from the learning signal.
    // Excluding it silently is a quieter version of the bug this whole epic exists to remove.
    const store = createSuggestionStore({ rootDir: join(dir, 'suggestions') })
    const s = seed(store)
    recordWeeklyVerdict(store, s.id, {
      verdict: 'reject',
      code: 'too-risky',
      text: 'first answer: too risky to run unattended',
    })
    const r = recordWeeklyVerdict(store, s.id, {
      verdict: 'approve',
      code: 'unblocks',
      text: 'second answer: I changed my mind, it is fine',
    })
    expect(r.ok).toBe(true)
    expect(r.verdictWarnings?.join(' ')).toMatch(/rejected/i)
    expect(r.verdictWarnings?.join(' ')).toMatch(/will not count|won't count|excluded/i)
  })

  it('T158: an uncontradicted verdict produces no warning', () => {
    const store = createSuggestionStore({ rootDir: join(dir, 'suggestions') })
    const s = seed(store)
    const r = recordWeeklyVerdict(store, s.id, {
      verdict: 'approve',
      code: 'unblocks',
      text: 'this unblocks the loop, ship it',
    })
    expect(r.ok).toBe(true)
    expect(r.verdictWarnings).toBeUndefined()
  })
})
