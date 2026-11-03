/**
 * T019 [US1] (specs/001-learning-memory-loop) — LongMemEval judge-harness pure core.
 *
 * The LongMemEval harness mirrors the LoCoMo one on the RIGHT axis (blind-judge answer accuracy +
 * o200k tokens; never retrieval recall). This suite drives the pure, importable core: instance
 * parsing (tolerant, drop-counting), deterministic session→doc mapping for isolated-vault ingestion,
 * control construction (reusing the proven judge-lib buildControlPairs), and per-question-type
 * aggregation (reusing aggregateAccuracy). Every check carries a positive AND a negative control.
 */
import { describe, it, expect } from 'vitest'
import {
  LME_QUESTION_TYPES,
  lmeTypeIndex,
  lmeTypeOfIndex,
  parseLmeInstances,
  sessionsToDocs,
  lmeToControlItems,
  aggregateByType,
  type LmeInstance,
} from '../../../scripts/longmemeval-judge-lib.js'
import { buildControlPairs } from '../../../scripts/locomo-judge-lib.js'

const VALID = {
  question_id: 'q-001',
  question_type: 'multi-session',
  question: 'Which city did I fly to after the conference?',
  answer: 'Denver',
  question_date: '2023/05/20 (Sat) 02:21',
  haystack_dates: ['2023/05/01 (Mon) 10:00', '2023/05/02 (Tue) 11:00'],
  haystack_session_ids: ['s1', 's2'],
  haystack_sessions: [
    [
      { role: 'user', content: 'I am flying to Denver after the conference.' },
      { role: 'assistant', content: 'Denver is lovely in May.' },
    ],
    [{ role: 'user', content: 'The conference wrapped up today.' }],
  ],
  answer_session_ids: ['s1'],
}

describe('LME_QUESTION_TYPES + lmeTypeIndex — the six official abilities, stable + strict', () => {
  it('contains exactly the six LongMemEval question types', () => {
    expect([...LME_QUESTION_TYPES].sort()).toEqual(
      [
        'single-session-user',
        'single-session-assistant',
        'single-session-preference',
        'temporal-reasoning',
        'knowledge-update',
        'multi-session',
      ].sort(),
    )
  })

  it('round-trips type ↔ index; an unknown type throws (never a silent bucket)', () => {
    for (const t of LME_QUESTION_TYPES) {
      expect(lmeTypeOfIndex(lmeTypeIndex(t))).toBe(t)
    }
    expect(() => lmeTypeIndex('made-up-type')).toThrow(/question_type/)
  })
})

describe('parseLmeInstances — tolerant parse, honest drop count', () => {
  it('POSITIVE: a valid instance parses with all fields normalized', () => {
    const { instances, dropped } = parseLmeInstances([VALID])
    expect(dropped).toBe(0)
    expect(instances).toHaveLength(1)
    const i = instances[0]!
    expect(i.questionId).toBe('q-001')
    expect(i.questionType).toBe('multi-session')
    expect(i.question).toBe('Which city did I fly to after the conference?')
    expect(i.answer).toBe('Denver')
    expect(i.haystackSessions).toHaveLength(2)
    expect(i.haystackSessions[0]![0]).toEqual({
      role: 'user',
      content: 'I am flying to Denver after the conference.',
    })
    expect(i.haystackDates).toEqual(VALID.haystack_dates)
    expect(i.isAbstention).toBe(false)
  })

  it('an _abs question id is flagged as an abstention instance', () => {
    const { instances } = parseLmeInstances([{ ...VALID, question_id: 'q-002_abs' }])
    expect(instances[0]!.isAbstention).toBe(true)
  })

  it('coerces a numeric answer to string', () => {
    const { instances } = parseLmeInstances([{ ...VALID, answer: 42 }])
    expect(instances[0]!.answer).toBe('42')
  })

  it('NEGATIVE: malformed entries are DROPPED and counted, never silently kept', () => {
    const missingType = { ...VALID, question_type: undefined }
    const unknownType = { ...VALID, question_type: 'bogus-type' }
    const badSessions = { ...VALID, haystack_sessions: 'not-an-array' }
    const missingAnswer = { ...VALID, answer: undefined }
    const { instances, dropped } = parseLmeInstances([
      VALID,
      missingType,
      unknownType,
      badSessions,
      missingAnswer,
    ])
    expect(instances).toHaveLength(1)
    expect(dropped).toBe(4)
  })

  it('a non-array root throws loudly (a corrupt dataset must never grade as empty-but-fine)', () => {
    expect(() => parseLmeInstances({ not: 'an array' })).toThrow(/array/i)
  })
})

describe('sessionsToDocs — deterministic ingestible docs per haystack session', () => {
  it('one doc per session with a stable path, a date header, and role-prefixed turns', () => {
    const { instances } = parseLmeInstances([VALID])
    const docs = sessionsToDocs(instances[0]!)
    expect(docs).toHaveLength(2)
    expect(docs[0]!.path).toBe('q-001/session-000.md')
    expect(docs[1]!.path).toBe('q-001/session-001.md')
    expect(docs[0]!.content).toContain('2023/05/01 (Mon) 10:00')
    expect(docs[0]!.content).toContain('user: I am flying to Denver after the conference.')
    expect(docs[0]!.content).toContain('assistant: Denver is lovely in May.')
    // determinism: same input ⇒ byte-identical docs
    expect(sessionsToDocs(instances[0]!)).toEqual(docs)
  })

  it('NEGATIVE: empty-content turns are skipped, an all-empty session yields no doc', () => {
    const { instances } = parseLmeInstances([
      {
        ...VALID,
        haystack_sessions: [[{ role: 'user', content: '' }], [{ role: 'user', content: 'kept' }]],
      },
    ])
    const docs = sessionsToDocs(instances[0]!)
    expect(docs).toHaveLength(1)
    expect(docs[0]!.content).toContain('kept')
  })
})

