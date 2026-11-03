import { describe, it, expect } from 'vitest'
import {
  goldFor,
  LOCOMO_UNANSWERABLE,
  countTokens,
  stddev,
  nToResolveDelta,
  aggregateAccuracy,
  pairedDeltas,
  pairedFrontier,
  pairedTokenFrontier,
  evaluateItem,
  pickPerCategory,
  meanCI,
  pooledStddev,
  buildControlPairs,
  controlsVerdict,
  buildHumanSlice,
  frontierValue,
  pairedValueDelta,
  normInv,
  tCritOneSided,
  hcopeLowerBound,
  gateVerdict,
  whichArmWon,
  LAMBDA_TOKEN_UNIT,
  LOCOMO_CAT,
  POS_CONTROL_CATS,
  NEG_CONTROL_CATS,
  NEUTRAL_CATS,
  controlClassOf,
  type JudgeEvalDeps,
} from '../../../scripts/locomo-judge-lib.js'
import { NULL_JUDGE_SCORE } from '../../../src/memory/judge-provider.js'
import { QA_NOT_FOUND } from '../../../src/memory/qa-generator.js'

// Pure, dependency-injected helpers for the App C.2→C.3 LLM-Judge ruler. No spawns: evaluateItem takes
// injected retrieve/generator/judge fakes so the retrieve→generate→judge wiring is unit-tested here and
// the real harness only supplies real providers. Anti-mistesting: the ruler's own logic is checked with
// hand-computed fixtures BEFORE any real number is trusted (mirrors locomo-scoring.test.ts).

describe('goldFor — gold selection per LoCoMo category', () => {
  it('uses `answer` for factual categories 1–4', () => {
    expect(goldFor({ question: 'q', category: 1, answer: 'Adoption agencies' })).toBe(
      'Adoption agencies',
    )
    expect(goldFor({ question: 'q', category: 2, answer: '7 May 2023' })).toBe('7 May 2023')
    expect(goldFor({ question: 'q', category: 4, answer: 42 })).toBe('42') // numeric answers coerced
  })
  it('uses the MAGMA "Unanswerable" abstain convention for adversarial category 5', () => {
    // App C.3 adversarial handling + OSS cat-5 "Information not found" — the correct behavior is to abstain.
    expect(
      goldFor({ question: 'q', category: 5, adversarial_answer: 'self-care is important' }),
    ).toBe(LOCOMO_UNANSWERABLE)
  })
})

describe('countTokens — REAL o200k_base tokenizer (input-context efficiency axis, deterministic)', () => {
  it('is 0 for empty, exact for known strings, and deterministic', () => {
    // Exact o200k_base BPE counts (pinned — gpt-tokenizer 3.4.0, offline). Replaces the old chars/4
    // proxy: Table-3 is an INPUT-context token claim, so the frontier must count REAL tokens.
    expect(countTokens('')).toBe(0)
    expect(countTokens('a')).toBe(1)
    expect(countTokens('hello world')).toBe(2)
    expect(countTokens('The quick brown fox jumps over the lazy dog.')).toBe(10)
    // Determinism (no sampling): same input → identical count.
    expect(countTokens('hello world')).toBe(countTokens('hello world'))
  })
  it('is monotonic in content and counts Eq-7 provenance scaffold as REAL tokens (NOT chars/4)', () => {
    expect(countTokens('a'.repeat(40))).toBeGreaterThan(countTokens('a'.repeat(8)))
    // The Eq-7 scaffold `<ref:id>` is punctuation-dense: real BPE splits it into MORE tokens than
    // chars/4 would estimate — so chars/4 UNDER-counts S4-ON scaffold cost. `<ref:1>` = 5 tokens, but
    // ceil(7/4) = 2. This is exactly why the frontier needs a real tokenizer to be honest.
    expect(countTokens('<ref:1>')).toBe(5)
    expect(countTokens('<ref:1>')).toBeGreaterThan(Math.ceil('<ref:1>'.length / 4))
  })
})

describe('stddev — sample standard deviation', () => {
  it('is 0 for identical values', () => {
    expect(stddev([0.7, 0.7, 0.7])).toBe(0)
  })
  it('matches a hand-computed value', () => {
    // values 0.6,0.8 → mean 0.7, sample variance = ((0.1)^2+(0.1)^2)/(2-1)=0.02 → sd=√0.02≈0.1414
    expect(stddev([0.6, 0.8])).toBeCloseTo(0.14142, 4)
  })
  it('returns 0 for <2 samples (undefined variance floor)', () => {
    expect(stddev([0.5])).toBe(0)
    expect(stddev([])).toBe(0)
  })
})

describe('nToResolveDelta — samples/arm to resolve a mean delta at a given sigma', () => {
  it('applies N = 2 (z·σ/δ)² and rounds up', () => {
    // z=1.96, σ=0.1, δ=0.04 → 2*(1.96*0.1/0.04)^2 = 2*(4.9)^2 = 48.02 → 49
    expect(nToResolveDelta(0.04, 0.1, 1.96)).toBe(49)
  })
  it('is Infinity when sigma>0 but delta is 0 (unresolvable)', () => {
    expect(nToResolveDelta(0, 0.1, 1.96)).toBe(Infinity)
  })
  it('is 0 when sigma is 0 (a deterministic judge resolves any delta with N=1-ish → 0 needed)', () => {
    expect(nToResolveDelta(0.04, 0, 1.96)).toBe(0)
  })
})

