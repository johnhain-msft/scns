/**
 * Retirement ledger — the minimal record that stops a removed memory from coming back.
 *
 * A row is keyed by (path, content_hash), i.e. a source REVISION rather than a name. That
 * distinction is what makes the guard safe to consult from the indexing hot path:
 *
 *   - a late indexing/backfill pass holding a pre-deletion snapshot tries to re-insert the
 *     EXACT retired revision and is refused;
 *   - a genuinely new memory later written at the same path hashes differently and indexes
 *     normally — the guard never bans future content for resembling retired content.
 *
 * Restoring a retirement clears `restored_at`, which re-admits that revision.
 *
 * Kept deliberately dependency-free (only `better-sqlite3`) so both the deletion primitive and
 * the indexer can use it without dragging the negative-memory graph into the indexer's imports.
 */

import type Database from 'better-sqlite3'

export interface RetirementRow {
  readonly id: number
  readonly path: string
  readonly contentHash: string
  readonly mode: string
  readonly planId: string
  readonly recoveryRef: string | null
  readonly retiredAt: string
  readonly restoredAt: string | null
}

export function ensureRetirementTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_retirements (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      path         TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      mode         TEXT NOT NULL,
      plan_id      TEXT NOT NULL,
      recovery_ref TEXT,
      retired_at   TEXT NOT NULL DEFAULT (datetime('now')),
      restored_at  TEXT,
      UNIQUE(path, content_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_retirements_path ON memory_retirements(path);
  `)
}

/**
 * Paths with at least one un-restored retirement. Usually empty, so the indexer only pays for a
 * content hash on the handful of paths that actually appear here.
 */
export function loadActiveRetirementPaths(db: Database.Database): ReadonlySet<string> {
  try {
    const rows = db
      .prepare('SELECT DISTINCT path FROM memory_retirements WHERE restored_at IS NULL')
      .all() as Array<{ path: string }>
    return new Set(rows.map((r) => r.path))
  } catch {
    // Ledger absent (a DB created before this feature) ⇒ nothing is retired.
    return new Set()
  }
}

/** True when this exact (path, revision) was retired and has not been restored. */
export function isRetiredRevision(
  db: Database.Database,
  path: string,
  contentHash: string,
): boolean {
  try {
    const row = db
      .prepare(
        'SELECT 1 AS hit FROM memory_retirements WHERE path = ? AND content_hash = ? AND restored_at IS NULL',
      )
      .get(path, contentHash) as { hit: number } | undefined
    return row !== undefined
  } catch {
    return false
  }
}

export function recordRetirement(
  db: Database.Database,
  args: {
    readonly path: string
    readonly contentHash: string
    readonly mode: string
    readonly planId: string
    readonly recoveryRef: string | null
  },
): void {
  ensureRetirementTable(db)
  db.prepare(
    `INSERT INTO memory_retirements (path, content_hash, mode, plan_id, recovery_ref)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(path, content_hash) DO UPDATE SET
       mode = excluded.mode, plan_id = excluded.plan_id,
       recovery_ref = excluded.recovery_ref, restored_at = NULL`,
  ).run(args.path, args.contentHash, args.mode, args.planId, args.recoveryRef)
}

export function markRestored(db: Database.Database, id: number): void {
  db.prepare("UPDATE memory_retirements SET restored_at = datetime('now') WHERE id = ?").run(id)
}

export function findRestorableRetirement(
  db: Database.Database,
  path: string,
): { id: number; contentHash: string; mode: string; recoveryRef: string | null } | null {
  ensureRetirementTable(db)
  const row = db
    .prepare(
      `SELECT id, content_hash, mode, recovery_ref FROM memory_retirements
       WHERE path = ? AND restored_at IS NULL ORDER BY id DESC LIMIT 1`,
    )
    .get(path) as
    | { id: number; content_hash: string; mode: string; recovery_ref: string | null }
    | undefined
  if (!row) return null
  return {
    id: row.id,
    contentHash: row.content_hash,
    mode: row.mode,
    recoveryRef: row.recovery_ref,
  }
}

export function listRetirements(db: Database.Database): readonly RetirementRow[] {
  ensureRetirementTable(db)
  const rows = db
    .prepare(
      'SELECT id, path, content_hash, mode, plan_id, recovery_ref, retired_at, restored_at FROM memory_retirements ORDER BY id',
    )
    .all() as Array<{
    id: number
    path: string
    content_hash: string
    mode: string
    plan_id: string
    recovery_ref: string | null
    retired_at: string
    restored_at: string | null
  }>
  return rows.map((r) => ({
    id: r.id,
    path: r.path,
    contentHash: r.content_hash,
    mode: r.mode,
    planId: r.plan_id,
    recoveryRef: r.recovery_ref,
    retiredAt: r.retired_at,
    restoredAt: r.restored_at,
  }))
}
