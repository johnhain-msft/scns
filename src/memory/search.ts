/**
 * Hybrid search engine — combines vector search (sqlite-vec) with
 * keyword search (FTS5). Score = 0.7 * vector + 0.3 * keyword.
 */

import type Database from 'better-sqlite3'
import { generateEmbedding, serializeEmbedding } from './embeddings.js'

export interface SearchConfig {
  readonly vectorWeight: number
  readonly keywordWeight: number
  readonly limit: number
  /**
   * T023 [US2] — observe-only capture of the query embedding the vector path ALREADY computes, so
   * the live experience logger can persist it at zero extra cost (gate #9: never a synchronous embed
   * just to log). Absent ⇒ byte-identical behavior; a throwing observer never breaks the search.
   */
  readonly onQueryEmbedding?: (embedding: Float32Array) => void
}

export interface SearchResult {
  readonly chunkId: number
  readonly filePath: string
  readonly content: string
  readonly score: number
  readonly vectorScore: number
  readonly keywordScore: number
  readonly chunkIndex: number
  /**
   * MAGMA provenance: `true` when this result is a Stage-1 hybrid ANCHOR (an Eq-4 entry point), as opposed
   * to a node reached by Stage-3 graph traversal. Optional (absent on every non-traversal path ⇒ undefined).
   * Stage-4 (Eq. 7) reads it to protect anchors from salience-token-budget elision (AnchorRetention = 1.0).
   */
  readonly isAnchor?: boolean
}

const DEFAULT_CONFIG: SearchConfig = {
  vectorWeight: 0.7,
  keywordWeight: 0.3,
  limit: 10,
}

interface VecRow {
  chunk_id: number
  distance: number
}

interface FtsRow {
  id: number
  file_path: string
  content: string
  chunk_index: number
  rank: number
}

interface ChunkRow {
  id: number
  file_path: string
  content: string
  chunk_index: number
}

/**
 * Hybrid search: vector similarity + keyword matching.
 * Requires embeddings to have been indexed.
 */
export async function hybridSearch(
  db: Database.Database,
  query: string,
  config: Partial<SearchConfig> = {},
): Promise<readonly SearchResult[]> {
  const { vectorWeight, keywordWeight, limit } = { ...DEFAULT_CONFIG, ...config }

  // Run vector and keyword searches
  const vectorResults = await vectorSearch(db, query, limit * 2, config.onQueryEmbedding)
  const keywordResults = keywordSearch(db, query, limit * 2)

  // Merge results by chunk ID
  return mergeResults(db, vectorResults, keywordResults, vectorWeight, keywordWeight, limit)
}

/**
 * Keyword-only search using FTS5 (no embeddings needed).
 */
