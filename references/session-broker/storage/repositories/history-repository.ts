import type Database from 'better-sqlite3'

const DEFAULT_RETENTION_DAYS = 7

export interface TeamHistoryRecord {
  readonly id: string
  readonly name: string
  readonly description: string | null
  readonly status: string | null
  readonly created_at: string | null
  readonly archived_at: string | null
  readonly member_summary: string | null
  readonly task_summary: string | null
  readonly purged_at: string | null
}

export interface SessionHistoryRecord {
  readonly id: string
  readonly purpose: string | null
  readonly working_dir: string | null
  readonly worktree: string | null
  readonly status: string | null
  readonly last_heartbeat: string | null
  readonly created_at: string | null
  readonly archived_at: string | null
  readonly team_name: string | null
  readonly purged_at: string | null
}

export interface TaskHistoryRecord {
  readonly id: number
  readonly team_id: string
  readonly seq: number | null
  readonly subject: string
  readonly description: string | null
  readonly status: string | null
  readonly owner: string | null
  readonly active_form: string | null
  readonly created_at: string | null
  readonly updated_at: string | null
  readonly team_name: string | null
  readonly purged_at: string | null
}

export interface MessageHistoryRecord {
  readonly id: string
  readonly sender_id: string | null
  readonly receiver_id: string | null
  readonly content: string
  readonly story_id: string | null
  readonly reply_to: string | null
  readonly created_at: string | null
  readonly read_at: string | null
  readonly purged_at: string | null
}

export interface PurgeTeamResult {
  readonly team_id: string
  readonly team_name: string
  readonly members_archived: number
  readonly tasks_archived: number
  readonly messages_archived: number
}

export interface PurgeSessionResult {
  readonly session_id: string
  readonly messages_archived: number
}

export interface HistoryQueryOptions {
  readonly limit?: number
  readonly since?: string
  readonly name?: string
}

export interface ExpiredHistoryResult {
  readonly teams_deleted: number
  readonly sessions_deleted: number
  readonly tasks_deleted: number
  readonly messages_deleted: number
}

export function purgeTeamToHistory(
  db: Database.Database,
  teamId: string,
): PurgeTeamResult | null {
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId) as Record<string, unknown> | undefined
  if (!team) return null

  const teamName = team.name as string

  // Snapshot members as JSON summary
  const members = db.prepare(
    'SELECT name, role, agent_type, status FROM team_members WHERE team_id = ?'
  ).all(teamId) as ReadonlyArray<Record<string, unknown>>
  const memberSummary = JSON.stringify(members)

  // Snapshot tasks as JSON summary
  const tasks = db.prepare(
    'SELECT id, subject, status, owner FROM tasks WHERE team_id = ?'
  ).all(teamId) as ReadonlyArray<Record<string, unknown>>
  const taskSummary = JSON.stringify(tasks)

  // Archive tasks to tasks_history
  const taskRows = db.prepare(
    'SELECT * FROM tasks WHERE team_id = ?'
  ).all(teamId) as ReadonlyArray<Record<string, unknown>>

  const insertTask = db.prepare(
    `INSERT INTO tasks_history (id, team_id, seq, subject, description, status, owner, active_form, created_at, updated_at, team_name)
     VALUES (@id, @team_id, @seq, @subject, @description, @status, @owner, @active_form, @created_at, @updated_at, @team_name)`
  )

  for (const task of taskRows) {
    insertTask.run({ ...task, team_name: teamName })
  }

  // Archive messages from team members to messages_history
  const memberSessionIds = db.prepare(
    'SELECT session_id FROM team_members WHERE team_id = ?'
  ).all(teamId) as ReadonlyArray<{ session_id: string }>

  let messagesArchived = 0
  const insertMessage = db.prepare(
    `INSERT INTO messages_history (id, sender_id, receiver_id, content, story_id, reply_to, created_at, read_at)
     VALUES (@id, @sender_id, @receiver_id, @content, @story_id, @reply_to, @created_at, @read_at)`
  )

  const seenMessageIds = new Set<string>()
  for (const { session_id } of memberSessionIds) {
    const msgs = db.prepare(
      'SELECT * FROM messages WHERE sender_id = ? OR receiver_id = ?'
    ).all(session_id, session_id) as ReadonlyArray<Record<string, unknown>>

    for (const msg of msgs) {
      const msgId = msg.id as string
      if (!seenMessageIds.has(msgId)) {
        seenMessageIds.add(msgId)
        try {
          insertMessage.run(msg)
          messagesArchived += 1
        } catch {
          // Ignore duplicates from prior partial runs
        }
      }
    }
  }

  // Insert team into teams_history
  db.prepare(
    `INSERT INTO teams_history (id, name, description, status, created_at, archived_at, member_summary, task_summary)
     VALUES (@id, @name, @description, @status, @created_at, @archived_at, @member_summary, @task_summary)`
  ).run({
    ...team,
    member_summary: memberSummary,
    task_summary: taskSummary,
  })

  // Delete associated data from active tables (order matters for FK constraints)
  db.prepare('DELETE FROM task_dependencies WHERE task_id IN (SELECT id FROM tasks WHERE team_id = ?)').run(teamId)
  db.prepare('DELETE FROM tasks WHERE team_id = ?').run(teamId)
  db.prepare('DELETE FROM respawn_policies WHERE team_id = ?').run(teamId)
  db.prepare('DELETE FROM respawn_history WHERE team_id = ?').run(teamId)
  db.prepare('DELETE FROM scaling_policies WHERE team_id = ?').run(teamId)
  db.prepare('DELETE FROM usage_records WHERE team_id = ?').run(teamId)

  // Delete messages for member sessions
  for (const { session_id } of memberSessionIds) {
    db.prepare('DELETE FROM messages WHERE sender_id = ? OR receiver_id = ?').run(session_id, session_id)
  }

  db.prepare('DELETE FROM team_members WHERE team_id = ?').run(teamId)
  db.prepare('DELETE FROM teams WHERE id = ?').run(teamId)

  return {
    team_id: teamId,
    team_name: teamName,
    members_archived: members.length,
    tasks_archived: taskRows.length,
    messages_archived: messagesArchived,
  }
}

