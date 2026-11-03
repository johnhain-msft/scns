import type Database from 'better-sqlite3'
import type { EventLog } from '../services/event-log.js'
import { findTeamById } from '../storage/repositories/team-repository.js'
import {
  upsertRespawnPolicy,
  findRespawnPoliciesByTeam,
  findRespawnHistory,
} from '../storage/repositories/respawn-repository.js'
import { type ToolResult, textResult, errorResult } from './helpers.js'

interface SetRespawnPolicyInput {
  readonly team_id: string
  readonly role: string
  readonly min_count?: number
  readonly max_retries?: number
  readonly backoff_base_ms?: number
  readonly enabled?: boolean
}

export function handleSetRespawnPolicy(
  db: Database.Database,
  eventLog: EventLog,
  input: SetRespawnPolicyInput,
): ToolResult {
  const team = findTeamById(db, input.team_id)
  if (!team) {
    return errorResult(`Team '${input.team_id}' not found`)
  }

  const policy = upsertRespawnPolicy(db, {
    team_id: input.team_id,
    role: input.role,
    min_count: input.min_count,
    max_retries: input.max_retries,
    backoff_base_ms: input.backoff_base_ms,
    enabled: input.enabled,
  })

  eventLog.taskUpdated(null, {
    action: 'respawn_policy_set',
    team_id: input.team_id,
    role: input.role,
  })

  return textResult(policy)
}

interface GetRespawnPolicyInput {
  readonly team_id: string
}

export function handleGetRespawnPolicy(
  db: Database.Database,
  input: GetRespawnPolicyInput,
): ToolResult {
  const team = findTeamById(db, input.team_id)
  if (!team) {
    return errorResult(`Team '${input.team_id}' not found`)
  }

  const policies = findRespawnPoliciesByTeam(db, input.team_id)
  return textResult({ team_id: input.team_id, policies })
}

interface ListRespawnHistoryInput {
  readonly team_id: string
  readonly limit?: number
  readonly status?: string
}

export function handleListRespawnHistory(
  db: Database.Database,
  input: ListRespawnHistoryInput,
): ToolResult {
  const team = findTeamById(db, input.team_id)
  if (!team) {
    return errorResult(`Team '${input.team_id}' not found`)
  }

  const history = findRespawnHistory(db, input.team_id, {
    limit: input.limit,
    status: input.status,
  })
  return textResult({ team_id: input.team_id, history })
}
