/**
 * ROUTING ACCURACY — did the router send each query to the tool its hop-shape required?
 *
 * The purpose frame (NORTH_STAR "Retrieval design intent", 2026-08-14) retires the promote/retire
 * verdict: `magma` and `multihop-iter` are purpose-routed tools, not rivals, so the weekly question
 * is no longer "which arm wins" but "was the query sent to the right tool?". This module computes
 * that answer from the SAME evidence base as before — the settled accept/waste rows in
 * `retrieval_experience`, keyed on `explore_arm` — with no schema change and no live-path change.
 *
 * ## Ground truth: outcome-based, per class, under query-independent assignment (decided)
 *
 * Two ways to establish "the right tool" were weighed:
 *   (a) STRUCTURAL ANNOTATION — a human labels a sample of queries with their true hop-shape and the
 *       classifier is scored as precision/recall against that.
 *   (b) OUTCOME-BASED — the ε-exploration policy assigns the tool independently of the query, so
 *       within each predicted shape both tools were served the SAME query distribution; if the
 *       classifier is right, the tool the shape calls for accepts at a higher rate within that
 *       stratum.
 * (b) is chosen. It measures the north-star quantity (accept-vs-waste on real usage) rather than a
 * human's opinion of query structure, it needs ZERO new labels (labels are the scarcest resource —
 * 74 of 2,623 rows), and it is exactly how Adaptive-RAG (arXiv:2403.14403) derives its own routing
 * labels: from which strategy actually succeeded, not from annotation. (a) survives only as the unit
 * tests' hand-picked positive/negative controls.
 *
 * ## The agreement metric — STRATIFIED and BALANCED, so its chance level is 0.5 unconditionally
 * For each non-ambiguous shape s with both tools present:
 *     advantage(s) = acceptRate(shape's tool | s) − acceptRate(other tool | s)
 *     agreement(s) = 0.5 + 0.5 · advantage(s)
 * and overall agreement = Σ_s w_s · agreement(s), w_s = settled rows in s / total. If the classifier
 * carries no routing information, the two tools accept at the same rate within every shape, so every
 * agreement(s) is 0.5 and the total is 0.5 — under ANY assignment ratio (the live sample is not 50/50:
 * ε=0.1-era rows and bound-hit rows are in it) and ANY per-shape base accept rate. The naive pooled
 * form `(served == recommended) == accepted` does NOT have that property (its chance level moves with
 * the magma:multihop share and with the single:multi share) and is therefore not the metric; its raw
 * 2×2 counts are still reported because they are legible. The interval is an approximate 95%
 * interval: Wilson half-widths per cell, propagated through the weighted difference.
 *
 * ## Caveats carried, not hidden
 * - Assignment is query-independent but not uniform over time: `propensity` records the logging
 *   policy per row (0.5 balanced era, 0.9/0.1 the ε=0.1 era, 1.0 when an exploration bound forced
 *   the default). The mix is reported. Stratification handles the ratio; a propensity-weighted variant
 *   is a documented follow-up if the eras' query mixes are suspected to differ.
 * - Retired tools (`hybrid`) are tallied for the served/settled funnel and excluded from every
 *   comparison — they are unmeasurable (NULL conversation_id) and cannot be served.
 */
import { ARM_SAMPLE_SERVED_WHERE, type ExperienceStore } from '../memory/experience-store.js'
import {
  classifyHopShape,
  HOP_SHAPES,
  HOP_SHAPE_CLASSIFIER_VERSION,
  toolForHopShape,
  type HopShape,
  type RetrievalTool,
} from '../memory/hop-shape.js'

/** An outcome ABOVE this is an accept (0.6 partially-used and up); at or below is a waste (0.4 ignored, 0.2, 0.0). */
export const ACCEPT_THRESHOLD = 0.5
/** Agreement an uninformative classifier scores — unconditionally, by construction (see the header). */
export const CHANCE_AGREEMENT = 0.5
/** A per-shape, per-tool cell with fewer settled rows than this is worded "too few labels to separate the tools". */
export const CELL_MIN_N = 10
/**
 * CUTOVER PRE-FRAME (John's decision, not this module's): live classify-then-route becomes a
 * candidate once the classifier's agreement with outcomes is credibly above chance — the 95%
 * LOWER bound must clear {@link CUTOVER_AGREEMENT_LOWER_BOUND} on at least
 * {@link CUTOVER_MIN_CLASSIFIED} contributing settled rows. 0.55 rather than 0.50 so a bound that
 * merely grazes chance does not qualify; 100 rows so the bound means something at all.
 */
