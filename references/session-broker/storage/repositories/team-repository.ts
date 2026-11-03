import type Database from 'better-sqlite3'
import type { Team, TeamMember } from '../../types.js'

interface CreateTeamInput {
  readonly id: string
  readonly name: string
  readonly description?: string | null
  readonly parent_team_id?: string | null
}

export function createTeam(db: Database.Database, input: CreateTeamInput): Team {
  db.prepare(
    `INSERT INTO teams (id, name, description, parent_team_id)
     VALUES (@id, @name, @description, @parent_team_id)`
  ).run({
    id: input.id,
    name: input.name,
    description: input.description ?? null,
    parent_team_id: input.parent_team_id ?? null,
  })

  return findTeamById(db, input.id)!
}

export function findTeamById(db: Database.Database, id: string): Team | null {
  const row = db.prepare('SELECT * FROM teams WHERE id = ?').get(id) as Team | undefined
  return row ? { ...row } : null
}

export function findTeamByName(db: Database.Database, name: string): Team | null {
  const row = db.prepare('SELECT * FROM teams WHERE name = ?').get(name) as Team | undefined
  return row ? { ...row } : null
}

export function findAllTeams(
  db: Database.Database,
  status?: string,
  includeArchived?: boolean,
  parentTeamId?: string,
): ReadonlyArray<Team> {
  const conditions: string[] = []
  const params: unknown[] = []

  if (status) {
    conditions.push('status = ?')
    params.push(status)
  }
  if (!includeArchived) {
    conditions.push('archived_at IS NULL')
  }
  if (parentTeamId !== undefined) {
    conditions.push('parent_team_id = ?')
    params.push(parentTeamId)
  }

  const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''
  const rows = db.prepare(`SELECT * FROM teams${where} ORDER BY created_at`).all(...params) as Team[]
  return rows.map((row) => ({ ...row }))
}

export function archiveTeam(db: Database.Database, id: string): boolean {
  const result = db.prepare("UPDATE teams SET archived_at = datetime('now') WHERE id = ? AND archived_at IS NULL").run(id)
  return result.changes > 0
}

export function findArchivedTeamsOlderThan(
  db: Database.Database,
  ttlSeconds: number,
): ReadonlyArray<Team> {
  const rows = db.prepare(
    `SELECT * FROM teams
     WHERE archived_at IS NOT NULL
     AND archived_at <= datetime('now', '-' || ? || ' seconds')
     ORDER BY archived_at`
  ).all(ttlSeconds) as Team[]
  return rows.map((row) => ({ ...row }))
}

export function updateTeamStatus(db: Database.Database, id: string, status: string): Team | null {
  db.prepare('UPDATE teams SET status = ? WHERE id = ?').run(status, id)
  return findTeamById(db, id)
}

export function deleteTeam(db: Database.Database, id: string): boolean {
  const result = db.prepare('DELETE FROM teams WHERE id = ?').run(id)
  return result.changes > 0
}

interface AddMemberInput {
  readonly team_id: string
  readonly session_id: string
  readonly name: string
  readonly role?: string
  readonly agent_type?: string | null
}

export function addTeamMember(db: Database.Database, input: AddMemberInput): TeamMember {
  db.prepare(
    `INSERT INTO team_members (team_id, session_id, name, role, agent_type)
     VALUES (@team_id, @session_id, @name, @role, @agent_type)`
  ).run({
    team_id: input.team_id,
    session_id: input.session_id,
    name: input.name,
    role: input.role ?? 'general',
    agent_type: input.agent_type ?? null,
  })

  return findTeamMember(db, input.team_id, input.session_id)!
}

export function findTeamMember(
  db: Database.Database,
  teamId: string,
  sessionId: string,
): TeamMember | null {
  const row = db.prepare(
    'SELECT * FROM team_members WHERE team_id = ? AND session_id = ?'
  ).get(teamId, sessionId) as TeamMember | undefined
  return row ? { ...row } : null
}

export function removeTeamMember(
  db: Database.Database,
  teamId: string,
  sessionId: string,
): boolean {
  const result = db.prepare(
    'DELETE FROM team_members WHERE team_id = ? AND session_id = ?'
  ).run(teamId, sessionId)
  return result.changes > 0
}

export function findTeamMembers(
  db: Database.Database,
  teamId: string,
): ReadonlyArray<TeamMember> {
  const rows = db.prepare(
    'SELECT * FROM team_members WHERE team_id = ? ORDER BY joined_at'
  ).all(teamId) as TeamMember[]
  return rows.map((row) => ({ ...row }))
}

export function findTeamBySession(
  db: Database.Database,
  sessionId: string,
): Team | null {
  const row = db.prepare(
    `SELECT t.* FROM teams t
     JOIN team_members tm ON t.id = tm.team_id
     WHERE tm.session_id = ?
     LIMIT 1`
  ).get(sessionId) as Team | undefined
  return row ? { ...row } : null
}

export function updateMemberStatus(
  db: Database.Database,
  teamId: string,
  sessionId: string,
  status: string,
): void {
  db.prepare(
    'UPDATE team_members SET status = ? WHERE team_id = ? AND session_id = ?'
  ).run(status, teamId, sessionId)
}