describe('aggregateAccuracy — drops sentinels, reports per-category', () => {
  it('means only real [0,1] scores and drops NULL/error rows', () => {
    const rows = [
      {
        question: 'a',
        category: 1,
        score: 1.0,
        contextTokens: 100,
        judgeNull: false,
        genError: false,
      },
      {
        question: 'b',
        category: 1,
        score: 0.0,
        contextTokens: 120,
        judgeNull: false,
        genError: false,
      },
      {
        question: 'c',
        category: 2,
        score: 0.8,
        contextTokens: 80,
        judgeNull: false,
        genError: false,
      },
      {
        question: 'd',
        category: 2,
        score: NULL_JUDGE_SCORE,
        contextTokens: 90,
        judgeNull: true,
        genError: false,
      },
      {
        question: 'e',
        category: 5,
        score: NULL_JUDGE_SCORE,
        contextTokens: 70,
        judgeNull: false,
        genError: true,
      },
    ]
    const agg = aggregateAccuracy(rows)
    expect(agg.nScored).toBe(3) // a,b,c
    expect(agg.nDropped).toBe(2) // d (judgeNull), e (genError)
    expect(agg.meanScore).toBeCloseTo((1.0 + 0.0 + 0.8) / 3)
    expect(agg.meanContextTokens).toBeCloseTo((100 + 120 + 80 + 90 + 70) / 5) // tokens counted for ALL retrieved
    expect(agg.byCategory[1]!.meanScore).toBeCloseTo(0.5)
    expect(agg.byCategory[2]!.nScored).toBe(1)
  })
})

describe('evaluateItem — retrieve → generate → judge wiring (injected fakes, no spawn)', () => {
  const baseDeps = (over: Partial<JudgeEvalDeps> = {}): JudgeEvalDeps => ({
    retrieve: async () => ({
      text: 'Relevant SCNS memories:\nCaroline researched adoption.',
      chunkIds: [1, 2],
    }),
    intentOf: () => 'ENTITY',
    generator: { generate: async () => ({ answer: 'Adoption agencies', notFound: false }) },
    judge: { judge: async () => ({ score: 0.8, reasoning: 'ok' }) },
    ...over,
  })

  it('produces a scored row with context tokens counted', async () => {
    const row = await evaluateItem(
      { question: 'What did Caroline research?', gold: 'Adoption agencies', category: 1 },
      baseDeps(),
    )
    expect(row.score).toBeCloseTo(0.8)
    expect(row.answer).toBe('Adoption agencies')
    expect(row.genError).toBe(false)
    expect(row.judgeNull).toBe(false)
    expect(row.contextTokens).toBeGreaterThan(0)
  })

  it('JUDGES a genuine abstain (does NOT drop it) — passes "Information not found" as the candidate', async () => {
    let sawCandidate = ''
    const row = await evaluateItem(
      { question: 'q', gold: LOCOMO_UNANSWERABLE, category: 5 },
      baseDeps({
        generator: { generate: async () => ({ answer: '', notFound: true }) },
        judge: {
          judge: async (req) => {
            sawCandidate = req.candidate
            return { score: 1.0, reasoning: 'correct abstain' }
          },
        },
      }),
    )
    expect(sawCandidate.toLowerCase()).toContain('information not found')
    expect(row.judgeNull).toBe(false)
    expect(row.score).toBe(1.0)
  })

  it('DROPS a generator spawn failure (error) — never calls the judge, marks genError', async () => {
    let judgeCalled = false
    const row = await evaluateItem(
      { question: 'q', gold: 'g', category: 1 },
      baseDeps({
        generator: { generate: async () => ({ answer: '', notFound: true, error: true }) },
        judge: {
          judge: async () => {
            judgeCalled = true
            return { score: 1, reasoning: '' }
          },
        },
      }),
    )
    expect(judgeCalled).toBe(false)
    expect(row.genError).toBe(true)
    expect(row.score).toBe(NULL_JUDGE_SCORE)
  })

  it('does NOT leak retrieved context to the judge (blind — R2)', async () => {
    let judgeReq: { question: string; gold: string; candidate: string } | undefined
    await evaluateItem(
      { question: 'q', gold: 'g', category: 1 },
      baseDeps({
        judge: {
          judge: async (req) => {
            judgeReq = req
            return { score: 0.5, reasoning: '' }
          },
        },
      }),
    )
    expect(JSON.stringify(judgeReq)).not.toContain('Relevant SCNS memories')
  })
})

// ── new pure orchestrator logic (R2 controls / R3 variance / R1 deterministic sampling / human slice) ──

describe('pickPerCategory — deterministic per-category sampling (R1 dev slice)', () => {
  const items = [
    { question: 'q-b', category: 1, dia: 'D1:9' },
    { question: 'q-a', category: 1, dia: 'D1:2' },
    { question: 'q-c', category: 1, dia: 'D1:5' },
    { question: 'q-x', category: 2, dia: 'D2:1' },
    { question: 'q-y', category: 2, dia: 'D2:3' },
  ]
  it('takes the first N per category by a STABLE ascending key (reproducible across runs)', () => {
    const picked = pickPerCategory(
      items,
      2,
      (it) => it.category,
      (it) => it.dia,
    )
    // cat 1 sorted by dia: D1:2(q-a), D1:5(q-c), D1:9(q-b) → first 2 = q-a,q-c ; cat 2 → q-x,q-y
    expect(picked.map((p) => p.question)).toEqual(['q-a', 'q-c', 'q-x', 'q-y'])
  })
  it('returns all of a category when it has fewer than N', () => {
    const picked = pickPerCategory(
      items,
      5,
      (it) => it.category,
      (it) => it.dia,
    )
    expect(picked.filter((p) => p.category === 2).length).toBe(2)
  })
  it('is a pure re-order/slice — same input ⇒ identical output', () => {
    const a = pickPerCategory(
      items,
      2,
      (it) => it.category,
      (it) => it.dia,
    )
    const b = pickPerCategory(
      items,
      2,
      (it) => it.category,
      (it) => it.dia,
    )
    expect(a).toEqual(b)
  })
  it('accepts a per-category cap FUNCTION (M2 oversamples WHY-relevant categories)', () => {
    // cat 1 → cap 1, cat 2 → cap 5. cat1 sorted by dia: D1:2(q-a) first ⇒ [q-a]; cat2 → all [q-x,q-y].
    const picked = pickPerCategory(
      items,
      (c) => (c === 1 ? 1 : 5),
      (it) => it.category,
      (it) => it.dia,
    )
    expect(picked.map((p) => p.question)).toEqual(['q-a', 'q-x', 'q-y'])
  })
})

