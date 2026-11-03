import type Database from 'better-sqlite3'
import { findTeamById, findTeamMembers } from '../storage/repositories/team-repository.js'
import { type ToolResult, textResult, errorResult } from './helpers.js'

export interface MemberStats {
  readonly session_id: string
  readonly name: string
  readonly role: string
  readonly messages_sent: number
  readonly tasks_completed: number
  readonly tasks_in_progress: number
  readonly avg_task_duration_seconds: number | null
  readonly active_intents: number
  readonly last_heartbeat: string | null
}

interface GetMemberStatsInput {
  readonly team_id: string
}

function countMessagesSent(db: Database.Database, sessionId: string): number {
  const row = db.prepare(
    'SELECT COUNT(*) as count FROM messages WHERE sender_id = ?'
  ).get(sessionId) as { count: number }
  return row.count
}

function countTasksByOwnerAndStatus(
  db: Database.Database,
  teamId: string,
  owner: string,
  status: string,
): number {
  const row = db.prepare(
    'SELECT COUNT(*) as count FROM tasks WHERE team_id = ? AND owner = ? AND status = ?'
  ).get(teamId, owner, status) as { count: number }
  return row.count
}

function getAvgTaskDuration(
  db: Database.Database,
  teamId: string,
  owner: string,
): number | null {
  const row = db.prepare(
    `SELECT AVG(
       (julianday(updated_at) - julianday(created_at)) * 86400
     ) as avg_duration
     FROM tasks
     WHERE team_id = ? AND owner = ? AND status = 'completed'`
  ).get(teamId, owner) as { avg_duration: number | null }

  if (row.avg_duration === null) {
    return null
  }

  return Math.round(row.avg_duration)
}

function countActiveIntents(db: Database.Database, sessionId: string): number {
  const row = db.prepare(
    'SELECT COUNT(*) as count FROM file_intents WHERE session_id = ?'
  ).get(sessionId) as { count: number }
  return row.count
}

function getLastHeartbeat(db: Database.Database, sessionId: string): string | null {
  const row = db.prepare(
    'SELECT last_heartbeat FROM sessions WHERE id = ?'
  ).get(sessionId) as { last_heartbeat: string } | undefined
  return row?.last_heartbeat ?? null
}

export function handleGetMemberStats(
  db: Database.Database,
  input: GetMemberStatsInput,
): ToolResult {
  const team = findTeamById(db, input.team_id)
  if (!team) {
    return errorResult(`Team '${input.team_id}' not found`)
  }

  const members = findTeamMembers(db, input.team_id)

  const stats: ReadonlyArray<MemberStats> = members.map((member) => ({
    session_id: member.session_id,
    name: member.name,
    role: member.role,
    messages_sent: countMessagesSent(db, member.session_id),
    tasks_completed: countTasksByOwnerAndStatus(db, input.team_id, member.session_id, 'completed'),
    tasks_in_progress: countTasksByOwnerAndStatus(db, input.team_id, member.session_id, 'in_progress'),
    avg_task_duration_seconds: getAvgTaskDuration(db, input.team_id, member.session_id),
    active_intents: countActiveIntents(db, member.session_id),
    last_heartbeat: getLastHeartbeat(db, member.session_id),
  }))

  return textResult({ team_id: input.team_id, members: stats })
}
