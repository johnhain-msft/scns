import type Database from 'better-sqlite3'
import type { EventLog } from '../services/event-log.js'
import {
  insertUsageRecord,
  sumUsageBySession,
  sumUsageByTeam,
  sumUsageByTask,
} from '../storage/repositories/usage-repository.js'
import { type ToolResult, textResult, errorResult } from './helpers.js'

interface RecordUsageInput {
  readonly session_id: string
  readonly team_id?: string | null
  readonly task_id?: number | null
  readonly tokens_in: number
  readonly tokens_out: number
  readonly model?: string | null
  readonly cost_usd: number
}

export function handleRecordUsage(
  db: Database.Database,
  eventLog: EventLog,
  input: RecordUsageInput,
): ToolResult {
  const record = insertUsageRecord(db, {
    session_id: input.session_id,
    team_id: input.team_id,
    task_id: input.task_id,
    tokens_in: input.tokens_in,
    tokens_out: input.tokens_out,
    model: input.model,
    cost_usd: input.cost_usd,
  })

  eventLog.usageRecorded(input.session_id, {
    tokens_in: input.tokens_in,
    tokens_out: input.tokens_out,
    cost_usd: input.cost_usd,
    model: input.model ?? null,
  })

  return textResult(record)
}

interface GetUsageSummaryInput {
  readonly session_id?: string
  readonly team_id?: string
  readonly task_id?: number
}

export function handleGetUsageSummary(
  db: Database.Database,
  input: GetUsageSummaryInput,
): ToolResult {
  if (!input.session_id && !input.team_id && !input.task_id) {
    return errorResult('At least one of session_id, team_id, or task_id is required')
  }

  const result: Record<string, unknown> = {}

  if (input.session_id) {
    result.session = { session_id: input.session_id, ...sumUsageBySession(db, input.session_id) }
  }
  if (input.team_id) {
    result.team = { team_id: input.team_id, ...sumUsageByTeam(db, input.team_id) }
  }
  if (input.task_id) {
    result.task = { task_id: input.task_id, ...sumUsageByTask(db, input.task_id) }
  }

  return textResult(result)
}

interface GetTeamBudgetInput {
  readonly team_id: string
}

export function handleGetTeamBudget(
  db: Database.Database,
  input: GetTeamBudgetInput,
): ToolResult {
  const summary = sumUsageByTeam(db, input.team_id)
  return textResult({
    team_id: input.team_id,
    ...summary,
  })
}