describe('pairedDeltas — matched-pair Arm-B − Arm-A delta (M2, cancels item difficulty)', () => {
  // Index-aligned rows (same items, two arms). idx3 is DROPPED in Arm A (null) ⇒ not a matched pair.
  const rowsA = [
    { category: 1, score: 0.2 },
    { category: 1, score: 0.8 },
    { category: 2, score: 0.4 },
    { category: 2, score: NULL_JUDGE_SCORE },
  ]
  const rowsB = [
    { category: 1, score: 0.6 },
    { category: 1, score: 0.8 },
    { category: 2, score: 0.9 },
    { category: 2, score: 0.7 },
  ]
  it('averages the per-item delta over pairs graded by BOTH arms', () => {
    const p = pairedDeltas(rowsA, rowsB)
    expect(p.n).toBe(3) // idx3 dropped (Arm A null)
    expect(p.meanA).toBeCloseTo((0.2 + 0.8 + 0.4) / 3, 6)
    expect(p.meanB).toBeCloseTo((0.6 + 0.8 + 0.9) / 3, 6)
    expect(p.meanDelta).toBeCloseTo((0.4 + 0.0 + 0.5) / 3, 6) // 0.3
  })
  it('splits the delta by category', () => {
    const p = pairedDeltas(rowsA, rowsB)
    expect(p.byCategory[1]!.n).toBe(2)
    expect(p.byCategory[1]!.meanA).toBeCloseTo(0.5, 6)
    expect(p.byCategory[1]!.meanB).toBeCloseTo(0.7, 6)
    expect(p.byCategory[1]!.meanDelta).toBeCloseTo(0.2, 6) // (0.4 + 0.0)/2
    expect(p.byCategory[2]!.n).toBe(1) // idx2 only (idx3 dropped)
    expect(p.byCategory[2]!.meanDelta).toBeCloseTo(0.5, 6)
  })
  it('throws on misaligned length or category mismatch (a harness programming error)', () => {
    expect(() => pairedDeltas(rowsA, rowsB.slice(0, 3))).toThrow(/align/)
    expect(() =>
      pairedDeltas([{ category: 1, score: 0.5 }], [{ category: 2, score: 0.5 }]),
    ).toThrow(/category mismatch/)
  })
})

