import type Database from 'better-sqlite3'
import type { Session } from '../../types.js'
import { DatabaseError } from '../../../shared/errors.js'

interface CreateSessionInput {
  readonly id: string
  readonly purpose: string
  readonly working_dir: string
  readonly worktree: string | null
  readonly repo_context?: string | null
  readonly parent_session_id?: string | null
  readonly branch_point_message_id?: string | null
  /**
   * Multi-project foundation (P3): the project this session belongs to.
   * NULL = legacy/global (excluded from autonomous project-scoped reads).
   */
  readonly project_id?: string | null
}

export function createSession(db: Database.Database, input: CreateSessionInput): Session {
  try {
    db.prepare(
      `INSERT INTO sessions (id, purpose, working_dir, worktree, repo_context, parent_session_id, branch_point_message_id, project_id)
       VALUES (@id, @purpose, @working_dir, @worktree, @repo_context, @parent_session_id, @branch_point_message_id, @project_id)`,
    ).run({
      ...input,
      repo_context: input.repo_context ?? null,
      parent_session_id: input.parent_session_id ?? null,
      branch_point_message_id: input.branch_point_message_id ?? null,
      project_id: input.project_id ?? null,
    })
  } catch (err) {
    throw new DatabaseError(`Failed to create session '${input.id}'`, { cause: err })
  }

  return findSessionById(db, input.id)!
}

export function findSessionById(db: Database.Database, id: string): Session | null {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Session | undefined
  return row ? { ...row } : null
}

export function findAllSessions(
  db: Database.Database,
  status?: string,
  includeArchived?: boolean,
  projectId?: string,
): ReadonlyArray<Session> {
  const conditions: string[] = []
  const params: unknown[] = []

  if (status) {
    conditions.push('status = ?')
    params.push(status)
  }
  if (!includeArchived) {
    conditions.push('archived_at IS NULL')
  }
  // Multi-project (P3): strict scoping — legacy NULL rows excluded when a
  // projectId is supplied. Omitting projectId preserves global behaviour.
  if (projectId !== undefined) {
    conditions.push('project_id = ?')
    params.push(projectId)
  }

  const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''
  const rows = db
    .prepare(`SELECT * FROM sessions${where} ORDER BY created_at`)
    .all(...params) as Session[]
  return rows.map((row) => ({ ...row }))
}

export function findZombieSessions(
  db: Database.Database,
  thresholdSeconds: number,
): ReadonlyArray<Session> {
  // Match two cases:
  //   1. Live-status sessions whose heartbeat has expired (the typical zombie)
  //   2. Sessions already tagged status='zombie' — any heartbeat age — so a
  //      row left in that state (from a prior broker crash between mark and
  //      delete, or from older code) gets reaped on the next tick instead of
  //      persisting forever. Regression fix for 13.10.2.
  const rows = db
    .prepare(
      `SELECT * FROM sessions
       WHERE (
         status IN ('active', 'working', 'reporting', 'idle', 'paused', 'registered')
         AND last_heartbeat < datetime('now', '-' || ? || ' seconds')
       )
       OR status = 'zombie'
       ORDER BY last_heartbeat`,
    )
    .all(thresholdSeconds) as Session[]
  return rows.map((row) => ({ ...row }))
}

export function updateSessionStatus(
  db: Database.Database,
  id: string,
  status: string,
): Session | null {
  try {
    if (status === 'completed') {
      db.prepare("UPDATE sessions SET status = ?, archived_at = datetime('now') WHERE id = ?").run(
        status,
        id,
      )
    } else {
      db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run(status, id)
    }
  } catch (err) {
    throw new DatabaseError(`Failed to update session '${id}' status to '${status}'`, {
      cause: err,
    })
  }
  return findSessionById(db, id)
}

export function archiveSession(db: Database.Database, id: string): boolean {
  const result = db
    .prepare(
      "UPDATE sessions SET archived_at = datetime('now') WHERE id = ? AND archived_at IS NULL",
    )
    .run(id)
  return result.changes > 0
}

export function unarchiveSession(db: Database.Database, id: string): boolean {
  const result = db
    .prepare('UPDATE sessions SET archived_at = NULL WHERE id = ? AND archived_at IS NOT NULL')
    .run(id)
  return result.changes > 0
}

export function findArchivedSessionsOlderThan(
  db: Database.Database,
  ttlSeconds: number,
): ReadonlyArray<Session> {
  const rows = db
    .prepare(
      `SELECT * FROM sessions
     WHERE archived_at IS NOT NULL
     AND archived_at <= datetime('now', '-' || ? || ' seconds')
     ORDER BY archived_at`,
    )
    .all(ttlSeconds) as Session[]
  return rows.map((row) => ({ ...row }))
}

export function updateHeartbeat(db: Database.Database, id: string): void {
  db.prepare("UPDATE sessions SET last_heartbeat = datetime('now') WHERE id = ?").run(id)
}

/**
 * Issue #70: retire a session's execution lease WITHOUT destroying its
 * participant identity. The row survives (archived, status 'expired') so
 * directed messages keep both endpoints addressable and a reconnecting
 * session can revive under the same id.
 */
