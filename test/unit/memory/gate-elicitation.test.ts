import { describe, it, expect } from 'vitest'
import {
  openExperienceStore,
  logRetrievalExperience,
  type ExperienceStore,
} from '../../../src/memory/experience-store.js'
import { findReaskPriorId } from '../../../src/memory/reask-detector.js'
import { settleHumanOutcomeForAttempt } from '../../../src/memory/human-outcome.js'
import {
  computeMaxPriorSimilarity,
  setGateQuestion,
  findDeliverableGateQuestion,
  markGateDelivered,
  findGateAnsweredPriorId,
  settleGateAnswered,
  countSessionGateAsks,
} from '../../../src/memory/gate-elicitation.js'

// ── GATE Part C — the write-back that MANUFACTURES the clean accept/waste label ───────────────────
// GATE's async loop, on SCNS's existing per-attempt settle seam (mirrors the N1 re-ask detector):
//   turn N   : ambiguous prompt → briefing logged (row_N) → a clarifying question is attached (setGateQuestion)
//   turn N+1 : the question is DELIVERED into the briefing (findDeliverable → markGateDelivered)
//   turn N+2 : a substantive follow-up = the human ANSWERED → settle row_N as ACCEPT + write elicited_intent
//   (a verbatim RE-ASK instead → the re-ask detector settles WASTE — the two are mutually exclusive)
// Additive, non-destructive columns; session-scoped; first-signal-wins; fail-safe.

const mk = (
  store: ExperienceStore,
  conversationId: string | undefined,
  queryText: string,
  embedding?: Float32Array,
): number =>
  logRetrievalExperience(store, {
    queryText,
    levers: { traverse: true, synthesize: true },
    retrievedChunkIds: [1, 2],
    ...(conversationId ? { conversationId } : {}),
    ...(embedding ? { queryEmbedding: embedding } : {}),
  })

const outcome = (store: ExperienceStore, id: number): number | null =>
  (store.db.prepare('SELECT human_outcome AS h FROM retrieval_experience WHERE id = ?').get(id) as {
    h: number | null
  }).h

const elicited = (store: ExperienceStore, id: number): string | null =>
  (store.db.prepare('SELECT elicited_intent AS e FROM retrieval_experience WHERE id = ?').get(id) as {
    e: string | null
  }).e

describe('migration — additive GATE columns (non-destructive)', () => {
  it('adds gate_question, gate_delivered, elicited_intent (idempotent open)', () => {
    const store = openExperienceStore(':memory:')
    const cols = new Set(
      (store.db.prepare('PRAGMA table_info(retrieval_experience)').all() as { name: string }[]).map(
        (c) => c.name,
      ),
    )
    expect(cols.has('gate_question')).toBe(true)
    expect(cols.has('gate_delivered')).toBe(true)
    expect(cols.has('elicited_intent')).toBe(true)
    store.close()
  })
})

describe('setGateQuestion — attach the generated question to the exact row', () => {
  it('writes the question; a blank question is a no-op', () => {
    const store = openExperienceStore(':memory:')
    const id = mk(store, 'sess-A', 'fix this')
    expect(setGateQuestion(store, id, 'Which file should I change?')).toBe(true)
    const row = store.db
      .prepare('SELECT gate_question AS q, gate_delivered AS d FROM retrieval_experience WHERE id = ?')
      .get(id) as { q: string | null; d: number }
    expect(row.q).toBe('Which file should I change?')
    expect(row.d).toBe(0)
    expect(setGateQuestion(store, id, '   ')).toBe(false)
    store.close()
  })
})

describe('findDeliverableGateQuestion — the newest undelivered, unsettled gate-pending row in session', () => {
  it('POSITIVE: returns a pending question to inject into the next briefing', () => {
    const store = openExperienceStore(':memory:')
    const id = mk(store, 'sess-A', 'fix this')
    setGateQuestion(store, id, 'Which module?')
    const d = findDeliverableGateQuestion(store, {
      conversationId: 'sess-A',
      deliveryPrompt: 'and what about the retry budget on that path?',
    })
    expect(d).toEqual({ experienceId: id, question: 'Which module?' })
    store.close()
  })

  it('NEGATIVE: nothing to deliver when no question was attached, or across sessions', () => {
    const store = openExperienceStore(':memory:')
    const id = mk(store, 'sess-A', 'fix this')
    setGateQuestion(store, id, 'Which module?')
    expect(
      findDeliverableGateQuestion(store, {
        conversationId: 'sess-B',
        deliveryPrompt: 'and what about the retry budget on that path?',
      }),
    ).toBeNull()
    const plain = mk(store, 'sess-C', 'no question here')
    expect(plain).toBeGreaterThan(0)
    expect(
      findDeliverableGateQuestion(store, {
        conversationId: 'sess-C',
        deliveryPrompt: 'and what about the retry budget on that path?',
      }),
    ).toBeNull()
    store.close()
  })

  it('NEGATIVE: once delivered it is not delivered again (markGateDelivered)', () => {
    const store = openExperienceStore(':memory:')
    const id = mk(store, 'sess-A', 'fix this')
    setGateQuestion(store, id, 'Which module?')
    expect(markGateDelivered(store, id)).toBe(true)
    expect(
      findDeliverableGateQuestion(store, {
        conversationId: 'sess-A',
        deliveryPrompt: 'and what about the retry budget on that path?',
      }),
    ).toBeNull()
    store.close()
  })
})

