import type Database from 'better-sqlite3'
import type { UsageRecord } from '../../types.js'

interface InsertUsageInput {
  readonly session_id: string
  readonly team_id?: string | null
  readonly task_id?: number | null
  readonly tokens_in: number
  readonly tokens_out: number
  readonly model?: string | null
  readonly cost_usd: number
}

export function insertUsageRecord(
  db: Database.Database,
  input: InsertUsageInput,
): UsageRecord {
  const result = db.prepare(
    `INSERT INTO usage_records (session_id, team_id, task_id, tokens_in, tokens_out, model, cost_usd)
     VALUES (@session_id, @team_id, @task_id, @tokens_in, @tokens_out, @model, @cost_usd)`
  ).run({
    session_id: input.session_id,
    team_id: input.team_id ?? null,
    task_id: input.task_id ?? null,
    tokens_in: input.tokens_in,
    tokens_out: input.tokens_out,
    model: input.model ?? null,
    cost_usd: input.cost_usd,
  })

  return findUsageRecordById(db, Number(result.lastInsertRowid))!
}

function findUsageRecordById(
  db: Database.Database,
  id: number,
): UsageRecord | null {
  const row = db.prepare(
    'SELECT * FROM usage_records WHERE id = ?'
  ).get(id) as UsageRecord | undefined
  return row ? { ...row } : null
}

export interface UsageSummary {
  readonly total_tokens_in: number
  readonly total_tokens_out: number
  readonly total_cost_usd: number
  readonly record_count: number
}

export function sumUsageBySession(
  db: Database.Database,
  sessionId: string,
): UsageSummary {
  const row = db.prepare(
    `SELECT
       COALESCE(SUM(tokens_in), 0) as total_tokens_in,
       COALESCE(SUM(tokens_out), 0) as total_tokens_out,
       COALESCE(SUM(cost_usd), 0) as total_cost_usd,
       COUNT(*) as record_count
     FROM usage_records WHERE session_id = ?`
  ).get(sessionId) as UsageSummary
  return { ...row }
}

export function sumUsageByTeam(
  db: Database.Database,
  teamId: string,
): UsageSummary {
  const row = db.prepare(
    `SELECT
       COALESCE(SUM(tokens_in), 0) as total_tokens_in,
       COALESCE(SUM(tokens_out), 0) as total_tokens_out,
       COALESCE(SUM(cost_usd), 0) as total_cost_usd,
       COUNT(*) as record_count
     FROM usage_records WHERE team_id = ?`
  ).get(teamId) as UsageSummary
  return { ...row }
}

export function sumUsageByTask(
  db: Database.Database,
  taskId: number,
): UsageSummary {
  const row = db.prepare(
    `SELECT
       COALESCE(SUM(tokens_in), 0) as total_tokens_in,
       COALESCE(SUM(tokens_out), 0) as total_tokens_out,
       COALESCE(SUM(cost_usd), 0) as total_cost_usd,
       COUNT(*) as record_count
     FROM usage_records WHERE task_id = ?`
  ).get(taskId) as UsageSummary
  return { ...row }
}

export function deleteUsageRecordsByTeam(
  db: Database.Database,
  teamId: string,
): number {
  const result = db.prepare(
    'DELETE FROM usage_records WHERE team_id = ?'
  ).run(teamId)
  return result.changes
}

export function deleteAllUsageRecords(db: Database.Database): number {
  const result = db.prepare('DELETE FROM usage_records').run()
  return result.changes
}
