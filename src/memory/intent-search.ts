/**
 * M1.2 — intent-aware retrieval router (design-m1.md §5). Wraps the ONE `memorySearch` adapter so
 * all callers (CLI, dashboard `/api/memory/search`, ideation/D1 `/api/extension/context`) route
 * over the M1.1 entity/temporal substrate when enabled — MAGMA's #1 retrieval lever (Table 4).
 *
 * DEFAULT-OFF and fully fallback-guarded:
 *   - `enabled` falsy ⇒ returns `baseSearch(query, topK)` verbatim (byte-identical to today).
 *   - ENTITY ⇒ aggregate `entityNeighborhood` over all matched entities, NEWEST-first.
 *   - WHEN   ⇒ same aggregation, CHRONOLOGICAL (oldest-first) — a literal timeline.
 *   - WHY    ⇒ aggregate `causalNeighborhood` (cause→effect chains) over all matched entities,
 *             highest-confidence first; falls back to baseSearch when no causal edge is anchored
 *             on a named entity (never worse than today).
 *   - DEFAULT, or an ENTITY/WHEN/WHY query whose neighborhood is empty ⇒ baseSearch (today's behavior).
 *
 * Routed graph hits are mapped to `SearchResult` with a synthetic POSITIONAL score (top of the
 * returned ordering = 1.0, monotonically decreasing) and zero vector/keyword contribution — they
 * are structural neighborhood hits, not hybrid-ranked hits.
 */

import type Database from 'better-sqlite3'
import type { SearchResult } from './search.js'
import { classifyIntent } from './intent.js'
import { adaptiveTraversalSearch, type TraversalOptions } from './adaptive-traversal.js'
import { multiHopIterativeSearch, type MultiHopOptions } from './multihop-iterative.js'
import { entityNeighborhood, type NeighborhoodChunk } from './entities/neighborhood.js'
import { SCNS_GAZETTEER, type GazetteerEntry } from './entities/gazetteer.js'
import { resolveQueryEntities, queryNamesLearnedEntity } from './entities/learned-vocab.js'
import {
  causalNeighborhood,
  formatCausalChain,
  topologicalOrderCausalChains,
  type CausalChain,
} from './causal-neighborhood.js'
import { semanticNeighborhood, type SemanticNeighbor } from './semantic-neighborhood.js'
import { temporalTimeline } from './temporal-timeline.js'
import type { SemanticRelevanceScorer } from './semantic-relevance.js'
import {
  reciprocalRankFusion,
  fusedResultsToSearchResults,
  DEFAULT_RRF_K,
  type RankedItem,
  type FusionSource,
} from './fusion.js'

/** The underlying (today's) search — the hybrid/keyword path the adapter uses when not routing. */
export type BaseSearch = (query: string, topK: number) => Promise<readonly SearchResult[]>

/**
 * Per-subspace weights for MAGMA Algorithm 1 fusion. Hybrid (vector+keyword relevance) is the
 * anchor; entity (object permanence) is co-equal; the associative semantic tier and the
 * recency-only temporal re-rank are softer priors that boost — but do not dominate — a chunk
 * already supported by relevance or entity evidence.
 */
export interface FusionWeights {
  readonly hybrid?: number
  readonly entity?: number
  readonly semantic?: number
  readonly temporal?: number
}

const DEFAULT_FUSION_WEIGHTS: Required<FusionWeights> = {
  hybrid: 1.0,
  entity: 1.0,
  semantic: 0.5,
  temporal: 0.5,
}

// Relevance-anchored ENTITY-route weights (Phase 13.12.35). When the ENTITY
// route is relevance-ranked instead of recency-dumped, fuse ONLY hybrid⊕entity:
// hybrid strongly dominates (6×) so it never demotes a hybrid #1, while entity
// membership (1×) is a light tiebreak that ADDS recall at the tail (chunks no
// hybrid hit found). semantic/temporal off to avoid the dilution that made full
// fusion regress lookups. Tuned h=6,e=1 ⇒ MRR 0.620 (hybrid 0.648, hit@1 7/14
// matches hybrid, found 13/14) vs binary recency dump 0.354/9 on the n=14 set.
const ENTITY_RELEVANCE_WEIGHTS: Required<FusionWeights> = {
  hybrid: 6.0,
  entity: 1.0,
  semantic: 0.0,
  temporal: 0.0,
}

