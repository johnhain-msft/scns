/**
 * Team Orchestration — high-level team lifecycle management on top of the team repository.
 */

import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { Team, TeamMember } from '../types.js'
import { NotFoundError, ConflictError } from '../errors.js'
import {
  createTeam as repoCreateTeam,
  findTeamById,
  findTeamMembers,
  addTeamMember,
  removeTeamMember,
  updateTeamStatus,
  archiveTeam,
  getTeamTree,
  getAncestors,
  getRootTeams as repoGetRootTeams,
  getSubTeams,
  updateMemberStatus as repoUpdateMemberStatus,
} from '../storage/repositories/team-repository.js'
import { findSessionById } from '../storage/repositories/session-repository.js'

// ── Return types ─────────────────────────────────────────────

export interface TeamInfo {
  readonly team: Team
  readonly members: ReadonlyArray<TeamMember>
  readonly task_counts: {
    readonly pending: number
    readonly in_progress: number
    readonly completed: number
  }
  readonly sub_teams: ReadonlyArray<Team>
}

// ── Public API ───────────────────────────────────────────────

export function createTeam(
  db: Database.Database,
  name: string,
  description?: string,
  parentTeamId?: string,
  projectId?: string,
): Team {
  if (parentTeamId) {
    const parent = findTeamById(db, parentTeamId)
    if (!parent) {
      throw new NotFoundError('Team', parentTeamId)
    }
  }

  const id = randomUUID()
  return repoCreateTeam(db, {
    id,
    name,
    description: description ?? null,
    parent_team_id: parentTeamId ?? null,
    project_id: projectId ?? null,
  })
}

export function disbandTeam(db: Database.Database, teamId: string): Team {
  const team = findTeamById(db, teamId)
  if (!team) {
    throw new NotFoundError('Team', teamId)
  }

  // Remove all members first
  const members = findTeamMembers(db, teamId)
  for (const member of members) {
    removeTeamMember(db, teamId, member.session_id)
  }

  // Set status to disbanded and archive
  updateTeamStatus(db, teamId, 'disbanded')
  archiveTeam(db, teamId)

  return findTeamById(db, teamId)!
}

export function joinTeam(
  db: Database.Database,
  teamId: string,
  sessionId: string,
  name: string,
  role?: string,
  agentType?: string,
): TeamMember {
  const team = findTeamById(db, teamId)
  if (!team) {
    throw new NotFoundError('Team', teamId)
  }
  if (team.status === 'disbanded') {
    throw new ConflictError(`Team '${teamId}' is disbanded`)
  }

  // Validate session exists
  const session = findSessionById(db, sessionId)
  if (!session) {
    throw new NotFoundError('Session', sessionId)
  }

  try {
    return addTeamMember(db, {
      team_id: teamId,
      session_id: sessionId,
      name,
      role,
      agent_type: agentType ?? null,
    })
  } catch (err: unknown) {
    // SQLite UNIQUE constraint violation → ConflictError
    if (err instanceof Error && err.message.includes('UNIQUE constraint')) {
      throw new ConflictError(`Session '${sessionId}' is already a member of team '${teamId}'`)
    }
    throw err
  }
}

export function leaveTeam(db: Database.Database, teamId: string, sessionId: string): void {
  removeTeamMember(db, teamId, sessionId)
}

export function getTeamInfo(db: Database.Database, teamId: string): TeamInfo {
  const team = findTeamById(db, teamId)
  if (!team) {
    throw new NotFoundError('Team', teamId)
  }

  const members = findTeamMembers(db, teamId)
  const subTeams = getSubTeams(db, teamId)

  const countByStatus = (status: string): number => {
    const row = db
      .prepare('SELECT COUNT(*) as count FROM tasks WHERE team_id = ? AND status = ?')
      .get(teamId, status) as { count: number }
    return row.count
  }

  return {
    team,
    members,
    task_counts: {
      pending: countByStatus('pending'),
      in_progress: countByStatus('in_progress'),
      completed: countByStatus('completed'),
    },
    sub_teams: subTeams,
  }
}

export function getTeamHierarchy(db: Database.Database, teamId: string): ReadonlyArray<Team> {
  return getTeamTree(db, teamId)
}

export function getTeamAncestors(db: Database.Database, teamId: string): ReadonlyArray<Team> {
  return getAncestors(db, teamId)
}

export function getRootTeams(db: Database.Database): ReadonlyArray<Team> {
  return repoGetRootTeams(db)
}

export function updateMemberStatus(
  db: Database.Database,
  teamId: string,
  sessionId: string,
  status: string,
): void {
  repoUpdateMemberStatus(db, teamId, sessionId, status)
}
