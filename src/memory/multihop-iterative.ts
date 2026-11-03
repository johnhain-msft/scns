/**
 * C2 — Multi-hop ITERATIVE retrieval on the MAGMA graph (a capability BEYOND the paper).
 *
 * MAGMA does NOT win multi-hop QA (Table 1: 0.528 < Nemori 0.569 / MemoryOS 0.552) — the paper's own
 * concession, and the north-star (plan §9) needs multi-hop for effective learning. This module adds the
 * ITERATIVE/ACTIVE-retrieval pattern family on top of the graph substrate:
 *   - IRCoT (Trivedi et al., ACL 2023): interleave retrieval with intermediate reasoning — each round's
 *     findings drive the next round's queries.
 *   - FLARE (Jiang et al., EMNLP 2023, arXiv:2305.06983) / DRAGIN (Su et al., ACL 2024, arXiv:2403.10081):
 *     retrieve again only while there is an information need — here operationalized as the ZERO-GAIN STOP
 *     (a round that surfaces no unseen chunk ends the loop).
 *
 * The default follow-up proposer is DETERMINISTIC + GRAPH-NATIVE (no LLM spawn, det×2-safe):
 * {@link bridgeEntityFollowups} — entities linked (memory_edges `entity` rows) to the chunks retrieved so
 * far but NOT named in the query become follow-up queries `"<entity> <query>"`. An LLM proposer (true
 * IRCoT) is injectable via {@link MultiHopOptions.proposeFollowups}; the judged harness may wire the
 * ephemeral ACP generator there without touching this module.
 *
 * Each round's inner retriever is the FAITHFUL Algorithm-1 beam ({@link adaptiveTraversalSearch},
 * `innerSearch:'traversal'`, the default — the graph substrate stays the engine) or the plain base search
 * (`'base'`, deterministic/CI-safe). Rounds merge via weighted RRF ({@link reciprocalRankFusion}) with
 * per-round weight decay so round-0 anchors stay primary and later hops only ADD recall.
 *
 * Default-OFF: surfaced via `intentAwareSearch({ multiHop: true })`; never alters today's prod path.
 */
import type Database from 'better-sqlite3'
import type { SearchResult } from './search.js'
import { adaptiveTraversalSearch, type TraversalOptions } from './adaptive-traversal.js'
import { SCNS_GAZETTEER, type GazetteerEntry } from './entities/gazetteer.js'
import { resolveQueryEntities } from './entities/learned-vocab.js'
import type { SemanticRelevanceScorer } from './semantic-relevance.js'
import { reciprocalRankFusion, fusedResultsToSearchResults, type FusionSource } from './fusion.js'

/** Query → ranked chunks (the hybrid FTS+vector inner retriever). Mirrors intent-search BaseSearch. */
type BaseSearch = (query: string, topK: number) => Promise<readonly SearchResult[]>

/** Follow-up rounds AFTER round 0 (IRCoT-style hop budget). */
export const DEFAULT_MULTIHOP_MAX_ROUNDS = 2
/** Follow-up queries issued per round (bounded fan-out). */
export const DEFAULT_MULTIHOP_MAX_FOLLOWUPS = 3
/** RRF weight decay per round: round r's sources weigh decay^r, so anchors stay primary. */
export const DEFAULT_MULTIHOP_ROUND_DECAY = 0.5

/**
 * Proposes follow-up queries for the next hop from everything retrieved so far. `round` is 1-based
 * (the round the proposals will feed). Returning [] ends the loop.
 */
export type FollowupProposer = (
  query: string,
  resultsSoFar: readonly SearchResult[],
  round: number,
) => Promise<readonly string[]>

export interface MultiHopOptions {
  /** Follow-up rounds after round 0. Default {@link DEFAULT_MULTIHOP_MAX_ROUNDS}. */
  readonly maxRounds?: number
  /** Max follow-up queries per round. Default {@link DEFAULT_MULTIHOP_MAX_FOLLOWUPS}. */
  readonly maxFollowupsPerRound?: number
  /** Per-round RRF weight decay. Default {@link DEFAULT_MULTIHOP_ROUND_DECAY}. */
  readonly roundDecay?: number
  readonly gazetteer?: readonly GazetteerEntry[]
  /** Injectable follow-up proposer (the LLM/IRCoT seam). Default {@link bridgeEntityFollowups}. */
  readonly proposeFollowups?: FollowupProposer
  /**
   * Per-round inner retriever: `'traversal'` (default) = the faithful Alg-1 beam over the graph;
   * `'base'` = the injected base search verbatim (deterministic, embedding-free).
   */
  readonly innerSearch?: 'traversal' | 'base'
  /** Beam tuning forwarded when `innerSearch` is `'traversal'`. */
  readonly traversalOptions?: TraversalOptions
  /** Cosine(query, chunk) scorer forwarded to the traversal inner retriever. */
  readonly semanticRelevance?: SemanticRelevanceScorer
}

/**
 * The DEFAULT graph-native follow-up proposer: BRIDGE ENTITIES. Entities linked via `memory_edges`
 * entity rows to the retrieved chunks, EXCLUDING entities already named in the query (gazetteer match
 * or literal substring), ranked by link frequency across the retrieved set (desc) then name (asc),
 * capped at `max`. Each becomes the follow-up query `"<entity> <query>"`. Pure read; deterministic.
 */
