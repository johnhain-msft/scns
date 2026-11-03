import type Database from 'better-sqlite3'

// ── Types ───────────────────────────────────────────────────────

export interface RespawnPolicy {
  readonly id: number
  readonly team_id: string
  readonly role: string
  readonly min_count: number
  readonly max_retries: number
  readonly backoff_base_ms: number
  readonly enabled: number
  readonly created_at: string
  readonly updated_at: string
}

export type RespawnStatus = 'pending' | 'spawned' | 'failed' | 'abandoned'

export interface RespawnHistoryRecord {
  readonly id: number
  readonly team_id: string
  readonly original_session_id: string
  readonly new_session_id: string | null
  readonly role: string
  readonly name: string
  readonly agent_type: string | null
  readonly attempt: number
  readonly status: RespawnStatus
  readonly error_message: string | null
  readonly created_at: string
}

// ── Input types ─────────────────────────────────────────────────

interface UpsertRespawnPolicyInput {
  readonly team_id: string
  readonly role: string
  readonly min_count?: number
  readonly max_retries?: number
  readonly backoff_base_ms?: number
  readonly enabled?: number
}

interface RecordRespawnAttemptInput {
  readonly team_id: string
  readonly original_session_id: string
  readonly new_session_id?: string | null
  readonly role: string
  readonly name: string
  readonly agent_type?: string | null
  readonly attempt: number
  readonly status: RespawnStatus
  readonly error_message?: string | null
}

interface UpdateRespawnStatusOptions {
  readonly new_session_id?: string
  readonly error_message?: string
}

interface FindRespawnHistoryOptions {
  readonly limit?: number
}

// ── Respawn Policies ────────────────────────────────────────────

export function upsertRespawnPolicy(
  db: Database.Database,
  input: UpsertRespawnPolicyInput,
): RespawnPolicy {
  db.prepare(
    `INSERT INTO respawn_policies (team_id, role, min_count, max_retries, backoff_base_ms, enabled)
     VALUES (@team_id, @role, @min_count, @max_retries, @backoff_base_ms, @enabled)
     ON CONFLICT(team_id, role) DO UPDATE SET
       min_count = excluded.min_count,
       max_retries = excluded.max_retries,
       backoff_base_ms = excluded.backoff_base_ms,
       enabled = excluded.enabled,
       updated_at = datetime('now')`,
  ).run({
    team_id: input.team_id,
    role: input.role,
    min_count: input.min_count ?? 1,
    max_retries: input.max_retries ?? 3,
    backoff_base_ms: input.backoff_base_ms ?? 5000,
    enabled: input.enabled ?? 1,
  })

  const row = db
    .prepare('SELECT * FROM respawn_policies WHERE team_id = ? AND role = ?')
    .get(input.team_id, input.role) as RespawnPolicy

  return { ...row }
}

export function findRespawnPolicy(
  db: Database.Database,
  teamId: string,
  role: string,
): RespawnPolicy | null {
  const row = db
    .prepare('SELECT * FROM respawn_policies WHERE team_id = ? AND role = ?')
    .get(teamId, role) as RespawnPolicy | undefined

  return row ? { ...row } : null
}

export function findRespawnPoliciesByTeam(
  db: Database.Database,
  teamId: string,
): ReadonlyArray<RespawnPolicy> {
  const rows = db
    .prepare('SELECT * FROM respawn_policies WHERE team_id = ? ORDER BY role')
    .all(teamId) as RespawnPolicy[]

  return rows.map((row) => ({ ...row }))
}

export function deleteRespawnPolicy(db: Database.Database, teamId: string, role: string): boolean {
  const result = db
    .prepare('DELETE FROM respawn_policies WHERE team_id = ? AND role = ?')
    .run(teamId, role)
  return result.changes > 0
}

// ── Respawn History ─────────────────────────────────────────────

export function recordRespawnAttempt(
  db: Database.Database,
  input: RecordRespawnAttemptInput,
): RespawnHistoryRecord {
  const result = db
    .prepare(
      `INSERT INTO respawn_history
       (team_id, original_session_id, new_session_id, role, name, agent_type, attempt, status, error_message)
     VALUES
       (@team_id, @original_session_id, @new_session_id, @role, @name, @agent_type, @attempt, @status, @error_message)`,
    )
    .run({
      team_id: input.team_id,
      original_session_id: input.original_session_id,
      new_session_id: input.new_session_id ?? null,
      role: input.role,
      name: input.name,
      agent_type: input.agent_type ?? null,
      attempt: input.attempt,
      status: input.status,
      error_message: input.error_message ?? null,
    })

  const row = db
    .prepare('SELECT * FROM respawn_history WHERE id = ?')
    .get(result.lastInsertRowid) as RespawnHistoryRecord

  return { ...row }
}

export function updateRespawnStatus(
  db: Database.Database,
  id: number,
  status: RespawnStatus,
  options: UpdateRespawnStatusOptions,
): RespawnHistoryRecord | null {
  const setClauses = ['status = @status']
  const params: Record<string, unknown> = { id, status }

  if (options.new_session_id !== undefined) {
    setClauses.push('new_session_id = @new_session_id')
    params.new_session_id = options.new_session_id
  }

  if (options.error_message !== undefined) {
    setClauses.push('error_message = @error_message')
    params.error_message = options.error_message
  }

  const result = db
    .prepare(`UPDATE respawn_history SET ${setClauses.join(', ')} WHERE id = @id`)
    .run(params)

  if (result.changes === 0) return null

  const row = db
    .prepare('SELECT * FROM respawn_history WHERE id = ?')
    .get(id) as RespawnHistoryRecord

  return { ...row }
}

export function findRespawnHistory(
  db: Database.Database,
  teamId: string,
  options?: FindRespawnHistoryOptions,
): ReadonlyArray<RespawnHistoryRecord> {
  const limit = options?.limit
  const sql = limit
    ? 'SELECT * FROM respawn_history WHERE team_id = ? ORDER BY created_at DESC, id DESC LIMIT ?'
    : 'SELECT * FROM respawn_history WHERE team_id = ? ORDER BY created_at DESC, id DESC'

  const rows = limit
    ? (db.prepare(sql).all(teamId, limit) as RespawnHistoryRecord[])
    : (db.prepare(sql).all(teamId) as RespawnHistoryRecord[])

  return rows.map((row) => ({ ...row }))
}

export function findRespawnHistoryBySession(
  db: Database.Database,
  originalSessionId: string,
): ReadonlyArray<RespawnHistoryRecord> {
  const rows = db
    .prepare(
      'SELECT * FROM respawn_history WHERE original_session_id = ? ORDER BY created_at DESC, id DESC',
    )
    .all(originalSessionId) as RespawnHistoryRecord[]

  return rows.map((row) => ({ ...row }))
}