describe('pairedFrontier — Stage-4 OFF (Arm P, plain join) vs ON (Arm S, Eq-7) paired Δacc + Δtok', () => {
  // The gate-token-accounting instrument. MAGMA §3.4 / Eq. 7 (Narrative Synthesis via Graph
  // Linearization) is the paper's context-management + token-efficiency mechanism; Table 3 reports its
  // headline (~3.37k tok/query vs 100k+ un-managed). Because retrieval is deterministic, Arm P
  // (synthesize:false) and Arm S (synthesize:true) score the IDENTICAL retrieved SET — so the paired Δ
  // ISOLATES Stage-4 formatting. This unit checks the aggregation math with hand-computed fixtures BEFORE
  // the ~1h real run consumes it (anti-mistesting). Tokens here are REAL o200k_base counts (countTokens);
  // these synthetic fixtures exercise the aggregation math (both a token SAVING and a token COST) — the
  // win is Δacc≥−σ AT Δtok<0.

  it('accuracy axis: paired Δ(S−P) over pairs graded by BOTH arms, dropping null pairs', () => {
    const rowsP = [
      { category: 1, score: 0.8, contextTokens: 1000 },
      { category: 1, score: NULL_JUDGE_SCORE, contextTokens: 1200 }, // dropped (Arm P null)
      { category: 2, score: 0.4, contextTokens: 800 },
    ]
    const rowsS = [
      { category: 1, score: 0.9, contextTokens: 400 },
      { category: 1, score: 0.7, contextTokens: 500 },
      { category: 2, score: 0.4, contextTokens: 300 },
    ]
    const f = pairedFrontier(rowsP, rowsS)
    expect(f.nAcc).toBe(2) // idx1 dropped (Arm P null) — never counted as a 0.0
    expect(f.meanScoreP).toBeCloseTo((0.8 + 0.4) / 2, 6)
    expect(f.meanScoreS).toBeCloseTo((0.9 + 0.4) / 2, 6)
    expect(f.meanDeltaScore).toBeCloseTo((0.1 + 0.0) / 2, 6) // 0.05
  })

  it('token axis counts ALL index-aligned items (tokens exist regardless of the downstream grade)', () => {
    // SAME fixture as above: idx1 is accuracy-DROPPED but its retrieved tokens STILL count on the
    // efficiency axis (what retrieval fed the generator, per aggregateAccuracy's token semantics).
    const rowsP = [
      { category: 1, score: 0.8, contextTokens: 1000 },
      { category: 1, score: NULL_JUDGE_SCORE, contextTokens: 1200 },
      { category: 2, score: 0.4, contextTokens: 800 },
    ]
    const rowsS = [
      { category: 1, score: 0.9, contextTokens: 400 },
      { category: 1, score: 0.7, contextTokens: 500 },
      { category: 2, score: 0.4, contextTokens: 300 },
    ]
    const f = pairedFrontier(rowsP, rowsS)
    expect(f.nTok).toBe(3) // ALL items, incl. the accuracy-dropped one
    expect(f.meanTokP).toBeCloseTo((1000 + 1200 + 800) / 3, 6) // 1000 = the S4-OFF full-context reference
    expect(f.meanTokS).toBeCloseTo((400 + 500 + 300) / 3, 6) // 400
    expect(f.meanDeltaTok).toBeCloseTo(400 - 1000, 6) // −600 ⇒ Stage-4 SAVED tokens (the win direction)
  })

  it('POSITIVE control — equal accuracy at FEWER tokens is the MAGMA "earns its keep" shape', () => {
    const P = [
      { category: 1, score: 0.8, contextTokens: 1000 },
      { category: 1, score: 0.6, contextTokens: 1200 },
      { category: 2, score: 1.0, contextTokens: 800 },
    ]
    const S = [
      { category: 1, score: 0.8, contextTokens: 400 },
      { category: 1, score: 0.6, contextTokens: 500 },
      { category: 2, score: 1.0, contextTokens: 300 },
    ]
    const f = pairedFrontier(P, S)
    expect(f.meanDeltaScore).toBeCloseTo(0, 6) // accuracy unchanged
    expect(f.meanDeltaTok).toBeLessThan(0) // fewer tokens ⇒ a win
    expect(f.meanDeltaTok).toBeCloseTo(400 - 1000, 6) // −600
    expect(f.meanTokP).toBeCloseTo(1000, 6) // fullContextReferenceTokensO200k the harness reports
    expect(f.nItemsTokenReduced).toBe(3) // every item compressed
    expect(f.nItemsTokenIncreased).toBe(0)
    expect(f.nItemsTokenEqual).toBe(0)
  })

  it('NEGATIVE control — when Eq-7 scaffold overhead EXCEEDS compression, Δtok is POSITIVE (not a win)', () => {
    // Guards against a rigged instrument: provenance `[<t:τ> content <ref:id>]` scaffolding CAN add chars.
    // The instrument must report that honestly as a token COST, never silently as a saving.
    const P = [
      { category: 1, score: 0.5, contextTokens: 100 },
      { category: 2, score: 0.5, contextTokens: 120 },
    ]
    const S = [
      { category: 1, score: 0.5, contextTokens: 160 },
      { category: 2, score: 0.5, contextTokens: 180 },
    ]
    const f = pairedFrontier(P, S)
    expect(f.meanDeltaTok).toBeGreaterThan(0) // +60 ⇒ Stage-4 COST tokens
    expect(f.meanDeltaTok).toBeCloseTo(170 - 110, 6)
    expect(f.nItemsTokenIncreased).toBe(2) // both items grew (pure scaffold overhead, no compression)
    expect(f.nItemsTokenReduced).toBe(0)
  })

  it('per-item token-direction counts partition ALL items (reduced + increased + equal = nTok)', () => {
    // The self-attribution axis: a net Δtok≥0 with nItemsTokenReduced>0 ("some compressed") is a DIFFERENT
    // story from nItemsTokenReduced=0 ("nothing ever overflowed the budget → pure scaffold overhead").
    const P = [
      { category: 1, score: 0.5, contextTokens: 100 }, // S 60  → reduced
      { category: 1, score: 0.5, contextTokens: 100 }, // S 140 → increased
      { category: 2, score: 0.5, contextTokens: 100 }, // S 100 → equal
    ]
    const S = [
      { category: 1, score: 0.5, contextTokens: 60 },
      { category: 1, score: 0.5, contextTokens: 140 },
      { category: 2, score: 0.5, contextTokens: 100 },
    ]
    const f = pairedFrontier(P, S)
    expect(f.nItemsTokenReduced).toBe(1)
    expect(f.nItemsTokenIncreased).toBe(1)
    expect(f.nItemsTokenEqual).toBe(1)
    expect(f.nItemsTokenReduced + f.nItemsTokenIncreased + f.nItemsTokenEqual).toBe(f.nTok)
    expect(f.meanDeltaTok).toBeCloseTo((-40 + 40 + 0) / 3, 6) // 0 net — masks the split the counts expose
  })

  it('is consistent: meanDeltaTok === meanTokS − meanTokP (paired == difference-of-means, tokens undropped)', () => {
    const P = [
      { category: 1, score: 0.2, contextTokens: 900 },
      { category: 2, score: NULL_JUDGE_SCORE, contextTokens: 1100 },
    ]
    const S = [
      { category: 1, score: 0.9, contextTokens: 350 },
      { category: 2, score: 0.9, contextTokens: 450 },
    ]
    const f = pairedFrontier(P, S)
    expect(f.meanDeltaTok).toBeCloseTo(f.meanTokS - f.meanTokP, 9)
  })

  it('throws on misaligned length or category mismatch (inherits pairedDeltas validation)', () => {
    const P = [{ category: 1, score: 0.5, contextTokens: 10 }]
    expect(() => pairedFrontier(P, [])).toThrow(/align/)
    expect(() => pairedFrontier(P, [{ category: 2, score: 0.5, contextTokens: 10 }])).toThrow(
      /category mismatch/,
    )
  })
})

