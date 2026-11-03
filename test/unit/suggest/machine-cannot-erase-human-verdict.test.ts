/**
 * T131c / FR-050c / SC-028 — a MACHINE writer may not erase a standing HUMAN verdict.
 *
 * This file defends one invariant and one only: the author discriminator on `updateStatus`.
 * It is deliberately separate from `qg-failure-not-rejection.test.ts` (which defends the retry
 * and escalation arithmetic) because the two fail for different reasons and a mixed file makes
 * a regression ambiguous.
 *
 * The behaviour being discriminated is NOT a bug on the human side and must survive intact:
 * `verdictContradictsStatus` exists so that a human re-deciding through a verdict-less seam — a
 * dashboard button — cannot be overruled by last week's answer. Deleting it re-opens
 * FR-051b/SC-027, which T130 closed. The defect was only ever that it could not tell a human
 * writer from a machine one, and so treated the quality gate as a later human decision.
 *
 * Isolation: `mkdtempSync` per test; `~/.scns` is never opened.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSuggestionStore } from '../../../src/suggest/suggestion-store.js'
import { SuggestionType, type Suggestion, type SuggestionStatus } from '../../../src/suggest/types.js'

let dir: string
let store: ReturnType<typeof createSuggestionStore>

const JOHN_APPROVED = 'human:cheap-win:small and unblocks the weekly loop'
const JOHN_REJECTED = 'human:wrong-layer:the broker already owns this'

function seed(id: string, verdict: 'approve' | 'reject', reason: string): Suggestion {
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
  return store.updateStatus(
    id,
    (verdict === 'approve' ? 'approved' : 'rejected') as SuggestionStatus,
    reason,
    undefined,
    { reviewVerdict: verdict },
  )!
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scns-author-'))
  store = createSuggestionStore({ rootDir: join(dir, 'suggestions') })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('FR-050c — the machine cannot erase a human verdict', () => {
  it('a MACHINE write of a contradicting status leaves the human `approve` verdict standing', () => {
    const id = 'b1111111-0000-4000-8000-000000000001'
    expect(seed(id, 'approve', JOHN_APPROVED).reviewVerdict).toBe('approve')

    store.updateStatus(id, 'rejected' as SuggestionStatus, 'qg-fail:tests-failed', undefined, {
      author: 'machine',
    })

    // This is the 65a914f4 write, verbatim. The machine may record its own verdict; it may not
    // overwrite John's.
    const after = store.get(id)!
    expect(after.reviewVerdict).toBe('approve')
    expect(after.reviewReason).toBe(JOHN_APPROVED)
    expect(after.machineReason).toBe('qg-fail:tests-failed')
  })

  it('a MACHINE write leaves a human `reject` verdict standing too', () => {
    const id = 'b1111111-0000-4000-8000-000000000002'
    expect(seed(id, 'reject', JOHN_REJECTED).reviewVerdict).toBe('reject')

    // `approved`/`implemented` contradict a `reject` verdict. An automated re-promotion is still
    // not John changing his mind; the protection is symmetric on purpose, because the scarce
    // half of the corpus is not the only half worth protecting.
    store.updateStatus(id, 'implemented' as SuggestionStatus, 'qg-pass', undefined, {
      author: 'machine',
    })

    const after = store.get(id)!
    expect(after.reviewVerdict).toBe('reject')
    expect(after.reviewReason).toBe(JOHN_REJECTED)
  })

  it('SC-028 mutation: WITHOUT the author discriminator the same write erases the verdict', () => {
    const id = 'b1111111-0000-4000-8000-000000000003'
    seed(id, 'approve', JOHN_APPROVED)

    // The mutation is "the machine cannot declare itself" — i.e. the pre-fix arbiter, whose
    // store interface was narrowed to `(id, status, reason?)`. Omitting the author reproduces
    // the defect exactly, which is what makes the discriminator load-bearing rather than
    // decorative. If this ever stops erasing, the protection has moved somewhere else and this
    // test's premise needs re-deriving.
    store.updateStatus(id, 'rejected' as SuggestionStatus, 'qg-fail:tests-failed')

    expect(store.get(id)!.reviewVerdict).toBeUndefined()
  })
})

describe('FR-051b / SC-027 — the human fail-safe T130 closed is NOT re-opened', () => {
  it('a HUMAN write of a contradicting status still clears the stale verdict', () => {
    const id = 'b2222222-0000-4000-8000-000000000001'
    seed(id, 'approve', JOHN_APPROVED)

    // The dashboard "reject" button: a human re-deciding through a seam with no verdict field.
    // Monday's `approve` must NOT outrank Tuesday's click. Default author is `human`, so this is
    // also the assertion that the default is the safe one.
    store.updateStatus(id, 'rejected' as SuggestionStatus)

    expect(store.get(id)!.reviewVerdict).toBeUndefined()
  })

  it('an explicit verdict from a human write always wins, whatever the author', () => {
    const id = 'b2222222-0000-4000-8000-000000000002'
    seed(id, 'approve', JOHN_APPROVED)

    store.updateStatus(id, 'rejected' as SuggestionStatus, JOHN_REJECTED, undefined, {
      reviewVerdict: 'reject',
    })

    expect(store.get(id)!.reviewVerdict).toBe('reject')
    expect(store.get(id)!.reviewReason).toBe(JOHN_REJECTED)
  })

  it('a non-contradicting machine write is unaffected by the discriminator', () => {
    const id = 'b2222222-0000-4000-8000-000000000003'
    seed(id, 'approve', JOHN_APPROVED)

    // `in-progress` denies nothing, so both authors behave identically here. Pinned so the
    // discriminator cannot quietly grow into a broader behavioural difference.
    const asMachine = store.updateStatus(id, 'in-progress' as SuggestionStatus, undefined, undefined, {
      author: 'machine',
    })
    expect(asMachine!.reviewVerdict).toBe('approve')

    const asHuman = store.updateStatus(id, 'in-progress' as SuggestionStatus)
    expect(asHuman!.reviewVerdict).toBe('approve')
  })
})

describe('a WORDLESS human reason is still HIS — provenance, not rationale', () => {
  /**
   * RE-GRADE 2026-08-05, finding 2. `resolveReasons` (suggestion-store.ts:95/98) deliberately asks
   * `isHumanReason` and NOT `hasHumanRationale`: the question at this seam is "did John author
   * this?", never "did he explain himself?". A verdict code with no prose after it is still his
   * field, and a machine must not be able to take it just because he was terse.
   *
   * This was load-bearing and completely unpinned — a mutant switching either line to
   * `hasHumanRationale` was caught by NOTHING in the repo suite (`Tests 981 passed (981)`). These
   * three tests are that missing pin.
   */
  const JOHN_WORDLESS = 'human:cheap-win:'

  it('an empty human reason still survives a machine overwrite', () => {
    const id = 'b3333333-0000-4000-8000-000000000001'
    seed(id, 'approve', JOHN_WORDLESS)
    expect(store.get(id)!.reviewReason).toBe(JOHN_WORDLESS)

    store.updateStatus(id, 'rejected' as SuggestionStatus, 'qg-fail:tests-failed', undefined, {
      author: 'machine',
    })

    // Mutant at :98 (`isHumanReason` → `hasHumanRationale`) makes `protectedHuman` undefined here,
    // so the machine's string lands in his field and the wordless verdict is gone for good.
    const after = store.get(id)!
    expect(after.reviewReason).toBe(JOHN_WORDLESS)
    expect(after.machineReason).toBe('qg-fail:tests-failed')
  })

  it('a wordless verdict he writes NOW lands in his field, not the machine one', () => {
    const id = 'b3333333-0000-4000-8000-000000000002'
    seed(id, 'approve', JOHN_APPROVED)

    // Pins the INCOMING side, :95. Under the same mutant this reason fails the human test on the
    // way in, falls through to :98, and is filed as `machineReason` while last week's answer stays
    // standing as his — a machine reason invented out of something he actually typed.
    store.updateStatus(id, 'rejected' as SuggestionStatus, JOHN_WORDLESS, undefined, {
      reviewVerdict: 'reject',
    })

    const after = store.get(id)!
    expect(after.reviewReason).toBe(JOHN_WORDLESS)
    expect(after.machineReason).toBeUndefined()
  })

  it('NEGATIVE CONTROL: a machine reason is still freely overwritten by the next machine write', () => {
    const id = 'b3333333-0000-4000-8000-000000000003'
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

    // Guards the opposite mutant — ":98 protects everything". The protection is for HIS field
    // only; with no human reason on record there is nothing to protect and the newer machine
    // reason must win, or the store silently freezes the first failure it ever saw.
    store.updateStatus(id, 'rejected' as SuggestionStatus, 'qg-fail:tests-failed', undefined, {
      author: 'machine',
    })
    store.updateStatus(id, 'rejected' as SuggestionStatus, 'qg-fail:lint-failed', undefined, {
      author: 'machine',
    })

    expect(store.get(id)!.reviewReason).toBe('qg-fail:lint-failed')
  })
})