export function expireSession(db: Database.Database, id: string): boolean {
  const result = db
    .prepare(
      `UPDATE sessions SET status = 'expired', archived_at = datetime('now')
       WHERE id = ? AND status != 'completed'`,
    )
    .run(id)
  return result.changes > 0
}

/**
 * Issue #70: revive a known participant. A heartbeat proves liveness and may
 * undo lease expiry ('expired' → 'active'), but must not resurrect an
 * explicitly deregistered session — only an explicit re-registration or a
 * session-start (resume) may revive from 'completed'/'zombie', which callers
 * opt into via `fromStatuses`.
 */
export function reviveSession(
  db: Database.Database,
  id: string,
  fromStatuses: ReadonlyArray<string> = ['expired'],
): Session | null {
  const placeholders = fromStatuses.map(() => '?').join(', ')
  const result = db
    .prepare(
      `UPDATE sessions
       SET status = 'active', last_heartbeat = datetime('now'), archived_at = NULL
       WHERE id = ? AND status IN (${placeholders})`,
    )
    .run(id, ...fromStatuses)
  if (result.changes === 0) {
    // Already live — still refresh the heartbeat so a revive attempt counts
    // as proof of life.
    updateHeartbeat(db, id)
  }
  return findSessionById(db, id)
}

export function deleteSession(db: Database.Database, id: string): boolean {
  try {
    const result = db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
    return result.changes > 0
  } catch (err) {
    throw new DatabaseError(`Failed to delete session '${id}'`, { cause: err })
  }
}

export function countSessionsByStatus(db: Database.Database, status: string): number {
  const row = db.prepare('SELECT COUNT(*) as count FROM sessions WHERE status = ?').get(status) as {
    count: number
  }
  return row.count
}

export function findByRepoContext(
  db: Database.Database,
  repoContext: string,
): ReadonlyArray<Session> {
  const rows = db
    .prepare(
      `SELECT * FROM sessions
     WHERE repo_context = ?
     AND status = 'active'
     AND archived_at IS NULL
     ORDER BY created_at`,
    )
    .all(repoContext) as Session[]
  return rows.map((row) => ({ ...row }))
}

export function findSessionChildren(
  db: Database.Database,
  sessionId: string,
): ReadonlyArray<Session> {
  const rows = db
    .prepare(
      `SELECT * FROM sessions
     WHERE parent_session_id = ?
     ORDER BY created_at`,
    )
    .all(sessionId) as Session[]
  return rows.map((row) => ({ ...row }))
}

export function findStaleSessions(
  db: Database.Database,
  excludePurposes: ReadonlyArray<string>,
): ReadonlyArray<Session> {
  // Include sessions already tagged status='zombie' — they should also be
  // retired on startup. Terminal 'completed' sessions and already-'expired'
  // sessions (lease retired, identity retained — issue #70) are skipped.
  const placeholders = excludePurposes.map(() => '?').join(', ')
  const rows = db
    .prepare(
      `SELECT * FROM sessions WHERE status NOT IN ('completed', 'expired') AND purpose NOT IN (${placeholders})`,
    )
    .all(...excludePurposes) as Session[]
  return rows.map((row) => ({ ...row }))
}

export function markSessionsAsZombie(
  db: Database.Database,
  excludePurposes: ReadonlyArray<string>,
): number {
  const placeholders = excludePurposes.map(() => '?').join(', ')
  const result = db
    .prepare(
      `UPDATE sessions SET status = 'zombie' WHERE status NOT IN ('completed', 'zombie', 'expired') AND purpose NOT IN (${placeholders})`,
    )
    .run(...excludePurposes)
  return result.changes
}

/**
 * Retry a SQLite mutation on transient SQLITE_BUSY / SQLITE_LOCKED errors
 * with exponential backoff. Non-busy errors are rethrown immediately.
 *
 * Added to handle the startup-cleanup regression where another reader
 * (launchd-relaunched sibling broker) briefly held the db, and a throw
 * from `resetHookAndDiscoveredSessions` propagated all the way up to the
 * Node runtime, producing a C++ mutex abort. Now the caller gets a
 * chance to retry before surfacing the error.
 */
export function runWithBusyRetry<T>(
  fn: () => T,
  options: { readonly attempts?: number; readonly baseMs?: number } = {},
): T {
  const attempts = Math.max(1, options.attempts ?? 5)
  const baseMs = Math.max(1, options.baseMs ?? 50)
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return fn()
    } catch (err) {
      lastErr = err
      const code = (err as { code?: string })?.code
      const transient = code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED'
      if (!transient || i === attempts - 1) throw err
      const delay = baseMs * 2 ** i
      const end = Date.now() + delay
      // Synchronous spin-wait — SQLite mutations are sync and we want
      // ordering preserved w.r.t. subsequent cleanup steps. The delay
      // ceiling (attempts=5, baseMs=50) is ~800ms total worst case.
      while (Date.now() < end) {
        // no-op
      }
    }
  }
  throw lastErr
}

export function resetHookAndDiscoveredSessions(db: Database.Database): number {
  return runWithBusyRetry(() => {
    const result = db
      .prepare(
        `UPDATE sessions SET status = 'active', last_heartbeat = datetime('now'), archived_at = NULL
         WHERE purpose IN ('copilot-hook', 'discovered') AND status NOT IN ('completed', 'zombie', 'expired')`,
      )
      .run()
    return result.changes
  })
}
