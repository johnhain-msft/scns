/**
 * Causal-edge READ MVP (M1.3, design-m1.md §5) — the "WHY" half of the causal subspace.
 *
 * `memory_causal` was WRITE-ONLY: the dream slow-path infers + persists (cause→effect)
 * edges (`causal-edges.persistCausalEdges`) but nothing ever read them back, so the
 * intent router's WHY branch stayed a stub (`intent-search.ts`: WHY ⇒ baseSearch). This
 * module is the reader: for an entity it returns that entity's causal-edge neighborhood
 * (the cause→effect chains anchored on it), so a "why did X …" query can be answered
 * from the inferred causal graph instead of falling back to lexical search.
 *
 * Re-chunk safety (design-m1.md §3-4): `memory_causal` rows are keyed on STABLE content
 * hashes (`causalKey`), NOT the volatile `chunks.id`, so an adopted edge survives
 * re-indexing. The reader therefore resolves each cause/effect key back to live chunk
 * content BEST-EFFORT — if a chunk was re-chunked away, its content is '' but the edge
 * (and its human-readable `rationale`) is still surfaced. The edge is dropped from the
 * caller's results only if it carries no usable text at all (see `intent-search`).
 */

import type Database from 'better-sqlite3'
import { canonicalize, SCNS_GAZETTEER, type GazetteerEntry } from './entities/gazetteer.js'
import { buildCausalKeyToChunk } from './causal-edges.js'

/** One resolved causal chain: an inferred (cause→effect) edge anchored on an entity. */
export interface CausalChain {
  /** Stable content-hash of the cause text (the `memory_causal` row key). */
  readonly causeKey: string
  /** Stable content-hash of the effect text. */
  readonly effectKey: string
  /** Gazetteer canonical anchor the edge was inferred under (nullable). */
  readonly entity: string | null
  /** The judge's short cause→effect explanation (nullable). */
  readonly rationale: string | null
  /** Inferred confidence in [0,1]. */
  readonly confidence: number
  /** Live cause-chunk content, or '' if it was re-chunked away (best-effort). */
  readonly causeContent: string
  /** Live effect-chunk content, or '' if it was re-chunked away (best-effort). */
  readonly effectContent: string
  /** Live cause-chunk id, or null when unresolved. */
  readonly causeChunkId: number | null
  /** Live effect-chunk id, or null when unresolved. */
  readonly effectChunkId: number | null
}

export interface CausalNeighborhoodOptions {
  /** Cap the result to the N highest-confidence edges. */
  readonly limit?: number
  /** Override the gazetteer used for alias→canonical resolution. */
  readonly gazetteer?: readonly GazetteerEntry[]
  /**
   * Also resolve `name` against the LEARNED (App-C.1) vocabulary when it is not a gazetteer surface
   * (A-div2 query-side; symmetric with `entityNeighborhood`). Default OFF ⇒ gazetteer-only.
   */
  readonly learnedEntityQuery?: boolean
}

interface CausalRow {
  causeKey: string
  effectKey: string
  entity: string | null
  rationale: string | null
  confidence: number
}

/**
 * Return the causal-edge neighborhood of `name` (canonical or any alias): the inferred
 * (cause→effect) chains anchored on that entity in `memory_causal`, highest-confidence
 * first. With `limit`, the top-N by confidence are returned. Returns [] for an unknown
 * entity or one with no causal edges. The cause/effect content is resolved from live
 * chunks best-effort (re-chunk-safe; the `rationale` is always carried).
 */
export function causalNeighborhood(
  db: Database.Database,
  name: string,
  options: CausalNeighborhoodOptions = {},
): CausalChain[] {
  const gazetteer = options.gazetteer ?? SCNS_GAZETTEER
  const canonical =
    canonicalize(name, gazetteer) ?? (options.learnedEntityQuery ? name : undefined)
  if (!canonical) return []

  const params: unknown[] = [canonical]
  let limitClause = ''
  if (typeof options.limit === 'number' && options.limit >= 0) {
    limitClause = 'LIMIT ?'
    params.push(options.limit)
  }

  const rows = db
    .prepare(
      `SELECT cause_key AS causeKey, effect_key AS effectKey, entity, rationale, confidence
       FROM memory_causal
       WHERE entity = ?
       ORDER BY confidence DESC, id DESC
       ${limitClause}`,
    )
    .all(...params) as CausalRow[]
  if (rows.length === 0) return []

  const keyToChunk = buildCausalKeyToChunk(db)
  return rows.map((r) => {
    const cause = keyToChunk.get(r.causeKey)
    const effect = keyToChunk.get(r.effectKey)
    return {
      causeKey: r.causeKey,
      effectKey: r.effectKey,
      entity: r.entity,
      rationale: r.rationale,
      confidence: r.confidence,
      causeContent: cause?.content ?? '',
      effectContent: effect?.content ?? '',
      causeChunkId: cause?.id ?? null,
      effectChunkId: effect?.id ?? null,
    }
  })
}