export const CUTOVER_MIN_CLASSIFIED = 100
export const CUTOVER_AGREEMENT_LOWER_BOUND = 0.55
const Z95 = 1.96

export interface RoutingRow {
  readonly id: number
  /** `explore_arm` as stored — the tool that was actually served. */
  readonly tool: string
  readonly humanOutcome: number | null
  readonly queryText: string
  /** P(served tool | logging policy) recorded at decision time; null on legacy rows. */
  readonly propensity: number | null
}

export interface ToolTally {
  readonly tool: string
  /** In the live roster (can still be served) or retired (sample frozen). */
  readonly live: boolean
  readonly served: number
  readonly settled: number
  readonly accepted: number
  readonly wasted: number
  /** accepted / settled; null when nothing settled (never a fabricated 0). */
  readonly acceptRate: number | null
  /** Mean of the settled outcome gradient; null when nothing settled. */
  readonly meanOutcome: number | null
}

export type Directional = 'agrees' | 'disagrees' | 'tie' | 'insufficient' | 'not-applicable'

export interface ShapeCell {
  readonly shape: HopShape
  readonly recommendedTool: RetrievalTool | null
  /** Live tools only. */
  readonly byTool: ReadonlyMap<string, ToolTally>
  readonly served: number
  readonly settled: number
  /** Did the tool the shape calls for accept at a higher rate than the other tool, within this shape? */
  readonly directional: Directional
  /** True when any live tool has fewer than {@link CELL_MIN_N} settled rows in this shape. */
  readonly underPowered: boolean
  /** acceptRate(shape's tool) − acceptRate(other tool); null when either side has no settled rows. */
  readonly advantage: number | null
}

export interface AgreementTally {
  /** Settled classified rows in shapes where BOTH tools have settled rows (the contributing rows). */
  readonly n: number
  /** Settled classified rows in shapes where one tool has no settled rows (cannot contribute). */
  readonly nNotComparable: number
  /** Raw 2×2 over all classified settled rows — legible, but NOT the metric (its chance level moves). */
  readonly agreeAccept: number
  readonly agreeWaste: number
  readonly disagreeAccept: number
  readonly disagreeWaste: number
  /** Stratified balanced agreement; null when no shape is comparable. */
  readonly rate: number | null
  readonly lower95: number | null
  readonly upper95: number | null
  readonly chance: typeof CHANCE_AGREEMENT
}

export interface AssignmentMix {
  /** Settled rows per live tool. */
  readonly servedByTool: ReadonlyMap<string, number>
  /** Settled rows per logged propensity (rounded to 2 dp; `null` = not recorded). */
  readonly byPropensity: ReadonlyMap<string, number>
}

export interface CutoverPreframe {
  readonly metric: string
  readonly minClassified: number
  readonly lowerBoundThreshold: number
  readonly nClassified: number
  readonly lowerBound: number | null
  readonly met: boolean
}

export interface RoutingAccuracyReport {
  readonly classifierVersion: string
  readonly tools: readonly string[]
  readonly byTool: readonly ToolTally[]
  readonly byShape: readonly ShapeCell[]
  readonly agreement: AgreementTally
  readonly assignment: AssignmentMix
  readonly cutover: CutoverPreframe
}

/** Wilson score interval for a binomial proportion; null when n = 0. */
export function wilsonInterval(
  k: number,
  n: number,
  z = Z95,
): { lower: number; upper: number } | null {
  if (n <= 0) return null
  const p = k / n
  const z2 = z * z
  const denom = 1 + z2 / n
  const centre = (p + z2 / (2 * n)) / denom
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom
  return { lower: Math.max(0, centre - half), upper: Math.min(1, centre + half) }
}

const isAccept = (outcome: number): boolean => outcome > ACCEPT_THRESHOLD
const settledOf = (rows: readonly RoutingRow[]): RoutingRow[] =>
  rows.filter((r) => r.humanOutcome !== null)

