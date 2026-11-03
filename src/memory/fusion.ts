/**
 * MAGMA Algorithm 1 — weighted Reciprocal Rank Fusion (RRF) over the retrieval subspaces
 * (design-m1.md §5, Table 4). The unifying ranker that REPLACES the coarse binary intent
 * switch: instead of routing a query to exactly ONE subspace (entity OR temporal OR causal
 * OR hybrid) and returning a flat positional dump, it fuses the ranked candidate lists from
 * ALL enabled subspaces into ONE relevance-ranked result.
 *
 * RRF (Cormack et al. 2009) is the rank-aggregation method MAGMA fuses subspaces with: it
 * needs only each source's ORDERING (not calibrated cross-source scores), so the keyword/
 * vector hybrid score, the entity-neighborhood recency order, the semantic-edge weight order
 * and the temporal recency order can all be combined without normalising disparate scales.
 *
 *   raw(d)   = Σ_{s∈sources}  w_s / (k + rank_s(d))      // rank_s 1-based; absent ⇒ no term
 *   score(d) = raw(d) / max_d raw(d)                     // normalise so the top result = 1.0
 *
 * A document that surfaces in MULTIPLE subspaces accumulates multiple terms and therefore
 * outranks one that surfaces in only a single subspace — exactly the "fuse the evidence"
 * behaviour that fixes the flat-dump usability bug (a chunk that is both entity-linked AND
 * hybrid-relevant beats a chunk that is merely entity-linked). `k` (default 60) dampens the
 * weight of very-high ranks so the long tail still contributes. Pure + deterministic: no I/O,
 * no embeddings, no LLM.
 */

import type { SearchResult } from './search.js'

/**
 * RRF dampening constant. The canonical value from the original RRF paper; larger `k`
 * flattens the contribution curve (later ranks matter relatively more), smaller `k`
 * sharpens it toward the top of each list.
 */
export const DEFAULT_RRF_K = 60

/** A ranked candidate carrying just enough to emit a {@link SearchResult}. */
export interface RankedItem {
  readonly chunkId: number
  readonly filePath: string
  readonly content: string
  readonly chunkIndex: number
}

/** One retrieval subspace's contribution: an ORDERED (best-first) candidate list + a weight. */
export interface FusionSource {
  /** Provenance label (e.g. 'hybrid', 'entity', 'semantic', 'temporal'). */
  readonly name: string
  /** Relative weight of this subspace in the fused score. A weight of 0 skips the source. */
  readonly weight: number
  /** Candidates, ORDERED best-first. The position (1-based) is the RRF rank. */
  readonly items: readonly RankedItem[]
}

export interface FusionOptions {
  /** RRF dampening constant. Default {@link DEFAULT_RRF_K}. */
  readonly k?: number
  /** Cap the fused output to the top-N. */
  readonly limit?: number
  /**
   * Beam: cap how many candidates each source contributes (its top `beamWidth` by rank).
   * Bounds the fusion work and the tail influence of any one over-eager subspace. Default
   * unbounded (use every supplied item).
   */
  readonly beamWidth?: number
}

export interface FusedResult {
  readonly chunkId: number
  readonly filePath: string
  readonly content: string
  readonly chunkIndex: number
  /** Normalised RRF score in (0, 1], top result = 1.0. */
  readonly score: number
  /** Raw (un-normalised) weighted RRF score. */
  readonly rrf: number
  /** Names of the subspaces that contributed to this result, in source order. */
  readonly sources: readonly string[]
}

interface Accumulator {
  item: RankedItem
  rrf: number
  sources: string[]
  /** Best (lowest) 1-based rank this chunk achieved in any single source — a tie-break. */
  bestRank: number
}

/**
 * Weighted Reciprocal Rank Fusion over `sources`. Each source is an ordered candidate list;
 * a chunk's fused score sums `weight / (k + rank)` across the sources it appears in. Within a
 * single source a chunk is counted once (its best/earliest position). Sentinel/synthetic ids
 * (`chunkId <= 0`, e.g. an unresolved rationale-only causal chain) are skipped — they cannot
 * be de-duplicated by id and have no retrievable chunk. Results are sorted by fused score
 * (desc), then best single-source rank (asc), then chunk id (asc) for full determinism, and
 * normalised so the top score is 1.0.
 *
 * Returns [] when no source contributes a real chunk.
 */
export function reciprocalRankFusion(
  sources: readonly FusionSource[],
  options: FusionOptions = {},
): FusedResult[] {
  const k = typeof options.k === 'number' && options.k > 0 ? options.k : DEFAULT_RRF_K
  const beam =
    typeof options.beamWidth === 'number' && options.beamWidth >= 0
      ? Math.floor(options.beamWidth)
      : undefined

  const byId = new Map<number, Accumulator>()

  for (const source of sources) {
    if (!source || source.weight === 0 || source.items.length === 0) continue
    const seenInSource = new Set<number>()
    let rank = 0
    for (const item of source.items) {
      // Skip sentinel/synthetic ids (no real chunk to de-dup or retrieve).
      if (!Number.isInteger(item.chunkId) || item.chunkId <= 0) continue
      // A chunk occupies one rank per source — keep its first (best) position only.
      if (seenInSource.has(item.chunkId)) continue
      seenInSource.add(item.chunkId)
      rank += 1
      if (beam !== undefined && rank > beam) break
      const contribution = source.weight / (k + rank)
      const existing = byId.get(item.chunkId)
      if (existing) {
        existing.rrf += contribution
        existing.sources.push(source.name)
        if (rank < existing.bestRank) existing.bestRank = rank
      } else {
        byId.set(item.chunkId, {
          item,
          rrf: contribution,
          sources: [source.name],
          bestRank: rank,
        })
      }
    }
  }

  if (byId.size === 0) return []

  const accs = [...byId.values()]
  let maxRrf = 0
  for (const a of accs) if (a.rrf > maxRrf) maxRrf = a.rrf

  accs.sort((a, b) => b.rrf - a.rrf || a.bestRank - b.bestRank || a.item.chunkId - b.item.chunkId)

  const limited =
    typeof options.limit === 'number' && options.limit >= 0 ? accs.slice(0, options.limit) : accs

  return limited.map((a) => ({
    chunkId: a.item.chunkId,
    filePath: a.item.filePath,
    content: a.item.content,
    chunkIndex: a.item.chunkIndex,
    score: maxRrf > 0 ? a.rrf / maxRrf : 0,
    rrf: a.rrf,
    sources: a.sources,
  }))
}

/**
 * Map fused results to {@link SearchResult} rows. The fused score becomes `score`; the
 * vector/keyword components are zeroed because a fused score is a cross-subspace rank
 * aggregate, not a raw hybrid score (mirrors the neighborhood→SearchResult convention).
 */
export function fusedResultsToSearchResults(fused: readonly FusedResult[]): SearchResult[] {
  return fused.map((f) => ({
    chunkId: f.chunkId,
    filePath: f.filePath,
    content: f.content,
    score: f.score,
    vectorScore: 0,
    keywordScore: 0,
    chunkIndex: f.chunkIndex,
  }))
}
