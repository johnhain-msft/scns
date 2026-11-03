/**
 * Adaptive Traversal Policy — MAGMA Algorithm 1 (Heuristic Beam Search), the component whose ABSENCE
 * is the paper's single biggest ablation loss (Table 4: 0.700→0.637).
 *
 * The existing `fusionSearch` is a single-pass weighted RRF list-blend: it fuses a few precomputed
 * candidate lists ONCE. It is NOT a graph traversal — it cannot reach a node connected to an anchor
 * only via a typed edge (the buried-fact / multi-hop case). This module implements that missing piece
 * LITERALLY to the paper (§3.3 Stage 3):
 *
 *   Stage 1 (anchors):  Sanchor = baseSearch(query)  — hybrid FTS+vector RRF entry points (Eq. 4).
 *   Stage 3 (traverse): a beam expands NEIGHBORS over the typed edge graphs (entity/semantic/temporal/
 *     causal). Each transition is scored by the LITERAL Eq. 5
 *         S(nj|ni,q) = exp( λ1·φ(type(eij),Tq) + λ2·sim(⃗nj,q⃗) )                       (Alg. 1 line 11)
 *     where φ (Eq. 6) = wTq[type] is the intent-adaptive edge weight (Table 6 scale, e.g. WHY→causal)
 *     and sim = cosine(query, nj). A node's cumulative score is `scoreu·γ + S` (decay γ, Alg. 1 line 12).
 *     At each depth the top-`beamWidth` candidates form the next frontier (Alg. 1 line 17), up to
 *     `maxDepth` hops or the visited `budget` (Alg. 1 line 19).
 *
 *   DropThreshold (Table 6 = 0.15): a RELATIVE per-hop cosine-drop prune — a neighbor v of u is skipped
 *     when `sim(u,q) − sim(v,q) > dropThreshold` (the path's query relevance collapsed). This is the
 *     OSS `_adaptive_graph_traversal` `relative_drop_threshold` (memory/query_engine.py:1099-1104; prune at
 *     :1158 / :1189-1192, on `_cosine_similarity(query,node)`). It gates the cosine term, NOT the raw
 *     exp score (which with wcausal 3–5 is always ≫0.15), so the beam follows structure only while the
 *     semantic thread holds — the paper's dual "structure (φ) × contextual focus (sim)" signal.
 *
 *   NOTE — causal is LIVE since WS-2b: `materializeCausalEdges` (causal-edges.ts) bridges the
 *     content-hash-keyed `memory_causal` table into chunk→chunk `memory_edges` rows with
 *     edge_type='causal' (direction 'both'), which `neighbors(u,'causal')` below reads. The causal beam
 *     dimension contributes whenever the causal tier is populated (0 on a telemetry-only vault where
 *     `memory_causal` is empty; >0 on a conversational corpus that infers causes).
 *
 * Default-OFF: surfaced via `intentAwareSearch({ traverse: true })`; never alters today's prod path.
 */
import type Database from 'better-sqlite3'
import type { SearchResult } from './search.js'
import { classifyIntent, type QueryIntent } from './intent.js'
import { SCNS_GAZETTEER, type GazetteerEntry } from './entities/gazetteer.js'
import { makeSemanticRelevanceScorer, type SemanticRelevanceScorer } from './semantic-relevance.js'

/** Query → ranked chunks (the hybrid FTS+vector anchor source). Mirrors intent-search BaseSearch. */
type BaseSearch = (query: string, topK: number) => Promise<readonly SearchResult[]>

export type EdgeType = 'entity' | 'semantic' | 'temporal' | 'causal'

/** Per-edge-type structural weights φ(type, Tq) — the intent's "steering wheel" (Eq. 6). */
export type EdgeWeights = Readonly<Record<EdgeType, number>>

/**
 * Intent-adaptive edge weights wTq (Eq. 6 / Table 6) — the structural-alignment coefficients fed to
 * exp(λ1·φ + …) in Eq. 5. Values are on the Table-6 scale (wentity 2.5–6.0, wtemporal 0.5–4.0,
 * wcausal 3.0–5.0; wsemantic has no explicit Table-6 row, so it uses the wphrase associative range
 * 2.5–5.0). Each intent emphasises its own axis (ENTITY→entity, WHY→causal, WHEN→temporal high).
 */
export const DEFAULT_INTENT_WEIGHTS: Readonly<Record<QueryIntent, EdgeWeights>> = {
  ENTITY: { entity: 6.0, semantic: 3.0, temporal: 1.0, causal: 3.0 },
  WHY: { causal: 5.0, entity: 3.0, semantic: 3.0, temporal: 1.0 },
  WHEN: { temporal: 4.0, entity: 3.0, semantic: 3.0, causal: 3.0 },
  DEFAULT: { entity: 3.0, semantic: 3.0, temporal: 1.0, causal: 3.0 },
}