function tally(tool: string, live: boolean, rows: readonly RoutingRow[]): ToolTally {
  const settledRows = settledOf(rows)
  const accepted = settledRows.filter((r) => isAccept(r.humanOutcome!)).length
  const settled = settledRows.length
  return {
    tool,
    live,
    served: rows.length,
    settled,
    accepted,
    wasted: settled - accepted,
    acceptRate: settled > 0 ? accepted / settled : null,
    meanOutcome:
      settled > 0 ? settledRows.reduce((a, r) => a + r.humanOutcome!, 0) / settled : null,
  }
}

/** The best accept rate among the tools the shape does NOT call for; null if any of them has no rows. */
function otherRate(
  cell: ReadonlyMap<string, ToolTally>,
  recommended: RetrievalTool,
  liveTools: readonly string[],
): number | null {
  const others = liveTools
    .filter((t) => t !== recommended)
    .map((t) => cell.get(t)?.acceptRate ?? null)
  if (others.length === 0 || others.some((r) => r === null)) return null
  return Math.max(...(others as number[]))
}

function shapeCell(
  shape: HopShape,
  inShape: readonly RoutingRow[],
  liveTools: readonly string[],
): ShapeCell {
  const cell = new Map<string, ToolTally>()
  for (const t of liveTools) {
    cell.set(
      t,
      tally(
        t,
        true,
        inShape.filter((r) => r.tool === t),
      ),
    )
  }
  const recommended = toolForHopShape(shape)
  const rec = recommended === null ? null : (cell.get(recommended)?.acceptRate ?? null)
  const other = recommended === null ? null : otherRate(cell, recommended, liveTools)
  const advantage = rec === null || other === null ? null : rec - other
  const directional: Directional =
    recommended === null
      ? 'not-applicable'
      : advantage === null
        ? 'insufficient'
        : advantage > 0
          ? 'agrees'
          : advantage < 0
            ? 'disagrees'
            : 'tie'
  return {
    shape,
    recommendedTool: recommended,
    byTool: cell,
    served: inShape.length,
    settled: settledOf(inShape).length,
    directional,
    underPowered: [...cell.values()].some((t) => t.settled < CELL_MIN_N),
    advantage,
  }
}

/** Wilson half-width of a cell's accept rate (its ≈ 1.96·sd, non-degenerate at 0/1). */
function halfWidth(t: ToolTally | undefined): number {
  if (!t || t.settled === 0) return 0
  const w = wilsonInterval(t.accepted, t.settled)!
  return (w.upper - w.lower) / 2
}

/** Stratified balanced agreement over the comparable shapes (see the header). */
function agreementOf(
  cells: readonly ShapeCell[],
  classified: ReadonlyArray<{ row: RoutingRow; shape: HopShape }>,
  liveTools: readonly string[],
): AgreementTally {
  let agreeAccept = 0
  let agreeWaste = 0
  let disagreeAccept = 0
  let disagreeWaste = 0
  for (const { row, shape } of classified) {
    if (row.humanOutcome === null) continue
    const recommended = toolForHopShape(shape)
    if (recommended === null) continue
    const asRecommended = row.tool === recommended
    const accepted = isAccept(row.humanOutcome)
    if (asRecommended && accepted) agreeAccept++
    else if (!asRecommended && !accepted) agreeWaste++
    else if (!asRecommended && accepted) disagreeAccept++
    else disagreeWaste++
  }

  const comparable = cells.filter((c) => c.recommendedTool !== null && c.advantage !== null)
  const notComparable = cells.filter((c) => c.recommendedTool !== null && c.advantage === null)
  const n = comparable.reduce((a, c) => a + c.settled, 0)
  const nNotComparable = notComparable.reduce((a, c) => a + c.settled, 0)
  const base = { n, nNotComparable, agreeAccept, agreeWaste, disagreeAccept, disagreeWaste }
  if (n === 0)
    return { ...base, rate: null, lower95: null, upper95: null, chance: CHANCE_AGREEMENT }

  let rate = 0
  let variance = 0 // in units of (1.96·sd)² — i.e. squared half-widths
  for (const c of comparable) {
    const w = c.settled / n
    rate += w * (0.5 + 0.5 * c.advantage!)
    const recCell = c.byTool.get(c.recommendedTool!)
    const otherCells = liveTools.filter((t) => t !== c.recommendedTool).map((t) => c.byTool.get(t))
    const hRec = halfWidth(recCell)
    const hOther = Math.max(...otherCells.map((t) => halfWidth(t)))
    variance += w * w * 0.25 * (hRec * hRec + hOther * hOther)
  }
  const half = Math.sqrt(variance)
  return {
    ...base,
    rate,
    lower95: Math.max(0, rate - half),
    upper95: Math.min(1, rate + half),
    chance: CHANCE_AGREEMENT,
  }
}