/**
 * Render one causal chain into a single human/agent-readable block: the cause and effect
 * text joined by a causal arrow, with the judge's rationale appended. Falls back to
 * whichever side(s) resolved + the rationale, so a re-chunked edge still surfaces its
 * explanation. Returns '' when the chain carries no usable text at all (caller drops it).
 */
export function formatCausalChain(chain: CausalChain): string {
  const cause = chain.causeContent.trim()
  const effect = chain.effectContent.trim()
  const rationale = chain.rationale?.trim() ?? ''

  const parts: string[] = []
  if (cause && effect) parts.push(`${cause}\n→ led to →\n${effect}`)
  else if (effect) parts.push(effect)
  else if (cause) parts.push(cause)
  if (rationale) parts.push(`Why: ${rationale}`)

  return parts.join('\n')
}

/**
 * TOPOLOGICAL cause-ordering of a causal neighborhood (MAGMA paper Stage 4). The confidence sort
 * alone loses the cause→effect story: given edges (A→B), (B→C), (C→D) it may emit them in an order
 * that reads effects before their causes. This performs a deterministic Kahn topological sort over
 * the chain DAG — an edge X causally PRECEDES edge Y when `X.effectKey === Y.causeKey` — so a root
 * cause is emitted before the effect it leads to. Ties (independent roots / forks) break by
 * (confidence desc, causeKey, effectKey, input index) for full determinism. Cycle-safe: any chains
 * left in a cycle (should not occur for a DAG of inferred edges) are appended in the same tie-break
 * order rather than dropped or looped. Pure + side-effect-free.
 */
export function topologicalOrderCausalChains(chains: readonly CausalChain[]): CausalChain[] {
  if (chains.length <= 1) return [...chains]

  const n = chains.length
  const byCauseKey = new Map<string, number[]>()
  for (let i = 0; i < n; i++) {
    const arr = byCauseKey.get(chains[i]!.causeKey)
    if (arr) arr.push(i)
    else byCauseKey.set(chains[i]!.causeKey, [i])
  }

  const adj: number[][] = Array.from({ length: n }, () => [])
  const indeg = new Array<number>(n).fill(0)
  for (let i = 0; i < n; i++) {
    // Successors: chains whose CAUSE is this chain's EFFECT (this edge precedes them).
    for (const j of byCauseKey.get(chains[i]!.effectKey) ?? []) {
      if (j === i) continue
      adj[i]!.push(j)
      indeg[j] = (indeg[j] ?? 0) + 1
    }
  }

  const tieBreak = (a: number, b: number): number => {
    const ca = chains[a]!
    const cb = chains[b]!
    if (ca.confidence !== cb.confidence) return cb.confidence - ca.confidence
    if (ca.causeKey !== cb.causeKey) return ca.causeKey < cb.causeKey ? -1 : 1
    if (ca.effectKey !== cb.effectKey) return ca.effectKey < cb.effectKey ? -1 : 1
    return a - b
  }

  const emitted = new Set<number>()
  const out: CausalChain[] = []
  const ready: number[] = []
  for (let i = 0; i < n; i++) if ((indeg[i] ?? 0) === 0) ready.push(i)
  ready.sort(tieBreak)

  while (ready.length > 0) {
    const u = ready.shift()!
    if (emitted.has(u)) continue
    emitted.add(u)
    out.push(chains[u]!)
    for (const v of adj[u]!) {
      indeg[v] = (indeg[v] ?? 0) - 1
      if ((indeg[v] ?? 0) === 0) ready.push(v)
    }
    ready.sort(tieBreak)
  }

  // Cycle-safe remainder: anything not emitted (a cycle) appended deterministically.
  if (emitted.size < n) {
    const rest: number[] = []
    for (let i = 0; i < n; i++) if (!emitted.has(i)) rest.push(i)
    rest.sort(tieBreak)
    for (const i of rest) out.push(chains[i]!)
  }

  return out
}
