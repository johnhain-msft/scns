/**
 * `needs-human` is two things wearing one label — make the type carry that (John, 2026-08-04).
 *
 * The status means BOTH "a safety gate refused this; rebuild it" (13.12.16, `executor.ts:522`) and
 * "the quality gate exhausted its retries; decide" (FR-056b, Phase 10f). Until now the difference
 * was recovered by SNIFFING two unrelated fields at five separate readers:
 *
 *     s.machineReason?.startsWith('qg-fail:') && (s.attemptCount ?? 0) > 0
 *
 * Sniffing is the defect pattern. It is duplicated, so readers can drift; it is implicit, so nothing
 * fails when a producer forgets; and it is WRONG for the live artefact this whole phase exists for —
 * `65a914f4` carries a `qg-fail:` reason with `attemptCount: 0`, because it predates the counting.
 * John's ruling: make it two categories.
 *
 * The subtype is a FIELD, not two new statuses. `status` is the on-disk directory name, so new
 * statuses would relabel live files — the exact "rewriting history" T149 forbids. One status, an
 * explicit tag, and a legacy fallback so files written before this change keep classifying.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createSuggestionStore } from '../../../src/suggest/suggestion-store.js'
import {
  escalationKindOf,
  isGateExhausted,
  isGateRefused,
} from '../../../src/suggest/escalation.js'
import { isFamilyDedupped } from '../../../src/suggest/dedup-policy.js'
import type { Suggestion } from '../../../src/suggest/types.js'

let dir: string
let store: ReturnType<typeof createSuggestionStore>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scns-esc-'))
  store = createSuggestionStore({ rootDir: join(dir, 'suggestions') })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function mk(id: string, over: Partial<Suggestion> = {}): Suggestion {
  return {
    id,
    type: 'skill',
    title: `proposal ${id.slice(0, 8)}`,
    description: 'd',
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

describe('the two meanings of `needs-human` are distinct categories', () => {
  it('the gate exhausting its retries tags the item `gate-exhausted`', () => {
    const id = '55555555-0000-4000-8000-000000000001'
    store.save(mk(id))
    store.updateStatus(id, 'approved', 'human:cheap-win:go', undefined, {
      reviewVerdict: 'approve',
    })
    for (let i = 0; i < 6; i += 1) store.recordQualityGateFailure(id, 'qg-fail:no-diff')

    const s = store.get(id)!
    expect(s.status).toBe('needs-human')
    expect(s.escalation).toBe('gate-exhausted')
    expect(escalationKindOf(s)).toBe('gate-exhausted')
    expect(isGateExhausted(s)).toBe(true)
    expect(isGateRefused(s)).toBe(false)
  })

  it('a safety-gate refusal tags the item `gate-refused`', () => {
    const id = '55555555-0000-4000-8000-000000000002'
    store.save(mk(id))
    store.updateStatus(id, 'needs-human', 'self-critique: too risky unattended', undefined, {
      author: 'machine',
      escalation: 'gate-refused',
    })

    const s = store.get(id)!
    expect(s.escalation).toBe('gate-refused')
    expect(isGateRefused(s)).toBe(true)
    expect(isGateExhausted(s)).toBe(false)
  })

  it('survives a round-trip through the file (the tag is persisted, not in-memory)', () => {
    const id = '55555555-0000-4000-8000-000000000003'
    store.save(mk(id))
    store.updateStatus(id, 'approved', 'human:cheap-win:go', undefined, {
      reviewVerdict: 'approve',
    })
    for (let i = 0; i < 6; i += 1) store.recordQualityGateFailure(id, 'qg-fail:no-diff')

    // Re-open the store from scratch: nothing cached, everything read off disk.
    const reopened = createSuggestionStore({ rootDir: join(dir, 'suggestions') })
    expect(reopened.get(id)?.escalation).toBe('gate-exhausted')
  })
})

describe('the tag does not outlive the state it describes', () => {
  // Found by mutation, not by design: deleting the lifecycle guard in `updateStatus` left all
  // nine original tests green. An un-cleared tag is not cosmetic — `escalationKindOf` reads the
  // field FIRST, so a stale `gate-refused` left on a resumed item makes its NEXT genuine
  // gate-exhaustion classify as a refusal: it drops out of the weekly escalated pool, `retry`
  // refuses it, and dedup blocks its family forever. Exactly the silent mislabelling of 65a914f4.

  it('leaving `needs-human` clears the tag', () => {
    const id = '55555555-0000-4000-8000-00000000000b'
    store.save(mk(id))
    store.updateStatus(id, 'needs-human', 'self-critique: risky', undefined, {
      author: 'machine',
      escalation: 'gate-refused',
    })
    expect(store.get(id)?.escalation).toBe('gate-refused')

    store.updateStatus(id, 'approved', 'human:reconsidered:go', undefined, {
      reviewVerdict: 'approve',
    })
    const resumed = store.get(id)!
    expect(resumed.escalation).toBeUndefined()
    // And the stale tag is not merely absent from the object — it must not be readable back.
    expect(escalationKindOf(resumed)).toBeNull()
  })

  it('a resumed item that LATER exhausts the gate is classified as exhausted, not refused', () => {
    const id = '55555555-0000-4000-8000-00000000000c'
    store.save(mk(id))
    store.updateStatus(id, 'needs-human', 'self-critique: risky', undefined, {
      author: 'machine',
      escalation: 'gate-refused',
    })
    store.updateStatus(id, 'approved', 'human:reconsidered:go', undefined, {
      reviewVerdict: 'approve',
    })
    for (let i = 0; i < 6; i += 1) store.recordQualityGateFailure(id, 'qg-fail:no-diff')

    const s = store.get(id)!
    expect(s.status).toBe('needs-human')
    expect(escalationKindOf(s)).toBe('gate-exhausted')
    expect(isGateExhausted(s)).toBe(true)
  })

  it('repromote clears the tag on the gate-exhausted path', () => {
    const id = '55555555-0000-4000-8000-00000000000d'
    store.save(mk(id))
    store.updateStatus(id, 'approved', 'human:cheap-win:go', undefined, {
      reviewVerdict: 'approve',
    })
    for (let i = 0; i < 6; i += 1) store.recordQualityGateFailure(id, 'qg-fail:no-diff')
    expect(store.get(id)?.escalation).toBe('gate-exhausted')

    store.repromote(id)
    expect(store.get(id)?.status).toBe('pending')
    expect(store.get(id)?.escalation).toBeUndefined()
  })

  it('clearBackoff clears the tag when it resumes the item', () => {
    const id = '55555555-0000-4000-8000-00000000000e'
    store.save(mk(id))
    store.updateStatus(id, 'approved', 'human:cheap-win:go', undefined, {
      reviewVerdict: 'approve',
    })
    for (let i = 0; i < 6; i += 1) store.recordQualityGateFailure(id, 'qg-fail:no-diff')
    expect(store.get(id)?.escalation).toBe('gate-exhausted')

    store.clearBackoff(id)
    const cleared = store.get(id)!
    expect(cleared.status).not.toBe('needs-human')
    expect(cleared.escalation).toBeUndefined()
  })
})

describe('legacy files written before the split still classify', () => {
  // ~/.scns holds real `needs-human` files with no `escalation` field. If the new predicate only
  // read the field, every one of them would silently leave the escalated pool — an invisible
  // regression on live data, which is the failure mode this phase is about.
  it('falls back to the old discriminator when the tag is absent', () => {
    const legacy = mk('55555555-0000-4000-8000-000000000004', {
      status: 'needs-human',
      machineReason: 'qg-fail:tests-failed',
      attemptCount: 5,
    })
    expect(legacy.escalation).toBeUndefined()
    expect(isGateExhausted(legacy)).toBe(true)
  })

  it('an untagged `needs-human` with no qg-fail reason is gate-refused, not exhausted', () => {
    const legacy = mk('55555555-0000-4000-8000-000000000005', {
      status: 'needs-human',
      machineReason: 'self-critique: risky',
    })
    expect(isGateExhausted(legacy)).toBe(false)
    expect(isGateRefused(legacy)).toBe(true)
  })

  it('NEGATIVE CONTROL: a non-`needs-human` item is neither', () => {
    const approved = mk('55555555-0000-4000-8000-000000000006', {
      status: 'approved',
      machineReason: 'qg-fail:tests-failed',
      attemptCount: 5,
    })
    expect(escalationKindOf(approved)).toBeNull()
    expect(isGateExhausted(approved)).toBe(false)
    expect(isGateRefused(approved)).toBe(false)
  })
})

describe('dedup is deliberately UNCHANGED by the split — recorded so it is not re-added', () => {
  // A gate-exhausted exception was written here during pass 4 remediation and REMOVED in pass 5.
  // Two independent graders showed it was unreachable: `isFamilyDedupped` has one production
  // caller (`generator.ts:334`) and `shouldSkip` consults `store.findSimilar` first, which scans
  // every status dir lifetime-wide on >0.8 title overlap. Making it reachable would be worse than
  // leaving it: auto-approval is live at 0.80, so a re-proposed idea would be auto-approved with
  // no human in the loop and burn five more unattended quality-gate builds, each exhaustion
  // minting a new escalated item at the TOP of John's capped weekly packet.
  //
  // These tests pin the status quo on purpose. If a future change makes an idea re-proposable, it
  // must do so by RESUMING the existing suggestion (so `attemptCount` accumulates) rather than by
  // relaxing dedup — and these tests should be changed deliberately, with that in hand.
  const LONG_AGO = new Date('2026-01-01T00:00:00.000Z').toISOString()
  const NOW = Date.parse('2026-08-04T00:00:00.000Z')

  const dedupped = (over: Partial<Suggestion>): boolean =>
    isFamilyDedupped({
      title: 'Add retry to the indexer',
      type: 'skill',
      stored: [
        mk('55555555-0000-4000-8000-00000000000a', {
          title: 'Add retry to the indexer',
          status: 'needs-human',
          updatedAt: LONG_AGO,
          ...over,
        }),
      ],
      nowMs: NOW,
      dedupWindowDays: 7,
    })

  it('BOTH kinds of needs-human still block, window or not', () => {
    expect(
      dedupped({ escalation: 'gate-exhausted', machineReason: 'qg-fail:no-diff', attemptCount: 5 }),
    ).toBe(true)
    expect(dedupped({ escalation: 'gate-refused', machineReason: 'self-critique: risky' })).toBe(
      true,
    )
  })

  it('NEGATIVE CONTROL: an ordinary terminal item outside the window still re-surfaces', () => {
    // Proves the block above comes from ACTIVE_STATUSES membership, not from the window being
    // mis-set or the family failing to match.
    expect(dedupped({ status: 'implemented' })).toBe(false)
  })
})
