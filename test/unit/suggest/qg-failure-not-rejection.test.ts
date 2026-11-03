/**
 * Phase 10f — RED state for the failure branch (FR-050c, FR-056 – FR-058; SC-028 – SC-030).
 *
 * The live inversion this pins, measured 2026-08-04:
 *
 *     ~/.scns/suggestions/rejected/65a914f4-b229-4fde-874e-c46a44dd845f.md
 *       status:        "rejected"          ← the label that means "John declined this"
 *       reviewReason:  "human:cheap-win:"  ← but John APPROVED it
 *       machineReason: "qg-fail:tests-failed"
 *       (no attemptCount field at all)     ← terminal on attempt one, zero retries
 *
 * John approved `65a914f4` at 16:33, the brain spawned a team, both dev sessions exited with
 * `diff_bytes=0`, the gate failed at 16:53, and the arbiter wrote `rejected`. Because
 * `rejected ∈ FAILED_VERDICTS`, the learner then counted his APPROVAL as his REFUSAL and fed it
 * into family suppression.
 *
 * Everything asserted here is about the seam between the quality gate and the suggestion store.
 * The retry machinery already exists (`recordFailure`, `computeNextRetryAt`,
 * `MAX_ATTEMPTS_BEFORE_FAILED`); the gate simply never called it.
 *
 * Isolation: `mkdtempSync` store dir per test. `~/.scns` is never opened, for reading or writing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createSuggestionStore,
  MAX_ATTEMPTS_BEFORE_FAILED,
} from '../../../src/suggest/suggestion-store.js'
import {
  SuggestionType,
  type Suggestion,
  type SuggestionStatus,
} from '../../../src/suggest/types.js'

let dir: string
let store: ReturnType<typeof createSuggestionStore>

function sugg(id: string): Suggestion {
  return {
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
  } as Suggestion
}

/**
 * Put a suggestion in exactly the state `65a914f4` was in the instant before the gate ran:
 * John has approved it with his own words and an explicit `approve` verdict, and the brain has
 * moved it to `in-progress` against a spawned team.
 */
