/**
 * Semantic-edge READ path — the associative "what else relates to this" neighborhood
 * (design-m1.md §5). The complement to the entity/causal readers: where those traverse
 * curated entity links and inferred cause→effect chains, this traverses the DETERMINISTIC
 * embedding-similarity graph built by {@link buildSemanticEdges}.
 *
 * Its distinctive capability is MULTI-HOP associative reach. A chunk's DIRECT (1-hop)
 * semantic neighbors are, by construction, the chunks nearest its embedding — exactly the
 * chunks the hybrid vector search would already surface for a query landing on it. The
 * value the graph adds over single-shot vector search is the SECOND hop: neighbor-of-
 * neighbor chunks that are related transitively (A↔B, B↔C) but NOT near A's own embedding,
 * so a single hybrid query rooted at A never reaches C. A 2-hop walk does.
 *
 * Pure read: a breadth-first walk over `memory_edges` (edge_type='semantic'), no vectors
 * recomputed, no I/O. Seed chunks are excluded from the output; each returned chunk carries
 * the hop at which it was first reached (closest hop wins) and the best edge weight on that
 * discovery, ordered (hop asc, weight desc, id asc).
 */

import type Database from 'better-sqlite3'

export interface SemanticNeighborOptions {
  /** How many edges to traverse from the seeds. 1 = direct neighbors, 2 = +neighbor-of-neighbor. Default 1. */
  readonly hops?: number
  /** Cap the result to the top-N (by hop then weight). */
  readonly limit?: number
}

export interface SemanticNeighbor {
  readonly chunkId: number
  readonly filePath: string
  readonly content: string
  readonly chunkIndex: number
  /** The fewest semantic edges between a seed and this chunk (1 = direct, 2 = via one bridge). */
  readonly hop: number
  /** Best (max) edge weight on this chunk's discovery hop — higher = nearer the discovering node. */
  readonly weight: number
}

interface EdgeRow {
  dst: number
  weight: number
}

interface ChunkRow {
  chunkId: number
  filePath: string
  content: string
  chunkIndex: number
}

interface Discovery {
  hop: number
  weight: number
}

/**
 * Return the semantic neighborhood of `seedChunkIds`: the chunks reachable within `hops`
 * semantic edges, breadth-first. A chunk discovered at an earlier hop keeps that (closer)
 * hop; within a hop the strongest discovering edge weight wins. Seed chunks themselves are
 * excluded. Returns [] for empty seeds, `hops < 1`, or a vault with no semantic edges.
 *
 * Ordering: hop ascending (closest association first), then weight descending, then chunk id.
 */
export function semanticNeighborhood(
  db: Database.Database,
  seedChunkIds: readonly number[],
  options: SemanticNeighborOptions = {},
): SemanticNeighbor[] {
  const hops = typeof options.hops === 'number' && options.hops >= 1 ? Math.floor(options.hops) : 1
  const seedSet = new Set(seedChunkIds)
  if (seedSet.size === 0) return []

  const neighborStmt = db.prepare(
    `SELECT dst_chunk AS dst, weight FROM memory_edges
     WHERE edge_type = 'semantic' AND src_chunk = ?`,
  )

  const discovered = new Map<number, Discovery>()
  let frontier: number[] = [...seedSet]

  for (let hop = 1; hop <= hops; hop++) {
    const nextFrontier = new Set<number>()
    for (const src of frontier) {
      for (const edge of neighborStmt.all(src) as EdgeRow[]) {
        if (seedSet.has(edge.dst)) continue
        const existing = discovered.get(edge.dst)
        if (!existing) {
          // First time seen — record this hop, queue it to expand at the next hop.
          discovered.set(edge.dst, { hop, weight: edge.weight })
          nextFrontier.add(edge.dst)
        } else if (existing.hop === hop && edge.weight > existing.weight) {
          // Seen again at the same hop via a stronger edge — keep the stronger weight.
          existing.weight = edge.weight
        }
        // Seen at an earlier hop ⇒ keep the closer hop (do not demote).
      }
    }
    frontier = [...nextFrontier]
    if (frontier.length === 0) break
  }

  if (discovered.size === 0) return []

  const getChunk = db.prepare(
    `SELECT id AS chunkId, file_path AS filePath, content, chunk_index AS chunkIndex
     FROM chunks WHERE id = ?`,
  )

  const out: SemanticNeighbor[] = []
  for (const [chunkId, d] of discovered) {
    const chunk = getChunk.get(chunkId) as ChunkRow | undefined
    if (!chunk) continue // edge CASCADE makes this unreachable, but stay defensive
    out.push({
      chunkId: chunk.chunkId,
      filePath: chunk.filePath,
      content: chunk.content,
      chunkIndex: chunk.chunkIndex,
      hop: d.hop,
      weight: d.weight,
    })
  }

  out.sort((a, b) => a.hop - b.hop || b.weight - a.weight || a.chunkId - b.chunkId)
  return typeof options.limit === 'number' && options.limit >= 0 ? out.slice(0, options.limit) : out
}
