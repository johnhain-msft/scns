import { describe, it, expect } from 'vitest'
import { openExperienceStore, logRetrievalExperience } from '../../../src/memory/experience-store.js'
import { settleHumanOutcomeForAttempt } from '../../../src/memory/human-outcome.js'
import { normalizePrompt, findReaskPriorId } from '../../../src/memory/reask-detector.js'

// ── N1 — capture the FIRST real human accept/waste bound to the EXACT experienceId ────────────────
// The live magma briefing logs one retrieval_experience row per prompt and mints an experienceId. When
// the SAME human re-asks the SAME question in the SAME session, that prior briefing FAILED to serve —
// a real implicit `re-asked` cue (→ 0.2 waste). This detector finds the exact prior attempt id to settle.
// Conservative by design (same-session + verbatim-normalized + unsettled + min length) so a real signal
// lands with zero false positives — no §7 intent/semantic classification (that is post-N1).

describe('normalizePrompt — trim, lowercase, collapse whitespace (verbatim re-ask key)', () => {
  it('is case-insensitive and whitespace-insensitive', () => {
    expect(normalizePrompt('  How  do I\tfix\nthe   broker? ')).toBe('how do i fix the broker?')
    expect(normalizePrompt('Restart The Broker')).toBe('restart the broker')
  })
  it('is stable under re-normalization (idempotent)', () => {
    const once = normalizePrompt('  A   B   c ')
    expect(normalizePrompt(once)).toBe(once)
  })
})

describe('findReaskPriorId — same-session verbatim re-ask → the exact prior unsettled id', () => {
  const mk = (
    store: ReturnType<typeof openExperienceStore>,
    conversationId: string | undefined,
    queryText: string,
  ): number =>
    logRetrievalExperience(store, {
      queryText,
      levers: { traverse: true, synthesize: true },
      retrievedChunkIds: [1, 2],
      ...(conversationId ? { conversationId } : {}),
    })

  it('POSITIVE: a verbatim re-ask in the same session returns the prior attempt id', () => {
    const store = openExperienceStore(':memory:')
    const prior = mk(store, 'sess-A', 'How do I restart the SCNS broker safely?')
    // detection runs BEFORE the new row is logged, so a match is necessarily an earlier turn
    expect(findReaskPriorId(store, { conversationId: 'sess-A', prompt: 'How do I restart the SCNS broker safely?' })).toBe(prior)
    store.close()
  })

  it('POSITIVE: normalization matches across case + whitespace differences', () => {
    const store = openExperienceStore(':memory:')
    const prior = mk(store, 'sess-A', 'How do I restart the SCNS broker safely?')
    expect(
      findReaskPriorId(store, { conversationId: 'sess-A', prompt: '  how do i   restart the scns broker safely? ' }),
    ).toBe(prior)
    store.close()
  })

  it('POSITIVE: returns the NEWEST matching prior attempt when the question was asked before', () => {
    const store = openExperienceStore(':memory:')
    const first = mk(store, 'sess-A', 'What is the broker default port configuration?')
    const second = mk(store, 'sess-A', 'What is the broker default port configuration?')
    expect(second).toBeGreaterThan(first)
    expect(findReaskPriorId(store, { conversationId: 'sess-A', prompt: 'What is the broker default port configuration?' })).toBe(second)
    store.close()
  })

  it('NEGATIVE: a different session never matches (session-scoped credit assignment)', () => {
    const store = openExperienceStore(':memory:')
    mk(store, 'sess-A', 'How do I restart the SCNS broker safely?')
    expect(findReaskPriorId(store, { conversationId: 'sess-B', prompt: 'How do I restart the SCNS broker safely?' })).toBeNull()
    store.close()
  })

  it('NEGATIVE: a missing/empty conversationId never fires (live rows without a session key are safe)', () => {
    const store = openExperienceStore(':memory:')
    mk(store, undefined, 'How do I restart the SCNS broker safely?')
    expect(findReaskPriorId(store, { conversationId: undefined, prompt: 'How do I restart the SCNS broker safely?' })).toBeNull()
    expect(findReaskPriorId(store, { conversationId: '   ', prompt: 'How do I restart the SCNS broker safely?' })).toBeNull()
    store.close()
  })

  it('NEGATIVE: generic short prompts below minChars never fire (precision guard vs "plan"/"analyze")', () => {
    const store = openExperienceStore(':memory:')
    mk(store, 'sess-A', 'plan')
    expect(findReaskPriorId(store, { conversationId: 'sess-A', prompt: 'plan' })).toBeNull()
    mk(store, 'sess-A', 'analyze')
    expect(findReaskPriorId(store, { conversationId: 'sess-A', prompt: 'analyze' })).toBeNull()
    store.close()
  })

  it('NEGATIVE: an ALREADY-SETTLED prior row is not matched again (first-signal-wins upstream)', () => {
    const store = openExperienceStore(':memory:')
    const prior = mk(store, 'sess-A', 'How do I restart the SCNS broker safely?')
    // settle it once (e.g. a prior re-ask already landed)
    expect(settleHumanOutcomeForAttempt(store, prior, 're-asked')).toBe(true)
    expect(findReaskPriorId(store, { conversationId: 'sess-A', prompt: 'How do I restart the SCNS broker safely?' })).toBeNull()
    store.close()
  })

  it('NEGATIVE: a non-matching prompt in the same session returns null', () => {
    const store = openExperienceStore(':memory:')
    mk(store, 'sess-A', 'How do I restart the SCNS broker safely?')
    expect(findReaskPriorId(store, { conversationId: 'sess-A', prompt: 'What edges does the semantic tier build?' })).toBeNull()
    store.close()
  })

  it('END-TO-END seam order: detect prior → settle 0.2 → log new row; only the prior is settled', () => {
    const store = openExperienceStore(':memory:')
    const conversationId = 'sess-live'
    const prompt = 'How do I restart the SCNS broker without disturbing team mode?'
    // turn 1: log the briefing attempt
    const prior = mk(store, conversationId, prompt)
    // turn 2 (the re-ask): the seam FIRST detects, then settles, then logs the new row
    const priorId = findReaskPriorId(store, { conversationId, prompt })
    expect(priorId).toBe(prior)
    expect(settleHumanOutcomeForAttempt(store, priorId!, 're-asked')).toBe(true)
    const next = mk(store, conversationId, prompt)
    const outcome = (id: number): number | null =>
      (store.db.prepare('SELECT human_outcome AS h FROM retrieval_experience WHERE id = ?').get(id) as { h: number | null }).h
    expect(outcome(prior)).toBe(0.2) // the failed briefing, bound to its EXACT id
    expect(outcome(next)).toBeNull() // the fresh attempt stays open
    store.close()
  })

  it('FAIL-SAFE: a detector error never throws (returns null)', () => {
    const store = openExperienceStore(':memory:')
    store.close() // force the underlying query to fail
    expect(findReaskPriorId(store, { conversationId: 'sess-A', prompt: 'How do I restart the SCNS broker safely?' })).toBeNull()
  })
})