function humanApprovedAndInFlight(id: string): Suggestion {
  store.save(sugg(id))
  store.updateStatus(
    id,
    'approved' as SuggestionStatus,
    'human:cheap-win:small and unblocks the loop',
    undefined,
    {
      reviewVerdict: 'approve',
    },
  )
  return store.markInProgress(id, `team-sugg-${id.slice(0, 8)}`)!
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scns-qg-failure-'))
  store = createSuggestionStore({ rootDir: join(dir, 'suggestions') })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('FR-056 — a build failure is not the human’s refusal', () => {
  it('T142(a): a gate failure on a human-approved proposal does NOT land in `rejected`', () => {
    const s = humanApprovedAndInFlight('a1111111-0000-4000-8000-000000000001')
    expect(s.status).toBe('in-progress')

    const after = store.recordQualityGateFailure(s.id, 'qg-fail:tests-failed')

    // `rejected` is reserved for "John declined this" (FR-056). This is the exact label the
    // live corpus carries on 65a914f4 and the reason the learner inverted his approval.
    expect(after?.status).not.toBe('rejected')
  })

  it('T142(b): a gate failure increments `attemptCount` and schedules a retry', () => {
    const s = humanApprovedAndInFlight('a1111111-0000-4000-8000-000000000002')
    expect(s.attemptCount).toBe(0)

    const after = store.recordQualityGateFailure(s.id, 'qg-fail:tests-failed')

    // 65a914f4 has no `attemptCount` field at all — it was terminal on attempt one.
    expect(after?.attemptCount).toBe(1)
    expect(after?.lastError).toContain('qg-fail:tests-failed')
    expect(after?.nextRetryAt).toBeTruthy()
  })

  it('T142(c) / T131d: the human `approve` verdict survives the machine’s write', () => {
    const s = humanApprovedAndInFlight('a1111111-0000-4000-8000-000000000003')
    expect(s.reviewVerdict).toBe('approve')

    store.recordQualityGateFailure(s.id, 'qg-fail:tests-failed')
    const after = store.get(s.id)

    // FR-050c / SC-028: a machine writer must not erase a standing human verdict. Without this
    // the census cannot even see the violation — the proof that John approved is destroyed by
    // the same write that mislabels it.
    expect(after?.reviewVerdict).toBe('approve')
    expect(after?.reviewReason).toBe('human:cheap-win:small and unblocks the loop')
  })

  it('T142 positive control: a gate PASS still reaches `implemented` on the first attempt', () => {
    const s = humanApprovedAndInFlight('a1111111-0000-4000-8000-000000000004')

    const after = store.updateStatus(
      s.id,
      'implemented' as SuggestionStatus,
      'qg-pass',
      undefined,
      {
        author: 'machine',
      },
    )

    // This is what stops the fix from being "disable the gate". The pass path is not defective
    // and must not change.
    expect(after?.status).toBe('implemented')
    expect(after?.attemptCount).toBe(0)
    expect(after?.reviewVerdict).toBe('approve')
  })
})

describe('FR-057 — iterate before labelling', () => {
  it('T144: the proposal returns to `approved` so the brain re-picks it up on backoff', () => {
    const s = humanApprovedAndInFlight('a2222222-0000-4000-8000-000000000001')

    const after = store.recordQualityGateFailure(s.id, 'qg-fail:tests-failed')

    // The brain's retry loop lists `approved` only (`agent-loop.ts` ApprovedSuggestions).
    // Leaving the item in `in-progress` would strand it forever — a silent terminal state
    // that is worse than the mislabel it replaces.
    expect(after?.status).toBe('approved')
    expect(store.list('approved' as SuggestionStatus).map((x) => x.id)).toContain(s.id)
  })

  it('T144: `inflightTeamId` is cleared so the failed team cannot be resumed', () => {
    const s = humanApprovedAndInFlight('a2222222-0000-4000-8000-000000000002')
    expect(s.inflightTeamId).toBe(`team-sugg-${s.id.slice(0, 8)}`)

    store.recordQualityGateFailure(s.id, 'qg-fail:tests-failed')

    // FR-057c: a retry must spawn a NEW agent context. Both dev sessions on 65a914f4 exited
    // with message_count=0 — the signature of a stuck context — so resuming the same team id
    // would reproduce the failure deterministically.
    expect(store.get(s.id)?.inflightTeamId).toBeNull()
  })

  it('T145: a retry records no second verdict and does not re-enter the human decision path', () => {
    const s = humanApprovedAndInFlight('a2222222-0000-4000-8000-000000000003')

    store.recordQualityGateFailure(s.id, 'qg-fail:tests-failed')
    const first = store.get(s.id)!
    store.markInProgress(s.id, 'team-sugg-retry2')
    store.recordQualityGateFailure(s.id, 'qg-fail:tests-failed')
    const second = store.get(s.id)!

    // A retry is a new IMPLEMENTATION attempt, not a new DECISION. The verdict and the human's
    // words are carried unchanged; only the attempt counter moves.
    expect(second.reviewVerdict).toBe(first.reviewVerdict)
    expect(second.reviewReason).toBe(first.reviewReason)
    expect(second.attemptCount).toBe(2)
  })

  it('T146: the gate seam honours MAX_ATTEMPTS_BEFORE_FAILED and does not introduce a second limit', () => {
    // Pinned so a future edit to the constant fails loudly instead of silently changing gate
    // behaviour. DECIDED 2026-08-04: the ceiling stays 5.
    expect(MAX_ATTEMPTS_BEFORE_FAILED).toBe(5)

    const s = humanApprovedAndInFlight('a3333333-0000-4000-8000-000000000001')
    const statuses: string[] = []
    for (let i = 0; i < MAX_ATTEMPTS_BEFORE_FAILED; i++) {
      const after = store.recordQualityGateFailure(s.id, `qg-fail:attempt-${i + 1}`)
      statuses.push(after!.status)
    }

    // Non-terminal for every attempt below the ceiling, terminal exactly at it.
    expect(statuses.slice(0, MAX_ATTEMPTS_BEFORE_FAILED - 1)).toEqual(
      Array(MAX_ATTEMPTS_BEFORE_FAILED - 1).fill('approved'),
    )
    expect(statuses[MAX_ATTEMPTS_BEFORE_FAILED - 1]).toBe('needs-human')
    expect(store.get(s.id)?.attemptCount).toBe(MAX_ATTEMPTS_BEFORE_FAILED)
  })
})

describe('FR-058 — escalate rather than close', () => {
  function exhaust(id: string): Suggestion {
    const s = humanApprovedAndInFlight(id)
    for (let i = 0; i < MAX_ATTEMPTS_BEFORE_FAILED; i++) {
      store.recordQualityGateFailure(s.id, `qg-fail:tests-failed`)
    }
    return store.get(s.id)!
  }

  it('T147: an exhausted proposal escalates to `needs-human`, not `rejected` or `failed`', () => {
    const s = exhaust('a4444444-0000-4000-8000-000000000001')

    // DECIDED: reuse the existing `needs-human`. It is in neither LANDED_VERDICTS nor
    // FAILED_VERDICTS, so it contributes 0 to both counts (FR-056a).
    expect(s.status).toBe('needs-human')
  })

  it('T147: the escalated item carries lastError, the gate output and attemptCount (FR-058)', () => {
    const s = exhaust('a4444444-0000-4000-8000-000000000002')

    // John cannot decide "fix it or close it" without seeing why it failed and how often.
    expect(s.lastError).toContain('qg-fail:tests-failed')
    expect(s.attemptCount).toBe(MAX_ATTEMPTS_BEFORE_FAILED)
    expect(s.lastAttemptAt).toBeTruthy()
  })

  it('T147: an exhausted implementation is distinguishable from a gate-opt-in `needs-human` (FR-056b)', () => {
    const exhausted = exhaust('a4444444-0000-4000-8000-000000000003')

    // `needs-human` already means "the gate requires an explicit opt-in" (executor.ts:522).
    // Overloading it is only safe while the two remain readable apart. The discriminator is
    // `machineReason` starting `qg-fail:` PLUS a non-zero attemptCount.
    const optIn = sugg('a4444444-0000-4000-8000-000000000004')
    store.save(optIn)
    store.updateStatus(optIn.id, 'needs-human' as SuggestionStatus, 'autonomy-level-too-low')

    expect(exhausted.machineReason?.startsWith('qg-fail:')).toBe(true)
    expect(exhausted.attemptCount).toBeGreaterThan(0)

    const optInAfter = store.get(optIn.id)!
    expect(optInAfter.machineReason?.startsWith('qg-fail:') ?? false).toBe(false)
    expect(optInAfter.attemptCount).toBe(0)
  })

  it('T147: the human’s words and verdict survive all the way to escalation', () => {
    const s = exhaust('a4444444-0000-4000-8000-000000000005')

    // The whole point: five build failures are still not John changing his mind.
    expect(s.reviewVerdict).toBe('approve')
    expect(s.reviewReason).toBe('human:cheap-win:small and unblocks the loop')
  })
})

describe('T144 scope boundary — a proposal the human never approved', () => {
  it('a gate failure on an auto-approved proposal still iterates and never becomes `rejected`', () => {
    // Reachable unattended: SCNS_SUGGEST_AUTO_APPROVE_THRESHOLD is live on the plist, so the
    // brain approves and executes without John. Decided explicitly rather than inherited:
    // `rejected` means "the HUMAN declined this", and no human was involved here at all — so
    // this path gets the same iterate-then-escalate treatment, and the difference is visible
    // in the ABSENCE of a human verdict, not in the status.
    const id = 'a5555555-0000-4000-8000-000000000001'
    store.save(sugg(id))
    store.updateStatus(id, 'approved' as SuggestionStatus, 'auto-approved: confidence 0.91')
    store.markInProgress(id, 'team-sugg-a5555555')

    const after = store.recordQualityGateFailure(id, 'qg-fail:tests-failed')

    expect(after?.status).toBe('approved')
    expect(after?.attemptCount).toBe(1)
    expect(after?.reviewVerdict).toBeUndefined()
  })

  it('an auto-approved proposal that exhausts its budget also escalates to `needs-human`', () => {
    const id = 'a5555555-0000-4000-8000-000000000002'
    store.save(sugg(id))
    store.updateStatus(id, 'approved' as SuggestionStatus, 'auto-approved: confidence 0.91')
    for (let i = 0; i < MAX_ATTEMPTS_BEFORE_FAILED; i++) {
      store.recordQualityGateFailure(id, 'qg-fail:tests-failed')
    }

    // Escalation is right here too: an item the machine approved AND could not build is
    // precisely something John should see, and it is still not his refusal.
    expect(store.get(id)?.status).toBe('needs-human')
  })
})
