import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSuggestionStore } from '../../../src/suggest/suggestion-store.js'
import { SuggestionType, type Suggestion } from '../../../src/suggest/types.js'
import {
  buildWeeklySession,
  recordWeeklyVerdict,
  buildWeeklyNudge,
  explainedTerminalSuggestions,
} from '../../../src/suggest/weekly-session.js'

let dir: string
let store: ReturnType<typeof createSuggestionStore>

/** Deterministic-per-name UUIDs — the schema requires a real uuid, so 'a'/'b' fixtures fail. */
const IDS = new Map<string, string>()
function uid(name: string): string {
  if (!IDS.has(name)) IDS.set(name, randomUUID())
  return IDS.get(name)!
}

function sugg(o: Partial<Suggestion> & { id: string }): Suggestion {
  return {
    type: SuggestionType.Workflow,
    title: `title ${o.id}`,
    description: 'a description',
    confidence: 0.5,
    status: 'pending',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    evidence: [],
    ...o,
  } as Suggestion
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scns-weekly-'))
  store = createSuggestionStore({ rootDir: dir })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('buildWeeklySession', () => {
  it('returns an empty-but-valid session when there is nothing to review (NEGATIVE CONTROL)', () => {
    const s = buildWeeklySession({ store, now: new Date('2026-07-27T12:00:00Z') })
    expect(s.packet.items).toHaveLength(0)
    expect(s.engagement.sufficientData).toBe(false)
    expect(s.hasWork).toBe(false)
  })

  it('raises NO arm-promotion proposal any more — the tools are purpose-routed, not rivals (Step 2)', () => {
    const s = buildWeeklySession({ store, now: new Date('2026-08-17T09:00:00Z') })
    expect(store.list('pending').filter((x) => x.type === SuggestionType.ArmPromotion)).toHaveLength(0)
    expect(s.packet.items).toHaveLength(0)
    expect('armPromotion' in s).toBe(false)
  })

  it('reads engagement from HUMAN reasons only, never machine ones', () => {
    store.save(sugg({ id: uid('a') }))
    store.save(sugg({ id: uid('b') }))
    store.updateStatus(uid('a'), 'rejected', 'qg-fail:tests-failed')
    store.updateStatus(uid('b'), 'rejected', 'human:premature: no propensity model yet, far too early')
    const s = buildWeeklySession({ store, now: new Date('2026-07-27T12:00:00Z') })
    expect(s.engagement.n).toBe(1)
  })

  it('surfaces pending work and counts unexplained history', () => {
    for (const n of ['p1', 'p2']) store.save(sugg({ id: uid(n) }))
    store.save(sugg({ id: uid('r1') }))
    store.updateStatus(uid('r1'), 'rejected', undefined)
    const s = buildWeeklySession({ store, now: new Date('2026-07-27T12:00:00Z') })
    expect(s.packet.totalPending).toBe(2)
    expect(s.packet.totalUnexplained).toBe(1)
    expect(s.hasWork).toBe(true)
  })
})

describe('recordWeeklyVerdict', () => {
  beforeEach(() => store.save(sugg({ id: uid('x') })))

  it('writes the human reason through the EXISTING review path with the human: prefix', () => {
    const r = recordWeeklyVerdict(store, uid('x'), {
      verdict: 'reject',
      code: 'premature',
      text: 'we have no propensity model yet so this is far too early',
    })
    expect(r.ok).toBe(true)
    const after = store.get(uid('x'))!
    expect(after.status).toBe('rejected')
    expect(after.reviewReason).toMatch(/^human:premature: /)
    // and it must be on disk, since the outcome-writer reads the file
    const files = store.list('rejected')
    expect(files.find((f) => f.id === uid('x'))!.reviewReason).toMatch(/^human:premature: /)
  })

  it('refuses a verdict with no reason, rather than adding another unexplained row', () => {
    const r = recordWeeklyVerdict(store, uid('x'), { verdict: 'reject', code: null, text: '' })
    expect(r.ok).toBe(false)
    expect(store.get(uid('x'))!.status).toBe('pending')
  })

  it('reports a clear failure for an unknown id instead of throwing', () => {
    const r = recordWeeklyVerdict(store, randomUUID(), {
      verdict: 'approve',
      code: 'unblocks',
      text: 'this clears a real blocker i keep hitting',
    })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/not found/i)
  })
})

