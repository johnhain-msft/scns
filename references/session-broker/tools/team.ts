import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { EventLog } from '../services/event-log.js'
import {
  createTeam,
  findTeamById,
  findTeamByName,
  findAllTeams,
  deleteTeam,
  updateTeamStatus,
  archiveTeam,
  addTeamMember,
  removeTeamMember,
  findTeamMembers,
  getSubTeams,
  getTeamTree,
} from '../storage/repositories/team-repository.js'
import { deleteTasksByTeam } from '../storage/repositories/task-repository.js'
import { deleteRespawnPoliciesByTeam, deleteRespawnHistoryByTeam } from '../storage/repositories/respawn-repository.js'
import { deleteScalingPoliciesByTeam } from '../storage/repositories/scaling-repository.js'
import { deleteUsageRecordsByTeam } from '../storage/repositories/usage-repository.js'
import { handleDeregisterSession } from './session.js'
import { type ToolResult, textResult, errorResult } from './helpers.js'

interface CreateTeamInput {
  readonly name: string
  readonly description?: string | null
  readonly parent_team_id?: string | null
}

export function handleCreateTeam(
  db: Database.Database,
  eventLog: EventLog,
  input: CreateTeamInput,
): ToolResult {
  const existing = findTeamByName(db, input.name)
  if (existing) {
    if (existing.status === 'disbanded') {
      deleteTeam(db, existing.id)
    } else {
      return errorResult(`Team with name '${input.name}' already exists (id: ${existing.id})`)
    }
  }

  if (input.parent_team_id) {
    const parent = findTeamById(db, input.parent_team_id)
    if (!parent) {
      return errorResult(`Parent team '${input.parent_team_id}' not found`)
    }
  }

  try {
    const team = createTeam(db, {
      id: randomUUID(),
      name: input.name,
      description: input.description ?? null,
      parent_team_id: input.parent_team_id ?? null,
    })
    eventLog.teamCreated(null, { team_id: team.id, name: team.name })
    return textResult(team)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResult(`Failed to create team: ${message}`)
  }
}

interface DisbandTeamInput {
  readonly team_id: string
}

export function handleDisbandTeam(
  db: Database.Database,
  eventLog: EventLog,
  input: DisbandTeamInput,
): ToolResult {
  const team = findTeamById(db, input.team_id)
  if (!team) {
    return errorResult(`Team '${input.team_id}' not found`)
  }

  // Cascade: disband all descendant teams first (depth-first via tree)
  const descendants = getTeamTree(db, input.team_id).filter((t) => t.id !== input.team_id)
  for (const descendant of descendants) {
    disbandSingleTeam(db, eventLog, descendant.id)
  }

  // Disband the target team itself
  return disbandSingleTeam(db, eventLog, input.team_id)
}

function disbandSingleTeam(
  db: Database.Database,
  eventLog: EventLog,
  teamId: string,
): ToolResult {
  const team = findTeamById(db, teamId)
  if (!team) {
    return errorResult(`Team '${teamId}' not found`)
  }

  const members = findTeamMembers(db, teamId)
  for (const member of members) {
    removeTeamMember(db, teamId, member.session_id)
  }

  const tasksDeleted = deleteTasksByTeam(db, teamId)
  const updated = updateTeamStatus(db, teamId, 'disbanded')

  if (!updated) {
    return errorResult(`Failed to disband team '${teamId}'`)
  }

  // Archive the team for retention (GC will hard-delete after TTL)
  archiveTeam(db, teamId)

  eventLog.teamDisbanded(null, {
    team_id: teamId,
    name: team.name,
    tasks_deleted: tasksDeleted,
  })

  return textResult({
    disbanded: true,
    team_id: teamId,
    name: team.name,
    tasks_deleted: tasksDeleted,
  })
}

interface JoinTeamInput {
  readonly team_id: string
  readonly session_id: string
  readonly name: string
  readonly role?: string
  readonly agent_type?: string | null
}

export function handleJoinTeam(
  db: Database.Database,
  eventLog: EventLog,
  input: JoinTeamInput,
): ToolResult {
  const team = findTeamById(db, input.team_id)
  if (!team) {
    return errorResult(`Team '${input.team_id}' not found`)
  }

  try {
    const member = addTeamMember(db, {
      team_id: input.team_id,
      session_id: input.session_id,
      name: input.name,
      role: input.role,
      agent_type: input.agent_type,
    })
    eventLog.teamMemberJoined(input.session_id, {
      team_id: input.team_id,
      team_name: team.name,
      name: input.name,
      role: member.role,
    })
    return textResult(member)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResult(`Failed to join team: ${message}`)
  }
}