describe('pairedTokenFrontier — deterministic REAL-token S4-OFF vs S4-ON frontier + full-context framing', () => {
  // The DETERMINISTIC headline axis (no judge): index-aligned o200k token counts for Arm P (S4-OFF) vs
  // Arm S (S4-ON), plus a full-context baseline (entire conversation) for MAGMA Table-3 framing (managed
  // retrieval as a fraction of the un-managed whole). Hand-computed fixtures gate the ~s-fast token run.
  it('computes mean tokens, Δtok, direction counts, and full-context fractions', () => {
    const tokP = [1000, 800]
    const tokS = [400, 300]
    const full = [8000, 8000]
    const f = pairedTokenFrontier(tokP, tokS, full)
    expect(f.nItems).toBe(2)
    expect(f.meanTokP).toBeCloseTo(900, 6)
    expect(f.meanTokS).toBeCloseTo(350, 6)
    expect(f.meanDeltaTok).toBeCloseTo(-550, 6) // Stage-4 SAVED tokens (win direction)
    expect(f.nItemsTokenReduced).toBe(2)
    expect(f.nItemsTokenIncreased).toBe(0)
    expect(f.nItemsTokenEqual).toBe(0)
    expect(f.meanFullContextTok).toBeCloseTo(8000, 6)
    expect(f.fracOfFullP).toBeCloseTo(900 / 8000, 9) // 0.1125 of full context
    expect(f.fracOfFullS).toBeCloseTo(350 / 8000, 9) // 0.04375 — MAGMA's Table-3 fraction
  })
  it('classifies per-item token direction (reduced / increased / equal) honestly', () => {
    const f = pairedTokenFrontier([100, 100, 100], [60, 140, 100], [500, 500, 500])
    expect(f.nItemsTokenReduced).toBe(1)
    expect(f.nItemsTokenIncreased).toBe(1)
    expect(f.nItemsTokenEqual).toBe(1)
    expect(f.meanDeltaTok).toBeCloseTo((-40 + 40 + 0) / 3, 6) // 0 net — the counts expose the split
  })
  it('guards div-by-zero when no full-context baseline is supplied (fractions → 0)', () => {
    const f = pairedTokenFrontier([100], [50], [0])
    expect(f.meanFullContextTok).toBe(0)
    expect(f.fracOfFullP).toBe(0)
    expect(f.fracOfFullS).toBe(0)
  })
  it('throws on misaligned token arrays', () => {
    expect(() => pairedTokenFrontier([1, 2], [1], [1, 2])).toThrow(/misalign/)
    expect(() => pairedTokenFrontier([1], [1], [1, 2])).toThrow(/misalign/)
  })
})

describe('meanCI — mean + 95% CI of the mean (R3/R4 reporting under judge noise)', () => {
  it('reports mean, n, sigma, and half-width ci = z·σ/√n', () => {
    const r = meanCI([0.6, 0.8], 1.96) // mean 0.7, sd 0.14142, se=0.1, ci=0.196
    expect(r.mean).toBeCloseTo(0.7, 6)
    expect(r.n).toBe(2)
    expect(r.sigma).toBeCloseTo(0.14142, 4)
    expect(r.ci).toBeCloseTo((1.96 * 0.14142) / Math.sqrt(2), 4)
  })
  it('has zero CI for identical samples and n=0 guard', () => {
    expect(meanCI([0.5, 0.5, 0.5]).ci).toBe(0)
    expect(meanCI([]).mean).toBe(0)
    expect(meanCI([]).ci).toBe(0)
  })
})

describe('pooledStddev — pooled σ across frozen items each judged k× (R3)', () => {
  it('equals sqrt(mean of per-item sample variances) for equal group sizes', () => {
    // item A [0.6,0.8] var=0.02 ; item B [0.2,0.4] var=0.02 → pooled var 0.02 → σ≈0.14142
    expect(
      pooledStddev([
        [0.6, 0.8],
        [0.2, 0.4],
      ]),
    ).toBeCloseTo(0.14142, 4)
  })
  it('is 0 when every item is internally constant', () => {
    expect(
      pooledStddev([
        [0.7, 0.7],
        [0.2, 0.2, 0.2],
      ]),
    ).toBe(0)
  })
  it('ignores singleton/empty groups (no variance contribution) without NaN', () => {
    expect(pooledStddev([[0.6, 0.8], [0.5]])).toBeCloseTo(0.14142, 4)
    expect(pooledStddev([[], []])).toBe(0)
  })
})

describe('buildControlPairs — R2 pos (gold-as-candidate) / neg (mismatched) construction', () => {
  const items = [
    { question: 'q1', gold: 'Adoption agencies', category: 1 },
    { question: 'q2', gold: '7 May 2023', category: 2 },
    { question: 'q3', gold: 'A red bicycle', category: 4 },
  ]
  it('pos candidate === gold for every item', () => {
    const { pos } = buildControlPairs(items)
    expect(pos).toHaveLength(3)
    for (const p of pos) expect(p.candidate).toBe(p.gold)
  })
  it("neg candidate is another item's gold and NEVER equals its own gold", () => {
    const { neg } = buildControlPairs(items)
    expect(neg).toHaveLength(3)
    for (const n of neg) {
      expect(n.candidate).not.toBe(n.gold)
      expect(items.some((it) => it.gold === n.candidate)).toBe(true) // a real (mismatched) answer
    }
  })
  it('is deterministic', () => {
    expect(buildControlPairs(items)).toEqual(buildControlPairs(items))
  })
})