describe('backfilling an already-rejected suggestion', () => {
  it('attaches a human reason without resurrecting or re-deciding it', () => {
    store.save(sugg({ id: uid('old') }))
    store.updateStatus(uid('old'), 'rejected', undefined)
    const r = recordWeeklyVerdict(store, uid('old'), {
      verdict: 'reject',
      code: 'already-exists',
      text: 'the team reaper already covered this entire path',
    })
    expect(r.ok).toBe(true)
    const after = store.get(uid('old'))!
    expect(after.status).toBe('rejected')
    expect(after.reviewReason).toMatch(/^human:already-exists: /)
    expect(readFileSync(join(dir, 'rejected', `${uid('old')}.md`), 'utf-8')).toContain('human:already-exists')
  })
})

describe('buildWeeklyNudge', () => {
  it('says nothing when there is no pending work (NEGATIVE CONTROL)', () => {
    expect(buildWeeklyNudge(store, new Date('2026-07-27T12:00:00Z'))).toBeNull()
  })

  it('nudges when work is pending and no reason has ever been given', () => {
    store.save(sugg({ id: uid('n1') }))
    const n = buildWeeklyNudge(store, new Date('2026-07-27T12:00:00Z'))
    expect(n).toBeTruthy()
    expect(n).toMatch(/review weekly/)
  })

  it('goes quiet for a week after a review, rather than nagging every briefing', () => {
    store.save(sugg({ id: uid('n2') }))
    store.save(sugg({ id: uid('n3') }))
    store.updateStatus(uid('n2'), 'rejected', 'human:premature: too early, no propensity model yet')
    const justAfter = new Date(Date.now() + 60_000)
    expect(buildWeeklyNudge(store, justAfter)).toBeNull()
    const nextWeek = new Date(Date.now() + 8 * 86_400_000)
    expect(buildWeeklyNudge(store, nextWeek)).toBeTruthy()
  })

  it('is not reset by a MACHINE reason — only the human counts', () => {
    store.save(sugg({ id: uid('n4') }))
    store.save(sugg({ id: uid('n5') }))
    store.updateStatus(uid('n4'), 'rejected', 'qg-fail:tests-failed')
    expect(buildWeeklyNudge(store, new Date())).toBeTruthy()
  })
})

describe('explainedTerminalSuggestions — the bridge to the learner', () => {
  it('returns only terminal suggestions carrying a HUMAN reason', () => {
    store.save(sugg({ id: uid('e1') }))
    store.save(sugg({ id: uid('e2') }))
    store.save(sugg({ id: uid('e3') }))
    store.updateStatus(uid('e1'), 'rejected', 'human:risky: touches the allowlist, absolutely not')
    store.updateStatus(uid('e2'), 'rejected', 'qg-fail:tests-failed')
    // e3 stays pending
    const out = explainedTerminalSuggestions(store)
    expect(out.map((s) => s.id)).toEqual([uid('e1')])
  })

  it('returns nothing when no human has ever explained anything (NEGATIVE CONTROL)', () => {
    store.save(sugg({ id: uid('e4') }))
    store.updateStatus(uid('e4'), 'rejected', 'qg-fail:no-diff')
    expect(explainedTerminalSuggestions(store)).toHaveLength(0)
  })
})