export function purgeSessionToHistory(
  db: Database.Database,
  sessionId: string,
): PurgeSessionResult | null {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as Record<string, unknown> | undefined
  if (!session) return null

  // Find team name for context
  const teamInfo = db.prepare(
    `SELECT t.name FROM teams t
     JOIN team_members tm ON t.id = tm.team_id
     WHERE tm.session_id = ? LIMIT 1`
  ).get(sessionId) as { name: string } | undefined

  // Archive messages
  const msgs = db.prepare(
    'SELECT * FROM messages WHERE sender_id = ? OR receiver_id = ?'
  ).all(sessionId, sessionId) as ReadonlyArray<Record<string, unknown>>

  const insertMessage = db.prepare(
    `INSERT INTO messages_history (id, sender_id, receiver_id, content, story_id, reply_to, created_at, read_at)
     VALUES (@id, @sender_id, @receiver_id, @content, @story_id, @reply_to, @created_at, @read_at)`
  )

  let messagesArchived = 0
  for (const msg of msgs) {
    try {
      insertMessage.run(msg)
      messagesArchived += 1
    } catch {
      // Ignore duplicates
    }
  }

  // Insert session into sessions_history
  db.prepare(
    `INSERT INTO sessions_history (id, purpose, working_dir, worktree, status, last_heartbeat, created_at, archived_at, team_name)
     VALUES (@id, @purpose, @working_dir, @worktree, @status, @last_heartbeat, @created_at, @archived_at, @team_name)`
  ).run({
    ...session,
    team_name: teamInfo?.name ?? null,
  })

  // Clean up active data
  db.prepare('DELETE FROM messages WHERE sender_id = ? OR receiver_id = ?').run(sessionId, sessionId)
  db.prepare('DELETE FROM file_intents WHERE session_id = ?').run(sessionId)
  db.prepare('DELETE FROM shared_state WHERE session_id = ?').run(sessionId)
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId)

  return {
    session_id: sessionId,
    messages_archived: messagesArchived,
  }
}

