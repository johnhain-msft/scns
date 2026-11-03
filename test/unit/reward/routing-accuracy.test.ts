/**
 * Step 2 (D1) — ROUTING ACCURACY: were queries sent to the tool their hop-shape required?
 *
 * Replaces the promote/retire verdict. Ground truth is OUTCOME-BASED under query-independent
 * assignment: within each predicted hop-shape, the tool the shape calls for should accept at a higher
 * rate than the other tool. Agreement = 0.5 + half the settled-row-weighted average of that
 * within-shape advantage — STRATIFIED and BALANCED, so an uninformative classifier scores exactly 0.5
 * under ANY assignment ratio and ANY per-shape base accept rate (the naive pooled
 * `(served == recommended) == accepted` does not have that property; the independent review of this
 * PR showed it reading 0.65 for an uninformative classifier under an 80/20 split).
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  computeRoutingAccuracy,
  wilsonInterval,
  loadRoutingRows,
  ACCEPT_THRESHOLD,
  CHANCE_AGREEMENT,
  CUTOVER_MIN_CLASSIFIED,
  CUTOVER_AGREEMENT_LOWER_BOUND,
  CELL_MIN_N,
  type RoutingRow,
} from '../../../src/reward/routing-accuracy.js'
import { HOP_SHAPE_CLASSIFIER_VERSION } from '../../../src/memory/hop-shape.js'
import {
  openExperienceStore,
  logRetrievalExperience,
  settleHumanOutcome,
} from '../../../src/memory/experience-store.js'

const SINGLE = 'continue' // classifies single-hop → magma
const MULTI = 'why is the brains consolidate branch the reason for the starvation?' // multi-hop → multihop-iter
const AMBIG = 'ok' // ambiguous → no recommendation
const LIVE = ['magma', 'multihop-iter'] as const

let nextId = 1
function row(
  tool: string,
  queryText: string,
  humanOutcome: number | null,
  propensity: number | null = 0.5,
): RoutingRow {
  return { id: nextId++, tool, queryText, humanOutcome, propensity }
}

describe('wilsonInterval — the confidence bound behind every "under-powered" statement', () => {
  it('returns null for n=0 (never a fabricated interval)', () => {
    expect(wilsonInterval(0, 0)).toBeNull()
  })
  it('is symmetric around 0.5 for k=n/2 and narrows with n', () => {
    const a = wilsonInterval(5, 10)!
    const b = wilsonInterval(50, 100)!
    expect(a.lower).toBeCloseTo(1 - a.upper, 6)
    expect(b.upper - b.lower).toBeLessThan(a.upper - a.lower)
  })
  it('never leaves [0,1]', () => {
    for (const [k, n] of [
      [0, 1],
      [1, 1],
      [0, 3],
      [3, 3],
      [7, 8],
    ]) {
      const w = wilsonInterval(k!, n!)!
      expect(w.lower).toBeGreaterThanOrEqual(0)
      expect(w.upper).toBeLessThanOrEqual(1)
    }
  })
})

describe('computeRoutingAccuracy — per-tool accept/waste under random assignment', () => {
  it('tallies served, settled, accepted, wasted, accept rate and mean outcome per live tool', () => {
    const rows = [
      row('magma', SINGLE, 1.0),
      row('magma', SINGLE, 0.2),
      row('magma', SINGLE, null),
      row('multihop-iter', MULTI, 0.8),
      row('multihop-iter', MULTI, null),
      row('multihop-iter', MULTI, null),
    ]
    const r = computeRoutingAccuracy(rows, { tools: LIVE })
    const magma = r.byTool.find((t) => t.tool === 'magma')!
    expect(magma).toMatchObject({ served: 3, settled: 2, accepted: 1, wasted: 1 })
    expect(magma.acceptRate).toBeCloseTo(0.5)
    expect(magma.meanOutcome).toBeCloseTo(0.6)
    const mh = r.byTool.find((t) => t.tool === 'multihop-iter')!
    expect(mh).toMatchObject({ served: 3, settled: 1, accepted: 1, wasted: 0 })
    expect(mh.acceptRate).toBeCloseTo(1)
  })

  it('a live tool with NO rows is still reported, at zero, with null rates (never a fabricated 0.00)', () => {
    const r = computeRoutingAccuracy([row('magma', SINGLE, 1.0)], { tools: LIVE })
    const mh = r.byTool.find((t) => t.tool === 'multihop-iter')!
    expect(mh).toMatchObject({
      served: 0,
      settled: 0,
      accepted: 0,
      wasted: 0,
      acceptRate: null,
      meanOutcome: null,
    })
  })

  it('accept means outcome ABOVE the threshold; 0.6 (partially used) is an accept, 0.4 (ignored) is not', () => {
    expect(ACCEPT_THRESHOLD).toBe(0.5)
    const r = computeRoutingAccuracy(
      [row('magma', SINGLE, 0.6), row('magma', SINGLE, 0.4), row('magma', SINGLE, 0.5)],
      { tools: LIVE },
    )
    const magma = r.byTool.find((t) => t.tool === 'magma')!
    expect(magma.accepted).toBe(1)
    expect(magma.wasted).toBe(2)
  })

  it('a RETIRED tool (rows exist, not in the live roster) is tallied but excluded from shapes and agreement', () => {
    const rows = [
      row('hybrid', SINGLE, null),
      row('hybrid', MULTI, null),
      row('magma', SINGLE, 1.0),
    ]
    const r = computeRoutingAccuracy(rows, { tools: LIVE })
    const hybrid = r.byTool.find((t) => t.tool === 'hybrid')!
    expect(hybrid).toMatchObject({ served: 2, settled: 0, live: false })
    for (const cell of r.byShape) {
      expect(cell.byTool.has('hybrid')).toBe(false)
    }
    // the one settled single-hop row has no multihop-iter counterpart in its shape ⇒ not comparable
    expect(r.agreement.n).toBe(0)
    expect(r.agreement.nNotComparable).toBe(1)
  })
})

describe('computeRoutingAccuracy — per hop-shape, the tool the shape calls for vs the other tool', () => {
  it('slices settled rows by predicted shape and names the recommended tool per shape', () => {
    const rows = [
      row('magma', SINGLE, 1.0),
      row('magma', SINGLE, 1.0),
      row('multihop-iter', SINGLE, 0.2),
      row('multihop-iter', MULTI, 1.0),
      row('magma', MULTI, 0.2),
      row('magma', AMBIG, 1.0),
    ]
    const r = computeRoutingAccuracy(rows, { tools: LIVE })
    const single = r.byShape.find((c) => c.shape === 'single-hop')!
    expect(single.recommendedTool).toBe('magma')
    expect(single.settled).toBe(3)
    expect(single.byTool.get('magma')).toMatchObject({ settled: 2, accepted: 2 })
    expect(single.byTool.get('multihop-iter')).toMatchObject({ settled: 1, accepted: 0 })
    expect(single.directional).toBe('agrees')

    const multi = r.byShape.find((c) => c.shape === 'multi-hop')!
    expect(multi.recommendedTool).toBe('multihop-iter')
    expect(multi.directional).toBe('agrees')

    const amb = r.byShape.find((c) => c.shape === 'ambiguous')!
    expect(amb.recommendedTool).toBeNull()
    expect(amb.directional).toBe('not-applicable')
    expect(amb.settled).toBe(1)
  })

  it('directional is "disagrees" when the OTHER tool did better in a shape, and "insufficient" when a tool has no rows', () => {
    const rows = [row('magma', SINGLE, 0.2), row('multihop-iter', SINGLE, 1.0)]
    const r = computeRoutingAccuracy(rows, { tools: LIVE })
    expect(r.byShape.find((c) => c.shape === 'single-hop')!.directional).toBe('disagrees')
    const r2 = computeRoutingAccuracy([row('magma', SINGLE, 1.0)], { tools: LIVE })
    expect(r2.byShape.find((c) => c.shape === 'single-hop')!.directional).toBe('insufficient')
  })

  it('flags a shape as under-powered when either tool has fewer than CELL_MIN_N settled rows', () => {
    const rows: RoutingRow[] = []
    for (let i = 0; i < CELL_MIN_N; i++) rows.push(row('magma', SINGLE, 1.0))
    for (let i = 0; i < CELL_MIN_N - 1; i++) rows.push(row('multihop-iter', SINGLE, 0.2))
    const r = computeRoutingAccuracy(rows, { tools: LIVE })
    expect(r.byShape.find((c) => c.shape === 'single-hop')!.underPowered).toBe(true)
    rows.push(row('multihop-iter', SINGLE, 0.2))
    const r2 = computeRoutingAccuracy(rows, { tools: LIVE })
    expect(r2.byShape.find((c) => c.shape === 'single-hop')!.underPowered).toBe(false)
  })

  it('reports how the UNSETTLED served rows classify too (the shape distribution the router would see)', () => {
    const rows = [
      row('magma', SINGLE, null),
      row('magma', MULTI, null),
      row('magma', AMBIG, null),
      row('magma', SINGLE, 1.0),
    ]
    const r = computeRoutingAccuracy(rows, { tools: LIVE })
    expect(r.byShape.find((c) => c.shape === 'single-hop')!.served).toBe(2)
    expect(r.byShape.find((c) => c.shape === 'multi-hop')!.served).toBe(1)
    expect(r.byShape.find((c) => c.shape === 'ambiguous')!.served).toBe(1)
  })
})

describe('computeRoutingAccuracy — classifier-vs-outcome AGREEMENT (stratified, balanced)', () => {
  it('is 0.50 + half the average within-shape advantage of the recommended tool, over comparable shapes', () => {
    const rows = [
      row('magma', SINGLE, 1.0), // rec, accepted
      row('multihop-iter', SINGLE, 0.2), // not rec, wasted
      row('magma', SINGLE, 0.2), // rec, wasted
      row('multihop-iter', SINGLE, 1.0), // not rec, accepted
      row('multihop-iter', MULTI, 1.0), // rec, accepted — but no magma row in multi-hop ⇒ not comparable
      row('magma', AMBIG, 1.0), // ambiguous ⇒ excluded from agreement
      row('magma', SINGLE, null), // unsettled ⇒ excluded
    ]
    const r = computeRoutingAccuracy(rows, { tools: LIVE })
    // single-hop: magma 0.5 (n=2) vs multihop-iter 0.5 (n=2) ⇒ advantage 0 ⇒ 0.5
    expect(r.agreement).toMatchObject({
      n: 4,
      nNotComparable: 1,
      agreeAccept: 2,
      agreeWaste: 1,
      disagreeAccept: 1,
      disagreeWaste: 1,
    })
    expect(r.agreement.rate).toBeCloseTo(0.5, 6)
    expect(r.agreement.chance).toBe(CHANCE_AGREEMENT)
    expect(CHANCE_AGREEMENT).toBe(0.5)
    expect(r.agreement.lower95).not.toBeNull()
    expect(r.agreement.lower95!).toBeLessThan(0.5)
    expect(r.agreement.upper95!).toBeGreaterThan(0.5)
  })

  it('an EMPTY comparable sample yields null rate and bounds, n=0 — never 0.00 as fact', () => {
    const r = computeRoutingAccuracy([row('magma', AMBIG, 1.0)], { tools: LIVE })
    expect(r.agreement).toMatchObject({ n: 0, rate: null, lower95: null, upper95: null })
  })

  it('CHANCE LEVEL under BALANCED assignment: identical accept rates on both tools ⇒ exactly 0.50', () => {
    const rows: RoutingRow[] = []
    for (let i = 0; i < 100; i++) {
      rows.push(row('magma', SINGLE, i % 5 === 0 ? 0.2 : 1.0))
      rows.push(row('multihop-iter', SINGLE, i % 5 === 0 ? 0.2 : 1.0))
    }
    expect(computeRoutingAccuracy(rows, { tools: LIVE }).agreement.rate).toBeCloseTo(0.5, 6)
  })

  it('CHANCE LEVEL under UNBALANCED assignment (80/20) with identical accept rates ⇒ still 0.50 (the naive pooled form would read 0.65)', () => {
    // The independent review's counterexample: both tools accept 0.75, magma served 4× as often.
    const rows: RoutingRow[] = []
    for (let i = 0; i < 160; i++) rows.push(row('magma', SINGLE, i % 4 === 0 ? 0.2 : 1.0))
    for (let i = 0; i < 40; i++) rows.push(row('multihop-iter', SINGLE, i % 4 === 0 ? 0.2 : 1.0))
    const r = computeRoutingAccuracy(rows, { tools: LIVE })
    expect(r.agreement.rate).toBeCloseTo(0.5, 6)
    // and the raw pooled 2×2 shows the confound the metric avoids: (120 + 10) / 200 = 0.65
    const pooled = (r.agreement.agreeAccept + r.agreement.agreeWaste) / r.agreement.n
    expect(pooled).toBeCloseTo(0.65, 6)
    expect(r.cutover.met).toBe(false)
  })

  it('CHANCE LEVEL when base accept rates DIFFER by shape and assignment is unbalanced ⇒ still 0.50', () => {
    // single-hop rows accept 0.9 on BOTH tools, multi-hop rows accept 0.3 on BOTH tools; magma 80%.
    const rows: RoutingRow[] = []
    for (let i = 0; i < 80; i++) rows.push(row('magma', SINGLE, i % 10 === 0 ? 0.2 : 1.0))
    for (let i = 0; i < 20; i++) rows.push(row('multihop-iter', SINGLE, i % 10 === 0 ? 0.2 : 1.0))
    for (let i = 0; i < 80; i++) rows.push(row('magma', MULTI, i % 10 < 3 ? 1.0 : 0.2))
    for (let i = 0; i < 20; i++) rows.push(row('multihop-iter', MULTI, i % 10 < 3 ? 1.0 : 0.2))
    expect(computeRoutingAccuracy(rows, { tools: LIVE }).agreement.rate).toBeCloseTo(0.5, 6)
  })

  it('POSITIVE CONTROL: an informative classifier scores above 0.50 even under unbalanced assignment', () => {
    // within single-hop, magma (the shape\'s tool) accepts 0.9 and multihop-iter 0.3; 80/20 served
    const rows: RoutingRow[] = []
    for (let i = 0; i < 80; i++) rows.push(row('magma', SINGLE, i % 10 === 0 ? 0.2 : 1.0))
    for (let i = 0; i < 20; i++) rows.push(row('multihop-iter', SINGLE, i % 10 < 3 ? 1.0 : 0.2))
    const r = computeRoutingAccuracy(rows, { tools: LIVE })
    expect(r.agreement.rate).toBeCloseTo(0.5 + 0.5 * (0.9 - 0.3), 6) // 0.80
    expect(r.agreement.lower95!).toBeGreaterThan(0.5)
  })

  it('NEGATIVE CONTROL: an ANTI-informative classifier scores below 0.50, with the whole interval below chance', () => {
    const rows: RoutingRow[] = []
    for (let i = 0; i < 60; i++) rows.push(row('magma', SINGLE, i % 10 === 0 ? 1.0 : 0.2)) // rec accepts 0.1
    for (let i = 0; i < 60; i++) rows.push(row('multihop-iter', SINGLE, i % 10 === 0 ? 0.2 : 1.0)) // other 0.9
    const r = computeRoutingAccuracy(rows, { tools: LIVE })
    expect(r.agreement.rate).toBeCloseTo(0.5 + 0.5 * (0.1 - 0.9), 6) // 0.10
    expect(r.agreement.upper95!).toBeLessThan(0.5)
  })

  it('reports the assignment mix of the settled sample: served per tool and logged propensity', () => {
    const rows = [
      row('magma', SINGLE, 1.0, 0.5),
      row('magma', SINGLE, 1.0, 0.9),
      row('magma', SINGLE, 0.2, 1),
      row('multihop-iter', SINGLE, 1.0, 0.5),
      row('multihop-iter', SINGLE, 1.0, null),
      row('magma', SINGLE, null, 0.5), // unsettled ⇒ not in the mix
      row('hybrid', SINGLE, 1.0, 0.5), // retired ⇒ not in the mix
    ]
    const r = computeRoutingAccuracy(rows, { tools: LIVE })
    expect([...r.assignment.servedByTool]).toEqual([
      ['magma', 3],
      ['multihop-iter', 2],
    ])
    expect(Object.fromEntries(r.assignment.byPropensity)).toEqual({
      '0.50': 2,
      '0.90': 1,
      '1.00': 1,
      null: 1,
    })
  })
})

describe('computeRoutingAccuracy — the CUTOVER PRE-FRAME (John decides; this only names the bar)', () => {
  /** n single-hop rows, `share` of them on magma; magma accepts `pRec`, multihop-iter accepts `pOther`. */
  function informative(n: number, share: number, pRec: number, pOther: number): RoutingRow[] {
    const rows: RoutingRow[] = []
    const nRec = Math.round(n * share)
    for (let i = 0; i < nRec; i++) rows.push(row('magma', SINGLE, i / nRec < pRec ? 1.0 : 0.2))
    for (let i = 0; i < n - nRec; i++)
      rows.push(row('multihop-iter', SINGLE, i / (n - nRec) < pOther ? 1.0 : 0.2))
    return rows
  }

  it('names the metric and thresholds and evaluates them against the current sample', () => {
    const r = computeRoutingAccuracy([row('magma', SINGLE, 1.0)], { tools: LIVE })
    expect(r.cutover.metric).toMatch(/agreement/i)
    expect(r.cutover.minClassified).toBe(CUTOVER_MIN_CLASSIFIED)
    expect(r.cutover.lowerBoundThreshold).toBe(CUTOVER_AGREEMENT_LOWER_BOUND)
    expect(CUTOVER_MIN_CLASSIFIED).toBe(100)
    expect(CUTOVER_AGREEMENT_LOWER_BOUND).toBe(0.55)
    expect(r.cutover.nClassified).toBe(0) // one tool only ⇒ nothing comparable yet
    expect(r.cutover.met).toBe(false)
  })

  it('is met only when BOTH n ≥ minClassified AND the 95% lower bound clears the threshold', () => {
    // 120 comparable rows, strongly informative (0.9 vs 0.3) under a 70/30 split ⇒ met
    const met = computeRoutingAccuracy(informative(120, 0.7, 0.9, 0.3), { tools: LIVE })
    expect(met.agreement.rate).toBeCloseTo(0.8, 1)
    expect(met.cutover.met).toBe(true)
    // 120 rows, weakly informative (0.8 vs 0.7 ⇒ 0.55 point estimate) ⇒ lower bound < 0.55 ⇒ not met
    const weak = computeRoutingAccuracy(informative(120, 0.5, 0.8, 0.7), { tools: LIVE })
    expect(weak.agreement.rate).toBeCloseTo(0.55, 6)
    expect(weak.cutover.met).toBe(false)
    // 60 rows, strongly informative ⇒ lower bound > 0.55 but n < 100 ⇒ not met
    const small = computeRoutingAccuracy(informative(60, 0.5, 0.95, 0.15), { tools: LIVE })
    expect(small.agreement.lower95!).toBeGreaterThan(0.55)
    expect(small.cutover.met).toBe(false)
  })

  it('carries the classifier version so a future revision cannot silently inherit an old measurement', () => {
    expect(computeRoutingAccuracy([], { tools: LIVE }).classifierVersion).toBe(
      HOP_SHAPE_CLASSIFIER_VERSION,
    )
  })
})

