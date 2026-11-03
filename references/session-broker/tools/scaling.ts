import type Database from 'better-sqlite3'
import type { EventLog } from '../services/event-log.js'
import { findTeamById } from '../storage/repositories/team-repository.js'
import {
  upsertScalingPolicy,
  findScalingPoliciesByTeam,
} from '../storage/repositories/scaling-repository.js'
import { type ToolResult, textResult, errorResult } from './helpers.js'

interface SetScalingPolicyInput {
  readonly team_id: string
  readonly role: string
  readonly min_count?: number
  readonly max_count?: number
  readonly scale_up_threshold?: number
  readonly scale_down_threshold?: number
  readonly cooldown_ms?: number
  readonly enabled?: boolean
}

export function handleSetScalingPolicy(
  db: Database.Database,
  eventLog: EventLog,
  input: SetScalingPolicyInput,
): ToolResult {
  const team = findTeamById(db, input.team_id)
  if (!team) {
    return errorResult(`Team '${input.team_id}' not found`)
  }

  const policy = upsertScalingPolicy(db, {
    team_id: input.team_id,
    role: input.role,
    min_count: input.min_count,
    max_count: input.max_count,
    scale_up_threshold: input.scale_up_threshold,
    scale_down_threshold: input.scale_down_threshold,
    cooldown_ms: input.cooldown_ms,
    enabled: input.enabled,
  })

  eventLog.taskUpdated(null, {
    action: 'scaling_policy_set',
    team_id: input.team_id,
    role: input.role,
  })

  return textResult(policy)
}

interface GetScalingPolicyInput {
  readonly team_id: string
}

export function handleGetScalingPolicy(
  db: Database.Database,
  input: GetScalingPolicyInput,
): ToolResult {
  const team = findTeamById(db, input.team_id)
  if (!team) {
    return errorResult(`Team '${input.team_id}' not found`)
  }

  const policies = findScalingPoliciesByTeam(db, input.team_id)
  return textResult({ team_id: input.team_id, policies })
}
