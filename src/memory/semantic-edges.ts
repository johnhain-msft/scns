/**
 * Derived memory edges — DETERMINISTIC SEMANTIC layer (the next MAGMA subspace after
 * entity/temporal; design-m1.md §4-5).
 *
 * A semantic edge links two chunks whose stored embeddings are near in vector space —
 * the associative-recall substrate MAGMA uses to reach related facts that share no
 * surface tokens. Unlike the CAUSAL tier (an LLM judge over event pairs, persistence-
 * blocked on a telemetry-heavy vault), semantic similarity is fully DETERMINISTIC and
 * POPULATABLE today: it is read directly from the `chunk_embeddings` sqlite-vec table
 * (the BGE-small vectors already stored at index time), with NO embedding worker and
 * NO LLM in the path.
 *
 * Like the entity/temporal edges (`entities/edges.ts`) it is a pure function of current
 * content (here, the stored vectors), so it is RECOMPUTED each content-changing index
 * pass rather than persisted incrementally — `chunks.id` is AUTOINCREMENT and chunks are
 * deleted+reinserted (NEW id) on change, which would orphan any id-keyed edge. It writes
 * into the SAME `memory_edges` table as entity/temporal but under `edge_type='semantic'`,
 * and clears ONLY its own type before rebuilding (idempotent).
 *
 * ORDERING CONTRACT (critical): `rebuildMemoryEdges` (entity/temporal) does an unscoped
 * `DELETE FROM memory_edges` and so wipes semantic edges too. {@link buildSemanticEdges}
 * MUST therefore run AFTER `rebuildMemoryEdges` within an index pass (the indexer's
 * `maybeBuildSemanticEdges` enforces this), never before.
 *
 * Edge: chunk_src --[semantic]--> chunk_dst (source 'embedding', weight=similarity in
 * (0,1], higher = nearer). Directed per-source: each chunk points at its OWN nearest
 * neighbors, so the reader resolves a chunk's neighborhood with a simple `src_chunk = ?`
 * lookup (symmetric with the entity-neighborhood read path).
 */

import type Database from 'better-sqlite3'
import { logger } from '../shared/logger.js'

/** Default max nearest neighbors linked per chunk. */
export const DEFAULT_SEMANTIC_TOP_N = 5
/**
 * Default L2-distance ceiling for a kept edge. Grounded on the live vault's neighbor
 * distance distribution (2026-06-27, 209 chunks): p50≈0.50, p75≈0.57, p90≈0.64 — so
 * 0.6 keeps the closer ~80% of neighbors and drops the far tail. Tunable per call.
 */
export const DEFAULT_SEMANTIC_MAX_DISTANCE = 0.6

export interface SemanticEdgeOptions {
  /** Max nearest neighbors per chunk. Default {@link DEFAULT_SEMANTIC_TOP_N}. */
  readonly topN?: number
  /** Drop neighbors whose L2 distance exceeds this. Default {@link DEFAULT_SEMANTIC_MAX_DISTANCE}. */
  readonly maxDistance?: number
  /** Skip neighbors in the SAME source file (keep only cross-document edges). Default false. */
  readonly excludeSameFile?: boolean
}

export interface SemanticEdgeStats {
  /** Chunks that had a stored embedding (the KNN source set). */
  readonly chunksProcessed: number
  /** Semantic edges inserted. */
  readonly semanticEdges: number
}

interface EmbRow {
  chunk_id: number
  embedding: Buffer
}

interface KnnRow {
  chunk_id: number
  distance: number
}

/**
 * Recompute the deterministic semantic edge set from the current `chunk_embeddings`
 * (sqlite-vec vec0) table. For each chunk it runs a KNN over the stored vectors and links
 * the `topN` nearest neighbors within `maxDistance` (excluding self, and same-file when
 * `excludeSameFile`). Idempotent: clears ONLY `edge_type='semantic'` then rebuilds. Does
 * NOT open its own transaction (better-sqlite3 forbids nesting), so the caller wraps it —
 * and MUST call it AFTER `rebuildMemoryEdges` (which unscoped-deletes `memory_edges`).
 *
 * Pure read of stored vectors: no embedding worker, no network, no LLM. Returns 0 edges
 * when there are no embeddings (e.g. the FTS-only `indexVaultSync` path).
 */
