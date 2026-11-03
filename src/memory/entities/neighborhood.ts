/**
 * Entity neighborhood read MVP (M1.1, design-m1.md §5). Object permanence: aggregate every chunk
 * linked to one entity, temporal-ordered — the MAGMA "entity neighborhood" mechanism (§E case
 * study) and exactly the signal D2a needs to learn what lands for a given concept over time.
 */

import type Database from 'better-sqlite3'
import { canonicalize, SCNS_GAZETTEER, type GazetteerEntry } from './gazetteer.js'

export interface NeighborhoodChunk {
  readonly chunkId: number
  readonly filePath: string
  readonly content: string
  readonly chunkIndex: number
  /** Source file mtime (temporal ground truth). */
  readonly mtimeMs: number
}

export interface NeighborhoodOptions {
  /** Only include chunks whose file mtime is >= this epoch-ms cutoff (inclusive). */
  readonly since?: number
  /** Cap the result to the most-recent N chunks (still returned chronologically). */
  readonly limit?: number
  /** Override the gazetteer used for alias→canonical resolution. */
  readonly gazetteer?: readonly GazetteerEntry[]
  /**
   * Also resolve `name` against the LEARNED (App-C.1) `memory_entities` vocabulary when it is not a
   * gazetteer surface — a learned name (e.g. 'melanie') is a real entity row and is matched directly
   * by name (A-div2 query-side, MAGMA Algorithm 1 query→entity anchoring). Default OFF ⇒ gazetteer-
   * only resolution, byte-identical to today.
   */
  readonly learnedEntityQuery?: boolean
}

interface Row {
  chunkId: number
  filePath: string
  content: string
  chunkIndex: number
  mtimeMs: number
}

/**
 * Return the chunks linked to `name` (canonical or any alias) via entity edges, ordered
 * chronologically (mtime ascending). With `limit`, the MOST-RECENT N are returned, still in
 * chronological order. Returns [] for an unknown entity or one with no mentions.
 */
export function entityNeighborhood(
  db: Database.Database,
  name: string,
  options: NeighborhoodOptions = {},
): NeighborhoodChunk[] {
  const gazetteer = options.gazetteer ?? SCNS_GAZETTEER
  // Gazetteer canonicalization first (aliases resolved); else, when learned-entity resolution is
  // opted-in, treat `name` as a LEARNED memory_entities canonical directly. The existing
  // `WHERE name = ?` lookup below decides — a non-entity name still yields [] (unchanged).
  const canonical =
    canonicalize(name, gazetteer) ?? (options.learnedEntityQuery ? name : undefined)
  if (!canonical) return []

  const entity = db.prepare('SELECT id FROM memory_entities WHERE name = ?').get(canonical) as
    | { id: number }
    | undefined
  if (!entity) return []

  const params: unknown[] = [entity.id]
  let sinceClause = ''
  if (typeof options.since === 'number') {
    sinceClause = 'AND vf.mtime_ms >= ?'
    params.push(options.since)
  }
  const limitClause = typeof options.limit === 'number' && options.limit >= 0 ? 'LIMIT ?' : ''
  if (limitClause) params.push(options.limit)

  // Select most-recent-first (so LIMIT keeps the newest N), then reverse to chronological order.
  const rows = db
    .prepare(
      `SELECT c.id AS chunkId, c.file_path AS filePath, c.content AS content,
              c.chunk_index AS chunkIndex, vf.mtime_ms AS mtimeMs
       FROM memory_edges e
       JOIN chunks c ON c.id = e.src_chunk
       JOIN vault_files vf ON vf.path = c.file_path
       WHERE e.edge_type = 'entity' AND e.dst_entity = ? ${sinceClause}
       ORDER BY vf.mtime_ms DESC, c.chunk_index DESC, c.id DESC
       ${limitClause}`,
    )
    .all(...params) as Row[]

  return rows.reverse()
}
