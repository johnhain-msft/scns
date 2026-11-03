import { describe, it, expect } from 'vitest'
import {
  WHY_EVAL_QUESTIONS,
  validateWhyEvalQuestions,
  groupWhyQuestionsBySample,
  type WhyEvalQuestion,
} from '../../../scripts/locomo-why-questions.js'
import { type GazetteerEntry } from '../../../src/memory/entities/gazetteer.js'

// The 4 DEV-slice acting-person anchors (conv-26 Caroline/Melanie + conv-30 Jon/Gina), built exactly like
// the harness's per-conversation ORACLE gazetteer (canonical = speaker token, alias = lowercase form). This
// is the "4-speaker gaz" the durable plan validates the real 20 against.
const GAZ_4: GazetteerEntry[] = [
  { canonical: 'Caroline', kind: 'concept', aliases: ['caroline'] },
  { canonical: 'Melanie', kind: 'concept', aliases: ['melanie'] },
  { canonical: 'Jon', kind: 'concept', aliases: ['jon'] },
  { canonical: 'Gina', kind: 'concept', aliases: ['gina'] },
]

// Pure, spawn-free build-time guards for the WHY-eval question set. Anti-mistesting: a Q that would NOT
// classify WHY or would NOT match its anchor FAILS here BEFORE the harness ever fires a real judge, so the
// causal WHY-route is guaranteed to trigger for every item (M2's WHY0 failure cannot recur silently).

describe('WHY_EVAL_QUESTIONS — the authored set', () => {
  it('has exactly 20 questions, 5 per anchor across the 4 DEV-slice speakers', () => {
    expect(WHY_EVAL_QUESTIONS).toHaveLength(20)
    const perAnchor = new Map<string, number>()
    for (const q of WHY_EVAL_QUESTIONS) perAnchor.set(q.anchor, (perAnchor.get(q.anchor) ?? 0) + 1)
    expect(Object.fromEntries([...perAnchor].sort())).toEqual({ Caroline: 5, Gina: 5, Jon: 5, Melanie: 5 })
  })

  it('maps each anchor to the right sample_id (Caroline/Melanie→conv-26, Jon/Gina→conv-30)', () => {
    const sampleOf: Record<string, string> = { Caroline: 'conv-26', Melanie: 'conv-26', Jon: 'conv-30', Gina: 'conv-30' }
    for (const q of WHY_EVAL_QUESTIONS) expect(q.sampleId).toBe(sampleOf[q.anchor])
  })

  it('every item is category 1 (non-adversarial) with grounded evidence dia_ids', () => {
    for (const q of WHY_EVAL_QUESTIONS) {
      expect(q.category).toBe(1)
      expect(q.evidence.length).toBeGreaterThan(0)
      for (const e of q.evidence) expect(e).toMatch(/^conv-(26|30) · \w+ · D\d+:\d+$/)
    }
  })
})

describe('validateWhyEvalQuestions — PASSES on the real 20', () => {
  it('returns no issues for the authored set under the 4-speaker gazetteer', () => {
    const issues = validateWhyEvalQuestions(WHY_EVAL_QUESTIONS, GAZ_4)
    // Surface any offending stem so a regression is legible, not a bare length mismatch.
    expect(issues).toEqual([])
  })

  it('confirms all 20 stems classify WHY and name their anchor (the fired-route guarantee)', () => {
    // A restatement of the guarantee at the item level (the harness relies on WHY=20 + anchored reads).
    const issues = validateWhyEvalQuestions(WHY_EVAL_QUESTIONS, GAZ_4)
    expect(issues.map((i) => i.index)).toEqual([])
  })
})

describe('validateWhyEvalQuestions — FAILS on malformed fixtures', () => {
  const base: WhyEvalQuestion = WHY_EVAL_QUESTIONS[0]!

  it('flags a non-WHY phrasing (classifies ENTITY, not WHY)', () => {
    // "What led Caroline to …" has NO adjacent WHY marker ("led to" is not "led Caroline to") ⇒ ENTITY.
    const bad: WhyEvalQuestion = { ...base, question: 'What led Caroline to pursue a career in counseling?' }
    const issues = validateWhyEvalQuestions([bad], GAZ_4)
    expect(issues).toHaveLength(1)
    expect(issues[0]!.problems.join(' ')).toMatch(/does not classify as WHY/)
  })

  it('flags a WHY question whose text does not name the declared anchor', () => {
    // Valid WHY phrasing but the anchor person is absent ⇒ matchEntities cannot anchor the causal read.
    const bad: WhyEvalQuestion = { ...base, anchor: 'Caroline', question: 'Why did the support group matter so much to everyone?' }
    const issues = validateWhyEvalQuestions([bad], GAZ_4)
    expect(issues).toHaveLength(1)
    expect(issues[0]!.problems.join(' ')).toMatch(/anchor 'Caroline' not matched/)
  })

  it('flags an empty gold', () => {
    const bad: WhyEvalQuestion = { ...base, gold: '   ' }
    const issues = validateWhyEvalQuestions([bad], GAZ_4)
    expect(issues).toHaveLength(1)
    expect(issues[0]!.problems.join(' ')).toMatch(/empty gold/)
  })

  it('flags an adversarial category-5 item', () => {
    const bad: WhyEvalQuestion = { ...base, category: 5 }
    const issues = validateWhyEvalQuestions([bad], GAZ_4)
    expect(issues).toHaveLength(1)
    expect(issues[0]!.problems.join(' ')).toMatch(/category 5/)
  })

  it('reports multiple problems on one badly-formed item', () => {
    const bad: WhyEvalQuestion = { ...base, question: 'What did the group do?', gold: '', category: 5 }
    const issues = validateWhyEvalQuestions([bad], GAZ_4)
    expect(issues).toHaveLength(1)
    expect(issues[0]!.problems.length).toBeGreaterThanOrEqual(3)
  })

  it('an empty gazetteer strips every anchor (matchEntities can never hit) ⇒ all 20 fail', () => {
    const issues = validateWhyEvalQuestions(WHY_EVAL_QUESTIONS, [])
    expect(issues).toHaveLength(20)
    for (const i of issues) expect(i.problems.join(' ')).toMatch(/not matched/)
  })
})

describe('groupWhyQuestionsBySample — groups by sampleId', () => {
  it('splits the 20 into conv-26 (10) + conv-30 (10), order preserved', () => {
    const grouped = groupWhyQuestionsBySample(WHY_EVAL_QUESTIONS)
    expect([...grouped.keys()].sort()).toEqual(['conv-26', 'conv-30'])
    expect(grouped.get('conv-26')).toHaveLength(10)
    expect(grouped.get('conv-30')).toHaveLength(10)
    // every grouped item actually carries the key it was filed under
    for (const [sampleId, items] of grouped) for (const it of items) expect(it.sampleId).toBe(sampleId)
  })

  it('is order-preserving within a group', () => {
    const grouped = groupWhyQuestionsBySample(WHY_EVAL_QUESTIONS)
    expect(grouped.get('conv-26')!.map((q) => q.anchor)).toEqual([
      'Caroline', 'Caroline', 'Caroline', 'Caroline', 'Caroline',
      'Melanie', 'Melanie', 'Melanie', 'Melanie', 'Melanie',
    ])
  })
})
