import { describe, it, expect } from 'vitest'
import {
  SEMANTIC_GRADER_SYSTEM_PROMPT,
  buildJudgeUserPrompt,
  parseJudgeResponse,
  NULL_JUDGE,
  isNullJudge,
  NULL_JUDGE_SCORE,
  type JudgeProvider,
} from '../../../src/memory/judge-provider.js'

// MAGMA App C.3 (Semantic Grader — THE metric). Rubric extracted verbatim from
// ~/Downloads/magma.pdf → /tmp/magma_raw.txt:~1528-1562. Blind grade over
// {question, gold, candidate} on a continuous [0.0, 1.0] scale.

describe('SEMANTIC_GRADER_SYSTEM_PROMPT — faithful to App C.3', () => {
  it('states the continuous [0.0, 1.0] scale and the 6 rubric anchors', () => {
    const p = SEMANTIC_GRADER_SYSTEM_PROMPT
    expect(p).toContain('[0.0, 1.0]')
    for (const anchor of ['1.0', '0.8', '0.6', '0.4', '0.2', '0.0']) {
      expect(p).toContain(anchor)
    }
  })

  it('carries the three evaluation constraints incl. adversarial handling', () => {
    const p = SEMANTIC_GRADER_SYSTEM_PROMPT.toLowerCase()
    expect(p).toContain('temporal')
    expect(p).toContain('semantic equivalence')
    expect(p).toContain('adversarial')
    // Adversarial: a hallucinated fact against an "Unanswerable" gold ⇒ 0.0.
    expect(p).toContain('unanswerable')
  })

  it('specifies JSON {score, reasoning} output', () => {
    expect(SEMANTIC_GRADER_SYSTEM_PROMPT.toLowerCase()).toContain('json')
    expect(SEMANTIC_GRADER_SYSTEM_PROMPT).toContain('score')
    expect(SEMANTIC_GRADER_SYSTEM_PROMPT).toContain('reasoning')
  })
})

describe('buildJudgeUserPrompt — BLIND (question|gold|candidate only)', () => {
  const req = {
    question: 'When did Caroline go to the support group?',
    gold: '7 May 2023',
    candidate: 'She went on the 7th of May 2023.',
  }
  it('includes question, gold, and candidate', () => {
    const u = buildJudgeUserPrompt(req)
    expect(u).toContain('Caroline go to the support group')
    expect(u).toContain('7 May 2023')
    expect(u).toContain('7th of May 2023')
  })
  it('does NOT leak retrieved context / conversation (anti-self-grading R2)', () => {
    const u = buildJudgeUserPrompt(req).toLowerCase()
    expect(u).not.toContain('context')
    expect(u).not.toContain('retrieved')
    expect(u).not.toContain('conversation')
  })
})

describe('parseJudgeResponse — defensive, clamped, do-no-harm', () => {
  it('parses a clean JSON object', () => {
    const r = parseJudgeResponse('{"score": 0.8, "reasoning": "main point correct"}')
    expect(r.score).toBeCloseTo(0.8)
    expect(r.reasoning).toContain('main point')
  })
  it('strips markdown code fences', () => {
    const r = parseJudgeResponse('```json\n{"score": 1.0, "reasoning": "exact"}\n```')
    expect(r.score).toBe(1)
  })
  it('extracts a JSON object embedded in prose', () => {
    const r = parseJudgeResponse('Here is my grade: {"score": 0.6, "reasoning": "partial"} done.')
    expect(r.score).toBeCloseTo(0.6)
  })
  it('preserves a genuine 0.0 (contradiction) — NOT conflated with parse failure', () => {
    const r = parseJudgeResponse('{"score": 0.0, "reasoning": "hallucination"}')
    expect(r.score).toBe(0)
  })
  it('coerces a stringified score', () => {
    expect(parseJudgeResponse('{"score": "0.4", "reasoning": "x"}').score).toBeCloseTo(0.4)
  })
  it('clamps out-of-range scores into [0,1]', () => {
    expect(parseJudgeResponse('{"score": 1.7, "reasoning": "x"}').score).toBe(1)
    expect(parseJudgeResponse('{"score": -3, "reasoning": "x"}').score).toBe(0)
  })
  it('returns the NULL sentinel (never throws) on unparseable input', () => {
    for (const bad of ['not json', '', '{"reasoning":"no score"}', '{"score":"abc"}']) {
      const r = parseJudgeResponse(bad)
      expect(r.score).toBe(NULL_JUDGE_SCORE)
    }
  })
})

describe('NULL_JUDGE — default-OFF, inert', () => {
  it('returns the null sentinel score without spawning', async () => {
    const j: JudgeProvider = NULL_JUDGE
    const r = await j.judge({ question: 'q', gold: 'g', candidate: 'c' })
    expect(r.score).toBe(NULL_JUDGE_SCORE)
  })
  it('is detectable via isNullJudge', () => {
    expect(isNullJudge(NULL_JUDGE)).toBe(true)
    expect(isNullJudge(undefined)).toBe(true)
    expect(isNullJudge({ judge: async () => ({ score: 1, reasoning: '' }) })).toBe(false)
  })
})

// ── T011 [US1] (specs/001-learning-memory-loop) — the judge is BLIND to category (oracle leak) ───
describe('T011 — category is NEVER serialized into the judge prompt (oracle-leak lock)', () => {
  it('the prompt with category N is BYTE-IDENTICAL to the prompt without it', () => {
    const base = { question: 'Where did Mel travel?', gold: 'Yosemite', candidate: 'Yosemite' }
    const withCat = buildJudgeUserPrompt({ ...base, category: 5 })
    const withoutCat = buildJudgeUserPrompt(base)
    expect(withCat).toBe(withoutCat)
    expect(withCat).not.toMatch(/category/i)
    expect(withCat).not.toContain('5')
  })

  it('the prompt carries ONLY the three blind fields — question, gold, candidate', () => {
    const p = buildJudgeUserPrompt({
      question: 'THE-QUESTION',
      gold: 'THE-GOLD',
      candidate: 'THE-CANDIDATE',
      category: 2,
    })
    expect(p).toBe('Question: THE-QUESTION\nGold: THE-GOLD\nCandidate: THE-CANDIDATE')
  })
})