export function deleteAllTeams(db: Database.Database): number {
  const result = db.prepare('DELETE FROM teams').run()
  return result.changes
}

export function countTeamsByStatus(db: Database.Database, status: string): number {
  const row = db.prepare('SELECT COUNT(*) as count FROM teams WHERE status = ?').get(status) as { count: number }
  return row.count
}

interface SessionTeamInfo {
  readonly name: string
  readonly role: string
}

export function findTeamInfoBySession(
  db: Database.Database,
  sessionId: string,
): SessionTeamInfo | null {
  const row = db.prepare(
    `SELECT t.name, tm.role FROM teams t
     JOIN team_members tm ON t.id = tm.team_id
     WHERE tm.session_id = ?
     LIMIT 1`
  ).get(sessionId) as { name: string; role: string } | undefined
  return row ? { name: row.name, role: row.role } : null
}

export interface TeamMemberSnapshot {
  readonly team_id: string
  readonly session_id: string
  readonly role: string
  readonly name: string
  readonly agent_type: string | null
}

export function findTeamMemberInfoBySession(
  db: Database.Database,
  sessionId: string,
): TeamMemberSnapshot | null {
  const row = db.prepare(
    `SELECT tm.team_id, tm.session_id, tm.role, tm.name, tm.agent_type
     FROM team_members tm
     JOIN teams t ON tm.team_id = t.id
     WHERE tm.session_id = ? AND t.status = 'active'
     LIMIT 1`
  ).get(sessionId) as TeamMemberSnapshot | undefined
  return row ? { ...row } : null
}

export function countTeamMembersByRole(
  db: Database.Database,
  teamId: string,
  role: string,
): number {
  const row = db.prepare(
    'SELECT COUNT(*) as count FROM team_members tm JOIN sessions s ON tm.session_id = s.id WHERE tm.team_id = ? AND tm.role = ? AND s.status = \'active\''
  ).get(teamId, role) as { count: number }
  return row.count
}

export interface TeamStatus {
  readonly name: string
  readonly member_count: number
  readonly task_counts: {
    readonly pending: number
    readonly in_progress: number
    readonly completed: number
  }
  readonly idle: boolean
  readonly sub_teams: {
    readonly total: number
    readonly active: number
  }
}

export function getTeamStatus(db: Database.Database, teamId: string): TeamStatus | null {
  const team = findTeamById(db, teamId)
  if (!team) return null

  const members = findTeamMembers(db, teamId)

  const countByStatus = (status: string): number => {
    const row = db.prepare(
      'SELECT COUNT(*) as count FROM tasks WHERE team_id = ? AND status = ?'
    ).get(teamId, status) as { count: number }
    return row.count
  }

  const pending = countByStatus('pending')
  const inProgress = countByStatus('in_progress')
  const completed = countByStatus('completed')

  const subs = getSubTeams(db, teamId)
  const activeSubs = subs.filter((s) => s.status === 'active')

  return {
    name: team.name,
    member_count: members.length,
    task_counts: { pending, in_progress: inProgress, completed },
    idle: inProgress === 0,
    sub_teams: { total: subs.length, active: activeSubs.length },
  }
}

export function getSubTeams(
  db: Database.Database,
  parentTeamId: string,
): ReadonlyArray<Team> {
  const rows = db.prepare(
    'SELECT * FROM teams WHERE parent_team_id = ? ORDER BY created_at'
  ).all(parentTeamId) as Team[]
  return rows.map((row) => ({ ...row }))
}

export function getRootTeams(db: Database.Database): ReadonlyArray<Team> {
  const rows = db.prepare(
    'SELECT * FROM teams WHERE parent_team_id IS NULL AND archived_at IS NULL ORDER BY created_at'
  ).all() as Team[]
  return rows.map((row) => ({ ...row }))
}

export function getTeamTree(
  db: Database.Database,
  teamId: string,
): ReadonlyArray<Team> {
  const root = findTeamById(db, teamId)
  if (!root) return []

  const result: Team[] = [{ ...root }]
  const queue: string[] = [teamId]
  const visited = new Set<string>([teamId])

  while (queue.length > 0) {
    const currentId = queue.shift()!
    const children = getSubTeams(db, currentId)
    for (const child of children) {
      if (visited.has(child.id)) continue
      visited.add(child.id)
      result.push({ ...child })
      queue.push(child.id)
    }
  }

  return result
}

export function getAncestors(
  db: Database.Database,
  teamId: string,
): ReadonlyArray<Team> {
  const ancestors: Team[] = []
  let current = findTeamById(db, teamId)

  if (!current) return ancestors

  const visited = new Set<string>([teamId])
  let parentId = current.parent_team_id

  while (parentId) {
    if (visited.has(parentId)) break // safety: prevent infinite loop
    visited.add(parentId)
    const parent = findTeamById(db, parentId)
    if (!parent) break
    ancestors.push({ ...parent })
    parentId = parent.parent_team_id
  }

  return ancestors
}