export function queryTeamHistory(
  db: Database.Database,
  options?: HistoryQueryOptions,
): ReadonlyArray<TeamHistoryRecord> {
  const conditions: string[] = []
  const params: unknown[] = []

  if (options?.since) {
    conditions.push('purged_at >= ?')
    params.push(options.since)
  }
  if (options?.name) {
    conditions.push('name LIKE ?')
    params.push(`%${options.name}%`)
  }

  const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''
  const limit = options?.limit ?? 50

  const rows = db.prepare(
    `SELECT * FROM teams_history${where} ORDER BY purged_at DESC LIMIT ?`
  ).all(...params, limit) as TeamHistoryRecord[]

  return rows.map((row) => ({ ...row }))
}

export function querySessionHistory(
  db: Database.Database,
  options?: HistoryQueryOptions,
): ReadonlyArray<SessionHistoryRecord> {
  const conditions: string[] = []
  const params: unknown[] = []

  if (options?.since) {
    conditions.push('purged_at >= ?')
    params.push(options.since)
  }

  const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''
  const limit = options?.limit ?? 50

  const rows = db.prepare(
    `SELECT * FROM sessions_history${where} ORDER BY purged_at DESC LIMIT ?`
  ).all(...params, limit) as SessionHistoryRecord[]

  return rows.map((row) => ({ ...row }))
}

export function queryTaskHistory(
  db: Database.Database,
  teamId?: string,
  limit?: number,
): ReadonlyArray<TaskHistoryRecord> {
  const maxRows = limit ?? 50

  if (teamId) {
    const rows = db.prepare(
      'SELECT * FROM tasks_history WHERE team_id = ? ORDER BY purged_at DESC LIMIT ?'
    ).all(teamId, maxRows) as TaskHistoryRecord[]
    return rows.map((row) => ({ ...row }))
  }

  const rows = db.prepare(
    'SELECT * FROM tasks_history ORDER BY purged_at DESC LIMIT ?'
  ).all(maxRows) as TaskHistoryRecord[]
  return rows.map((row) => ({ ...row }))
}

export function queryMessageHistory(
  db: Database.Database,
  sessionId?: string,
  limit?: number,
): ReadonlyArray<MessageHistoryRecord> {
  const maxRows = limit ?? 50

  if (sessionId) {
    const rows = db.prepare(
      'SELECT * FROM messages_history WHERE sender_id = ? OR receiver_id = ? ORDER BY purged_at DESC LIMIT ?'
    ).all(sessionId, sessionId, maxRows) as MessageHistoryRecord[]
    return rows.map((row) => ({ ...row }))
  }

  const rows = db.prepare(
    'SELECT * FROM messages_history ORDER BY purged_at DESC LIMIT ?'
  ).all(maxRows) as MessageHistoryRecord[]
  return rows.map((row) => ({ ...row }))
}

export function deleteExpiredHistory(
  db: Database.Database,
  retentionDays?: number,
): ExpiredHistoryResult {
  const days = retentionDays ?? parseInt(process.env.HISTORY_RETENTION_DAYS ?? String(DEFAULT_RETENTION_DAYS), 10)

  const teamsResult = db.prepare(
    `DELETE FROM teams_history WHERE purged_at <= datetime('now', '-' || ? || ' days')`
  ).run(days)

  const sessionsResult = db.prepare(
    `DELETE FROM sessions_history WHERE purged_at <= datetime('now', '-' || ? || ' days')`
  ).run(days)

  const tasksResult = db.prepare(
    `DELETE FROM tasks_history WHERE purged_at <= datetime('now', '-' || ? || ' days')`
  ).run(days)

  const messagesResult = db.prepare(
    `DELETE FROM messages_history WHERE purged_at <= datetime('now', '-' || ? || ' days')`
  ).run(days)

  return {
    teams_deleted: teamsResult.changes,
    sessions_deleted: sessionsResult.changes,
    tasks_deleted: tasksResult.changes,
    messages_deleted: messagesResult.changes,
  }
}

export function countHistoryRecords(
  db: Database.Database,
): { teams: number; sessions: number; tasks: number; messages: number } {
  const teams = (db.prepare('SELECT COUNT(*) as count FROM teams_history').get() as { count: number }).count
  const sessions = (db.prepare('SELECT COUNT(*) as count FROM sessions_history').get() as { count: number }).count
  const tasks = (db.prepare('SELECT COUNT(*) as count FROM tasks_history').get() as { count: number }).count
  const messages = (db.prepare('SELECT COUNT(*) as count FROM messages_history').get() as { count: number }).count

  return { teams, sessions, tasks, messages }
}