// ── Authorship guard (2026-07-30) ────────────────────────────────────────────────────────────────
// The GATE *accept* path was hardened with the transcript oracle on 2026-07-25, but the *waste* path
// never got the same treatment: `findReaskPriorId` matched on normalized text alone. Because agent
// completion notices are VERBATIM-IDENTICAL strings that recur constantly, a repeated system
// notification looked exactly like a frustrated human re-asking the same question.
//
// Live damage, measured read-only over the PRE-CLEANUP snapshot `~/.scns/memory/experience.db.bak.
// 1785453679`: rows 907, 1685 and 1687 were settled `human_outcome=0.2` (waste) against
// `retriever=magma` from prompts of the form `Agent "<name>" (<type>) has finished processing and is
// now idle.` (907 = `abstention-grader`/`general-purpose`; 1685 and 1687 = `indep-review`/
// `code-review`) — 3 of the 8 waste rows in that snapshot. Those rows were reverted to unsettled with
// the operator's approval, so a query against the LIVE store today shows them NULL; the backup is the
// evidence. `prompt-authorship.ts` already carries the exact rule that catches these
// (`agent-completion-notice`); it simply was never applied here.
describe('findReaskPriorId — machine-authored prompts can never settle a HUMAN outcome', () => {
  const mk = (store: ReturnType<typeof openExperienceStore>, conversationId: string, queryText: string): number =>
    logRetrievalExperience(store, {
      queryText,
      levers: { traverse: true, synthesize: true },
      retrievedChunkIds: [1, 2],
      conversationId,
    })

  it('does not match when the incoming prompt is an agent-completion notice (live rows 1685/1687)', () => {
    const store = openExperienceStore(':memory:')
    const notice = 'Agent "indep-review" (code-review) has finished processing and is now idle.'
    const prior = mk(store, 'conv-1', notice)
    expect(prior).toBeGreaterThan(0)
    expect(findReaskPriorId(store, { conversationId: 'conv-1', prompt: notice })).toBeNull()
    store.close()
  })

  it('does not match an agent role-preamble spawn prompt', () => {
    const store = openExperienceStore(':memory:')
    const brief = 'You are a strict news-desk fact-checker. Verify every claim in the draft below.'
    mk(store, 'conv-2', brief)
    expect(findReaskPriorId(store, { conversationId: 'conv-2', prompt: brief })).toBeNull()
    store.close()
  })

  it('POSITIVE CONTROL: a genuine human re-ask still settles (the mechanism is not disabled)', () => {
    const store = openExperienceStore(':memory:')
    const q = 'confirm that those tasks never actually run -- pretty sure they do'
    const prior = mk(store, 'conv-3', q)
    expect(findReaskPriorId(store, { conversationId: 'conv-3', prompt: q })).toBe(prior)
    store.close()
  })
})
