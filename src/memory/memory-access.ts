/**
 * Memory access signal (the "use it or lose it" plumbing, handoff SIBLING milestone).
 *
 * Records which memory entities the system actually RETRIEVES — primarily the D2a
 * ideation read, which selects entity neighborhoods from the live graph. The dream
 * memory-maintenance phase uses this signal for access-aware decay: an entity never
 * retrieved in N dream cycles is a forgetting candidate. This is the shared signal
 * the handoff calls load-bearing — maintenance reuses D2's retrieval plumbing.
 *
 * Writes are recorded at the point of USE (e.g. when ideation selects an entity), NOT
 * inside the neighborhood reader, so the reader stays side-effect-free (the live
 * readonly probe must never mutate the vault). `memory_access` is created lazily.
 */

import type Database from 'better-sqlite3'

export interface AccessRow {
  readonly scope_key: string
  readonly kind: string
  readonly access_count: number
  readonly last_cycle: number
  readonly last_accessed_at: string
}

/** Idempotently create the access-tracking table (cheap CREATE IF NOT EXISTS). */
export function ensureMemoryAccessSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_access (
      scope_key        TEXT NOT NULL,
      kind             TEXT NOT NULL,
      access_count     INTEGER NOT NULL DEFAULT 0,
      last_cycle       INTEGER NOT NULL DEFAULT 0,
      last_accessed_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (kind, scope_key)
    );
  `)
}

function tableExists(db: Database.Database): boolean {
  const r = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_access'")
    .get() as { name?: string } | undefined
  return !!r?.name
}

/**
 * Record that `entity` was retrieved/used in the given dream `cycle` (default 0).
 * Upserts: increments the count and advances `last_cycle` to the most recent cycle.
 */
export function recordEntityAccess(db: Database.Database, entity: string, cycle = 0): void {
  ensureMemoryAccessSchema(db)
  db.prepare(
    `INSERT INTO memory_access (scope_key, kind, access_count, last_cycle, last_accessed_at)
     VALUES (?, 'entity', 1, ?, datetime('now'))
     ON CONFLICT(kind, scope_key) DO UPDATE SET
       access_count = access_count + 1,
       last_cycle = MAX(last_cycle, excluded.last_cycle),
       last_accessed_at = datetime('now')`,
  ).run(entity, cycle)
}

/** Read one access row; undefined when absent or the table doesn't exist. */
export function getAccess(
  db: Database.Database,
  kind: string,
  key: string,
): AccessRow | undefined {
  if (!tableExists(db)) return undefined
  const row = db
    .prepare('SELECT * FROM memory_access WHERE kind = ? AND scope_key = ?')
    .get(kind, key) as AccessRow | undefined
  return row ? { ...row } : undefined
}

/**
 * From a set of known entities, return those that are STALE: never accessed, or last
 * accessed strictly before `beforeCycle` (an access exactly at the cutoff is fresh).
 * Side-effect-free: with no table, every known entity is stale.
 */
export function staleEntities(
  db: Database.Database,
  knownEntities: readonly string[],
  beforeCycle: number,
): string[] {
  const fresh = new Set<string>()
  if (tableExists(db)) {
    const rows = db
      .prepare("SELECT scope_key, last_cycle FROM memory_access WHERE kind = 'entity'")
      .all() as Array<{ scope_key: string; last_cycle: number }>
    for (const r of rows) {
      if (r.last_cycle >= beforeCycle) fresh.add(r.scope_key)
    }
  }
  return knownEntities.filter((e) => !fresh.has(e))
}

/** Aggregate health of the access signal — used to gate access-aware decay. */
export interface AccessSignalStats {
  readonly tableExists: boolean
  /** Sum of access_count across rows of `kind`. */
  readonly totalAccesses: number
  /** Number of distinct accessed scope keys (entities) of `kind`. */
  readonly distinctEntities: number
  /** Highest `last_cycle` recorded (0 when empty). */
  readonly maxCycle: number
}

/**
 * Summarize the access signal. Side-effect-free: an absent table reports a fully cold
 * signal (zeros). The maintenance warm-up guard uses this to refuse access-aware decay
 * until the "use it or lose it" signal has actually accrued real retrievals.
 */
export function accessSignalStats(db: Database.Database, kind = 'entity'): AccessSignalStats {
  if (!tableExists(db)) {
    return { tableExists: false, totalAccesses: 0, distinctEntities: 0, maxCycle: 0 }
  }
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(access_count), 0) AS total,
              COUNT(*)                  AS distinctEntities,
              COALESCE(MAX(last_cycle), 0) AS maxCycle
       FROM memory_access WHERE kind = ?`,
    )
    .get(kind) as { total: number; distinctEntities: number; maxCycle: number }
  return {
    tableExists: true,
    totalAccesses: row.total,
    distinctEntities: row.distinctEntities,
    maxCycle: row.maxCycle,
  }
}
