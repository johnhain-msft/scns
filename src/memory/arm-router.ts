/**
 * C3 — deterministic query→arm ROUTER over the FAITHFUL retrieval arms (default-OFF policy).
 *
 * Prior-art assembly (PRIOR_ART.md §PHASE C — adopt the legos, build the integration):
 *   - Adaptive-RAG (Jeong et al., NAACL 2024, arXiv:2403.14403): a complexity classifier routes each
 *     query to no-/single-/multi-hop retrieval — recast here over SCNS's faithful arms
 *     {hybrid, magma (Alg-1 traverse + Stage-4), multihop-iter (C2 iterative)}.
 *   - SKR / PopQA (arXiv:2310.05002 / arXiv:2212.10511): a CHEAP when-not-to-retrieve front gate —
 *     {@link shouldSkipRetrieval} skips only clear no-memory-need turns (greetings/acks).
 *   - Hybrid-LLM / FrugalGPT (arXiv:2404.14618 / arXiv:2305.05176): one tunable cost knob — the same
 *     λ (accuracy-points per 1k context tokens) the offline gate sweeps; a token-averse λ pins the
 *     router back to the cheapest arm.
 *   - Table-5 (paper) grounding for the deep-arm choice: causal is the strongest single graph overall
 *     (0.590) and temporal the best on temporal questions (0.620) ⇒ WHY/WHEN route to the full faithful
 *     `magma` arm; comparison/multi-entity questions (the multi-hop shape) route to `multihop-iter`.
 *
 * EVIDENCE-GATED, NEVER SELF-FLIPPING (AGENTS.md #9): this module is a PURE decision function. It is
 * evaluated OFFLINE by the arm-frontier judged gate as a POLICY (per-item: the value of the arm it
 * picks, reusing the per-arm scored rows — zero extra spawns) against always-hybrid, via the same
 * HCOPE lower bound + paper-axis controls. Live routing stays exploit-only hybrid until John reviews a
 * certified win and flips the default himself.
 */
import type Database from 'better-sqlite3'
import { classifyIntent, type QueryIntent } from './intent.js'
import { SCNS_GAZETTEER, type GazetteerEntry } from './entities/gazetteer.js'
import { resolveQueryEntities } from './entities/learned-vocab.js'

/** The faithful arms (must mirror the harness FRONTIER_ARMS names). Index 0 = the incumbent. */
export const ROUTER_ARMS = ['hybrid', 'magma', 'multihop-iter'] as const
export type RouterArm = (typeof ROUTER_ARMS)[number]

/** λ the router assumes when the caller supplies none (accuracy-first, matches the gate's λ=0 column). */
export const DEFAULT_ROUTER_LAMBDA = 0
/** λ at/above which the deep arms are pinned back to hybrid (token-averse operating point). */
export const ROUTER_DEEP_LAMBDA_CUTOFF = 0.5

/** Whole-turn phrases that clearly need no memory retrieval (SKR-lite; conservative by design). */
const SKIP_PHRASES = new Set([
  'thanks',
  'thank you',
  'thx',
  'ok',
  'okay',
  'got it',
  'hello',
  'hi',
  'hey',
  'yes',
  'no',
  'yep',
  'nope',
  'sure',
  'cool',
  'great',
  'nice',
  'sounds good',
  'will do',
  'done',
  'bye',
  'goodbye',
])

/** Comparison / aggregation markers — the multi-hop question shape ("both/all/common/same …"). */
const COMPARISON_RE =
  /\b(both|all of|in common|same|compare[ds]?|comparison|either|which of|each of)\b/i

export interface QueryRouteFeatures {
  readonly intent: QueryIntent
  readonly wordCount: number
  readonly entityCount: number
  readonly comparison: boolean
}

export interface RouteDecision {
  /** True ⇒ the SKR-lite gate says this turn needs no retrieval at all. */
  readonly skipRetrieval: boolean
  /** The chosen arm (hybrid when skipping — the label is never a deep arm on a skipped turn). */
  readonly arm: RouterArm
  /** The features the decision was made on (trap-#1 attribution; logged with the episode). */
  readonly features: QueryRouteFeatures
  /** Human-readable one-liner for the audit trail. */
  readonly reason: string
}

