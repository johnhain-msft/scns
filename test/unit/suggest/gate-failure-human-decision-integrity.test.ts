/**
 * A quality-gate failure is a statement about the BUILD, never about the human's decision.
 *
 * These tests pin the boundary from both sides. A gate failure must not reopen, demote or
 * un-ship anything a human already decided; and the outcome ledger must record it as an
 * implementation failure rather than a refusal. Losing either direction re-creates the original
 * defect, where an approved proposal was booked as its author's rejection.
 *
 * Each `describe` names the invariant it defends. Positive controls are included so a test that
 * passes vacuously is visible.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { createSuggestionStore, MAX_ATTEMPTS_BEFORE_FAILED } from '../../../src/suggest/suggestion-store.js'
import { recordProposalOutcome, FAILED_VERDICTS } from '../../../src/memory/proposal-outcomes.js'
import { promoteSuggestions } from '../../../src/brain/suggestion-promoter.js'
import { selectWeeklyPacket } from '../../../src/suggest/weekly-review.js'
import { runRetry } from '../../../src/cli/suggest.js'
import { SuggestionType, type Suggestion } from '../../../src/suggest/types.js'

let dir: string
let store: ReturnType<typeof createSuggestionStore>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'p10f-findings-'))
  store = createSuggestionStore({ rootDir: join(dir, 'suggestions') })
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function seedApproved(id = '11111111-1111-4111-8111-111111111111'): Suggestion {
  store.save({
    id,
    type: SuggestionType.Workflow,
    title: `title ${id}`,
    description: 'a description',
    confidence: 0.9,
    status: 'pending',
    createdAt: '2026-08-04T00:00:00.000Z',
    updatedAt: '2026-08-04T00:00:00.000Z',
    evidence: [],
    tags: ['self-improvement'],
  } as Suggestion)
  store.updateStatus(id, 'approved', 'human:cheap-win:small and unblocks the loop', undefined, {
    reviewVerdict: 'approve',
    author: 'human',
  })
  return store.get(id)!
}

describe('a gate failure must not reopen a decision the human owns', () => {
  it('does not resurrect a proposal the human REJECTED while its team was still running', () => {
    // Reachable: John rejects (or the dashboard reject button fires) while the team runs; the gate
    // then fails and resolves the team back to this suggestion by parsing its id, which ignores
    // status entirely. Before the guard this wrote `status: approved` onto an item whose
    // `reviewVerdict` is `reject` — the exact contradiction `verdictContradictsStatus` prevents,
    // via the one path that legitimately bypasses it. The brain would then re-spawn a team for
    // work he declined, up to five times.
    const s = seedApproved()
    store.updateStatus(s.id, 'rejected', 'human:wrong-layer:the broker already owns this', undefined, {
      reviewVerdict: 'reject',
      author: 'human',
    })

    const after = store.recordQualityGateFailure(s.id, 'qg-fail:tests-failed')

    expect(after?.status).toBe('rejected')
    expect(after?.reviewVerdict).toBe('reject')
    // No retry is scheduled for something he said no to.
    expect(after?.nextRetryAt).toBeNull()
  })

  it('does not demote an already-implemented proposal', () => {
    const s = seedApproved()
    store.updateStatus(s.id, 'implemented', undefined, undefined, { author: 'machine' })

    const after = store.recordQualityGateFailure(s.id, 'qg-fail:tests-failed')

    expect(after?.status).toBe('implemented')
  })

  it('still retries normally when the human has NOT re-decided (positive control)', () => {
    const s = seedApproved()
    const after = store.recordQualityGateFailure(s.id, 'qg-fail:tests-failed')
    expect(after?.status).toBe('approved')
    expect(after?.attemptCount).toBe(1)
    expect(after?.nextRetryAt).not.toBeNull()
  })
})

describe('the outcome ledger must not bank a build failure as a refusal', () => {
  let db: Database.Database
  beforeEach(() => {
    db = new Database(':memory:')
  })
  afterEach(() => {
    db.close()
  })

  it('a gate failure banks `failed`, which is NOT counted by FAILED_VERDICTS', () => {
    // The phase fixed the suggestion FILE and left `proposal_outcomes` writing `rejected`, so the
    // learner-level harm — the one the spec actually describes — survived one layer down. It is
    // reachable unattended for any auto-approved item (no human verdict to protect it).
    const row = recordProposalOutcome(db, {
      entity: 'broker',
      family: 'port-precedence',
      title: 't',
      verdict: 'failed',
      suggestionId: 'sugg-1',
    })
    expect(row?.verdict).toBe('failed')
    expect(FAILED_VERDICTS.has('failed')).toBe(false)
  })

  it('a later landing SUPERSEDES an earlier build failure (first-write-wins is wrong once retries exist)', () => {
    // This divergence is created BY the retry change. While attempt 1 was terminal, first row ==
    // last row and `ON CONFLICT DO NOTHING` was harmless. With five attempts a proposal can fail
    // attempt 1 and land on attempt 3, and the ledger would permanently report attempt 1.
    recordProposalOutcome(db, {
      entity: 'broker',
      family: 'port-precedence',
      title: 't',
      verdict: 'failed',
      suggestionId: 'sugg-1',
    })
    const after = recordProposalOutcome(db, {
      entity: 'broker',
      family: 'port-precedence',
      title: 't',
      verdict: 'implemented',
      suggestionId: 'sugg-1',
    })
    expect(after?.verdict).toBe('implemented')

    const rows = db.prepare('SELECT verdict FROM proposal_outcomes').all() as Array<{ verdict: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0]!.verdict).toBe('implemented')
  })

  it('a build failure NEVER overwrites the human’s recorded rejection', () => {
    // The precedence the whole phase rests on, asserted in the direction that would be easy to get
    // backwards: his refusal outranks a machine failure, not the other way round.
    recordProposalOutcome(db, {
      entity: 'broker',
      family: 'port-precedence',
      title: 't',
      verdict: 'rejected',
      suggestionId: 'sugg-2',
    })
    recordProposalOutcome(db, {
      entity: 'broker',
      family: 'port-precedence',
      title: 't',
      verdict: 'failed',
      suggestionId: 'sugg-2',
    })
    const rows = db
      .prepare('SELECT verdict FROM proposal_outcomes WHERE suggestion_id = ?')
      .all('sugg-2') as Array<{ verdict: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0]!.verdict).toBe('rejected')
  })
})

describe('the promoter must honour the retry backoff', () => {
  const baseInput = {
    autonomyLevel: 2,
    maxConcurrentSessions: 4,
    activeSessions: 0,
    inflightTasks: [],
  }

  it('skips an approved item whose nextRetryAt has not arrived', () => {
    // `ApprovedSuggestions` honoured backoff; this path listed the SAME approved items and did not.
    // For a `solo` proposal (which 65a914f4 is) only this path runs, so the 5-attempt budget would
    // burn in minutes and a transient failure would escalate immediately.
    const s = {
      ...seedApproved(),
      nextRetryAt: new Date(10_000).toISOString(),
      attemptCount: 1,
    }
    const res = promoteSuggestions({ ...baseInput, suggestions: [s], nowMs: 5_000 })
    expect(res.promoted).toHaveLength(0)
    expect(res.skipped.map((x) => x.reason)).toContain('retry-backoff')
  })

  it('promotes once the backoff has elapsed (positive control)', () => {
    const s = {
      ...seedApproved(),
      nextRetryAt: new Date(10_000).toISOString(),
      attemptCount: 1,
    }
    const res = promoteSuggestions({ ...baseInput, suggestions: [s], nowMs: 20_000 })
    expect(res.promoted).toHaveLength(1)
  })
})

describe('an escalated proposal must be reachable and retryable', () => {
  function exhaust(id = '22222222-2222-4222-8222-222222222222'): Suggestion {
    const s = seedApproved(id)
    for (let i = 0; i < MAX_ATTEMPTS_BEFORE_FAILED; i++) {
      store.recordQualityGateFailure(s.id, 'qg-fail:tests-failed')
    }
    return store.get(s.id)!
  }

  it('reaches needs-human with the human verdict intact', () => {
    const s = exhaust()
    expect(s.status).toBe('needs-human')
    expect(s.reviewVerdict).toBe('approve')
    expect(s.attemptCount).toBe(MAX_ATTEMPTS_BEFORE_FAILED)
  })

  it('appears in the weekly packet — it was invisible BECAUSE the fix preserved his reason', () => {
    // The backfill pool selects terminal items with NO human reason. An escalated item has one:
    // John's approval, which this phase exists to protect. Succeeding at protecting his words was
    // therefore enough to hide the item from the surface built to show him things — and `hasWork`
    // gates whether the review window opens at all.
    const s = exhaust()
    const packet = selectWeeklyPacket({
      pending: [],
      terminal: [s],
      now: new Date(),
      budget: 5,
    } as never)

    expect(packet.selectedEscalated).toBe(1)
    expect(packet.items.map((i) => i.id)).toContain(s.id)
    expect(packet.items.find((i) => i.id === s.id)!.kind).toBe('escalated')
    expect(packet.items.length).toBeGreaterThan(0)
  })

  it('`scns suggest retry` accepts it and resets the budget', () => {
    // Without this the escalation was a dead end: retry refused anything not `failed`, and
    // `repromote` — the only other exit — sent it back to `pending` for re-triage.
    const s = exhaust()
    const res = runRetry(store as never, s.id)
    expect(res.ok).toBe(true)

    const after = store.get(s.id)!
    expect(after.status).toBe('approved')
    expect(after.attemptCount).toBe(0)
    expect(after.reviewVerdict).toBe('approve')
  })

  it('a needs-human from the OTHER meaning (safety-gate opt-in) is still refused by retry', () => {
    // FR-056b: the two meanings must stay distinguishable. A safety-gate `needs-human` has no
    // `qg-fail:` machineReason and no attempts, and genuinely needs re-judging, not another try.
    const s = seedApproved('33333333-3333-4333-8333-333333333333')
    store.updateStatus(s.id, 'needs-human', undefined, undefined, { author: 'machine' })

    const res = runRetry(store as never, s.id)
    expect(res.ok).toBe(false)
    expect(res.message).toContain('cannot retry')
  })

  it('repromote preserves the verdict and resets the counter for a gate-exhausted item', () => {
    // repromote is the only exit from needs-human and it cleared reviewVerdict/reviewReason — so
    // the machine would have erased John's approval one hop after the gate was stopped from doing
    // it. It also left attemptCount at the ceiling, so the NEXT single failure went terminal:
    // "terminal on attempt one", restored through the back door.
    const s = exhaust()
    const after = store.repromote(s.id)!

    expect(after.status).toBe('pending')
    expect(after.reviewVerdict).toBe('approve')
    expect(after.reviewReason).toBe('human:cheap-win:small and unblocks the loop')
    expect(after.attemptCount).toBe(0)
  })

  it('repromote still CLEARS the verdict for a rebuilt (safety-gate) needs-human', () => {
    // The 13.12.16 behaviour must survive unchanged: there the proposal text was replaced, so the
    // verdict genuinely belongs to a version that no longer exists.
    const s = seedApproved('44444444-4444-4444-8444-444444444444')
    store.updateStatus(s.id, 'needs-human', undefined, undefined, { author: 'machine' })

    const after = store.repromote(s.id)!
    expect(after.status).toBe('pending')
    expect(after.reviewVerdict).toBeUndefined()
    expect(after.reviewReason).toBeUndefined()
  })
})