describe('lmeToControlItems — plugs into the PROVEN judge-lib control builder', () => {
  it('maps instances to ControlItems keyed by type index; buildControlPairs then yields pos=own-gold / neg=other-gold', () => {
    const { instances } = parseLmeInstances([
      VALID,
      { ...VALID, question_id: 'q-003', question: 'What is my dog called?', answer: 'Biscuit' },
    ])
    const items = lmeToControlItems(instances)
    expect(items).toHaveLength(2)
    expect(items[0]).toEqual({
      question: VALID.question,
      gold: 'Denver',
      category: lmeTypeIndex('multi-session'),
    })
    const { pos, neg } = buildControlPairs(items)
    expect(pos[0]!.candidate).toBe('Denver') // positive control: own gold
    expect(neg[0]!.candidate).toBe('Biscuit') // negative control: a real-but-wrong gold
    expect(neg[0]!.candidate).not.toBe(neg[0]!.gold)
  })
})

describe('aggregateByType — per-question-type + overall {accuracy, tokens, n} (hand-computed)', () => {
  const rows = [
    {
      questionType: 'multi-session',
      score: 1.0,
      contextTokens: 100,
      judgeNull: false,
      genError: false,
    },
    {
      questionType: 'multi-session',
      score: 0.5,
      contextTokens: 300,
      judgeNull: false,
      genError: false,
    },
    {
      questionType: 'knowledge-update',
      score: 0.0,
      contextTokens: 200,
      judgeNull: false,
      genError: false,
    },
    {
      questionType: 'knowledge-update',
      score: -1,
      contextTokens: 400,
      judgeNull: true,
      genError: false,
    }, // dropped
  ]

  it('overall: nScored 3, nDropped 1, accuracy (1+0.5+0)/3 = 0.5, tokens mean over ALL rows = 250', () => {
    const agg = aggregateByType(rows)
    expect(agg.overall.nScored).toBe(3)
    expect(agg.overall.nDropped).toBe(1)
    expect(agg.overall.meanScore).toBeCloseTo(0.5, 10)
    expect(agg.overall.meanContextTokens).toBeCloseTo(250, 10)
  })

  it('per-type rows: multi-session 0.75 (n=2); knowledge-update 0.0 (n=1, the dropped row excluded)', () => {
    const agg = aggregateByType(rows)
    expect(agg.byType['multi-session']).toEqual({ nScored: 2, meanScore: 0.75 })
    expect(agg.byType['knowledge-update']).toEqual({ nScored: 1, meanScore: 0 })
  })

  it('NEGATIVE: an unknown type in a row throws (aggregation never invents a bucket)', () => {
    expect(() =>
      aggregateByType([
        { questionType: 'nope', score: 1, contextTokens: 1, judgeNull: false, genError: false },
      ]),
    ).toThrow(/question_type/)
  })
})

// The LmeInstance type is part of the public core: keep it structurally honest.
const _typecheck: LmeInstance = {
  questionId: 'x',
  questionType: 'multi-session',
  question: 'q',
  answer: 'a',
  questionDate: null,
  haystackDates: [],
  haystackSessionIds: [],
  haystackSessions: [],
  answerSessionIds: [],
  isAbstention: false,
}
void _typecheck

// ── structural locks on the harness CLI (mirrors the LoCoMo T012 locks) ─────────────────────────
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

describe('longmemeval-judge-harness — structural axis + guard locks', () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../../scripts/longmemeval-judge-harness.ts'),
    'utf8',
  )

  it('never imports the wrong-axis recall harnesses', () => {
    expect(src).not.toMatch(/from ['"].*locomo-scoring/)
    expect(src).not.toMatch(/from ['"].*locomo-multihop-harness/)
    expect(src).not.toMatch(/recall@|recallAtK|allHopsRecall/i)
  })

  it('runs the REAL seams: evaluateItem + retrieveContext + hybrid base + blind ACP judge/generator', () => {
    for (const marker of [
      'evaluateItem',
      'retrieveContext',
      'makeHybridBaseSearch',
      'createAcpJudge',
      'createAcpQaGenerator',
    ]) {
      expect(src, `harness must wire ${marker}`).toContain(marker)
    }
  })

  it('guards: refuses the live vault, isolates every vault under mkdtemp, spawns only behind the env flags', () => {
    expect(src).toContain('refuseIfLive')
    expect(src).toContain('mkdtempSync')
    expect(src).toContain('isJudgeEnabled')
    expect(src).toContain('isQaGeneratorEnabled')
  })

  it('dispatches smoke|controls|judge and emits RESULTS_JSON with σ context', () => {
    for (const mode of ["'smoke'", "'controls'", "'judge'"]) {
      expect(src).toContain(`MODE === ${mode}`)
    }
    expect((src.match(/RESULTS_JSON/g) ?? []).length).toBeGreaterThanOrEqual(3)
    expect(src).toContain('SCNS_JUDGE_SIGMA')
  })

  it('holds the injection budget IDENTICAL to the LoCoMo ruler (fixed generator + budget across arms)', () => {
    expect(src).toContain('RETRIEVAL_TOPK = 5')
    expect(src).toContain('RETRIEVAL_MAX_CHARS = 4000')
  })
})