export function buildSemanticEdges(
  db: Database.Database,
  options: SemanticEdgeOptions = {},
): SemanticEdgeStats {
  const topN =
    typeof options.topN === 'number' && options.topN > 0 ? Math.floor(options.topN) : DEFAULT_SEMANTIC_TOP_N
  const maxDistance =
    typeof options.maxDistance === 'number' && options.maxDistance >= 0
      ? options.maxDistance
      : DEFAULT_SEMANTIC_MAX_DISTANCE
  const excludeSameFile = options.excludeSameFile ?? false

  // Clear ONLY our own edge type — entity/temporal rows (rebuilt by rebuildMemoryEdges
  // immediately before us) must survive.
  db.prepare("DELETE FROM memory_edges WHERE edge_type = 'semantic'").run()

  // Source the KNN from embeddings whose chunk is STILL LIVE (joined to `chunks`). An
  // orphaned vec0 embedding (chunk_id no longer in `chunks` — see pruneOrphanedEmbeddings)
  // must never become an edge endpoint: memory_edges.src_chunk/dst_chunk carry a FK to
  // chunks(id), so a stale id would violate it. Filtering here makes the build FK-safe
  // independent of prune ordering.
  const embRows = db
    .prepare(
      `SELECT ce.chunk_id AS chunk_id, ce.embedding AS embedding
       FROM chunk_embeddings ce JOIN chunks c ON c.id = ce.chunk_id`,
    )
    .all() as EmbRow[]
  if (embRows.length === 0) return { chunksProcessed: 0, semanticEdges: 0 }

  const liveIds = new Set(embRows.map((r) => r.chunk_id))

  const fileOf = new Map<number, string>()
  if (excludeSameFile) {
    for (const r of db.prepare('SELECT id, file_path FROM chunks').all() as Array<{
      id: number
      file_path: string
    }>) {
      fileOf.set(r.id, r.file_path)
    }
  }

  // Over-fetch so self + orphan + (optionally) same-file neighbors can be filtered without
  // starving topN.
  const fetchK = Math.min(
    embRows.length + 1,
    excludeSameFile ? topN * 4 + 1 : topN + 2,
  )

  const knn = db.prepare(
    `SELECT chunk_id, distance FROM chunk_embeddings
     WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
  )
  const insertEdge = db.prepare(
    `INSERT INTO memory_edges (src_chunk, edge_type, dst_chunk, weight, source, confidence)
     VALUES (?, 'semantic', ?, ?, 'embedding', ?)`,
  )

  let semanticEdges = 0
  for (const row of embRows) {
    const srcFile = excludeSameFile ? fileOf.get(row.chunk_id) : undefined
    const neighbors = (knn.all(row.embedding, fetchK) as KnnRow[])
      .filter(
        (n) => n.chunk_id !== row.chunk_id && liveIds.has(n.chunk_id) && n.distance <= maxDistance,
      )
      .filter((n) => !excludeSameFile || fileOf.get(n.chunk_id) !== srcFile)
      // Deterministic tie-break: nearest first, then by id.
      .sort((a, b) => a.distance - b.distance || a.chunk_id - b.chunk_id)
      .slice(0, topN)

    for (const n of neighbors) {
      const similarity = 1 / (1 + n.distance) // L2 distance → (0,1], higher = nearer
      insertEdge.run(row.chunk_id, n.chunk_id, similarity, similarity)
      semanticEdges++
    }
  }

  if (semanticEdges > 0) {
    logger.debug({ chunksProcessed: embRows.length, semanticEdges }, 'Built semantic edges')
  }
  return { chunksProcessed: embRows.length, semanticEdges }
}
