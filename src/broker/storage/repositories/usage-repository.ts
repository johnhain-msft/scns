import type Database from 'better-sqlite3'

export interface UsageRecord {
  readonly id: number
  readonly session_id: string
  readonly team_id: string | null
  readonly task_id: number | null
  readonly tokens_in: number
  readonly tokens_out: number
  readonly model: string | null
  readonly cost_usd: number
  readonly recorded_at: string
}

export interface CostSummary {
  readonly total_tokens_in: number
  readonly total_tokens_out: number
  readonly total_cost_usd: number
  readonly session_count: number
  readonly record_count: number
}

export interface SessionCostSummary {
  readonly total_tokens_in: number
  readonly total_tokens_out: number
  readonly total_cost_usd: number
  readonly record_count: number
}

interface RecordUsageInput {
  readonly session_id: string
  readonly team_id?: string
  readonly task_id?: number
  readonly tokens_in: number
  readonly tokens_out: number
  readonly model?: string
  readonly cost_usd: number
}

export function recordUsage(db: Database.Database, input: RecordUsageInput): UsageRecord {
  const result = db
    .prepare(
      `INSERT INTO usage_records (session_id, team_id, task_id, tokens_in, tokens_out, model, cost_usd)
       VALUES (@session_id, @team_id, @task_id, @tokens_in, @tokens_out, @model, @cost_usd)`,
    )
    .run({
      session_id: input.session_id,
      team_id: input.team_id ?? null,
      task_id: input.task_id ?? null,
      tokens_in: input.tokens_in,
      tokens_out: input.tokens_out,
      model: input.model ?? null,
      cost_usd: input.cost_usd,
    })

  const row = db
    .prepare('SELECT * FROM usage_records WHERE id = ?')
    .get(result.lastInsertRowid) as UsageRecord

  return { ...row }
}

export function findUsageBySession(
  db: Database.Database,
  sessionId: string,
): ReadonlyArray<UsageRecord> {
  const rows = db
    .prepare('SELECT * FROM usage_records WHERE session_id = ? ORDER BY recorded_at DESC, id DESC')
    .all(sessionId) as UsageRecord[]

  return rows.map((row) => ({ ...row }))
}

export function findUsageByTeam(db: Database.Database, teamId: string): ReadonlyArray<UsageRecord> {
  const rows = db
    .prepare('SELECT * FROM usage_records WHERE team_id = ? ORDER BY recorded_at DESC, id DESC')
    .all(teamId) as UsageRecord[]

  return rows.map((row) => ({ ...row }))
}

export function getSessionCostSummary(
  db: Database.Database,
  sessionId: string,
): SessionCostSummary {
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(tokens_in), 0)  AS total_tokens_in,
         COALESCE(SUM(tokens_out), 0) AS total_tokens_out,
         COALESCE(SUM(cost_usd), 0)   AS total_cost_usd,
         COUNT(*)                      AS record_count
       FROM usage_records
       WHERE session_id = ?`,
    )
    .get(sessionId) as SessionCostSummary

  return { ...row }
}

export function getCostSummary(db: Database.Database): CostSummary {
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(tokens_in), 0)          AS total_tokens_in,
         COALESCE(SUM(tokens_out), 0)         AS total_tokens_out,
         COALESCE(SUM(cost_usd), 0)           AS total_cost_usd,
         COUNT(DISTINCT session_id)            AS session_count,
         COUNT(*)                              AS record_count
       FROM usage_records`,
    )
    .get() as CostSummary

  return { ...row }
}

export function findUsageSince(db: Database.Database, since: string): ReadonlyArray<UsageRecord> {
  const rows = db
    .prepare(
      'SELECT * FROM usage_records WHERE recorded_at >= ? ORDER BY recorded_at DESC, id DESC',
    )
    .all(since) as UsageRecord[]

  return rows.map((row) => ({ ...row }))
}

export function deleteUsageBySession(db: Database.Database, sessionId: string): number {
  const result = db.prepare('DELETE FROM usage_records WHERE session_id = ?').run(sessionId)
  return result.changes
}
