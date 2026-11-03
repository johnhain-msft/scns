import type Database from 'better-sqlite3'
import type { Session } from '../../types.js'

interface CreateSessionInput {
  readonly id: string
  readonly purpose: string
  readonly working_dir: string
  readonly worktree: string | null
  readonly repo_context?: string | null
  readonly parent_session_id?: string | null
  readonly branch_point_message_id?: string | null
}

export function createSession(db: Database.Database, input: CreateSessionInput): Session {
  db.prepare(
    `INSERT INTO sessions (id, purpose, working_dir, worktree, repo_context, parent_session_id, branch_point_message_id)
     VALUES (@id, @purpose, @working_dir, @worktree, @repo_context, @parent_session_id, @branch_point_message_id)`
  ).run({
    ...input,
    repo_context: input.repo_context ?? null,
    parent_session_id: input.parent_session_id ?? null,
    branch_point_message_id: input.branch_point_message_id ?? null,
  })

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

  const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''
  const rows = db.prepare(`SELECT * FROM sessions${where} ORDER BY created_at`).all(...params) as Session[]
  return rows.map((row) => ({ ...row }))
}

export function findZombieSessions(
  db: Database.Database,
  thresholdSeconds: number
): ReadonlyArray<Session> {
  const rows = db
    .prepare(
      `SELECT * FROM sessions
       WHERE status = 'active'
       AND last_heartbeat < datetime('now', '-' || ? || ' seconds')
       ORDER BY last_heartbeat`
    )
    .all(thresholdSeconds) as Session[]
  return rows.map((row) => ({ ...row }))
}

export function updateSessionStatus(db: Database.Database, id: string, status: string): Session | null {
  if (status === 'completed') {
    db.prepare("UPDATE sessions SET status = ?, archived_at = datetime('now') WHERE id = ?").run(status, id)
  } else {
    db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run(status, id)
  }
  return findSessionById(db, id)
}

export function archiveSession(db: Database.Database, id: string): boolean {
  const result = db.prepare("UPDATE sessions SET archived_at = datetime('now') WHERE id = ? AND archived_at IS NULL").run(id)
  return result.changes > 0
}

export function findArchivedSessionsOlderThan(
  db: Database.Database,
  ttlSeconds: number,
): ReadonlyArray<Session> {
  const rows = db.prepare(
    `SELECT * FROM sessions
     WHERE archived_at IS NOT NULL
     AND archived_at <= datetime('now', '-' || ? || ' seconds')
     ORDER BY archived_at`
  ).all(ttlSeconds) as Session[]
  return rows.map((row) => ({ ...row }))
}

export function updateHeartbeat(db: Database.Database, id: string): void {
  db.prepare("UPDATE sessions SET last_heartbeat = datetime('now') WHERE id = ?").run(id)
}

export function deleteSession(db: Database.Database, id: string): boolean {
  const result = db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  return result.changes > 0
}

export function countSessionsByStatus(db: Database.Database, status: string): number {
  const row = db.prepare('SELECT COUNT(*) as count FROM sessions WHERE status = ?').get(status) as { count: number }
  return row.count
}

export function findByRepoContext(
  db: Database.Database,
  repoContext: string,
): ReadonlyArray<Session> {
  const rows = db.prepare(
    `SELECT * FROM sessions
     WHERE repo_context = ?
     AND status = 'active'
     AND archived_at IS NULL
     ORDER BY created_at`
  ).all(repoContext) as Session[]
  return rows.map((row) => ({ ...row }))
}

export function findSessionChildren(
  db: Database.Database,
  sessionId: string,
): ReadonlyArray<Session> {
  const rows = db.prepare(
    `SELECT * FROM sessions
     WHERE parent_session_id = ?
     ORDER BY created_at`
  ).all(sessionId) as Session[]
  return rows.map((row) => ({ ...row }))
}