export function bridgeEntityFollowups(
  db: Database.Database,
  query: string,
  results: readonly SearchResult[],
  opts: { readonly gazetteer?: readonly GazetteerEntry[]; readonly max?: number } = {},
): string[] {
  const ids = [...new Set(results.map((r) => r.chunkId))]
  if (ids.length === 0) return []
  const max = opts.max ?? DEFAULT_MULTIHOP_MAX_FOLLOWUPS
  const gazetteer = opts.gazetteer ?? SCNS_GAZETTEER
  const rows = db
    .prepare(
      `SELECT me.name AS name, COUNT(*) AS freq
         FROM memory_edges e
         JOIN memory_entities me ON me.id = e.dst_entity
        WHERE e.edge_type = 'entity' AND e.src_chunk IN (${ids.map(() => '?').join(',')})
        GROUP BY me.name
        ORDER BY freq DESC, me.name ASC`,
    )
    .all(...ids) as Array<{ name: string; freq: number }>
  const qLower = query.toLowerCase()
  const namedInQuery = new Set(
    resolveQueryEntities(db, query, gazetteer).map((m) => m.canonical.toLowerCase()),
  )
  const out: string[] = []
  for (const r of rows) {
    const n = r.name.toLowerCase()
    if (namedInQuery.has(n) || qLower.includes(n)) continue
    out.push(`${r.name} ${query}`)
    if (out.length >= max) break
  }
  return out
}

/**
 * Iterative multi-hop retrieval (IRCoT/FLARE family, deterministic default). Round 0 retrieves for the
 * original query; each subsequent round issues the proposer's follow-up queries (never re-asking one),
 * merging every round via weighted RRF with per-round decay; the loop stops on zero information gain
 * (no unseen chunk this round), an empty/duplicate-only proposal, or `maxRounds`. Returns the fused
 * top-K. `[]` for `topK <= 0` or an empty round 0.
 */
export async function multiHopIterativeSearch(
  db: Database.Database,
  query: string,
  topK: number,
  baseSearch: BaseSearch,
  options: MultiHopOptions = {},
): Promise<readonly SearchResult[]> {
  if (topK <= 0) return []
  const maxRounds = options.maxRounds ?? DEFAULT_MULTIHOP_MAX_ROUNDS
  const maxFollowups = options.maxFollowupsPerRound ?? DEFAULT_MULTIHOP_MAX_FOLLOWUPS
  const decay = options.roundDecay ?? DEFAULT_MULTIHOP_ROUND_DECAY
  const gazetteer = options.gazetteer ?? SCNS_GAZETTEER
  const inner: (q: string) => Promise<readonly SearchResult[]> =
    (options.innerSearch ?? 'traversal') === 'traversal'
      ? (q) =>
          adaptiveTraversalSearch(db, q, topK, baseSearch, {
            gazetteer,
            ...(options.semanticRelevance ? { semanticRelevance: options.semanticRelevance } : {}),
            ...(options.traversalOptions ?? {}),
          })
      : (q) => baseSearch(q, topK)
  const propose: FollowupProposer =
    options.proposeFollowups ??
    (async (q, resultsSoFar) =>
      bridgeEntityFollowups(db, q, resultsSoFar, { gazetteer, max: maxFollowups }))

  const round0 = await inner(query)
  if (round0.length === 0) return []

  const sources: FusionSource[] = [{ name: 'round0', weight: 1, items: round0 }]
  const seen = new Set<number>(round0.map((r) => r.chunkId))
  const asked = new Set<string>([query])
  const accumulated: SearchResult[] = [...round0]

  for (let round = 1; round <= maxRounds; round++) {
    const proposals = (await propose(query, accumulated, round))
      .filter((q) => !asked.has(q))
      .slice(0, maxFollowups)
    if (proposals.length === 0) break
    let newFound = 0
    for (const [j, fq] of proposals.entries()) {
      asked.add(fq)
      const res = await inner(fq)
      if (res.length === 0) continue
      sources.push({ name: `round${round}.${j}`, weight: decay ** round, items: res })
      for (const r of res) {
        if (!seen.has(r.chunkId)) {
          seen.add(r.chunkId)
          accumulated.push(r)
          newFound++
        }
      }
    }
    if (newFound === 0) break // the FLARE/DRAGIN information-need stop: nothing new ⇒ no further need
  }

  return fusedResultsToSearchResults(
    reciprocalRankFusion(sources, {
      // Honor the Stage-4 serialize-all-visited contract exactly as `adaptiveTraversalSearch` does
      // (`returnCap` there). Capping at `topK` here made this arm pay for every follow-up traversal
      // and then discard ~94% of what it retrieved: measured live on the briefing path (topK=5,
      // returnBudget=200) the traversal arm returned 421 chars of chunk-ids and this arm 36 — ~1/16th
      // the context for ~2.7x the latency, which made it strictly dominated by construction.
      limit: Math.max(topK, options.traversalOptions?.returnBudget ?? topK),
    }),
  )
}
