/**
 * T012 [US1] (specs/001-learning-memory-loop) — certification-harness axis + controls locks.
 *
 * The harness is a CLI script (not importable without side effects), so these are STRUCTURAL locks on
 * its source — the same technique as the kto-learner Everitt-isolation suite: they prove the harness
 * (a) never imports the wrong-axis recall harnesses (`locomo-scoring`, `locomo-multihop-harness` —
 * retrieval recall/overlap must NEVER be the verdict), (b) exposes every certification mode the plan
 * gates on, (c) emits machine-checkable RESULTS_JSON rows carrying accuracy+tokens (+σ for judged
 * gates), and (d) gates the arm-frontier verdict through gateVerdict (value-LB + measured neg
 * controls), never through recall. The BEHAVIORAL row content is proven live by the quickstart
 * Scenario-1 runs; the pure math behind the rows is covered in locomo-judge-lib.test.ts.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const harnessPath = join(here, '../../../scripts/locomo-judge-harness.ts')
const src = readFileSync(harnessPath, 'utf8')

describe('T012 — the verdict axis is answer accuracy + tokens, never retrieval recall', () => {
  it('NEVER imports the wrong-axis recall harnesses (locomo-scoring / locomo-multihop-harness)', () => {
    expect(src).not.toMatch(/from ['"].*locomo-scoring/)
    expect(src).not.toMatch(/from ['"].*locomo-multihop-harness/)
  })

  it('imports its math from the judge lib (σ, HCOPE, controls, gateVerdict) — the right-axis toolbox', () => {
    expect(src).toMatch(/from ['"]\.\/locomo-judge-lib\.js['"]/)
    for (const fn of ['gateVerdict', 'hcopeLowerBound', 'pooledStddev', 'nToResolveDelta']) {
      expect(src, `harness must use ${fn}`).toContain(fn)
    }
  })

  it('no recall@k / overlap metric is computed anywhere in the harness', () => {
    expect(src).not.toMatch(/recall@|recallAt|hitRate|overlapRatio/i)
  })
})

describe('T012 — certification modes (T018 lock): variance, controls, cert-ingest, arm-frontier', () => {
  it('dispatches every cert mode the plan gates on', () => {
    for (const mode of [
      "'variance'",
      "'controls'",
      "'cert-ingest'",
      "'arm-frontier-tokens'",
      "'arm-frontier-accuracy'",
    ]) {
      expect(src, `mode ${mode} must be dispatchable`).toContain(`MODE === ${mode}`)
    }
  })

  it('the held-out cert path exists: SCNS_FRONTIER_SNAPSHOT + disjoint certSampleIds', () => {
    expect(src).toContain('SCNS_FRONTIER_SNAPSHOT')
    expect(src).toMatch(/certSampleIds|SCNS_CERT_SAMPLE_IDS/)
  })
})

describe('T012 — emitted rows are machine-checkable and carry the gate inputs', () => {
  it('every mode emits RESULTS_JSON (quoted, parseable evidence rows)', () => {
    expect((src.match(/RESULTS_JSON/g) ?? []).length).toBeGreaterThanOrEqual(5)
  })

  it('the variance rows carry pooled σ and the N-to-resolve ruler', () => {
    expect(src).toContain('pooledSigma')
    expect(src).toMatch(/nToResolve/)
  })

  it('the arm-frontier verdict rows carry value-LB + MEASURED negative controls (never a vacuous pass)', () => {
    for (const key of ['valueDeltaLB', 'negControlDeltaAcc', 'negControlN', 'posControlDeltaAcc']) {
      expect(src, `gate row must carry ${key}`).toContain(key)
    }
  })

  it('σ is model-scoped: the pinned-model comment + env override are present (never a bare constant)', () => {
    expect(src).toContain('SCNS_JUDGE_SIGMA')
    expect(src).toMatch(/re-establish|model-dependent/i)
  })
})

// ── T031 [US3] — the commit gate certifies a real win and REFUSES a tie (functional, real lib fns) ─
import {
  pairedValueDelta,
  hcopeLowerBound,
  gateVerdict,
  NEG_CONTROL_CATS,
  POS_CONTROL_CATS,
  type ArmFrontierRow,
} from '../../../scripts/locomo-judge-lib.js'

describe('T031 — arm-frontier commit gate: win > σ certifies, tie/within-σ refuses (0 flips)', () => {
  const SIGMA = 0.0267
  const CATS = [1, 2, 3, 4, 5] // multihop(NEG), temporal, openDomain, singleHop, adversarial
  const mkRows = (scoreOf: (cat: number, i: number) => number): ArmFrontierRow[] =>
    CATS.flatMap((cat) =>
      [0, 1, 2].map((i) => ({ category: cat, score: scoreOf(cat, i), contextTokens: 1000 })),
    )

  const controlDelta = (
    inc: readonly ArmFrontierRow[],
    cand: readonly ArmFrontierRow[],
    cats: ReadonlySet<number>,
  ): { delta: number; n: number } => {
    const deltas: number[] = []
    for (let i = 0; i < inc.length; i++) {
      if (!cats.has(inc[i]!.category)) continue
      if (inc[i]!.score < 0 || cand[i]!.score < 0) continue
      deltas.push(cand[i]!.score - inc[i]!.score)
    }
    return { delta: deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0, n: deltas.length }
  }

  it('POSITIVE: a candidate that wins by 0.3 ≫ σ everywhere except the neg controls (held flat) CERTIFIES', () => {
    const inc = mkRows(() => 0.5)
    const cand = mkRows((cat) => (NEG_CONTROL_CATS.has(cat) ? 0.5 : 0.8)) // never regress multihop
    const pvd = pairedValueDelta(inc, cand, 0)
    const lb = hcopeLowerBound(pvd.deltas, 0.05)
    const neg = controlDelta(inc, cand, NEG_CONTROL_CATS)
    const pos = controlDelta(inc, cand, POS_CONTROL_CATS)
    const v = gateVerdict({
      valueDeltaLB: lb.lowerBound,
      negControlDeltaAcc: neg.delta,
      negControlN: neg.n,
      posControlDeltaAcc: pos.delta,
      sigma: SIGMA,
    })
    expect(lb.lowerBound).toBeGreaterThan(0)
    expect(v.winner).toBe('candidate')
  })

  it('NEGATIVE: a dead tie REFUSES — the incumbent hybrid stands (0 flips on assumption, SC-006/SC-012)', () => {
    const inc = mkRows(() => 0.6)
    const cand = mkRows(() => 0.6)
    const pvd = pairedValueDelta(inc, cand, 0)
    const lb = hcopeLowerBound(pvd.deltas, 0.05)
    const neg = controlDelta(inc, cand, NEG_CONTROL_CATS)
    const v = gateVerdict({
      valueDeltaLB: lb.lowerBound,
      negControlDeltaAcc: neg.delta,
      negControlN: neg.n,
      posControlDeltaAcc: 0,
      sigma: SIGMA,
    })
    expect(v.winner).toBe('no-winner')
  })

  it('NEGATIVE: a token-cheap arm that quietly regresses the multihop neg control is BLOCKED', () => {
    const inc = mkRows(() => 0.6)
    // wins broadly but drops multihop by 0.2 ≫ σ — the neg leg must block it
    const cand = mkRows((cat) => (NEG_CONTROL_CATS.has(cat) ? 0.4 : 0.9))
    const pvd = pairedValueDelta(inc, cand, 0)
    const lb = hcopeLowerBound(pvd.deltas, 0.05)
    const neg = controlDelta(inc, cand, NEG_CONTROL_CATS)
    const v = gateVerdict({
      valueDeltaLB: lb.lowerBound,
      negControlDeltaAcc: neg.delta,
      negControlN: neg.n,
      posControlDeltaAcc: 0.3,
      sigma: SIGMA,
    })
    expect(lb.lowerBound).toBeGreaterThan(0) // the value gain alone would have passed…
    expect(v.negControlsClean).toBe(false) // …but the control fires
    expect(v.winner).toBe('no-winner')
  })
})

describe('T037 — the evidence arbiter is wired into the gate (structural locks)', () => {
  it('imports the bounded enactment mechanism and emits its decision', () => {
    expect(src).toMatch(/from '\.\.\/src\/memory\/routing-policy\.js'/)
    expect(src).toContain('commitRoutingPolicy')
    expect(src).toContain('ARBITER_JSON')
  })

  it('enactment is bring-up gated (shadow by default) and requires attested det×2', () => {
    expect(src).toContain('SCNS_ARBITER_ENACT')
    expect(src).toContain('SCNS_ARBITER_DET_RUNS')
    expect(src).toMatch(/shadow/i)
  })

  it('promotion demands DOMINANCE across the λ sweep plus a held-out, powered run', () => {
    expect(src).toMatch(/EVERY swept λ|winnersAtEveryLambda/)
    expect(src).toMatch(/heldOut && !thinProbe/)
  })
})

// ── T043 [US4] — the learned-controller promotion gate over HELD-OUT human-accepted outcomes ────
import { humanOutcomePromotion } from '../../../scripts/locomo-judge-lib.js'

describe('T043 — humanOutcomePromotion: the challenger promotes ONLY on a supported human-outcome win', () => {
  const rows = (arm: string, outcomes: readonly number[]) =>
    outcomes.map((humanOutcome) => ({ arm, humanOutcome, propensity: 1 }))

  it('POSITIVE: a clean separation with full support promotes (LB hand-computed = 1)', () => {
    const v = humanOutcomePromotion(
      [...rows('magma-reinforced', [1, 1, 1, 1, 1]), ...rows('hybrid', [0, 0, 0, 0, 0])],
      { challenger: 'magma-reinforced', incumbent: 'hybrid' },
    )
    expect(v.promote).toBe(true)
    expect(v.challengerMean).toBe(1)
    expect(v.incumbentMean).toBe(0)
    expect(v.deltaLowerBound).toBeCloseTo(1, 10) // zero variance ⇒ LB = the full delta
  })

  it('hand-computed Welch lower bound: Δ=0.44, s²=0.012 each, n=5 ⇒ LB ≈ 0.3260', () => {
    const v = humanOutcomePromotion(
      [
        ...rows('magma-reinforced', [1, 0.8, 1, 0.8, 1]),
        ...rows('hybrid', [0.4, 0.6, 0.4, 0.6, 0.4]),
      ],
      { challenger: 'magma-reinforced', incumbent: 'hybrid' },
    )
    expect(v.deltaLowerBound).toBeCloseTo(0.326, 3)
    expect(v.promote).toBe(true)
  })

  it('NEGATIVE: a dead tie NEVER promotes — the static policy stands and the null is honest (SC-008)', () => {
    const v = humanOutcomePromotion(
      [...rows('magma-reinforced', [0.5, 0.5, 0.5, 0.5, 0.5]), ...rows('hybrid', [0.5, 0.5, 0.5, 0.5, 0.5])],
      { challenger: 'magma-reinforced', incumbent: 'hybrid' },
    )
    expect(v.promote).toBe(false)
    expect(v.reason).toMatch(/no certified|lower bound|stands/i)
  })

  it('NEGATIVE: insufficient support refuses regardless of the point delta (min-n control)', () => {
    const v = humanOutcomePromotion(
      [...rows('magma-reinforced', [1, 1]), ...rows('hybrid', [0, 0])],
      { challenger: 'magma-reinforced', incumbent: 'hybrid', minN: 5 },
    )
    expect(v.promote).toBe(false)
    expect(v.reason).toMatch(/support|n=/i)
  })

  it('NEGATIVE: unsettled rows are the caller problem — only [0,1] outcomes are accepted (throws on bad input)', () => {
    expect(() =>
      humanOutcomePromotion([{ arm: 'hybrid', humanOutcome: 2, propensity: 1 }], {
        challenger: 'x',
        incumbent: 'hybrid',
      }),
    ).toThrow(/outcome/i)
  })
})

describe('T047 — the gate carries the edge-weight-reinforced beam CHALLENGER (structural locks)', () => {
  it('the reinforced arm exists behind SCNS_REINFORCED_ARM with useEdgeWeights ON', () => {
    expect(src).toContain('SCNS_REINFORCED_ARM')
    expect(src).toContain('magma-reinforced')
    expect(src).toMatch(/useEdgeWeights:\s*true/)
  })

  it('the reinforcement pre-step applies settled human outcomes to the SNAPSHOT COPY, never the live vault', () => {
    expect(src).toContain('applyExperienceReinforcement')
    expect(src).toMatch(/SCNS_EXPERIENCE_DB/)
  })
})

import {
  substrateDensityFloor,
  DEFAULT_SUBSTRATE_FLOOR,
  SUBSTRATE_STOP_MESSAGE,
  fidelityFloorVerdict,
  reproductionBand,
  reproductionCategoryPattern,
  reproductionOrderingPass,
  reproductionScrambledControl,
  reproductionVerdict,
  planEdgeScramble,
  type EdgeEndpoint,
} from '../../../scripts/locomo-judge-lib.js'

// T022/T028 — substrate density-floor STOP (contracts/substrate-density-floor.contract.md). The gate that
// the fable5 null slipped through: `preCheckOk = materialized > 0` passed on materialized=4. The floor
// requires ≥8 materialized causal edges per conversation AND ≥0.5 per judged WHY item AND a per-conv
// MINIMUM ≥ 8 (a sum/mean would MASK a per-conv 0).
describe('T028 — substrate density-floor STOP (per-conv minimum, not a masking sum)', () => {
  it('POSITIVE: a dense substrate (≥8/conv, ≥0.5/WHY-item, min≥8) passes the floor', () => {
    const r = substrateDensityFloor({ materializedPerConv: [10, 12, 9], perWhyItem: 0.8 })
    expect(r.preCheckOk).toBe(true)
    expect(r.perConvMin).toBe(9)
    expect(r.floor).toEqual(DEFAULT_SUBSTRATE_FLOOR)
  })

  it('NEGATIVE (fable5 defect): a per-conv 0 masked by a healthy MEAN still STOPS (min gates, not the sum)', () => {
    const r = substrateDensityFloor({ materializedPerConv: [20, 0], perWhyItem: 1.0 })
    expect(r.materializedPerConv).toBeGreaterThanOrEqual(8) // mean=10 looks fine…
    expect(r.perConvMin).toBe(0) // …but a conversation has ZERO causal edges
    expect(r.preCheckOk).toBe(false) // ⇒ STOP (the exact fable5 "OK ✓ on 1 relation/conv" hole, closed)
  })

  it('NEGATIVE (starved, materialized=4): below the per-conv floor STOPS', () => {
    const r = substrateDensityFloor({ materializedPerConv: [4], perWhyItem: 0.1 })
    expect(r.preCheckOk).toBe(false)
  })

  it('NEGATIVE: enough edges per conv but too few per WHY item still STOPS', () => {
    const r = substrateDensityFloor({ materializedPerConv: [10, 10], perWhyItem: 0.2 })
    expect(r.preCheckOk).toBe(false)
  })

  it('emits the exact STOP wording the contract mandates (same as the elsewhere-used STOP)', () => {
    expect(SUBSTRATE_STOP_MESSAGE).toBe(
      'STOP — substrate below density floor; any graph-arm Δ is a NULL, not a MAGMA verdict',
    )
  })
})

// T029 — Fidelity-Reproduction-Floor VOID (data-model §3): a candidate scoring below its own reference
// (paper number) VOIDS the comparison — it is never recorded as a "loss". fable5's magma at 0.2492 vs the
// paper's ~0.700 should have been VOID, not "hybrid wins".
describe('T029 — Fidelity-Reproduction-Floor VOID (below own reference ⇒ VOID, never a loss)', () => {
  it('REPRODUCED-floor OK: a candidate at/above the reproduction band is comparable', () => {
    const r = fidelityFloorVerdict({ candidateOverall: 0.68, referenceOverall: 0.7 })
    expect(r.verdict).toBe('ok')
  })

  it('VOID (fable5): a candidate ~3× below its published number VOIDs the comparison (not a loss)', () => {
    const r = fidelityFloorVerdict({ candidateOverall: 0.2492, referenceOverall: 0.7 })
    expect(r.verdict).toBe('VOID')
  })

  it('the reproduction band boundary (0.60) is inclusive', () => {
    expect(fidelityFloorVerdict({ candidateOverall: 0.6, referenceOverall: 0.7 }).verdict).toBe('ok')
    expect(fidelityFloorVerdict({ candidateOverall: 0.599, referenceOverall: 0.7 }).verdict).toBe(
      'VOID',
    )
  })
})

// T030 — the magma-only reproduction read reports absolute MAGMA fidelity before any comparison. The
// category-pattern leg is TARGET-BASED (G1): each gating category must meet its App-C.3 paper target;
// multi-hop is a concession FLOOR (never a ceiling); open-domain is neutral.
describe('T030 — magma-only reproduction band + Table-1 category pattern', () => {
  it('band boundary is inclusive at 0.60', () => {
    expect(reproductionBand(0.6)).toBe(true)
    expect(reproductionBand(0.599)).toBe(false)
  })

  it('POSITIVE: every gating category at its App-C.3 target passes', () => {
    expect(
      reproductionCategoryPattern({
        1: 0.528,
        2: 0.65,
        3: 0.54,
        4: 0.776,
        5: 0.742,
      }),
    ).toBe(true)
  })

  it('NEGATIVE: a pattern that misses paper targets fails', () => {
    expect(
      reproductionCategoryPattern({
        1: 0.8,
        2: 0.65,
        3: 0.517,
        4: 0.55, // single-hop 0.55 < 0.776 target
        5: 0.5, // adversarial 0.5 < 0.742 target
      }),
    ).toBe(false)
  })

  // ── G1 (John-approved 2026-07-07): target-based reproduction (App-C.3 Fidelity floor), replacing the
  // rank-shape `multi===minAcc` proxy that MIS-FIRED when magma BEAT the multi-hop concession.
  it('RED G1: magma BEATING the multi-hop concession passes when all paper targets are met (target-based, not rank-shape)', () => {
    // multi-hop 0.90 is the HIGHEST category (magma ≫ the 0.528 concession) ⇒ the old `multi===minAcc`
    // proxy mis-fires and returns false; a target-based floor must PASS (every gating category meets target).
    expect(reproductionCategoryPattern({ 1: 0.9, 2: 0.7, 3: 0.6, 4: 0.8, 5: 0.85 })).toBe(true)
  })

  it('G1: the real T027 run fails ONLY on the temporal miss; fixing temporal to target makes the SAME shape pass', () => {
    // Actual T027 per-category: only temporal (cat2) 0.5889 < 0.650 ⇒ false (the honest, real gap).
    expect(
      reproductionCategoryPattern({ 1: 0.8083, 2: 0.5889, 3: 0.7611, 4: 0.8111, 5: 0.9444 }),
    ).toBe(false)
    // …raise temporal to its target and the SAME multi-hop-above-concession shape now passes.
    expect(
      reproductionCategoryPattern({ 1: 0.8083, 2: 0.66, 3: 0.7611, 4: 0.8111, 5: 0.9444 }),
    ).toBe(true)
  })

  it('G1: multi-hop is a FLOOR (concession) — below 0.528 fails; open-domain is NEUTRAL (never gates)', () => {
    expect(reproductionCategoryPattern({ 1: 0.4, 2: 0.7, 3: 0.6, 4: 0.8, 5: 0.8 })).toBe(false) // multi < floor
    expect(reproductionCategoryPattern({ 1: 0.6, 2: 0.66, 3: 0.1, 4: 0.8, 5: 0.8 })).toBe(true) // low open-domain still passes
  })

  it('G1: an explicit tolerance lets a near-target category through (default 0 = strict)', () => {
    expect(reproductionCategoryPattern({ 1: 0.6, 2: 0.6, 3: 0.6, 4: 0.8, 5: 0.8 })).toBe(false) // temporal 0.60 < 0.65 strict
    expect(reproductionCategoryPattern({ 1: 0.6, 2: 0.6, 3: 0.6, 4: 0.8, 5: 0.8 }, 0.06)).toBe(true) // within 0.06
  })
})

// Increment 2 (T030 controls) — the two legs that let the reproduction gate ever certify REPRODUCED:
//   - ordering_pass: MAGMA's Eq-7 ordered+budgeted briefing must PRESERVE answer accuracy vs the SAME
//     retrieved subgraph dumped as full, unordered context (the linearization+budget is "free" — same
//     accuracy at far fewer tokens, the paper's efficiency claim).
//   - scrambled_control: destroying the typed-edge topology (edges shuffled) MUST degrade magma accuracy by
//     >= the judge noise floor σ — proof the GRAPH STRUCTURE contributes, not just the anchor chunks.
describe('T030 Increment 2 — ordering / scrambled-graph controls + full REPRODUCED verdict', () => {
  it('ordering_pass: magma ≥ full-context − tolerance (Eq-7 preserves accuracy at fewer tokens)', () => {
    expect(reproductionOrderingPass(0.78, 0.80)).toBe(true) // 0.78 >= 0.80 - 0.05 (default tol) — preserved
    expect(reproductionOrderingPass(0.80, 0.78)).toBe(true) // ordered even beats full-context
    expect(reproductionOrderingPass(0.60, 0.80)).toBe(false) // budgeting LOST 0.20 accuracy ⇒ fail
    expect(reproductionOrderingPass(0.70, 0.80, 0.15)).toBe(true) // explicit wider tolerance passes
  })

  it('scrambled_control: real − scrambled ≥ σ (graph structure must matter)', () => {
    expect(reproductionScrambledControl(0.78, 0.60, 0.0267)).toBe(true) // scrambling hurt by 0.18 ≥ σ ⇒ control holds
    expect(reproductionScrambledControl(0.78, 0.78, 0.0267)).toBe(false) // no degradation ⇒ graph inert ⇒ FAILS
    expect(reproductionScrambledControl(0.78, 0.79, 0.0267)).toBe(false) // scrambled BETTER ⇒ definitely fails
  })

  it('reproductionVerdict: REPRODUCED iff ALL legs pass', () => {
    const all = {
      bandPass: true,
      categoryPatternPass: true,
      orderingPass: true,
      scrambledPass: true,
      substratePass: true,
    }
    expect(reproductionVerdict(all)).toBe('REPRODUCED')
  })

  it('reproductionVerdict: substrate fail ⇒ BLOCKED (dominates)', () => {
    expect(
      reproductionVerdict({
        bandPass: true,
        categoryPatternPass: true,
        orderingPass: true,
        scrambledPass: true,
        substratePass: false,
      }),
    ).toBe('BLOCKED')
  })

  it('reproductionVerdict: band+category pass but a control fails ⇒ PARTIAL (not REPRODUCED, not NOT_REPRODUCED)', () => {
    expect(
      reproductionVerdict({
        bandPass: true,
        categoryPatternPass: true,
        orderingPass: true,
        scrambledPass: false, // scrambled control failed
        substratePass: true,
      }),
    ).toBe('PARTIAL')
    // the actual T027 state: band passes, category FAILS (temporal), controls unbuilt/false ⇒ NOT_REPRODUCED
    expect(
      reproductionVerdict({
        bandPass: true,
        categoryPatternPass: false,
        orderingPass: false,
        scrambledPass: false,
        substratePass: true,
      }),
    ).toBe('NOT_REPRODUCED')
  })

  it('reproductionVerdict: a null (unbuilt) control is treated as not-passing ⇒ never REPRODUCED on nulls', () => {
    expect(
      reproductionVerdict({
        bandPass: true,
        categoryPatternPass: true,
        orderingPass: null,
        scrambledPass: null,
        substratePass: true,
      }),
    ).toBe('PARTIAL')
  })
})

// planEdgeScramble — the deterministic MECHANISM behind the scrambled-graph negative control. It permutes
// typed-edge endpoints (dst_chunk) WITHIN each edge_type, destroying the pairing (topology) while preserving
// per-type edge count, the dst_chunk multiset (in-degree) and FK-validity (every new endpoint already existed
// for that type). This is what makes the scrambled arm a faithful "same substrate, wrong wiring" control.
describe('planEdgeScramble — topology-destroying, multiset+FK-preserving edge permutation', () => {
  const rng = (seed: number) => {
    // tiny deterministic LCG for the test (independent of the harness PRNG)
    let a = seed >>> 0
    return () => {
      a = (Math.imul(a, 1664525) + 1013904223) >>> 0
      return a / 0x100000000
    }
  }
  const causal = (id: number, dstChunk: number): EdgeEndpoint => ({ id, edgeType: 'causal', dstChunk })

  it('preserves the per-type dst_chunk multiset and edge count (in-degree unchanged)', () => {
    const edges = [10, 11, 12, 13, 14, 15, 16, 17].map((d, i) => causal(i + 1, d))
    const plan = planEdgeScramble(edges, rng(7))
    const applied = new Map(edges.map((e) => [e.id, e.dstChunk]))
    for (const p of plan) applied.set(p.id, p.newDstChunk)
    const before = edges.map((e) => e.dstChunk).sort((a, b) => a - b)
    const after = edges.map((e) => applied.get(e.id)!).sort((a, b) => a - b)
    expect(after).toEqual(before) // exact multiset preserved
  })

  it('is FK-safe: every new endpoint already existed as a dst_chunk of the SAME edge_type', () => {
    const causalDsts = new Set([20, 21, 22, 23, 24])
    const temporalDsts = new Set([50, 51, 52])
    const edges: EdgeEndpoint[] = [
      ...[20, 21, 22, 23, 24].map((d, i) => ({ id: i + 1, edgeType: 'causal', dstChunk: d })),
      ...[50, 51, 52].map((d, i) => ({ id: 100 + i, edgeType: 'temporal', dstChunk: d })),
    ]
    const plan = planEdgeScramble(edges, rng(3))
    const typeOfId = new Map(edges.map((e) => [e.id, e.edgeType]))
    for (const p of plan) {
      const valid = typeOfId.get(p.id) === 'causal' ? causalDsts : temporalDsts
      expect(valid.has(p.newDstChunk)).toBe(true) // never crosses edge_type, always a real chunk id
    }
  })

  it('permutes within a type only — a temporal endpoint never lands on a causal edge and vice-versa', () => {
    const edges: EdgeEndpoint[] = [
      { id: 1, edgeType: 'causal', dstChunk: 200 },
      { id: 2, edgeType: 'causal', dstChunk: 201 },
      { id: 3, edgeType: 'causal', dstChunk: 202 },
      { id: 4, edgeType: 'temporal', dstChunk: 900 },
      { id: 5, edgeType: 'temporal', dstChunk: 901 },
      { id: 6, edgeType: 'temporal', dstChunk: 902 },
    ]
    const plan = planEdgeScramble(edges, rng(99))
    for (const p of plan) {
      if (p.id <= 3) expect(p.newDstChunk).toBeGreaterThanOrEqual(200) // causal stays in [200,202]
      if (p.id <= 3) expect(p.newDstChunk).toBeLessThanOrEqual(202)
      if (p.id >= 4) expect(p.newDstChunk).toBeGreaterThanOrEqual(900) // temporal stays in [900,902]
    }
  })

  it('actually destroys topology: a distinct-valued graph gets a non-empty change plan', () => {
    const edges = Array.from({ length: 40 }, (_, i) => causal(i + 1, 1000 + i))
    const plan = planEdgeScramble(edges, rng(42))
    expect(plan.length).toBeGreaterThan(20) // the majority of endpoints are re-paired
    for (const p of plan) {
      const original = edges.find((e) => e.id === p.id)!.dstChunk
      expect(p.newDstChunk).not.toBe(original) // every RETURNED entry is a real change
    }
  })

  it('is deterministic in the rng (same seed ⇒ identical plan)', () => {
    const edges = Array.from({ length: 30 }, (_, i) => causal(i + 1, 500 + (i % 7)))
    expect(planEdgeScramble(edges, rng(5))).toEqual(planEdgeScramble(edges, rng(5)))
  })

  it('cannot change a type with a single edge or all-identical endpoints (no false degradation)', () => {
    const single: EdgeEndpoint[] = [{ id: 1, edgeType: 'causal', dstChunk: 7 }]
    expect(planEdgeScramble(single, rng(1))).toEqual([])
    const uniform = [1, 2, 3, 4].map((id) => causal(id, 42)) // all point at chunk 42
    expect(planEdgeScramble(uniform, rng(1))).toEqual([]) // multiset {42,42,42,42} — any permutation is a no-op
  })

  it('ignores rows without a dst_chunk endpoint (entity edges carry dst_entity, not dst_chunk)', () => {
    const edges: EdgeEndpoint[] = [
      { id: 1, edgeType: 'causal', dstChunk: 10 },
      { id: 2, edgeType: 'causal', dstChunk: 11 },
    ]
    const plan = planEdgeScramble(edges, rng(2))
    // only the two causal rows are eligible; plan ⊆ {1,2}
    for (const p of plan) expect([1, 2]).toContain(p.id)
  })
})

// T028 wiring — the density-floor STOP is not just a pure function; it must be REACHABLE in the harness's
// load-bearing comparative path (arm-frontier-accuracy) and the vacuous cert-ingest soft-gate deleted.
describe('T028 wiring — the substrate density-floor STOP is wired into the harness (structural)', () => {
  it('the harness computes the density floor and uses the STOP constant (not a bare materialized>0)', () => {
    expect(src).toContain('substrateDensityFloor')
    expect(src).toContain('SUBSTRATE_STOP_MESSAGE')
  })

  it('the judged comparative gate REFUSES the graph arms on a starved substrate (BLOCKED, not a null)', () => {
    expect(src).toMatch(/if \(!pre\.substrate\.preCheckOk\)/)
    expect(src).toMatch(/verdict: 'BLOCKED'/)
  })

  it('the vacuous cert-ingest soft-gate (preCheckOk = totalMaterialized > 0) is deleted', () => {
    expect(src).not.toContain('preCheckOk: manifest.totalMaterialized > 0')
  })

  it('the fable5-era causal cap-20 is un-capped (SCNS_M2_MAX_CANDIDATES default raised to 200)', () => {
    expect(src).toMatch(/SCNS_M2_MAX_CANDIDATES \?\? '200'/)
    expect(src).not.toMatch(/SCNS_M2_MAX_CANDIDATES \?\? '20'\)/)
  })
})