describe('loadRoutingRows — reads the arm sample from a store, read-only', () => {
  it('projects explore_arm / human_outcome / query_text / propensity for served human rows only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scns-routing-'))
    try {
      const store = openExperienceStore(join(dir, 'experience.db'))
      const a = logRetrievalExperience(store, {
        queryText: SINGLE,
        levers: { traverse: true, synthesize: true, exploreArm: 'magma', propensity: 0.5 },
        retrievedChunkIds: [],
      })
      logRetrievalExperience(store, {
        queryText: MULTI,
        levers: { multiHop: true, synthesize: true, exploreArm: 'multihop-iter', propensity: 0.5 },
        retrievedChunkIds: [],
      })
      // unassigned (no explore_arm) ⇒ NOT part of the arm sample
      logRetrievalExperience(store, {
        queryText: 'unassigned',
        levers: { traverse: true },
        retrievedChunkIds: [],
      })
      settleHumanOutcome(store, a, 1.0, 'test')
      const rows = loadRoutingRows(store)
      expect(rows).toHaveLength(2)
      expect(rows[0]).toMatchObject({
        tool: 'magma',
        humanOutcome: 1.0,
        queryText: SINGLE,
        propensity: 0.5,
      })
      expect(rows[1]).toMatchObject({ tool: 'multihop-iter', humanOutcome: null })
      store.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