/** Eq. 5 global coefficient defaults (Table 6: λ1 = 1.0 base, λ2 ∈ [0.3,0.7] → 0.5). */
export const DEFAULT_LAMBDA1 = 1.0
export const DEFAULT_LAMBDA2 = 0.5
/** Table 6 DropThreshold — the relative per-hop cosine-drop prune. */
export const DEFAULT_DROP_THRESHOLD = 0.15
/** Table 6 Max Depth (5 hops) and Max Nodes (200). */
export const DEFAULT_MAX_DEPTH = 5
export const DEFAULT_BUDGET = 200
/** Table 6 Vector Top-K hybrid anchor pool (reference query_engine.py fusion pool); research R1 raises 8→20. */
export const DEFAULT_ANCHOR_POOL = 20

export interface TraversalOptions {
  readonly gazetteer?: readonly GazetteerEntry[]
  /** Max beam-search depth (hops). Table 6: 5. */
  readonly maxDepth?: number
  /** Candidates kept per depth (Alg. 1 line 17). Default 8. */
  readonly beamWidth?: number
  /** Per-hop score decay γ (Alg. 1 line 12). Default 0.5. */
  readonly decay?: number
  /** Eq. 5 structural coefficient λ1. Table 6: 1.0. */
  readonly lambda1?: number
  /** Eq. 5 semantic coefficient λ2. Table 6: 0.3–0.7 (default 0.5). */
  readonly lambda2?: number
  /** Relative per-hop cosine-drop prune (Table 6 DropThreshold). Default 0.15. */
  readonly dropThreshold?: number
  /** Stop once this many nodes are visited (Alg. 1 line 19). Table 6: 200. */
  readonly budget?: number
  /** Hybrid anchor pool seeded before traversal (Table 6 Vector Top-K). research R1 default 20. */
  readonly anchorPool?: number
  /**
   * MAGMA Alg 1 lines 22-23 — the number of Visited nodes to SERIALIZE into the returned subgraph
   * (`return Serialize(Csorted)`), before Stage-4 (Eq. 7) token-budgets it. Default = the caller's `topK`
   * (byte-identical legacy behavior). The MAGMA/Stage-4 path passes the traversal `budget` so the WHOLE
   * anchor-floor ∪ reached-node set flows to Stage-4 — the graph AUGMENTS the anchors instead of the
   * `topK`-forced 1-for-1 swap. Only ever RAISES the boundary; never below `topK`.
   */
  readonly returnBudget?: number
  /** Override intent→edge-weight table (Eq. 6 / Table 6). */
  readonly intentWeights?: Readonly<Record<QueryIntent, EdgeWeights>>
  /** Cosine(query, chunk) scorer; built from the vault if omitted. */
  readonly semanticRelevance?: SemanticRelevanceScorer
  /**
   * Phase D readout (BEYOND the paper; plan §9 — "make the beam actually read memory_edges.weight"):
   * when ON, each transition's structural term is scaled by the edge's LEARNED weight —
   * `suv = exp(λ1·φ·w_edge + λ2·sim)` — so reinforced paths (w>1) rank above decayed ones (w<1).
   * Default OFF ⇒ the literal Eq-5 beam, byte-identical; and since the schema default weight is 1.0,
   * ON is ALSO identical until reinforcement actually moves a weight. Flipping this lever live is a
   * routing-policy change: it stays OFF pending a certified win on the judged gate (AGENTS.md #9).
   */
  readonly useEdgeWeights?: boolean
}

const EDGE_TYPES: readonly EdgeType[] = ['entity', 'semantic', 'temporal', 'causal']

/**
 * Neighbors of `chunkId` over one typed edge graph, each with its LEARNED edge weight. Entity edges
 * bridge chunk→entity→chunks (bridge weight = mean of the two entity-edge weights, aggregated AVG over
 * shared entities); parallel chunk→chunk edges collapse to their MAX weight.
 */
function neighbors(
  db: Database.Database,
  chunkId: number,
  type: EdgeType,
): Array<{ v: number; w: number }> {
  if (type === 'entity') {
    return db
      .prepare(
        `SELECT e2.src_chunk AS v, AVG((e1.weight + e2.weight) / 2.0) AS w
           FROM memory_edges e1
           JOIN memory_edges e2
             ON e2.dst_entity = e1.dst_entity AND e2.edge_type = 'entity'
          WHERE e1.src_chunk = ? AND e1.edge_type = 'entity' AND e2.src_chunk != e1.src_chunk
          GROUP BY e2.src_chunk`,
      )
      .all(chunkId) as Array<{ v: number; w: number }>
  }
  return db
    .prepare(
      `SELECT dst_chunk AS v, MAX(weight) AS w
         FROM memory_edges
        WHERE src_chunk = ? AND edge_type = ? AND dst_chunk IS NOT NULL
        GROUP BY dst_chunk`,
    )
    .all(chunkId, type) as Array<{ v: number; w: number }>
}