describe('non-decision verdicts must never be recorded as decisions', () => {
  // Found live: John answered five proposals with "explain what this is" and none of it was a
  // verdict. Recording that as a rejection would teach the learner the IDEA was bad when the
  // PROPOSAL TEXT was bad. `defer` had the same defect — it fell through to `rejected`.
  it('defer leaves the suggestion pending instead of rejecting it', () => {
    const id = uid('defer-1')
    store.save(sugg({ id }))
    // Long enough to clear the substance floor, so this exercises the defer path itself rather
    // than bailing out on a too-short reason.
    recordWeeklyVerdict(store, id, {
      verdict: 'defer',
      code: null,
      text: 'not right now, revisit after the refactor lands',
    })
    expect(store.get(id)?.status).toBe('pending')
  })

  it('defer does not require a reason — a skip is not a decision', () => {
    const id = uid('defer-2')
    store.save(sugg({ id }))
    const r = recordWeeklyVerdict(store, id, { verdict: 'defer', code: null, text: '' })
    expect(r.ok).toBe(true)
    expect(store.get(id)?.status).toBe('pending')
  })

  it('explain leaves the suggestion pending', () => {
    const id = uid('explain-1')
    store.save(sugg({ id }))
    const r = recordWeeklyVerdict(store, id, {
      verdict: 'explain',
      code: null,
      text: 'what is this? copilot already edits files',
    })
    expect(r.ok).toBe(true)
    expect(store.get(id)?.status).toBe('pending')
  })

  it('explain preserves the question as a human reason, tagged as needing explanation', () => {
    const id = uid('explain-2')
    store.save(sugg({ id }))
    recordWeeklyVerdict(store, id, {
      verdict: 'explain',
      code: null,
      text: 'what is this? copilot already edits files',
    })
    const reason = store.get(id)?.reviewReason ?? ''
    expect(reason).toContain('needs-explanation')
    expect(reason).toContain('copilot already edits files')
  })

  it('an explained-but-pending suggestion never reaches the learner as an outcome', () => {
    const id = uid('explain-3')
    store.save(sugg({ id }))
    recordWeeklyVerdict(store, id, { verdict: 'explain', code: null, text: 'what is this thing' })
    expect(explainedTerminalSuggestions(store).map((s) => s.id)).not.toContain(id)
  })

  it('still refuses a reason-free approve or reject', () => {
    const id = uid('strict-1')
    store.save(sugg({ id }))
    expect(recordWeeklyVerdict(store, id, { verdict: 'reject', code: null, text: '' }).ok).toBe(
      false,
    )
    expect(store.get(id)?.status).toBe('pending')
  })
})

describe('a wordless verdict must not reach the learner (65a914f4)', () => {
  // `explainedTerminalSuggestions` feeds `proposal_outcomes` — the learner's corpus.
  // `outcome-writer.ts:239` writes `rationale: suggestion.reviewReason ?? null`, so an approve code
  // with no prose after it would land there as the RAW string `'human:cheap-win:'` attributed to
  // John — and `recordProposalOutcome` is `ON CONFLICT … DO NOTHING`, so that first write would be
  // permanent and the real explanation could never replace it.
  it('excludes a terminal item whose human reason has no words', () => {
    store.save(sugg({ id: uid('e5') }))
    store.updateStatus(uid('e5'), 'rejected', 'human:cheap-win:')
    expect(explainedTerminalSuggestions(store).map((s) => s.id)).not.toContain(uid('e5'))
  })

  it('still includes one he actually explained (NEGATIVE CONTROL)', () => {
    store.save(sugg({ id: uid('e6') }))
    store.updateStatus(uid('e6'), 'rejected', 'human:risky: this touches the allowlist')
    expect(explainedTerminalSuggestions(store).map((s) => s.id)).toContain(uid('e6'))
  })
})