describe('findGateAnsweredPriorId — a substantive follow-up after delivery = the human answered', () => {
  const setupDelivered = (store: ExperienceStore): number => {
    const id = mk(store, 'sess-A', 'fix this')
    setGateQuestion(store, id, 'Which file should I change?')
    markGateDelivered(store, id)
    return id
  }

  it('POSITIVE: a different, substantive next prompt returns the delivered gate-pending id', () => {
    const store = openExperienceStore(':memory:')
    const id = setupDelivered(store)
    expect(
      findGateAnsweredPriorId(store, {
        conversationId: 'sess-A',
        prompt: 'the beam scorer in adaptive-traversal.ts',
      }),
    ).toBe(id)
    store.close()
  })

  it('NEGATIVE: a verbatim re-ask of the ORIGINAL is NOT an answer (that path is waste)', () => {
    const store = openExperienceStore(':memory:')
    setupDelivered(store)
    expect(findGateAnsweredPriorId(store, { conversationId: 'sess-A', prompt: 'fix this' })).toBeNull()
    store.close()
  })

  it('NEGATIVE: not yet delivered ⇒ no answer can have been given', () => {
    const store = openExperienceStore(':memory:')
    const id = mk(store, 'sess-A', 'fix this')
    setGateQuestion(store, id, 'Which file?')
    expect(
      findGateAnsweredPriorId(store, { conversationId: 'sess-A', prompt: 'the beam scorer' }),
    ).toBeNull()
    store.close()
  })

  it('NEGATIVE: cross-session and greeting/too-short follow-ups never settle', () => {
    const store = openExperienceStore(':memory:')
    setupDelivered(store)
    expect(findGateAnsweredPriorId(store, { conversationId: 'sess-B', prompt: 'the beam scorer' })).toBeNull()
    expect(findGateAnsweredPriorId(store, { conversationId: 'sess-A', prompt: 'ok' })).toBeNull()
    store.close()
  })
})

describe('settleGateAnswered — manufacture the ACCEPT label + write elicited_intent', () => {
  it('sets human_outcome=1.0 (accepted) and records the answer as elicited_intent', () => {
    const store = openExperienceStore(':memory:')
    const id = mk(store, 'sess-A', 'fix this')
    setGateQuestion(store, id, 'Which file?')
    markGateDelivered(store, id)
    expect(settleGateAnswered(store, id, 'the beam scorer in adaptive-traversal.ts')).toBe(true)
    expect(outcome(store, id)).toBe(1.0)
    expect(elicited(store, id)).toBe('the beam scorer in adaptive-traversal.ts')
    store.close()
  })

  it('first-signal-wins: never overwrites an already-settled row', () => {
    const store = openExperienceStore(':memory:')
    const id = mk(store, 'sess-A', 'fix this')
    setGateQuestion(store, id, 'Which file?')
    markGateDelivered(store, id)
    expect(settleHumanOutcomeForAttempt(store, id, 're-asked')).toBe(true) // waste lands first
    expect(settleGateAnswered(store, id, 'the beam scorer')).toBe(false)
    expect(outcome(store, id)).toBe(0.2) // unchanged
    store.close()
  })
})