/** The recognised fusion-weight keys (must match {@link FusionWeights}). */
const FUSION_WEIGHT_KEYS: readonly (keyof FusionWeights)[] = [
  'hybrid',
  'entity',
  'semantic',
  'temporal',
]

/**
 * Parse a `SCNS_FUSION_WEIGHTS` env string into a {@link FusionWeights} override so the per-
 * subspace fusion weights can be TUNED in prod (and measured via the QG retrieval gate) WITHOUT a
 * code change. Format: comma-separated `key=value` pairs, e.g.
 * `"hybrid=1,entity=0.5,semantic=0.8,temporal=0.2"`. Only the four recognised keys are honoured;
 * each value must be finite and ≥ 0 (a weight of 0 disables that subspace). Unknown keys, malformed
 * pairs and out-of-range values are ignored. Returns `undefined` when the input is absent/empty or
 * yields no valid override ⇒ {@link DEFAULT_FUSION_WEIGHTS} is left unchanged (default-preserving).
 */
export function parseFusionWeights(raw: string | undefined): FusionWeights | undefined {
  if (!raw || raw.trim() === '') return undefined
  const out: Partial<Record<keyof FusionWeights, number>> = {}
  for (const pair of raw.split(',')) {
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    const key = pair.slice(0, eq).trim()
    if (!FUSION_WEIGHT_KEYS.includes(key as keyof FusionWeights)) continue
    const valueStr = pair.slice(eq + 1).trim()
    if (valueStr === '') continue // `key=` with no value is malformed (Number('') is 0) ⇒ ignore
    const value = Number(valueStr)
    if (!Number.isFinite(value) || value < 0) continue
    out[key as keyof FusionWeights] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
}

export interface IntentSearchOptions {
  /** Route by intent over the entity/temporal substrate. Default OFF ⇒ pure `baseSearch`. */
  readonly enabled?: boolean
  /** Override the gazetteer used for intent + entity matching (defaults to `SCNS_GAZETTEER`). */
  readonly gazetteer?: readonly GazetteerEntry[]
  /**
   * Augment the base/DEFAULT path with 2-hop SEMANTIC associations (neighbor-of-neighbor
   * over the embedding-similarity graph) — the associative reach a single hybrid query
   * cannot do. Default OFF ⇒ retrieval is byte-identical to today. Composes with `enabled`:
   * it enriches the base-hybrid fallback (DEFAULT intent / disabled routing / empty
   * neighborhood); a routed ENTITY/WHEN/WHY hit is returned unaugmented.
   */
  readonly semantic?: boolean
  /**
   * MAGMA Algorithm 1 — fuse ALL retrieval subspaces (hybrid ⊕ entity ⊕ semantic ⊕ temporal)
   * via weighted Reciprocal Rank Fusion into ONE relevance-ranked result, instead of the
   * coarse binary intent switch (which returns a single subspace's flat positional dump).
   * Default OFF ⇒ unchanged. When ON it SUPERSEDES the `enabled` binary router (and folds in
   * the semantic tier by relevance, so `semantic` need not also be set). On a vault with no
   * entity/semantic substrate it degenerates to the hybrid order ⇒ never worse than today.
   */
  readonly fusion?: boolean
  /** Override the per-subspace fusion weights (see {@link FusionWeights}). */
  readonly fusionWeights?: FusionWeights
  /**
   * Drop 2-hop SEMANTIC augmentation candidates whose discovery edge weight is below this
   * (similarity in (0,1]; weight = 1/(1+L2)). Default 0 ⇒ no gate (today's behavior).
   */
  readonly minSemanticWeight?: number
  /**
   * Optional query-relevance scorer for the SEMANTIC tier. When supplied it ranks the semantic
   * candidates by this score (cosine of query↔candidate over stored embeddings) instead of edge
   * weight — so the associative chunk surfaced is the most QUERY-relevant available one, not
   * merely the strongest-edge one. Applies to BOTH the 2-hop augmentation (non-fusion `semantic`
   * path) AND fusion's semantic source (so fusion's semantic candidates are relevance-ranked, not
   * hop/weight-ranked). Injected (not imported) to keep the router embedding-free/deterministic;
   * absent ⇒ graph (hop/edge-weight) order (unchanged).
   */
  readonly semanticRelevance?: SemanticRelevanceScorer
  /**
   * Enrich the WHEN intent: when a temporal query names NO entity (so the entity-neighborhood
   * route is empty), return a chronological TIMELINE of the most-recent query-relevant chunks
   * instead of falling back to relevance-ranked hybrid search. Default OFF ⇒ today's behavior
   * (no-entity WHEN ⇒ baseSearch). Only affects the `enabled` (intent-routing) WHEN path.
   */
  readonly timeline?: boolean
  /**
   * Relevance-rank the ENTITY route. The binary router (`enabled`) classifies an entity-naming
   * factual lookup as ENTITY and returns the entity neighborhood NEWEST-first — a recency dump
   * that buries (or drops past topK) the keyword-relevant chunk, regressing factual lookups vs
   * plain hybrid. With this ON, an ENTITY hit is instead a hybrid⊕entity Reciprocal-Rank-Fusion
   * (relevance-dominant, see {@link ENTITY_RELEVANCE_WEIGHTS}) so a chunk that is BOTH relevant
   * AND entity-linked rises, keeping MAGMA's entity substrate without losing relevance. WHEN/WHY
   * routing is unchanged. Default OFF ⇒ today's recency dump. Only affects the `enabled` path.
   */
  readonly entityRelevanceRank?: boolean
  /**
   * Run the MAGMA Algorithm-1 Adaptive Traversal Policy (intent-weighted beam search over the four
   * typed edge graphs from hybrid anchors) instead of the single-pass RRF blend. This is the only
   * mode that can REACH a buried multi-hop node — one sharing no query tokens and low embedding
   * similarity but connected to an anchor through an entity/causal edge. Default OFF; when ON it
   * supersedes `fusion`/binary routing. See {@link adaptiveTraversalSearch}.
   */
  readonly traverse?: boolean
  /** Tuning forwarded to {@link adaptiveTraversalSearch} when `traverse` is ON. */
  readonly traversalOptions?: TraversalOptions
  /**
   * C2 — the multi-hop ITERATIVE arm (beyond MAGMA; IRCoT/FLARE family). Round 0 retrieves via the
   * faithful Alg-1 beam (or the base search), then graph-derived (or injected) follow-up queries
   * iterate until zero information gain. This targets the category the paper CONCEDES (Table 1
   * Multi-Hop 0.528 < Nemori 0.569). Default OFF; when ON it supersedes `traverse`/`fusion`/binary
   * routing (a distinct arm, not a beam variant). See {@link multiHopIterativeSearch}.
   */
  readonly multiHop?: boolean
  /** Tuning forwarded to {@link multiHopIterativeSearch} when `multiHop` is ON. */
  readonly multiHopOptions?: MultiHopOptions
  /**
   * Order a routed WHY neighborhood by cause→effect TOPOLOGICAL order (MAGMA paper Stage 4) instead
   * of confidence-only. A confidence sort can read effects before their causes; the topological sort
   * emits a root cause before the effect it leads to (deterministic, cycle-safe). Default OFF ⇒
   * today's confidence order. Only affects the `enabled` WHY route. See {@link topologicalOrderCausalChains}.
   */
  readonly causalTopoOrder?: boolean
  /**
   * A-div2 query-side: resolve a query naming a LEARNED (App-C.1, non-gazetteer) entity against the
   * data-driven `memory_entities` vocabulary — so e.g. 'melanie' anchors on her entity node /
   * neighborhood (MAGMA Algorithm 1 query→entity anchoring), not just the closed gazetteer. Additive
   * + default OFF (`SCNS_LEARNED_ENTITY_QUERY`): with it OFF, entity resolution AND routing are
   * byte-identical to today. When ON it applies to the fusion entity source, the binary ENTITY/WHY
   * routes, AND intent classification (a learned-only query then classifies ENTITY, not DEFAULT).
   */
  readonly learnedEntityQuery?: boolean
}

type Order = 'recent' | 'chronological'

/** Map temporal-ordered neighborhood chunks to SearchResult rows (positional score, top = 1.0). */
function neighborhoodToResults(chunks: readonly NeighborhoodChunk[]): SearchResult[] {
  const n = chunks.length
  return chunks.map((c, i) => ({
    chunkId: c.chunkId,
    filePath: c.filePath,
    content: c.content,
    score: n > 0 ? (n - i) / n : 0,
    vectorScore: 0,
    keywordScore: 0,
    chunkIndex: c.chunkIndex,
  }))
}

/**
 * Aggregate the entity neighborhoods of every gazetteer entity named in the query, de-duplicated by
 * chunk id, ordered by `order`, capped at `topK`. Returns [] when the query names no entity or none
 * of the named entities have any linked chunks (⇒ caller falls back to `baseSearch`).
 */
function aggregateNeighborhoods(
  db: Database.Database,
  query: string,
  topK: number,
  gazetteer: readonly GazetteerEntry[],
  order: Order,
  learned = false,
): NeighborhoodChunk[] {
  const matches = resolveQueryEntities(db, query, gazetteer, learned)
  if (matches.length === 0) return []

  const perEntityLimit = topK > 0 ? topK : undefined
  const byId = new Map<number, NeighborhoodChunk>()
  for (const m of matches) {
    for (const chunk of entityNeighborhood(db, m.canonical, {
      gazetteer,
      limit: perEntityLimit,
      learnedEntityQuery: learned,
    })) {
      if (!byId.has(chunk.chunkId)) byId.set(chunk.chunkId, chunk)
    }
  }

  const dir = order === 'recent' ? -1 : 1 // recent = descending mtime, chronological = ascending
  const merged = [...byId.values()].sort((a, b) => {
    if (a.mtimeMs !== b.mtimeMs) return dir * (a.mtimeMs - b.mtimeMs)
    if (a.chunkIndex !== b.chunkIndex) return dir * (a.chunkIndex - b.chunkIndex)
    return dir * (a.chunkId - b.chunkId)
  })

  return merged.slice(0, Math.max(0, topK))
}

/** Map causal chains to SearchResult rows (positional score, top = 1.0; structural hits). */
function causalChainsToResults(chains: readonly CausalChain[]): SearchResult[] {
  const rows: SearchResult[] = []
  for (const c of chains) {
    const content = formatCausalChain(c)
    if (content.trim() === '') continue // re-chunked away AND no rationale ⇒ no usable text
    rows.push({
      // The effect (outcome) is the primary referent; fall back to the cause, then a
      // synthetic id when neither side resolved to a live chunk (rationale-only edge).
      chunkId: c.effectChunkId ?? c.causeChunkId ?? -1,
      filePath: '',
      content,
      score: 0, // back-filled positionally below
      vectorScore: 0,
      keywordScore: 0,
      chunkIndex: 0,
    })
  }
  const n = rows.length
  return rows.map((r, i) => ({ ...r, score: n > 0 ? (n - i) / n : 0 }))
}

/**
 * Aggregate the causal-edge neighborhoods of every gazetteer entity named in the query,
 * de-duplicated by (cause,effect) key pair, capped at `topK`. Ordering is confidence-descending by
 * default; with `topoOrder`, chains are ordered by cause→effect TOPOLOGICAL order (paper Stage 4).
 * Returns [] when the query names no entity or none of the named entities have any causal edges
 * (⇒ caller falls back to `baseSearch`).
 */
function aggregateCausalChains(
  db: Database.Database,
  query: string,
  topK: number,
  gazetteer: readonly GazetteerEntry[],
  topoOrder = false,
  learned = false,
): CausalChain[] {
  const matches = resolveQueryEntities(db, query, gazetteer, learned)
  if (matches.length === 0) return []

  const perEntityLimit = topK > 0 ? topK : undefined
  const byPair = new Map<string, CausalChain>()
  for (const m of matches) {
    for (const chain of causalNeighborhood(db, m.canonical, {
      gazetteer,
      learnedEntityQuery: learned,
      ...(perEntityLimit !== undefined ? { limit: perEntityLimit } : {}),
    })) {
      const pair = `${chain.causeKey}\u0000${chain.effectKey}`
      const existing = byPair.get(pair)
      if (!existing || chain.confidence > existing.confidence) byPair.set(pair, chain)
    }
  }

  const deduped = [...byPair.values()].sort((a, b) => {
    if (a.confidence !== b.confidence) return b.confidence - a.confidence
    if (a.causeKey !== b.causeKey) return a.causeKey < b.causeKey ? -1 : 1
    return a.effectKey < b.effectKey ? -1 : 1
  })
  const merged = topoOrder ? topologicalOrderCausalChains(deduped) : deduped
  return merged.slice(0, Math.max(0, topK))
}

/**
 * Augment a base-hybrid result with NOVEL 2-hop semantic neighbors (neighbor-of-neighbor
 * over the embedding-similarity graph). The base hits are the seeds; their DIRECT (1-hop)
 * semantic neighbors are already what hybrid surfaces, so only chunks first reached at hop 2
 * (and absent from the base) are added — the associative reach a single hybrid query misses.
 *
 * A fraction of the `topK` budget (≈⅓, min 1) is RESERVED for these additions so they are
 * guaranteed to surface when they exist; they are appended after the retained base hits with
 * strictly-decreasing scores below the base floor (associative extras never outrank a direct
 * hit). When no novel 2-hop neighbor exists this is a no-op (returns the base verbatim).
 */
/** Options for the 2-hop semantic augmentation (relevance hardening). */
interface SemanticAugmentOptions {
  readonly minSemanticWeight?: number
  readonly semanticRelevance?: SemanticRelevanceScorer
}

function augmentWithSemanticTwoHop(
  db: Database.Database,
  base: readonly SearchResult[],
  topK: number,
  options: SemanticAugmentOptions = {},
): readonly SearchResult[] | Promise<readonly SearchResult[]> {
  if (topK <= 0 || base.length === 0) return base

  const minWeight =
    typeof options.minSemanticWeight === 'number' && options.minSemanticWeight > 0
      ? options.minSemanticWeight
      : 0

  const baseIds = new Set(base.map((r) => r.chunkId))
  const neighbors = semanticNeighborhood(db, [...baseIds], { hops: 2, limit: topK * 4 })
  const novelTwoHop = neighbors.filter(
    (n) => n.hop === 2 && !baseIds.has(n.chunkId) && n.weight >= minWeight,
  )
  if (novelTwoHop.length === 0) return base

  // Without a relevance scorer, keep the edge-weight order (today's behavior, fully sync).
  if (!options.semanticRelevance) return injectTwoHop(base, novelTwoHop, topK)

  // With a scorer: rank the novel 2-hop candidates by QUERY relevance (cosine over stored
  // embeddings) — the strongest-edge neighbor is not necessarily the most query-relevant.
  // Any scorer failure (cold embedding worker) falls back to the edge-weight order, so search
  // is never broken.
  return Promise.resolve(options.semanticRelevance(novelTwoHop.map((n) => n.chunkId)))
    .then((scores) => {
      const ranked =
        scores.size > 0
          ? [...novelTwoHop].sort((a, b) => {
              const sa = scores.get(a.chunkId) ?? -Infinity
              const sb = scores.get(b.chunkId) ?? -Infinity
              if (sb !== sa) return sb - sa
              if (b.weight !== a.weight) return b.weight - a.weight
              return a.chunkId - b.chunkId
            })
          : novelTwoHop
      return injectTwoHop(base, ranked, topK)
    })
    .catch(() => injectTwoHop(base, novelTwoHop, topK))
}

/**
 * Append the top `reserve` novel 2-hop chunks (≈⅓ of `topK`, min 1, taken from the FRONT of the
 * already-ordered `ranked` list) after the retained base hits, with strictly-decreasing scores
 * below the base floor (associative extras never outrank a direct hit).
 */
function injectTwoHop(
  base: readonly SearchResult[],
  ranked: readonly { chunkId: number; filePath: string; content: string; chunkIndex: number }[],
  topK: number,
): readonly SearchResult[] {
  const reserve = Math.min(ranked.length, Math.max(1, Math.floor(topK / 3)))
  const kept = base.slice(0, Math.max(0, topK - reserve))
  const floor = kept.length > 0 ? Math.min(...kept.map((r) => r.score)) : 1
  const scoreBase = floor > 0 ? floor : 1e-3

  const additions: SearchResult[] = ranked.slice(0, reserve).map((n, i) => ({
    chunkId: n.chunkId,
    filePath: n.filePath,
    content: n.content,
    score: scoreBase * 0.5 ** (i + 1), // strictly below the base floor, strictly decreasing
    vectorScore: 0,
    keywordScore: 0,
    chunkIndex: n.chunkIndex,
  }))

  return [...kept, ...additions]
}

/** Project any chunk-bearing row to a {@link RankedItem} (the fusion candidate shape). */
function toRankedItem(r: {
  readonly chunkId: number
  readonly filePath: string
  readonly content: string
  readonly chunkIndex: number
}): RankedItem {
  return { chunkId: r.chunkId, filePath: r.filePath, content: r.content, chunkIndex: r.chunkIndex }
}

interface PoolRow {
  chunkId: number
  filePath: string
  content: string
  chunkIndex: number
}

/**
 * The TEMPORAL fusion subspace: re-rank the already-gathered candidate pool by recency
 * (source-file mtime, desc). It introduces NO new chunks — purely a recency PRIOR over the
 * relevant candidates — so a recent chunk that is also relevant/entity-linked is boosted,
 * while no recent-but-irrelevant chunk is injected. Returns [] for an empty pool.
 */
function rankCandidatePoolByRecency(db: Database.Database, ids: ReadonlySet<number>): RankedItem[] {
  if (ids.size === 0) return []
  const idList = [...ids]
  const placeholders = idList.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT c.id AS chunkId, c.file_path AS filePath, c.content AS content,
              c.chunk_index AS chunkIndex
       FROM chunks c JOIN vault_files vf ON vf.path = c.file_path
       WHERE c.id IN (${placeholders})
       ORDER BY vf.mtime_ms DESC, c.chunk_index DESC, c.id DESC`,
    )
    .all(...idList) as PoolRow[]
  return rows.map(toRankedItem)
}

/**
 * Rank fusion's SEMANTIC candidates by QUERY relevance. `semanticNeighborhood` returns chunks in
 * graph order (hop asc, edge-weight desc) — proximity in the embedding graph, NOT similarity to
 * the query — so a strong-edge-but-tangential neighbor would feed RRF a better rank than a
 * weak-edge-but-relevant one. When a `scorer` is injected (cosine of query↔candidate over stored
 * embeddings — the item-2 signal) the neighbors are re-ordered by that score, so the semantic
 * source contributes RELEVANCE-ranked candidates. No scorer / empty score-map / scorer failure ⇒
 * the original graph order (today's fusion behaviour), so search is never broken or worse.
 */
async function rankSemanticByRelevance(
  neighbors: readonly SemanticNeighbor[],
  scorer: SemanticRelevanceScorer | undefined,
): Promise<RankedItem[]> {
  if (neighbors.length === 0) return []
  // No scorer (or nothing to reorder) ⇒ graph order, fully sync — byte-identical to today.
  if (!scorer || neighbors.length < 2) return neighbors.map(toRankedItem)
  try {
    const scores = await Promise.resolve(scorer(neighbors.map((n) => n.chunkId)))
    if (scores.size === 0) return neighbors.map(toRankedItem)
    return [...neighbors]
      .sort((a, b) => {
        const sa = scores.get(a.chunkId) ?? -Infinity
        const sb = scores.get(b.chunkId) ?? -Infinity
        if (sb !== sa) return sb - sa
        if (b.weight !== a.weight) return b.weight - a.weight
        return a.chunkId - b.chunkId
      })
      .map(toRankedItem)
  } catch {
    return neighbors.map(toRankedItem)
  }
}

/**
 * MAGMA Algorithm 1 retrieval. Gather ranked candidates from every subspace and fuse them
 * with weighted RRF into one relevance-ranked result:
 *   - hybrid:   `baseSearch` (vector+keyword relevance) — the anchor ordering.
 *   - entity:   the entity neighborhood of every named entity, recent-first (object
 *               permanence). Empty when the query names no entity.
 *   - semantic: 1- and 2-hop neighbors of the hybrid seeds over the embedding-similarity graph
 *               (associative reach). Ranked by query relevance when a `semanticRelevance` scorer
 *               is injected, else graph (hop/edge-weight) order. Empty without semantic edges.
 *   - temporal: the union candidate pool re-ranked by recency (a recency prior; no new chunks).
 *
 * Fusing hybrid relevance with entity membership is the fix for the flat positional
 * entity-dump: a chunk that is BOTH entity-linked AND relevant accumulates two RRF terms and
 * rises above a chunk that is merely entity-linked. With only a hybrid source (bare vault)
 * the fused order equals the hybrid order, so fusion is never worse than today.
 */
async function fusionSearch(
  db: Database.Database,
  query: string,
  topK: number,
  baseSearch: BaseSearch,
  gazetteer: readonly GazetteerEntry[],
  weights: Required<FusionWeights>,
  learned: boolean,
  semanticRelevance?: SemanticRelevanceScorer,
): Promise<readonly SearchResult[]> {
  if (topK <= 0) return []
  // Beam: gather a wider candidate pool than topK so RRF has material to fuse, then trim.
  const beamWidth = Math.max(topK * 4, 20)

  // Hybrid is ALWAYS computed: it is the relevance anchor, the semantic-seed source, and the
  // degenerate fallback. Each OTHER subspace is gathered only when its weight is non-zero, so a
  // zeroed subspace contributes no candidates (not even indirectly via the temporal re-rank).
  const hybrid = await baseSearch(query, beamWidth)
  const hybridItems = hybrid.map(toRankedItem)

  const entityItems =
    weights.entity !== 0
      ? aggregateNeighborhoods(db, query, beamWidth, gazetteer, 'recent', learned).map(toRankedItem)
      : []

  const seeds = hybridItems.slice(0, Math.min(8, hybridItems.length)).map((i) => i.chunkId)
  const semanticNeighbors =
    weights.semantic !== 0 && seeds.length > 0
      ? semanticNeighborhood(db, seeds, { hops: 2, limit: beamWidth })
      : []
  // Re-rank the semantic source by QUERY relevance when a scorer is injected (else graph order).
  const semanticItems = await rankSemanticByRelevance(semanticNeighbors, semanticRelevance)

  // Temporal re-ranks the union of the ACTIVE subspaces' candidates by recency (no new chunks).
  const poolIds = new Set<number>()
  if (weights.hybrid !== 0) for (const it of hybridItems) poolIds.add(it.chunkId)
  for (const it of entityItems) poolIds.add(it.chunkId)
  for (const it of semanticItems) poolIds.add(it.chunkId)
  const temporalItems = weights.temporal !== 0 ? rankCandidatePoolByRecency(db, poolIds) : []

  const sources: FusionSource[] = [
    { name: 'hybrid', weight: weights.hybrid, items: hybridItems },
    { name: 'entity', weight: weights.entity, items: entityItems },
    { name: 'semantic', weight: weights.semantic, items: semanticItems },
    { name: 'temporal', weight: weights.temporal, items: temporalItems },
  ].filter((s) => s.weight !== 0 && s.items.length > 0)

  const fused = reciprocalRankFusion(sources, { k: DEFAULT_RRF_K, limit: topK, beamWidth })
  // Degenerate guard: if nothing fused (all sources empty) fall back to the base order.
  if (fused.length === 0) return hybrid.slice(0, topK)
  return fusedResultsToSearchResults(fused)
}

/**
 * Intent-aware search. When `options.enabled`, `options.semantic` AND `options.fusion` are
 * all falsy this is exactly `baseSearch(query, topK)`. When `fusion`, it runs MAGMA
 * Algorithm 1 (weighted RRF over hybrid ⊕ entity ⊕ semantic ⊕ temporal) — superseding the
 * binary router. Otherwise when `enabled`, it classifies the query and routes ENTITY/WHEN
 * over the entity/temporal substrate and WHY over the causal-edge graph, falling back to
 * `baseSearch` for DEFAULT and any routed query with an empty neighborhood; when `semantic`
 * that base-hybrid fallback is additionally enriched with 2-hop semantic associations. In
 * every mode retrieval is never worse than today's hybrid search.
 */
export async function intentAwareSearch(
  db: Database.Database,
  query: string,
  topK: number,
  baseSearch: BaseSearch,
  options: IntentSearchOptions = {},
): Promise<readonly SearchResult[]> {
  const semantic = options.semantic ?? false
  const fusion = options.fusion ?? false
  const traverse = options.traverse ?? false
  const multiHop = options.multiHop ?? false
  if (!options.enabled && !semantic && !fusion && !traverse && !multiHop)
    return baseSearch(query, topK)

  const gazetteer = options.gazetteer ?? SCNS_GAZETTEER
  // A-div2 query-side (default OFF): also resolve query names against the LEARNED memory_entities
  // vocabulary. Threaded into the fusion entity source, the binary ENTITY/WHY routes, and intent
  // classification. OFF ⇒ every resolution below is gazetteer-only (byte-identical to today).
  const learned = options.learnedEntityQuery ?? false

  // C2 — the multi-hop ITERATIVE arm (beyond MAGMA). Supersedes traverse/fusion/binary routing:
  // an IRCoT/FLARE-family loop whose rounds retrieve via the faithful Alg-1 beam by default.
  if (multiHop) {
    return multiHopIterativeSearch(db, query, topK, baseSearch, {
      gazetteer,
      ...(options.semanticRelevance ? { semanticRelevance: options.semanticRelevance } : {}),
      ...(options.traversalOptions ? { traversalOptions: options.traversalOptions } : {}),
      ...(options.multiHopOptions ?? {}),
    })
  }

  // MAGMA Algorithm 1 — Adaptive Traversal Policy. Supersedes the RRF blend: a real beam-search
  // graph traversal that can reach buried multi-hop nodes (default-OFF).
  if (traverse) {
    return adaptiveTraversalSearch(db, query, topK, baseSearch, {
      gazetteer,
      semanticRelevance: options.semanticRelevance,
      ...(options.traversalOptions ?? {}),
    })
  }

  // MAGMA Algorithm 1 (fusion) supersedes the coarse binary router when enabled: it fuses
  // ALL subspaces by relevance rather than switching to ONE on a single classified intent.
  if (fusion) {
    const weights = { ...DEFAULT_FUSION_WEIGHTS, ...(options.fusionWeights ?? {}) }
    return fusionSearch(
      db,
      query,
      topK,
      baseSearch,
      gazetteer,
      weights,
      learned,
      options.semanticRelevance,
    )
  }

  if (options.enabled) {
    const intent = classifyIntent(
      query,
      gazetteer,
      learned ? { hasLearnedEntity: (q) => queryNamesLearnedEntity(db, q, gazetteer) } : {},
    )

    if (intent === 'ENTITY' || intent === 'WHEN') {
      // Phase 13.12.35 — relevance-rank the ENTITY route (default OFF). A pure
      // recency dump buries the keyword-relevant chunk; a hybrid⊕entity RRF
      // anchors on relevance while keeping the entity substrate. Measured to
      // recover the binary router's factual-lookup regression (MRR 0.354→0.572,
      // hybrid 0.648) without the semantic/temporal dilution that hurt fusion.
      if (intent === 'ENTITY' && options.entityRelevanceRank) {
        const fused = await fusionSearch(
          db,
          query,
          topK,
          baseSearch,
          gazetteer,
          ENTITY_RELEVANCE_WEIGHTS,
          learned,
          options.semanticRelevance,
        )
        if (fused.length > 0) return fused
      }
      const order: Order = intent === 'WHEN' ? 'chronological' : 'recent'
      const chunks = aggregateNeighborhoods(db, query, topK, gazetteer, order, learned)
      if (chunks.length > 0) return neighborhoodToResults(chunks)
      // No entity anchor for a WHEN query ⇒ optionally return a chronological timeline of the
      // most-recent query-relevant chunks (the time axis a relevance-ranked hybrid query misses).
      if (intent === 'WHEN' && options.timeline) {
        const timeline = await temporalTimeline(db, query, baseSearch, { limit: topK })
        if (timeline.length > 0) return neighborhoodToResults(timeline)
      }
    }

    if (intent === 'WHY') {
      const chains = aggregateCausalChains(
        db,
        query,
        topK,
        gazetteer,
        options.causalTopoOrder ?? false,
        learned,
      )
      const results = causalChainsToResults(chains)
      if (results.length > 0) return results
    }
  }

  // DEFAULT, disabled routing, or a routed query with an empty neighborhood ⇒ today's
  // hybrid search — optionally enriched with 2-hop semantic associations.
  const base = await baseSearch(query, topK)
  if (!semantic) return base
  return augmentWithSemanticTwoHop(db, base, topK, {
    minSemanticWeight: options.minSemanticWeight,
    semanticRelevance: options.semanticRelevance,
  })
}