function assignmentMix(
  settled: readonly RoutingRow[],
  liveTools: readonly string[],
): AssignmentMix {
  const servedByTool = new Map<string, number>()
  for (const t of liveTools) servedByTool.set(t, settled.filter((r) => r.tool === t).length)
  const byPropensity = new Map<string, number>()
  for (const r of settled) {
    const key = r.propensity === null ? 'null' : r.propensity.toFixed(2)
    byPropensity.set(key, (byPropensity.get(key) ?? 0) + 1)
  }
  return { servedByTool, byPropensity }
}

/** Compute the routing-accuracy report. Pure; classification happens here, at read time. */
export function computeRoutingAccuracy(
  rows: readonly RoutingRow[],
  opts: { readonly tools: readonly string[] },
): RoutingAccuracyReport {
  const liveTools = [...new Set(opts.tools)]
  const liveSet = new Set(liveTools)
  const seenTools = [...new Set([...liveTools, ...rows.map((r) => r.tool)])]
  const byTool = seenTools.map((t) =>
    tally(
      t,
      liveSet.has(t),
      rows.filter((r) => r.tool === t),
    ),
  )

  const liveRows = rows.filter((r) => liveSet.has(r.tool))
  const classified = liveRows.map((r) => ({ row: r, shape: classifyHopShape(r.queryText).shape }))
  const byShape = HOP_SHAPES.map((shape) =>
    shapeCell(
      shape,
      classified.filter((c) => c.shape === shape).map((c) => c.row),
      liveTools,
    ),
  )
  const agreement = agreementOf(byShape, classified, liveTools)
  const cutover: CutoverPreframe = {
    metric: 'stratified balanced classifier-vs-outcome agreement, approximate 95% lower bound',
    minClassified: CUTOVER_MIN_CLASSIFIED,
    lowerBoundThreshold: CUTOVER_AGREEMENT_LOWER_BOUND,
    nClassified: agreement.n,
    lowerBound: agreement.lower95,
    met:
      agreement.n >= CUTOVER_MIN_CLASSIFIED &&
      agreement.lower95 !== null &&
      agreement.lower95 > CUTOVER_AGREEMENT_LOWER_BOUND,
  }
  return {
    classifierVersion: HOP_SHAPE_CLASSIFIER_VERSION,
    tools: liveTools,
    byTool,
    byShape,
    agreement,
    assignment: assignmentMix(settledOf(liveRows), liveTools),
    cutover,
  }
}

/**
 * The arm sample as routing rows — served human-attributable rows keyed on `explore_arm`, settled or
 * not ({@link ARM_SAMPLE_SERVED_WHERE}: the same population every other arm count uses). SELECT-only;
 * the caller owns the handle and decides whether a throw is surfaced.
 */
export function loadRoutingRows(store: ExperienceStore): RoutingRow[] {
  const rows = store.db
    .prepare(
      `SELECT id, explore_arm AS tool, human_outcome AS humanOutcome, query_text AS queryText, propensity
         FROM retrieval_experience
        WHERE ${ARM_SAMPLE_SERVED_WHERE}
        ORDER BY id`,
    )
    .all() as Array<{
    id: number
    tool: string
    humanOutcome: number | null
    queryText: string | null
    propensity: number | null
  }>
  return rows.map((r) => ({
    id: r.id,
    tool: r.tool,
    humanOutcome: r.humanOutcome,
    queryText: r.queryText ?? '',
    propensity: r.propensity,
  }))
}