describe('controlsVerdict — pos ≫ neg separation gate (R2)', () => {
  it('PASSES when the pos mean clears the neg mean by ≥ minSeparation', () => {
    const v = controlsVerdict([0.9, 1.0, 0.8], [0.1, 0.0, 0.2], 0.3)
    expect(v.posMean).toBeCloseTo(0.9, 6)
    expect(v.negMean).toBeCloseTo(0.1, 6)
    expect(v.separation).toBeCloseTo(0.8, 6)
    expect(v.pass).toBe(true)
  })
  it('FAILS when separation is below the threshold (judge cannot tell right from wrong)', () => {
    const v = controlsVerdict([0.6, 0.5], [0.5, 0.4], 0.3)
    expect(v.pass).toBe(false)
  })
})

describe('buildHumanSlice — ~15 mixed-quality triples across all 5 categories (R2 calibration)', () => {
  const pool = [
    { question: 'q1', gold: 'Adoption agencies', category: 1 },
    { question: 'q2', gold: 'Volunteering at a shelter', category: 1 },
    { question: 'q3', gold: '7 May 2023', category: 2 },
    { question: 'q4', gold: 'Two years ago', category: 2 },
    { question: 'q5', gold: 'She likes hiking', category: 3 },
    { question: 'q6', gold: 'A photographer', category: 3 },
    { question: 'q7', gold: 'A red bicycle', category: 4 },
    { question: 'q8', gold: 'Caroline', category: 4 },
    { question: 'q9', gold: LOCOMO_UNANSWERABLE, category: 5 },
    { question: 'q10', gold: LOCOMO_UNANSWERABLE, category: 5 },
  ]
  it('emits a mix of candidate kinds spanning correct/partial/wrong/abstain across all categories', () => {
    const slice = buildHumanSlice(pool, 15)
    expect(slice.length).toBeGreaterThanOrEqual(8)
    const cats = new Set(slice.map((s) => s.category))
    for (const c of [1, 2, 3, 4, 5]) expect(cats.has(c)).toBe(true) // every category represented
    const kinds = new Set(slice.map((s) => s.kind))
    expect(kinds.has('correct')).toBe(true)
    expect(kinds.has('wrong')).toBe(true)
    expect(kinds.has('abstain')).toBe(true)
    // correct ⇒ candidate is the gold; abstain ⇒ the App C.2 sentinel
    for (const s of slice) {
      if (s.kind === 'correct') expect(s.candidate).toBe(s.gold)
      if (s.kind === 'abstain') expect(s.candidate).toBe(QA_NOT_FOUND)
      expect(s.human_score).toBeNull() // left for John to fill in
    }
  })
  it('is deterministic', () => {
    expect(buildHumanSlice(pool, 15)).toEqual(buildHumanSlice(pool, 15))
  })
  it('SPANS all categories even when one category dominates the pool (round-robin coverage)', () => {
    // Regression: a category-major slice(0,target) would emit ONLY cat 1 when cat 1 has ≥target items.
    const lopsided = [
      ...Array.from({ length: 30 }, (_, i) => ({
        question: `c1-${String(i).padStart(2, '0')}`,
        gold: `g1-${i}`,
        category: 1,
      })),
      { question: 'c2-a', gold: 'g2', category: 2 },
      { question: 'c3-a', gold: 'g3', category: 3 },
      { question: 'c4-a', gold: 'g4', category: 4 },
      { question: 'c5-a', gold: LOCOMO_UNANSWERABLE, category: 5 },
    ]
    const slice = buildHumanSlice(lopsided, 15)
    const cats = new Set(slice.map((s) => s.category))
    for (const c of [1, 2, 3, 4, 5]) expect(cats.has(c)).toBe(true)
  })
})

// ══ OFFLINE EVALUATOR — frontier value + HCOPE-style gate verdict (north-star measurement spine) ══
// Hand-checked fixtures BEFORE any real arm number is trusted (anti-mistesting). Pure/deterministic, no spawns.

describe('frontierValue — per-item vᵢ = accᵢ − λ·(tokᵢ/1000) + mean±CI', () => {
  it('LAMBDA_TOKEN_UNIT is 1000 (λ = accuracy-points per 1000 context tokens)', () => {
    expect(LAMBDA_TOKEN_UNIT).toBe(1000)
  })
  it('computes hand-checked values and allows a legitimately NEGATIVE value (token-heavy arm)', () => {
    // acc=[1.0,0.5], tok=[100,300], λ=0.5 ⇒ v=[1.0−0.5·0.1, 0.5−0.5·0.3]=[0.95,0.35], mean 0.65.
    const r = frontierValue([1.0, 0.5], [100, 300], 0.5)
    expect(r.perItem).toEqual([0.95, 0.35])
    expect(r.mean).toBeCloseTo(0.65, 10)
    // λ large enough that value goes negative — NOT dropped (unlike a score<0 sentinel).
    const neg = frontierValue([0.2], [1000], 1.0)
    expect(neg.perItem[0]).toBeCloseTo(-0.8, 10)
  })
  it('λ=0 ⇒ value is pure accuracy; throws on length mismatch', () => {
    expect(frontierValue([0.8, 0.4], [500, 900], 0).perItem).toEqual([0.8, 0.4])
    expect(() => frontierValue([1], [1, 2], 0.5)).toThrow(/align/)
  })
})