/**
 * Run the adaptive traversal (MAGMA Algorithm 1). Returns up to `returnBudget` (default `topK`) chunks from
 * the deduped union `anchors ∪ traversed` (= Visited, Alg. 1 lines 22-23 `return Serialize(Csorted)`). Final
 * admission preserves a minimum hybrid-anchor floor (each anchor flagged `isAnchor`) while filling the
 * remaining budget by the question-conditioned Eq. 5 transition salience `exp(λ1·φ(type,Tq)+λ2·sim)` so the
 * graph AUGMENTS anchors instead of collapsing to either pure cosine (causal starvation) or pure cumulative
 * beam score (anchor eviction). The MAGMA/Stage-4 path raises `returnBudget` to the traversal `budget` so the
 * WHOLE Visited subgraph flows to Stage-4 (Eq. 7) for salience-token budgeting; legacy callers keep the
 * topK-bounded return byte-identically. Falls back to anchors verbatim when there are no edges to traverse.
 */
export async function adaptiveTraversalSearch(
  db: Database.Database,
  query: string,
  topK: number,
  baseSearch: BaseSearch,
  options: TraversalOptions = {},
): Promise<readonly SearchResult[]> {
  if (topK <= 0) return []
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  const beamWidth = options.beamWidth ?? 8
  const decay = options.decay ?? 0.5
  const lambda1 = options.lambda1 ?? DEFAULT_LAMBDA1
  const lambda2 = options.lambda2 ?? DEFAULT_LAMBDA2
  const dropThreshold = options.dropThreshold ?? DEFAULT_DROP_THRESHOLD
  const budget = options.budget ?? DEFAULT_BUDGET
  const gazetteer = options.gazetteer ?? SCNS_GAZETTEER
  const weightTable = options.intentWeights ?? DEFAULT_INTENT_WEIGHTS
  const useEdgeWeights = options.useEdgeWeights ?? false
  const intent = classifyIntent(query, gazetteer)
  const w = weightTable[intent]
  const sim = options.semanticRelevance ?? makeSemanticRelevanceScorer(db, query)

  // Stage 1: anchors (hybrid RRF). Seed each anchor's cumulative score with the semantic-only Eq. 5
  // transition exp(λ2·sim) (φ = 0 — no edge was traversed to reach an anchor), so anchors and reached
  // nodes share one scale.
  const anchorPool = Math.max(topK, options.anchorPool ?? DEFAULT_ANCHOR_POOL)
  const anchors = await baseSearch(query, anchorPool)
  if (anchors.length === 0) return []

  const relevance = new Map<number, number>() // cosine(query, node) for every touched node
  const score = new Map<number, number>() // Alg. 1 cumulative beam score
  const admission = new Map<number, number>() // final dual φ×sim salience (Eq. 5 log-space)
  const anchorRel = await sim(anchors.map((a) => a.chunkId))
  let frontier: number[] = []
  const visited = new Set<number>()
  const anchorIds: number[] = []
  for (const a of anchors) {
    const rel = anchorRel.get(a.chunkId) ?? 0
    relevance.set(a.chunkId, rel)
    score.set(a.chunkId, Math.exp(lambda2 * rel))
    admission.set(a.chunkId, lambda2 * rel)
    frontier.push(a.chunkId)
    visited.add(a.chunkId)
    anchorIds.push(a.chunkId)
  }

  // Stage 3: intent-weighted beam search over typed edges (Alg. 1 lines 5–21).
  for (let depth = 1; depth <= maxDepth; depth++) {
    if (visited.size >= budget) break // Alg. 1 line 19 (Budget)

    // Enumerate frontier→neighbor transitions (u, v, intent weight φ, learned edge weight wEdge).
    const pending: Array<{ u: number; v: number; phi: number; wEdge: number }> = []
    const toScore = new Set<number>()
    for (const u of frontier) {
      for (const type of EDGE_TYPES) {
        const phi = w[type]
        if (phi <= 0) continue
        for (const { v, w: wEdge } of neighbors(db, u, type)) {
          if (visited.has(v)) continue
          pending.push({ u, v, phi, wEdge })
          if (!relevance.has(v)) toScore.add(v)
        }
      }
    }
    if (pending.length === 0) break

    // Score cosine(query, v) for the newly touched neighbors.
    if (toScore.size > 0) {
      const simMap = await sim([...toScore])
      for (const id of toScore) relevance.set(id, simMap.get(id) ?? 0)
    }

    // Eq. 5 transition + DropThreshold prune → best cumulative score per neighbor. With the Phase-D
    // readout ON the structural term is scaled by the LEARNED edge weight (φ·wEdge); OFF ⇒ literal Eq. 5.
    const bestByV = new Map<number, number>()
    for (const { u, v, phi, wEdge } of pending) {
      const su = relevance.get(u) ?? 0
      const sv = relevance.get(v) ?? 0
      if (su - sv > dropThreshold) continue // relative per-hop cosine-drop prune (Table 6)
      const phiEff = useEdgeWeights ? phi * wEdge : phi
      const transitionSalience = lambda1 * phiEff + lambda2 * sv
      const suv = Math.exp(transitionSalience) // Eq. 5 / Alg. 1 line 11 (+ Phase-D w_edge)
      const cand = (score.get(u) ?? 0) * decay + suv // Alg. 1 line 12
      if (!bestByV.has(v) || cand > bestByV.get(v)!) {
        bestByV.set(v, cand)
        admission.set(v, transitionSalience)
      }
    }
    if (bestByV.size === 0) break

    for (const [v, cand] of bestByV) {
      if (!score.has(v) || cand > score.get(v)!) score.set(v, cand)
    }
    // Next frontier = top-beamWidth newly reached nodes by cumulative score (Alg. 1 line 17).
    frontier = [...bestByV.keys()]
      .sort((a, b) => (score.get(b) ?? 0) - (score.get(a) ?? 0))
      .slice(0, beamWidth)
    for (const v of frontier) visited.add(v)
  }

  // MAGMA final context is the WHOLE Visited subgraph (Alg. 1 lines 22-23: `return Serialize(Csorted)`);
  // Stage-4 (Eq. 7) then salience-token-budgets it. SCNS exposes a `returnBudget` boundary before Stage 4:
  // default `topK` (byte-identical legacy) and the MAGMA/Stage-4 path passes the traversal `budget` so the
  // full anchor floor ∪ reached-node set flows to Stage-4 (the graph AUGMENTS the anchors instead of the
  // topK-forced 1-for-1 swap). Admission keeps a minimum anchor floor, then fills by the question-conditioned
  // φ×sim salience that walked the graph — removing the superseded pure-cosine slice that made the magma arm
  // inert, while avoiding the opposite pure-beam anchor-eviction bug.
  const returnCap = Math.max(topK, options.returnBudget ?? topK)
  const anchorSet = new Set<number>(anchorIds)
  const anchorsByRelevance = anchorIds
    .filter((id) => visited.has(id))
    .sort((a, b) => (relevance.get(b) ?? 0) - (relevance.get(a) ?? 0))
  const minAnchorCount =
    visited.size > anchorsByRelevance.length && returnCap > 1
      ? Math.min(
          anchorsByRelevance.length,
          Math.max(1, returnCap - Math.max(1, Math.floor(returnCap / 4))),
        )
      : Math.min(anchorsByRelevance.length, returnCap)
  const selected = new Set<number>(anchorsByRelevance.slice(0, minAnchorCount))
  const remaining = [...visited]
    .filter((id) => !selected.has(id))
    .sort((a, b) => {
      const byAdmission = (admission.get(b) ?? 0) - (admission.get(a) ?? 0)
      if (byAdmission !== 0) return byAdmission
      return (relevance.get(b) ?? 0) - (relevance.get(a) ?? 0)
    })
  for (const id of remaining) {
    if (selected.size >= returnCap) break
    selected.add(id)
  }
  const top = [...selected].sort((a, b) => {
    const byAdmission = (admission.get(b) ?? 0) - (admission.get(a) ?? 0)
    if (byAdmission !== 0) return byAdmission
    return (relevance.get(b) ?? 0) - (relevance.get(a) ?? 0)
  })
  const get = db.prepare(
    `SELECT id AS chunkId, file_path AS filePath, content, chunk_index AS chunkIndex FROM chunks WHERE id = ?`,
  )
  const out: SearchResult[] = []
  for (const id of top) {
    const row = get.get(id) as
      | { chunkId: number; filePath: string; content: string; chunkIndex: number }
      | undefined
    if (!row) continue
    // vectorScore/keywordScore are 0 for graph-derived results (mirrors the fusion → SearchResult
    // convention in fusion.ts); the cumulative beam score (Eq. 5) lives in `score`. Stage-1 anchors are
    // flagged `isAnchor` so Stage-4 (Eq. 7) can protect them from the salience-token budget (retention=1.0).
    const base: SearchResult = { ...row, score: score.get(id) ?? 0, vectorScore: 0, keywordScore: 0 }
    out.push(anchorSet.has(id) ? { ...base, isAnchor: true } : base)
  }
  return out
}
