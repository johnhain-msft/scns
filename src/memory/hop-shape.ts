/**
 * HOP-SHAPE CLASSIFIER — does this query need SINGLE-hop or MULTI-hop retrieval?
 *
 * Purpose frame (NORTH_STAR "Retrieval design intent", John, 2026-08-14): `magma` and
 * `multihop-iter` are PURPOSE-ROUTED tools, not rivals. `magma` serves single-hop retrieval (one
 * thing to look up, then Stage-4 synthesis); `multihop-iter` serves queries whose answer needs
 * several things chained (entity → relation → entity, cause → effect, state-then vs state-now).
 * The router's job is to tell the two shapes apart. This module is that decision — heuristic first,
 * OFFLINE/shadow first, learned later.
 *
 * PRIOR ART: Adaptive-RAG (Jeong et al., NAACL 2024, arXiv:2403.14403) routes each query by a
 * predicted complexity class {no-retrieval, single-step, multi-step} and — the part adapted here —
 * derives its training labels from OUTCOMES (which strategy actually answered correctly), not from
 * hand annotation. SCNS's analogue of "answered correctly" is the human accept/waste label, and its
 * analogue of the learned T5 classifier is, for now, this deterministic structural scorer. What is
 * borrowed is the idea (route by complexity; ground truth from outcomes); nothing of the codebase.
 *
 * WHAT IT DOES NOT DO: it does not read GATE / the Phase-13 intent interpreter (parked, SC-021 unmet)
 * and must not be coupled to it — hop-shape is a narrower question than intent. It does not touch
 * arm selection: in Step 2 the live path stays on balanced random assignment (`SCNS_EXPLORE_EPSILON`)
 * so that this classifier's agreement with outcomes can be MEASURED before anything routes on it.
 *
 * AMBIGUOUS IS A CLASS. When the structural evidence is absent or balanced the classifier says so
 * (`ambiguous`, with typed reasons) rather than flipping a coin — a coin flip would silently poison
 * the very agreement measurement that gates the live cutover.
 */
import { extractHopShapeSignals, type HopShapeSignals } from './hop-shape-signals.js'

/** Bump on ANY change to weights, margin, or a signal pattern — reports name the version they measured. */
export const HOP_SHAPE_CLASSIFIER_VERSION = 'heuristic-v1'

export const HOP_SHAPES = ['single-hop', 'multi-hop', 'ambiguous'] as const
export type HopShape = (typeof HOP_SHAPES)[number]

/**
 * The two purpose-routed retrieval tools. These are the SAME strings the live path records in
 * `retrieval_experience.explore_arm` (`magma`, `multihop-iter`) — stored rows are history and are
 * never rewritten, so the tool names ARE the arm names. Only the vocabulary around them changes:
 * "incumbent"/"challenger" are drift-era words with no meaning under purpose routing.
 */
export const RETRIEVAL_TOOLS = ['magma', 'multihop-iter'] as const
export type RetrievalTool = (typeof RETRIEVAL_TOOLS)[number]

/** Design intent, as a table: which tool each unambiguous shape calls for. */
export const TOOL_FOR_HOP_SHAPE: Readonly<Record<Exclude<HopShape, 'ambiguous'>, RetrievalTool>> = {
  'single-hop': 'magma',
  'multi-hop': 'multihop-iter',
}

/** The tool a shape calls for; `null` for `ambiguous` (no recommendation, by design). */
export function toolForHopShape(shape: HopShape): RetrievalTool | null {
  return shape === 'ambiguous' ? null : TOOL_FOR_HOP_SHAPE[shape]
}

/** Typed evidence. Multi-hop reasons argue for chaining; single-hop reasons argue for one lookup. */
export type HopShapeReason =
  // ── evidence FOR multi-hop ──
  | 'multi-entity-relation' // ≥ 2 distinct referents joined by a relation word (between/against/fit into…)
  | 'causal-chain' // asks why / root cause / how could / what went wrong
  | 'comparison' // vs / compare / difference between / instead of
  | 'temporal-chain' // since / where we left off / what changed / ≥ 2 dates
  | 'aggregation' // overall / summarize / where are we / progress
  | 'reference-following' // anaphora that must be resolved against a second referent
  | 'multi-question' // ≥ 2 questions in one prompt
  | 'sequence-chain' // then / after that / so that they can
  | 'multi-referent' // ≥ 3 distinct referents even without an explicit relation word
  // ── evidence FOR single-hop ──
  | 'short-directive' // ≤ 4 words opening with an imperative verb
  | 'file-directive' // "read <one path> and …" — exactly one referent, a path
  | 'single-referent' // exactly one explicit referent
  | 'yes-no-status' // opens with is/are/did/… and asks one question
  | 'plain-request' // no multi-hop structure at all, ≤ 30 words
  // ── ambiguity ──
  | 'no-signal' // nothing structural to read (empty, an acknowledgement, …)
  | 'conflicting-signals' // both sides scored, inside the margin
  | 'weak-signal' // the only evidence is a lone weak multi-hop cue (e.g. one "then") — not enough to call chaining

interface WeightedReason {
  readonly reason: HopShapeReason
  readonly weight: number
  readonly side: 'multi' | 'single'
}

/** Weights are the tuning surface. Changing one bumps {@link HOP_SHAPE_CLASSIFIER_VERSION}. */
export const HOP_SHAPE_WEIGHTS: Readonly<
  Record<Exclude<HopShapeReason, 'no-signal' | 'conflicting-signals' | 'weak-signal'>, number>