describe('pairedValueDelta — matched-pair v_candidate − v_incumbent (both-graded only)', () => {
  const inc = [
    { category: 1, score: 1.0, contextTokens: 100 },
    { category: 1, score: 0.0, contextTokens: 100 },
  ]
  const cand = [
    { category: 1, score: 1.0, contextTokens: 300 },
    { category: 1, score: 1.0, contextTokens: 300 },
  ]
  it('computes the hand-checked paired value delta', () => {
    // λ=0.5: vInc=[0.95,−0.05], vCand=[0.85,0.85] ⇒ deltas=[−0.10,0.90], mean 0.40.
    const r = pairedValueDelta(inc, cand, 0.5)
    expect(r.n).toBe(2)
    expect(r.deltas.map((d) => Number(d.toFixed(4)))).toEqual([-0.1, 0.9])
    expect(r.meanDelta).toBeCloseTo(0.4, 10)
    expect(r.meanValueIncumbent).toBeCloseTo(0.45, 10)
    expect(r.meanValueCandidate).toBeCloseTo(0.85, 10)
  })
  it('drops a pair when EITHER arm did not grade it (never counts a drop as 0.0)', () => {
    const candDrop = [cand[0]!, { category: 1, score: -1, contextTokens: 300 }]
    const r = pairedValueDelta(inc, candDrop, 0.5)
    expect(r.n).toBe(1) // only the first pair survives
    expect(r.deltas).toHaveLength(1)
    expect(r.deltas[0]!).toBeCloseTo(-0.1, 10)
  })
  it('throws on misaligned length or per-index category mismatch', () => {
    expect(() => pairedValueDelta(inc, [cand[0]!], 0.5)).toThrow(/align/)
    const catMismatch = [{ category: 2, score: 1, contextTokens: 300 }, cand[1]!]
    expect(() => pairedValueDelta(inc, catMismatch, 0.5)).toThrow(/category mismatch/)
  })
})

describe('normInv / tCritOneSided — deterministic quantiles (anchored to exact tables)', () => {
  it('normInv matches known standard-normal quantiles', () => {
    expect(normInv(0.975)).toBeCloseTo(1.959964, 4)
    expect(normInv(0.95)).toBeCloseTo(1.644854, 4)
    expect(normInv(0.5)).toBeCloseTo(0, 6)
  })
  it('tCritOneSided → normal quantile as df→∞; matches the exact t-table at finite df', () => {
    expect(tCritOneSided(Infinity, 0.05)).toBeCloseTo(1.644854, 4)
    expect(tCritOneSided(1e9, 0.05)).toBeCloseTo(1.644854, 4)
    // Exact one-sided t_{0.05}: df=10 → 1.8125, df=30 → 1.6973, df=19 → 1.7291.
    expect(tCritOneSided(10, 0.05)).toBeCloseTo(1.8125, 3)
    expect(tCritOneSided(30, 0.05)).toBeCloseTo(1.6973, 3)
    expect(tCritOneSided(19, 0.05)).toBeCloseTo(1.7291, 3)
    // A tighter δ widens the critical value (df=19, δ=0.01 → 2.539).
    expect(tCritOneSided(19, 0.01)).toBeCloseTo(2.539, 2)
  })
})

describe('hcopeLowerBound — one-sided (1−δ) lower bound (HCOPE analog; never a point estimate)', () => {
  it('LB = mean − t·σ/√n, matches the composed formula', () => {
    const deltas = [0.3, 0.5, 0.4]
    const b = hcopeLowerBound(deltas, 0.05)
    expect(b.n).toBe(3)
    expect(b.mean).toBeCloseTo(0.4, 10)
    const t = tCritOneSided(2, 0.05)
    expect(b.lowerBound).toBeCloseTo(0.4 - (t * b.sigma) / Math.sqrt(3), 10)
    expect(b.lowerBound).toBeLessThan(b.mean) // a lower bound is strictly below the point estimate when σ>0
  })
  it('σ=0 with n≥2 ⇒ LB = mean (a deterministic gain certifies itself)', () => {
    expect(hcopeLowerBound([0.4, 0.4, 0.4]).lowerBound).toBeCloseTo(0.4, 10)
  })
  it('n<2 ⇒ −∞ (a <2-sample win is never certifiable)', () => {
    expect(hcopeLowerBound([0.9]).lowerBound).toBe(-Infinity)
    expect(hcopeLowerBound([]).lowerBound).toBe(-Infinity)
  })
  it('is MONOTONE in n: more samples of the same spread ⇒ a tighter (higher) lower bound', () => {
    const lb2 = hcopeLowerBound([0.3, 0.5]).lowerBound // n=2, wide
    const lb4 = hcopeLowerBound([0.3, 0.5, 0.3, 0.5]).lowerBound // n=4, same mean/spread
    expect(lb4).toBeGreaterThan(lb2)
  })
})