interface LeaveTeamInput {
  readonly team_id: string
  readonly session_id: string
}

export function handleLeaveTeam(
  db: Database.Database,
  eventLog: EventLog,
  input: LeaveTeamInput,
): ToolResult {
  const removed = removeTeamMember(db, input.team_id, input.session_id)
  if (!removed) {
    return errorResult(`Session '${input.session_id}' is not a member of team '${input.team_id}'`)
  }

  eventLog.teamMemberLeft(input.session_id, {
    team_id: input.team_id,
  })

  return textResult({
    left: true,
    team_id: input.team_id,
    session_id: input.session_id,
  })
}

interface ListTeamMembersInput {
  readonly team_id: string
}

export function handleListTeamMembers(
  db: Database.Database,
  input: ListTeamMembersInput,
): ToolResult {
  const team = findTeamById(db, input.team_id)
  if (!team) {
    return errorResult(`Team '${input.team_id}' not found`)
  }

  const members = findTeamMembers(db, input.team_id)
  return textResult({ team, members })
}

interface ListTeamsInput {
  readonly status?: string
  readonly include_archived?: boolean
}

export function handleListTeams(
  db: Database.Database,
  input: ListTeamsInput,
): ToolResult {
  const teams = findAllTeams(db, input.status, input.include_archived)
  return textResult(teams)
}

interface PurgeTeamInput {
  readonly team_id: string
}

export function handlePurgeTeam(
  db: Database.Database,
  eventLog: EventLog,
  input: PurgeTeamInput,
): ToolResult {
  const team = findTeamById(db, input.team_id)
  if (!team) {
    return errorResult(`Team '${input.team_id}' not found`)
  }

  const members = findTeamMembers(db, input.team_id)
  const sessionIds = members.map((m) => m.session_id)

  for (const sessionId of sessionIds) {
    handleDeregisterSession(db, eventLog, { id: sessionId })
  }

  const respawnPoliciesDeleted = deleteRespawnPoliciesByTeam(db, input.team_id)
  const scalingPoliciesDeleted = deleteScalingPoliciesByTeam(db, input.team_id)
  const respawnHistoryDeleted = deleteRespawnHistoryByTeam(db, input.team_id)
  const usageRecordsDeleted = deleteUsageRecordsByTeam(db, input.team_id)
  deleteTasksByTeam(db, input.team_id)
  deleteTeam(db, input.team_id)

  eventLog.teamPurged(null, {
    team_id: input.team_id,
    team_name: team.name,
    sessions_purged: sessionIds.length,
    session_ids: sessionIds,
    respawn_policies_deleted: respawnPoliciesDeleted,
    scaling_policies_deleted: scalingPoliciesDeleted,
    respawn_history_deleted: respawnHistoryDeleted,
    usage_records_deleted: usageRecordsDeleted,
  })

  return textResult({
    purged: true,
    team_id: input.team_id,
    team_name: team.name,
    sessions_purged: sessionIds.length,
    session_ids: sessionIds,
    respawn_policies_deleted: respawnPoliciesDeleted,
    scaling_policies_deleted: scalingPoliciesDeleted,
    respawn_history_deleted: respawnHistoryDeleted,
    usage_records_deleted: usageRecordsDeleted,
  })
}

interface GetSubTeamsInput {
  readonly team_id: string
}

export function handleGetSubTeams(
  db: Database.Database,
  input: GetSubTeamsInput,
): ToolResult {
  const team = findTeamById(db, input.team_id)
  if (!team) {
    return errorResult(`Team '${input.team_id}' not found`)
  }

  const subs = getSubTeams(db, input.team_id)
  return textResult(subs)
}

interface GetTeamTreeInput {
  readonly team_id: string
}

export function handleGetTeamTree(
  db: Database.Database,
  input: GetTeamTreeInput,
): ToolResult {
  const team = findTeamById(db, input.team_id)
  if (!team) {
    return errorResult(`Team '${input.team_id}' not found`)
  }

  const tree = getTeamTree(db, input.team_id)
  return textResult(tree)
}