> = {
  'multi-entity-relation': 2,
  'causal-chain': 2,
  comparison: 2,
  'temporal-chain': 1.5,
  aggregation: 1.5,
  'reference-following': 1.5,
  'multi-question': 1,
  'sequence-chain': 1,
  'multi-referent': 1,
  'short-directive': 2,
  'file-directive': 2,
  'single-referent': 1.5,
  'yes-no-status': 1.5,
  'plain-request': 1,
}

/** One side must lead by at least this much, or the query is `ambiguous`. */
export const HOP_SHAPE_MARGIN = 1
/**
 * Multi-hop needs at least this much POSITIVE evidence (one strong cue, or two weak ones). The
 * asymmetry is deliberate and is the Adaptive-RAG prior adapted: the simplest strategy is the
 * default, and chaining must be argued for — a lone "then" or a second question mark is not an
 * argument, so it yields `ambiguous`/`weak-signal` rather than a multi-hop call.
 */
export const HOP_SHAPE_MULTI_MIN_EVIDENCE = 1.5

/** Longest prompt (in words) that counts as a "plain request" when it shows no multi-hop structure. */
const PLAIN_REQUEST_MAX_WORDS = 30
const SHORT_DIRECTIVE_MAX_WORDS = 4

export interface HopShapeClassification {
  readonly shape: HopShape
  /** Strongest first; never duplicated. `ambiguous` always ends in `no-signal`, `conflicting-signals` or `weak-signal`. */
  readonly reasons: readonly HopShapeReason[]
  /** The tool the shape calls for; `null` when ambiguous. */
  readonly recommendedTool: RetrievalTool | null
  readonly scores: { readonly single: number; readonly multi: number }
  readonly version: string
}

/** Every reason the signals support, each side, unordered. */
function collectEvidence(s: HopShapeSignals): WeightedReason[] {
  const hits: WeightedReason[] = []
  const add = (reason: keyof typeof HOP_SHAPE_WEIGHTS, side: WeightedReason['side']): void => {
    hits.push({ reason, side, weight: HOP_SHAPE_WEIGHTS[reason] })
  }
  // Entities = explicit referents (paths, PR numbers, ids) + nominal work nouns ("the fix", "the
  // tasks"). A relation word only means chaining when there are two things to chain.
  const entities = s.referents + s.workNouns

  // ── multi-hop evidence ──
  if (entities >= 2 && s.relation) add('multi-entity-relation', 'multi')
  if (s.causal) add('causal-chain', 'multi')
  if (s.comparison) add('comparison', 'multi')
  if (s.temporal || s.temporalReferents >= 2) add('temporal-chain', 'multi')
  if (s.aggregation) add('aggregation', 'multi')
  if ((s.anaphora >= 1 && entities >= 2) || s.anaphora >= 2) add('reference-following', 'multi')
  if (s.questionMarks >= 2) add('multi-question', 'multi')
  if (s.sequence) add('sequence-chain', 'multi')
  if (s.referents >= 3 && !s.relation) add('multi-referent', 'multi')

  // ── single-hop evidence ──
  if (s.wordCount > 0 && s.wordCount <= SHORT_DIRECTIVE_MAX_WORDS && s.imperativeOpener) {
    add('short-directive', 'single')
  }
  if (s.fileDirective) add('file-directive', 'single')
  if (s.referents === 1) add('single-referent', 'single')
  if (s.yesNoOpener) add('yes-no-status', 'single')
  // Only when NOTHING else fired on either side: a plain request with no chaining structure.
  if (hits.length === 0 && s.wordCount > 0 && s.wordCount <= PLAIN_REQUEST_MAX_WORDS) {
    if (s.imperativeOpener || s.yesNoOpener || s.wordCount >= 5) add('plain-request', 'single')
  }
  return hits
}

/** Strongest first, then by name — a plain code-point compare, so the order is locale-independent. */
function orderReasons(hits: readonly WeightedReason[]): HopShapeReason[] {
  return [...hits]
    .sort((a, b) => b.weight - a.weight || (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0))
    .map((h) => h.reason)
}

function decide(hits: readonly WeightedReason[]): HopShapeClassification {
  const multi = hits.filter((h) => h.side === 'multi').reduce((a, h) => a + h.weight, 0)
  const single = hits.filter((h) => h.side === 'single').reduce((a, h) => a + h.weight, 0)
  const scores = { single, multi }
  const ordered = orderReasons(hits)
  const result = (shape: HopShape, reasons: readonly HopShapeReason[]): HopShapeClassification => ({
    shape,
    reasons,
    recommendedTool: toolForHopShape(shape),
    scores,
    version: HOP_SHAPE_CLASSIFIER_VERSION,
  })
  if (multi === 0 && single === 0) return result('ambiguous', ['no-signal'])
  if (multi - single >= HOP_SHAPE_MARGIN) {
    return multi < HOP_SHAPE_MULTI_MIN_EVIDENCE
      ? result('ambiguous', [...ordered, 'weak-signal'])
      : result('multi-hop', ordered)
  }
  if (single - multi >= HOP_SHAPE_MARGIN) return result('single-hop', ordered)
  return result('ambiguous', [...ordered, 'conflicting-signals'])
}

/**
 * Classify one query. Pure, deterministic, never throws (a classifier that can break a briefing is
 * not shadow-safe). Whitespace-insensitive; case-insensitive for every cue word — identifier and
 * spec-id referents (`FR-034`, `minN`, `NORTH_STAR`) are case-SENSITIVE on purpose, since case is
 * what marks them as identifiers.
 */
export function classifyHopShape(query: string): HopShapeClassification {
  return decide(collectEvidence(extractHopShapeSignals(typeof query === 'string' ? query : '')))
}