/**
 * SKR-lite skip gate: TRUE only for a whole-turn greeting/acknowledgement (normalized to lowercase,
 * terminal punctuation stripped) — a query with a question mark, a content sentence, or anything not in
 * the small phrase set NEVER skips. Empty/whitespace returns false (nothing to answer — caller's call).
 */
export function shouldSkipRetrieval(query: string): boolean {
  const norm = query
    .toLowerCase()
    .replace(/[.!,;:]+$/g, '')
    .trim()
  if (norm === '' || norm.includes('?')) return false
  return SKIP_PHRASES.has(norm)
}

/**
 * Route one query to a faithful arm (pure, deterministic):
 *   skip-gate → hybrid(skip) ;
 *   λ ≥ {@link ROUTER_DEEP_LAMBDA_CUTOFF} → hybrid (token-averse pin) ;
 *   comparison markers OR ≥2 distinct entity anchors → multihop-iter ;
 *   WHY or WHEN intent → magma ;
 *   else → hybrid (the incumbent).
 *
 * NOTE (DP-F5, 2026-08-02): this function once accepted an `episodeAdvice` option — the "been-here-before"
 * CBR reuse/avoid hook (T049 [US4]). Its ONLY producer was `adviseFromEpisodes` in `similar-episode.ts`,
 * which had zero callers anywhere in `src/`, `test/` or `scripts/`, and whose `(intent, target)` lookup key
 * was unmatchable regardless: `target` is NULL on all 2060 live `retrieval_experience` rows. Both the
 * module and the option were deleted rather than narrowed (Constitution IV). If the hook is revived —
 * `docs/research/intent-prior-art.md` proposes feeding it from graph insight nodes — restore it from
 * git history AND give it a real producer plus a non-vacuous key in the same change.
 */
export function routeQueryArm(
  db: Database.Database,
  query: string,
  opts: {
    readonly gazetteer?: readonly GazetteerEntry[]
    readonly lambda?: number
  } = {},
): RouteDecision {
  const gazetteer = opts.gazetteer ?? SCNS_GAZETTEER
  const lambda = opts.lambda ?? DEFAULT_ROUTER_LAMBDA
  const intent = classifyIntent(query, gazetteer)
  const entities = resolveQueryEntities(db, query, gazetteer)
  const features: QueryRouteFeatures = {
    intent,
    wordCount: query.trim() === '' ? 0 : query.trim().split(/\s+/).length,
    entityCount: new Set(entities.map((e) => e.canonical)).size,
    comparison: COMPARISON_RE.test(query),
  }
  if (shouldSkipRetrieval(query)) {
    return {
      skipRetrieval: true,
      arm: 'hybrid',
      features,
      reason: 'skip-gate: whole-turn greeting/ack (no memory need)',
    }
  }
  if (lambda >= ROUTER_DEEP_LAMBDA_CUTOFF) {
    return {
      skipRetrieval: false,
      arm: 'hybrid',
      features,
      reason: `λ=${lambda} ≥ ${ROUTER_DEEP_LAMBDA_CUTOFF} (token-averse) pins the cheapest arm`,
    }
  }
  // T049 [US4] — the "been-here-before" reuse branch lived here; see the DP-F5 note on this function.
  if (features.comparison || features.entityCount >= 2) {
    return {
      skipRetrieval: false,
      arm: 'multihop-iter',
      features,
      reason: features.comparison
        ? 'comparison/aggregation markers ⇒ multi-hop question shape'
        : `${features.entityCount} distinct entity anchors ⇒ multi-hop question shape`,
    }
  }
  if (intent === 'WHY' || intent === 'WHEN') {
    return {
      skipRetrieval: false,
      arm: 'magma',
      features,
      reason: `${intent} intent ⇒ the graph's strong axis (Table 5: causal/temporal)`,
    }
  }
  return { skipRetrieval: false, arm: 'hybrid', features, reason: 'default ⇒ incumbent hybrid' }
}