describe('gateVerdict — candidate wins ONLY on certified value gain AND no negative-control regression', () => {
  const SIGMA = 0.0224 // the reused judge σ
  it('CLEAR WIN (positive control): LB>0 and neg-controls clean ⇒ winner=candidate', () => {
    const v = gateVerdict({
      valueDeltaLB: 0.1,
      negControlDeltaAcc: 0.0,
      negControlN: 5,
      posControlDeltaAcc: 0.2,
      sigma: SIGMA,
    })
    expect(v.winner).toBe('candidate')
    expect(v.valueGainCertified).toBe(true)
    expect(v.negControlsClean).toBe(true)
  })
  it('WITHIN-σ NULL (negative control): value LB ≤ 0 ⇒ no-winner (a measured NULL)', () => {
    const v = gateVerdict({
      valueDeltaLB: -0.01,
      negControlDeltaAcc: 0.0,
      negControlN: 5,
      posControlDeltaAcc: 0.0,
      sigma: SIGMA,
    })
    expect(v.winner).toBe('no-winner')
    expect(v.valueGainCertified).toBe(false)
  })
  it('NEG-CONTROL BLOCK (anti-mistesting): certified value gain BUT breaks context-answerable Qs ⇒ no-winner', () => {
    // A token-cheap arm can post a positive value LB yet quietly REGRESS the negative controls (Δacc < −σ).
    // It must NOT win — this is the guard against a convenient proxy that isn't the real mechanism.
    const v = gateVerdict({
      valueDeltaLB: 0.2,
      negControlDeltaAcc: -0.1,
      negControlN: 5,
      posControlDeltaAcc: 0.3,
      sigma: SIGMA,
    })
    expect(v.winner).toBe('no-winner')
    expect(v.valueGainCertified).toBe(true)
    expect(v.negControlsClean).toBe(false)
  })
  it('boundary: negControlDeltaAcc exactly −σ passes (≥ −σ, not > −σ)', () => {
    const v = gateVerdict({
      valueDeltaLB: 0.05,
      negControlDeltaAcc: -SIGMA,
      negControlN: 5,
      posControlDeltaAcc: 0.0,
      sigma: SIGMA,
    })
    expect(v.negControlsClean).toBe(true)
    expect(v.winner).toBe('candidate')
  })
})

describe('whichArmWon — per-item argmax value, ties with the incumbent → incumbent (anti-churn)', () => {
  it('picks the argmax arm per item and resolves an incumbent tie to the incumbent', () => {
    const r = whichArmWon(
      {
        hybrid: [0.5, 0.5, 0.9], // incumbent
        entity: [0.6, 0.4, 0.9], // item2 ties hybrid at 0.9 ⇒ hybrid keeps it
        causal: [0.4, 0.7, 0.8],
      },
      'hybrid',
    )
    expect(r.perItem).toEqual(['entity', 'causal', 'hybrid'])
    expect(r.tally).toEqual({ hybrid: 1, entity: 1, causal: 1 })
  })
  it('throws when the incumbent is absent or arm arrays misalign', () => {
    expect(() => whichArmWon({ hybrid: [0.5] }, 'missing')).toThrow(/incumbent/)
    expect(() => whichArmWon({ hybrid: [0.5, 0.5], entity: [0.6] }, 'hybrid')).toThrow(/length/)
  })
})

describe('control cats — the PAPER axis (Table 1), never inverted again', () => {
  // MAGMA Table 1 (LLM-Judge): Multi-Hop 0.528 (< Nemori 0.569 / MemoryOS 0.552 — a LOSS),
  // Temporal 0.650, Open-Domain 0.517 (narrow), Single-Hop 0.776, Adversarial 0.742, Overall 0.700.
  it('POS controls are MAGMA’s real wins: temporal + singleHop + adversarial', () => {
    expect(POS_CONTROL_CATS).toEqual(
      new Set([LOCOMO_CAT.temporal, LOCOMO_CAT.singleHop, LOCOMO_CAT.adversarial]),
    )
  })
  it('NEG control is the paper’s concession: multihop (must-not-regress; NEVER a positive control)', () => {
    expect(NEG_CONTROL_CATS).toEqual(new Set([LOCOMO_CAT.multihop]))
    expect(POS_CONTROL_CATS.has(LOCOMO_CAT.multihop)).toBe(false)
  })
  it('openDomain is neutral (narrow 0.517 win — measured + reported, gates nothing)', () => {
    expect(NEUTRAL_CATS).toEqual(new Set([LOCOMO_CAT.openDomain]))
  })
  it('the three sets PARTITION all five categories (no overlap, no gap)', () => {
    const all = [...POS_CONTROL_CATS, ...NEG_CONTROL_CATS, ...NEUTRAL_CATS].sort()
    expect(all).toEqual([1, 2, 3, 4, 5])
  })
  it('controlClassOf maps each category; throws on an unknown category (fail fast)', () => {
    expect(controlClassOf(LOCOMO_CAT.temporal)).toBe('positive')
    expect(controlClassOf(LOCOMO_CAT.singleHop)).toBe('positive')
    expect(controlClassOf(LOCOMO_CAT.adversarial)).toBe('positive')
    expect(controlClassOf(LOCOMO_CAT.multihop)).toBe('negative')
    expect(controlClassOf(LOCOMO_CAT.openDomain)).toBe('neutral')
    expect(() => controlClassOf(6)).toThrow(/category/)
  })
})

describe('gateVerdict — UNMEASURED negative controls can never produce a vacuous pass', () => {
  it('n=0 both-graded neg pairs fails the neg leg regardless of a certified value gain', () => {
    // The vacuous-pass hole: an empty neg subset used to yield Δacc=0 ≥ −σ ⇒ a certified "winner" with
    // ZERO negative-control coverage. n=0 must fail the neg leg outright.
    const v = gateVerdict({
      valueDeltaLB: 0.5,
      negControlDeltaAcc: 0.0,
      negControlN: 0,
      posControlDeltaAcc: 0.4,
      sigma: 0.0267,
    })
    expect(v.negControlsClean).toBe(false)
    expect(v.winner).toBe('no-winner')
    expect(v.reasons.join(' ')).toMatch(/UNMEASURED/)
  })
})
