/**
 * Temporal timeline reader — the WHEN-intent enrichment (design-m1.md §5, the ◑ temporal tier).
 *
 * The entity/temporal neighborhood reader already answers "WHEN did <entity> …" by returning a
 * named entity's chunks in chronological order. But a WHEN query that names NO gazetteer entity
 * ("what did we work on recently", "show the timeline of the retries work") has no entity anchor,
 * so the router falls back to relevance-ranked hybrid search — which is exactly the WRONG order
 * for a timeline.
 *
 * This reader supplies the missing capability: take the query's RELEVANCE candidates (a wide
 * `baseSearch` beam) and re-order them CHRONOLOGICALLY — the N most-recent relevant chunks,
 * returned oldest-first as a literal timeline. It is a pure re-ordering of the same candidate
 * pool (introduces no new chunks), so it never surfaces an irrelevant chunk; it only changes the
 * AXIS from relevance to time, which a single hybrid query cannot do.
 */

import type Database from 'better-sqlite3'
import type { SearchResult } from './search.js'
import type { NeighborhoodChunk } from './entities/neighborhood.js'

/** Base search the timeline re-orders (the production hybrid/keyword path). */
export type TimelineBaseSearch = (
  query: string,
  topK: number,
) => Promise<readonly SearchResult[]>

export interface TimelineOptions {
  /** Number of timeline entries to return (the most-recent N relevant chunks). Default 5. */
  readonly limit?: number
  /** How wide a relevance pool to draw from before the chronological cut. Default max(limit*4, 20). */
  readonly beam?: number
  /** Only include chunks whose source-file mtime is >= this epoch-ms cutoff (inclusive). */
  readonly since?: number
}

interface Row {
  chunkId: number
  filePath: string
  content: string
  chunkIndex: number
  mtimeMs: number
}

/**
 * Return a chronological (oldest-first) timeline of the most-recent `limit` chunks among the
 * query's relevance candidates. Draws a `beam`-wide relevance pool from `baseSearch`, keeps the
 * newest `limit` by source-file mtime, then returns them oldest-first (same ordering contract as
 * the WHEN entity-neighborhood route). Returns [] when the query has no relevance candidates.
 */
export async function temporalTimeline(
  db: Database.Database,
  query: string,
  baseSearch: TimelineBaseSearch,
  options: TimelineOptions = {},
): Promise<NeighborhoodChunk[]> {
  const limit =
    typeof options.limit === 'number' && options.limit > 0 ? Math.floor(options.limit) : 5
  const beam =
    typeof options.beam === 'number' && options.beam > 0
      ? Math.floor(options.beam)
      : Math.max(limit * 4, 20)

  const candidates = await baseSearch(query, beam)
  const ids = candidates
    .map((c) => c.chunkId)
    .filter((id) => Number.isInteger(id) && id > 0)
  if (ids.length === 0) return []

  const placeholders = ids.map(() => '?').join(',')
  const params: unknown[] = [...ids]
  let sinceClause = ''
  if (typeof options.since === 'number') {
    sinceClause = 'AND vf.mtime_ms >= ?'
    params.push(options.since)
  }
  params.push(limit)

  // Select the newest `limit` of the relevance pool, then reverse to chronological (oldest-first).
  const rows = db
    .prepare(
      `SELECT c.id AS chunkId, c.file_path AS filePath, c.content AS content,
              c.chunk_index AS chunkIndex, vf.mtime_ms AS mtimeMs
       FROM chunks c JOIN vault_files vf ON vf.path = c.file_path
       WHERE c.id IN (${placeholders}) ${sinceClause}
       ORDER BY vf.mtime_ms DESC, c.chunk_index DESC, c.id DESC
       LIMIT ?`,
    )
    .all(...params) as Row[]

  return rows.reverse().map((r) => ({
    chunkId: r.chunkId,
    filePath: r.filePath,
    content: r.content,
    chunkIndex: r.chunkIndex,
    mtimeMs: r.mtimeMs,
  }))
}