describe('computeMaxPriorSimilarity — the OOS cosine scan feeding the trigger', () => {
  it('returns the max cosine over prior episode embeddings', () => {
    const store = openExperienceStore(':memory:')
    mk(store, 'sess-A', 'about the ledger', new Float32Array([1, 0, 0]))
    mk(store, 'sess-A', 'about the broker', new Float32Array([0, 1, 0]))
    // a query close to the first prior
    const sim = computeMaxPriorSimilarity(store, new Float32Array([0.9, 0.1, 0]))
    expect(sim).not.toBeNull()
    expect(sim!).toBeGreaterThan(0.9)
    store.close()
  })

  it('returns null when there are no prior embeddings (cold-start ⇒ trigger treats as unknown)', () => {
    const store = openExperienceStore(':memory:')
    mk(store, 'sess-A', 'no embedding row') // logged without an embedding
    expect(computeMaxPriorSimilarity(store, new Float32Array([1, 0, 0]))).toBeNull()
    store.close()
  })

  // The novelty signal answers "have we ever served anything like this to the HUMAN". Measured on the
  // live store 2026-07-24, 58.1% of the corpus is machine-authored (445 `You are ...` agent spawns +
  // 14 completion notices of 752 rows), so an unfiltered scan lets a sub-agent's own prompt make the
  // human's prompt look familiar — suppressing the very question GATE should ask.
  it('EXCLUDES machine-authored prior prompts from the novelty comparison', () => {
    const store = openExperienceStore(':memory:')
    mk(store, 'sess-A', 'You are a strict news-desk fact-checker for a daily digest.', new Float32Array([1, 0, 0]))
    mk(store, 'sess-A', 'Agent "mem-isolation" (explore) has finished processing and is now idle.', new Float32Array([1, 0, 0]))
    mk(store, 'sess-A', 'lets update north star so it isnt stale', new Float32Array([0, 1, 0]))
    // Near-identical to the machine rows, orthogonal to the only human one ⇒ must read as NOVEL.
    const sim = computeMaxPriorSimilarity(store, new Float32Array([1, 0, 0]))
    expect(sim).not.toBeNull()
    expect(sim!).toBeLessThan(0.1)
    store.close()
  })

  it('returns null when every prior embedded row is machine-authored', () => {
    const store = openExperienceStore(':memory:')
    mk(store, 'sess-A', 'You are worker-3 on team __fleet__.', new Float32Array([1, 0, 0]))
    expect(computeMaxPriorSimilarity(store, new Float32Array([1, 0, 0]))).toBeNull()
    store.close()
  })
})

describe('countSessionGateAsks — the anti-nag budget counter', () => {
  it('counts questions attached in the session; 0 for another session or no key', () => {
    const store = openExperienceStore(':memory:')
    const a = mk(store, 'sess-A', 'fix this')
    setGateQuestion(store, a, 'Which file?')
    const b = mk(store, 'sess-A', 'improve this')
    setGateQuestion(store, b, 'Speed or memory?')
    mk(store, 'sess-A', 'no question attached here')
    expect(countSessionGateAsks(store, 'sess-A')).toBe(2)
    expect(countSessionGateAsks(store, 'sess-B')).toBe(0)
    expect(countSessionGateAsks(store, undefined)).toBe(0)
    store.close()
  })
})

describe('END-TO-END — the full GATE async loop across three turns', () => {
  it('ambiguous → ask → deliver → answered=ACCEPT (and a re-ask instead = WASTE)', () => {
    const store = openExperienceStore(':memory:')
    const conv = 'sess-live'
    // turn N: ambiguous briefing logged, a clarifying question attached
    const rowN = mk(store, conv, 'fix this')
    setGateQuestion(store, rowN, 'Which file should I change?')
    // turn N+1: the briefing delivers the pending question
    const deliver = findDeliverableGateQuestion(store, {
      conversationId: conv,
      deliveryPrompt: 'follow-up prompt while question is pending',
    })
    expect(deliver?.experienceId).toBe(rowN)
    markGateDelivered(store, rowN)
    mk(store, conv, 'follow-up prompt while question is pending') // this turn's own row
    // turn N+2: the human answers (substantive follow-up) → settle row_N as ACCEPT
    const answeredId = findGateAnsweredPriorId(store, {
      conversationId: conv,
      prompt: 'change the beam scorer in adaptive-traversal.ts',
    })
    expect(answeredId).toBe(rowN)
    expect(settleGateAnswered(store, answeredId!, 'change the beam scorer in adaptive-traversal.ts')).toBe(
      true,
    )
    expect(outcome(store, rowN)).toBe(1.0)

    // CONTRAST: a fresh gate-pending row that gets a verbatim RE-ASK instead → waste on the right row
    // (prompt ≥ the re-ask detector's 12-char precision floor)
    const rowW = mk(store, conv, 'optimize this whole module')
    setGateQuestion(store, rowW, 'Optimize for speed or memory?')
    markGateDelivered(store, rowW)
    const reaskId = findReaskPriorId(store, { conversationId: conv, prompt: 'optimize this whole module' })
    expect(reaskId).toBe(rowW)
    settleHumanOutcomeForAttempt(store, reaskId!, 're-asked')
    expect(outcome(store, rowW)).toBe(0.2)
    store.close()
  })
})