export function keywordSearch(
  db: Database.Database,
  query: string,
  limit: number = 10,
): Map<number, number> {
  const scores = new Map<number, number>()

  if (!query.trim()) return scores

  // Escape FTS5 special characters for safety
  const safeQuery = escapeFts5Query(query)
  if (!safeQuery) return scores

  try {
    const rows = db
      .prepare(
        `SELECT c.id, c.file_path, c.content, c.chunk_index, rank
         FROM chunks_fts
         JOIN chunks c ON c.id = chunks_fts.rowid
         WHERE chunks_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(safeQuery, limit) as FtsRow[]

    if (rows.length === 0) return scores

    // Normalize ranks to 0-1 scale using BM25 rank (negative, closer to 0 = better).
    // Use 1/(1+abs(rank)) to avoid single-result collapsing to 0.
    for (const row of rows) {
      const normalized = 1 / (1 + Math.abs(row.rank))
      scores.set(row.id, normalized)
    }
  } catch (err: unknown) {
    const message = (err instanceof Error ? err.message : '').toLowerCase()
    // FTS5 syntax/parse errors (including "no such column: X" when a bareword
    // is misread as a column filter) must never abort the surrounding hybrid
    // search — degrade to empty keyword results and let vector search stand.
    if (
      message.includes('fts5') ||
      message.includes('no such column') ||
      message.includes('syntax error')
    ) {
      // Known FTS5 syntax error — return empty results
    } else {
      throw err
    }
  }

  return scores
}

/**
 * Vector-only search using sqlite-vec.
 */
async function vectorSearch(
  db: Database.Database,
  query: string,
  limit: number,
  onQueryEmbedding?: (embedding: Float32Array) => void,
): Promise<Map<number, number>> {
  const scores = new Map<number, number>()

  const { embedding } = await generateEmbedding(query)
  if (onQueryEmbedding) {
    try {
      onQueryEmbedding(embedding)
    } catch {
      /* observe-only — a broken observer never breaks the search */
    }
  }
  const queryBuf = serializeEmbedding(embedding)

  const rows = db
    .prepare(
      `SELECT chunk_id, distance
       FROM chunk_embeddings
       WHERE embedding MATCH ?
       ORDER BY distance
       LIMIT ?`,
    )
    .all(queryBuf, limit) as VecRow[]

  if (rows.length === 0) return scores

  // Convert distance to similarity score (0-1, higher = more similar)
  // sqlite-vec uses L2 distance by default
  const maxDistance = Math.max(...rows.map((r) => r.distance))
  for (const row of rows) {
    const similarity = maxDistance > 0 ? 1 - row.distance / maxDistance : 1
    scores.set(row.chunk_id, Math.max(0, similarity))
  }

  return scores
}

/**
 * Merge vector and keyword scores into ranked results.
 */
function mergeResults(
  db: Database.Database,
  vectorScores: Map<number, number>,
  keywordScores: Map<number, number>,
  vectorWeight: number,
  keywordWeight: number,
  limit: number,
): readonly SearchResult[] {
  // Collect all unique chunk IDs
  const allIds = new Set([...vectorScores.keys(), ...keywordScores.keys()])

  const scored: Array<{
    chunkId: number
    score: number
    vectorScore: number
    keywordScore: number
  }> = []

  for (const id of allIds) {
    const vs = vectorScores.get(id) ?? 0
    const ks = keywordScores.get(id) ?? 0
    scored.push({
      chunkId: id,
      score: vectorWeight * vs + keywordWeight * ks,
      vectorScore: vs,
      keywordScore: ks,
    })
  }

  // Sort by score descending, take top N
  scored.sort((a, b) => b.score - a.score)
  const topN = scored.slice(0, limit)

  // Fetch chunk metadata
  const getChunk = db.prepare('SELECT id, file_path, content, chunk_index FROM chunks WHERE id = ?')

  return topN
    .map((s) => {
      const chunk = getChunk.get(s.chunkId) as ChunkRow | undefined
      if (!chunk) return null
      return {
        chunkId: s.chunkId,
        filePath: chunk.file_path,
        content: chunk.content,
        score: s.score,
        vectorScore: s.vectorScore,
        keywordScore: s.keywordScore,
        chunkIndex: chunk.chunk_index,
      }
    })
    .filter((r): r is SearchResult => r !== null)
}

/**
 * Keyword-only hybrid search (no embeddings needed).
 * Useful for testing or when fastembed is unavailable.
 */
export function keywordOnlySearch(
  db: Database.Database,
  query: string,
  limit: number = 10,
): readonly SearchResult[] {
  const keywordScores = keywordSearch(db, query, limit)
  return mergeResults(db, new Map(), keywordScores, 0, 1, limit)
}

/** Escape FTS5 special characters in user query */
export function escapeFts5Query(query: string): string {
  // Remove FTS5 operators, keep individual words
  const words = query
    .replace(/['"(){}[\]^~*:.+,\/\-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0)

  if (words.length === 0) return ''

  // Use OR between terms for broad matching (any term matches)
  return words.join(' OR ')
}
