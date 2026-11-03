import type Database from 'better-sqlite3'
import type { RespawnPolicy, RespawnHistory } from '../../types.js'

interface CreatePolicyInput {
  readonly team_id: string
  readonly role: string
  readonly min_count?: number
  readonly max_retries?: number
  readonly backoff_base_ms?: number
  readonly enabled?: boolean
}

export function upsertRespawnPolicy(
  db: Database.Database,
  input: CreatePolicyInput,
): RespawnPolicy {
  db.prepare(
    `INSERT INTO respawn_policies (team_id, role, min_count, max_retries, backoff_base_ms, enabled)
     VALUES (@team_id, @role, @min_count, @max_retries, @backoff_base_ms, @enabled)
     ON CONFLICT(team_id, role) DO UPDATE SET
       min_count = @min_count,
       max_retries = @max_retries,
       backoff_base_ms = @backoff_base_ms,
       enabled = @enabled,
       updated_at = datetime('now')`
  ).run({
    team_id: input.team_id,
    role: input.role,
    min_count: input.min_count ?? 1,
    max_retries: input.max_retries ?? 3,
    backoff_base_ms: input.backoff_base_ms ?? 5000,
    enabled: (input.enabled ?? true) ? 1 : 0,
  })

  return findRespawnPolicy(db, input.team_id, input.role)!
}

export function findRespawnPolicy(
  db: Database.Database,
  teamId: string,
  role: string,
): RespawnPolicy | null {
  const row = db.prepare(
    'SELECT * FROM respawn_policies WHERE team_id = ? AND role = ?'
  ).get(teamId, role) as RespawnPolicy | undefined
  return row ? { ...row } : null
}

export function findRespawnPoliciesByTeam(
  db: Database.Database,
  teamId: string,
): ReadonlyArray<RespawnPolicy> {
  const rows = db.prepare(
    'SELECT * FROM respawn_policies WHERE team_id = ? ORDER BY role'
  ).all(teamId) as RespawnPolicy[]
  return rows.map((row) => ({ ...row }))
}

export function deleteRespawnPoliciesByTeam(
  db: Database.Database,
  teamId: string,
): number {
  const result = db.prepare(
    'DELETE FROM respawn_policies WHERE team_id = ?'
  ).run(teamId)
  return result.changes
}

export function deleteAllRespawnPolicies(db: Database.Database): number {
  const result = db.prepare('DELETE FROM respawn_policies').run()
  return result.changes
}

interface CreateAttemptInput {
  readonly team_id: string
  readonly original_session_id: string
  readonly role: string
  readonly name: string
  readonly agent_type?: string | null
  readonly attempt: number
}

export function createRespawnAttempt(
  db: Database.Database,
  input: CreateAttemptInput,
): RespawnHistory {
  const result = db.prepare(
    `INSERT INTO respawn_history (team_id, original_session_id, role, name, agent_type, attempt)
     VALUES (@team_id, @original_session_id, @role, @name, @agent_type, @attempt)`
  ).run({
    team_id: input.team_id,
    original_session_id: input.original_session_id,
    role: input.role,
    name: input.name,
    agent_type: input.agent_type ?? null,
    attempt: input.attempt,
  })

  return findRespawnAttemptById(db, Number(result.lastInsertRowid))!
}

function findRespawnAttemptById(
  db: Database.Database,
  id: number,
): RespawnHistory | null {
  const row = db.prepare(
    'SELECT * FROM respawn_history WHERE id = ?'
  ).get(id) as RespawnHistory | undefined
  return row ? { ...row } : null
}

interface UpdateAttemptInput {
  readonly status: string
  readonly new_session_id?: string | null
  readonly error_message?: string | null
}

export function updateRespawnAttempt(
  db: Database.Database,
  id: number,
  updates: UpdateAttemptInput,
): RespawnHistory | null {
  db.prepare(
    `UPDATE respawn_history SET
       status = @status,
       new_session_id = COALESCE(@new_session_id, new_session_id),
       error_message = COALESCE(@error_message, error_message)
     WHERE id = @id`
  ).run({
    id,
    status: updates.status,
    new_session_id: updates.new_session_id ?? null,
    error_message: updates.error_message ?? null,
  })

  return findRespawnAttemptById(db, id)
}

export function countRecentFailures(
  db: Database.Database,
  teamId: string,
  role: string,
  windowSeconds: number = 300,
): number {
  const row = db.prepare(
    `SELECT COUNT(*) as count FROM respawn_history
     WHERE team_id = ? AND role = ? AND status IN ('failed', 'abandoned')
     AND created_at > datetime('now', '-' || ? || ' seconds')`
  ).get(teamId, role, windowSeconds) as { count: number }
  return row.count
}

export function findRespawnHistory(
  db: Database.Database,
  teamId: string,
  options?: { readonly limit?: number; readonly status?: string },
): ReadonlyArray<RespawnHistory> {
  const limit = options?.limit ?? 50
  if (options?.status) {
    const rows = db.prepare(
      'SELECT * FROM respawn_history WHERE team_id = ? AND status = ? ORDER BY id DESC LIMIT ?'
    ).all(teamId, options.status, limit) as RespawnHistory[]
    return rows.map((row) => ({ ...row }))
  }
  const rows = db.prepare(
    'SELECT * FROM respawn_history WHERE team_id = ? ORDER BY id DESC LIMIT ?'
  ).all(teamId, limit) as RespawnHistory[]
  return rows.map((row) => ({ ...row }))
}

export function deleteRespawnHistoryByTeam(
  db: Database.Database,
  teamId: string,
): number {
  const result = db.prepare(
    'DELETE FROM respawn_history WHERE team_id = ?'
  ).run(teamId)
  return result.changes
}

export function deleteAllRespawnHistory(db: Database.Database): number {
  const result = db.prepare('DELETE FROM respawn_history').run()
  return result.changes
}