describe('a wordless verdict IS engagement evidence (weekly-session.ts:116)', () => {
  /**
   * RE-GRADE 2026-08-05, finding 3. The mirror image of the block above, and the reason the split
   * is a split rather than a rename: `historyFrom` asks PROVENANCE — did he review this at all —
   * so a verdict code with no prose is still a review that happened. It is in fact the strongest
   * rubber-stamp evidence there is, because `assessEngagement` folds `text` into
   * `meanReasonLength`; dropping it would delete the cheapest reviews from the sample and flatter
   * the guard that exists to catch exactly them.
   *
   * The site was unpinned (a mutant to `hasHumanRationale` was caught by nothing —
   * `Tests 981 passed (981)`) AND the justification committed with it was wrong: it claimed this
   * site "always fails safe toward blocking autonomy". The boundary test below is the
   * counter-example that disproves that claim, kept as a test so the false version cannot come
   * back as a rationale for switching the site.
   */
  const WORDLESS = 'human:cheap-win:'

  function explained(name: string, status: 'approved' | 'rejected', reason: string): void {
    store.save(sugg({ id: uid(name) }))
    store.updateStatus(uid(name), status, reason, undefined, {
      reviewVerdict: status === 'approved' ? 'approve' : 'reject',
    })
  }

  /** Four reviews he actually wrote: one disagreement, so only `n` is ever in question. */
  function seedFourExplained(tag: string): void {
    explained(`${tag}-1`, 'approved', 'human:unblocks: this clears the weekly review loop for me')
    explained(`${tag}-2`, 'approved', 'human:sound-reasoning: the case made here holds up fine')
    explained(`${tag}-3`, 'approved', 'human:known-problem: I have hit this exact thing twice')
    explained(`${tag}-4`, 'rejected', 'human:premature: no propensity model exists yet, too early')
  }

  it('counts a terminal item whose human reason has no words, and lets it drag the mean down', () => {
    seedFourExplained('eng')
    const before = buildWeeklySession({ store, now: new Date('2026-07-27T12:00:00Z') })
    expect(before.engagement.n).toBe(4)

    explained('eng-5', 'approved', WORDLESS)

    const after = buildWeeklySession({ store, now: new Date('2026-07-27T12:00:00Z') })
    // Under the mutant (`isHumanReason` → `hasHumanRationale`) `n` stays 4 and the mean is
    // unchanged — the cheap review vanishes from the very sample built to notice cheap reviews.
    expect(after.engagement.n).toBe(5)
    expect(after.engagement.meanReasonLength).toBeLessThan(before.engagement.meanReasonLength)
  })

  it('CORRECTS THE RECORD: including it can UNBLOCK autonomy at MIN_ASSESSABLE_REVIEWS, not block it', () => {
    seedFourExplained('bnd')

    // n=4. `readyToEscalate` is `sufficientData && !rubberStamping && disagreedRecently`, and
    // `sufficientData` is `n >= MIN_ASSESSABLE_REVIEWS` (5) — so four explained reviews are not
    // yet assessable and permission is withheld.
    const before = buildWeeklySession({ store, now: new Date('2026-07-27T12:00:00Z') })
    expect(before.engagement.n).toBe(4)
    expect(before.engagement.sufficientData).toBe(false)
    expect(before.engagement.readyToEscalate).toBe(false)

    explained('bnd-5', 'approved', WORDLESS)

    // n=5, purely because the wordless verdict was counted — and permission flips ON. This is the
    // counter-example: at this boundary the site fails OPEN, not safe. It is kept on provenance
    // anyway because the effect is two-sided and the balance favours it — past the boundary the
    // same record drags `meanReasonLength` toward `lowEffort`, which is the rubber-stamp evidence.
    const after = buildWeeklySession({ store, now: new Date('2026-07-27T12:00:00Z') })
    expect(after.engagement.n).toBe(5)
    expect(after.engagement.sufficientData).toBe(true)
    expect(after.engagement.readyToEscalate).toBe(true)
  })

  it('NEGATIVE CONTROL: a wordless MACHINE reason is still not engagement', () => {
    seedFourExplained('neg')
    store.save(sugg({ id: uid('neg-5') }))
    store.updateStatus(uid('neg-5'), 'rejected', 'qg-fail:tests-failed', undefined, {
      author: 'machine',
    })

    // Provenance is the test, not terseness. Widening this site to "any reason at all" would let
    // the quality gate's own bookkeeping certify that a human is paying attention.
    const s = buildWeeklySession({ store, now: new Date('2026-07-27T12:00:00Z') })
    expect(s.engagement.n).toBe(4)
    expect(s.engagement.readyToEscalate).toBe(false)
  })
})
