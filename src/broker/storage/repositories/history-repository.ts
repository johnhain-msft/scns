import type Database from 'better-sqlite3'
import {
  archiveMessages,
  countRetainedMessagesForSession,
  findSettleableMessageIds,
} from './message-repository.js'

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
  readonly client_message_id: string | null
  readonly created_at: string | null
  readonly delivered_at: string | null
  readonly read_at: string | null
  readonly disposition: string | null
  readonly disposition_at: string | null
  readonly disposition_note: string | null
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
  /**
   * Issue #70: number of live directed messages this session sent that other
   * participants have not yet read/disposed. When non-zero the sessions row
   * is retained (identity must outlive the correspondence referencing it)
   * and the purge should be retried after the mail settles.
   */
  readonly messages_retained: number
  readonly deferred: boolean
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

export function purgeTeamToHistory(db: Database.Database, teamId: string): PurgeTeamResult | null {
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId) as
    | Record<string, unknown>
    | undefined
  if (!team) return null

  const teamName = team.name as string

  const doPurge = db.transaction(() => {
    // Snapshot members as JSON summary
    const members = db
      .prepare('SELECT name, role, agent_type, status FROM team_members WHERE team_id = ?')
      .all(teamId) as ReadonlyArray<Record<string, unknown>>
    const memberSummary = JSON.stringify(members)

    // Snapshot tasks as JSON summary
    const tasks = db
      .prepare('SELECT id, subject, status, owner FROM tasks WHERE team_id = ?')
      .all(teamId) as ReadonlyArray<Record<string, unknown>>
    const taskSummary = JSON.stringify(tasks)

    // Archive tasks to tasks_history
    const taskRows = db
      .prepare('SELECT * FROM tasks WHERE team_id = ?')
      .all(teamId) as ReadonlyArray<Record<string, unknown>>

    const insertTask = db.prepare(
      `INSERT INTO tasks_history (id, team_id, seq, subject, description, status, owner, active_form, created_at, updated_at, team_name)
       VALUES (@id, @team_id, @seq, @subject, @description, @status, @owner, @active_form, @created_at, @updated_at, @team_name)`,
    )

    for (const task of taskRows) {
      insertTask.run({ ...task, team_name: teamName })
    }

    // Archive team correspondence to messages_history.
    //
    // Issue #70 retention invariant: disbanding a team settles the TEAM's
    // coordination record, not its members' private correspondence — member
    // sessions survive a team purge. Settleable here: messages scoped to
    // this team (team_id) and member correspondence already read/disposed.
    // Unread directed mail stays live so no participant's inbox is emptied
    // by another party's lifecycle event.
    const memberSessionIds = db
      .prepare('SELECT session_id FROM team_members WHERE team_id = ?')
      .all(teamId) as ReadonlyArray<{ session_id: string }>

    let messagesArchived = 0
    const insertMessage = db.prepare(
      `INSERT INTO messages_history (id, sender_id, receiver_id, content, story_id, reply_to, client_message_id, created_at, delivered_at, read_at, disposition, disposition_at, disposition_note)
       VALUES (@id, @sender_id, @receiver_id, @content, @story_id, @reply_to, @client_message_id, @created_at, @delivered_at, @read_at, @disposition, @disposition_at, @disposition_note)`,
    )

    const settleableMessages = new Map<string, Record<string, unknown>>()
    const teamScoped = db
      .prepare('SELECT * FROM messages WHERE team_id = ?')
      .all(teamId) as ReadonlyArray<Record<string, unknown>>
    for (const msg of teamScoped) {
      settleableMessages.set(msg.id as string, msg)
    }
    for (const { session_id } of memberSessionIds) {
      const settled = db
        .prepare(
          `SELECT * FROM messages
           WHERE (sender_id = ? OR receiver_id = ?)
             AND (read_at IS NOT NULL OR disposition IS NOT NULL)`,
        )
        .all(session_id, session_id) as ReadonlyArray<Record<string, unknown>>
      for (const msg of settled) {
        settleableMessages.set(msg.id as string, msg)
      }
    }

    for (const msg of settleableMessages.values()) {
      try {
        insertMessage.run({
          id: msg.id,
          sender_id: msg.sender_id ?? null,
          receiver_id: msg.receiver_id ?? null,
          content: msg.content,
          story_id: msg.story_id ?? null,
          reply_to: msg.reply_to ?? null,
          client_message_id: msg.client_message_id ?? null,
          created_at: msg.created_at ?? null,
          delivered_at: msg.delivered_at ?? null,
          read_at: msg.read_at ?? null,
          disposition: msg.disposition ?? null,
          disposition_at: msg.disposition_at ?? null,
          disposition_note: msg.disposition_note ?? null,
        })
        messagesArchived += 1
      } catch {
        // Ignore duplicates from prior partial runs
      }
    }

    // Insert team into teams_history
    db.prepare(
      `INSERT INTO teams_history (id, name, description, status, created_at, archived_at, member_summary, task_summary)
       VALUES (@id, @name, @description, @status, @created_at, @archived_at, @member_summary, @task_summary)`,
    ).run({
      ...team,
      member_summary: memberSummary,
      task_summary: taskSummary,
    })

    // Delete associated data from active tables (order matters for FK constraints)
    db.prepare(
      'DELETE FROM task_dependencies WHERE task_id IN (SELECT id FROM tasks WHERE team_id = ?)',
    ).run(teamId)
    db.prepare('DELETE FROM tasks WHERE team_id = ?').run(teamId)
    db.prepare('DELETE FROM respawn_policies WHERE team_id = ?').run(teamId)
    db.prepare('DELETE FROM respawn_history WHERE team_id = ?').run(teamId)
    db.prepare('DELETE FROM scaling_policies WHERE team_id = ?').run(teamId)
    db.prepare('DELETE FROM usage_records WHERE team_id = ?').run(teamId)

    // Delete only the settled messages archived above — unread directed
    // member mail stays live (issue #70).
    const deleteMessage = db.prepare('DELETE FROM messages WHERE id = ?')
    for (const id of settleableMessages.keys()) {
      deleteMessage.run(id)
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
  })

  return doPurge()
}

/**
 * @deprecated Prefer `terminateSession` in services/session-retirement.ts —
 * it is the production settlement path and shares these exact rules. This
 * function delegates to the same primitives so the retention invariant
 * cannot drift between the two.
 */
export function purgeSessionToHistory(
  db: Database.Database,
  sessionId: string,
): PurgeSessionResult | null {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as
    | Record<string, unknown>
    | undefined
  if (!session) return null

  const doPurge = db.transaction((): PurgeSessionResult => {
    // Find team name for context
    const teamInfo = db
      .prepare(
        `SELECT t.name FROM teams t
       JOIN team_members tm ON t.id = tm.team_id
       WHERE tm.session_id = ? LIMIT 1`,
      )
      .get(sessionId) as { name: string } | undefined

    // Issue #70 retention invariant: settle only this session's own inbox,
    // correspondence already read/disposed, and broadcasts it sent. Directed
    // mail it sent that its recipient has not read/disposed stays live —
    // deleting it (or this row, whose FK would SET NULL the sender) would
    // damage another participant's inbox.
    const messagesArchived = archiveMessages(db, findSettleableMessageIds(db, sessionId))
    const retained = countRetainedMessagesForSession(db, sessionId)

    if (retained > 0) {
      // Keep the identity row (archived, lease expired) until the mail settles.
      db.prepare(
        `UPDATE sessions SET status = 'expired', archived_at = COALESCE(archived_at, datetime('now'))
         WHERE id = ?`,
      ).run(sessionId)
      return {
        session_id: sessionId,
        messages_archived: messagesArchived,
        messages_retained: retained,
        deferred: true,
      }
    }

    // Insert session into sessions_history
    db.prepare(
      `INSERT INTO sessions_history (id, purpose, working_dir, worktree, status, last_heartbeat, created_at, archived_at, team_name)
       VALUES (@id, @purpose, @working_dir, @worktree, @status, @last_heartbeat, @created_at, @archived_at, @team_name)`,
    ).run({
      id: session.id,
      purpose: session.purpose ?? null,
      working_dir: session.working_dir ?? null,
      worktree: session.worktree ?? null,
      status: session.status ?? null,
      last_heartbeat: session.last_heartbeat ?? null,
      created_at: session.created_at ?? null,
      archived_at: session.archived_at ?? null,
      team_name: teamInfo?.name ?? null,
    })

    // Clean up active data
    db.prepare('DELETE FROM file_intents WHERE session_id = ?').run(sessionId)
    db.prepare('DELETE FROM shared_state WHERE session_id = ?').run(sessionId)
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId)

    return {
      session_id: sessionId,
      messages_archived: messagesArchived,
      messages_retained: 0,
      deferred: false,
    }
  })

  return doPurge()
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

  const rows = db
    .prepare(`SELECT * FROM teams_history${where} ORDER BY purged_at DESC LIMIT ?`)
    .all(...params, limit) as TeamHistoryRecord[]

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

  const rows = db
    .prepare(`SELECT * FROM sessions_history${where} ORDER BY purged_at DESC LIMIT ?`)
    .all(...params, limit) as SessionHistoryRecord[]

  return rows.map((row) => ({ ...row }))
}

export function queryTaskHistory(
  db: Database.Database,
  teamId?: string,
  limit?: number,
): ReadonlyArray<TaskHistoryRecord> {
  const maxRows = limit ?? 50

  if (teamId) {
    const rows = db
      .prepare('SELECT * FROM tasks_history WHERE team_id = ? ORDER BY purged_at DESC LIMIT ?')
      .all(teamId, maxRows) as TaskHistoryRecord[]
    return rows.map((row) => ({ ...row }))
  }

  const rows = db
    .prepare('SELECT * FROM tasks_history ORDER BY purged_at DESC LIMIT ?')
    .all(maxRows) as TaskHistoryRecord[]
  return rows.map((row) => ({ ...row }))
}

export function queryMessageHistory(
  db: Database.Database,
  sessionId?: string,
  limit?: number,
): ReadonlyArray<MessageHistoryRecord> {
  const maxRows = limit ?? 50

  if (sessionId) {
    const rows = db
      .prepare(
        'SELECT * FROM messages_history WHERE sender_id = ? OR receiver_id = ? ORDER BY purged_at DESC LIMIT ?',
      )
      .all(sessionId, sessionId, maxRows) as MessageHistoryRecord[]
    return rows.map((row) => ({ ...row }))
  }

  const rows = db
    .prepare('SELECT * FROM messages_history ORDER BY purged_at DESC LIMIT ?')
    .all(maxRows) as MessageHistoryRecord[]
  return rows.map((row) => ({ ...row }))
}

/**
 * Delete history records older than `retentionDays`.
 *
 * The retention period is resolved in this order:
 * 1. The `retentionDays` argument (if provided).
 * 2. The `HISTORY_RETENTION_DAYS` environment variable (integer, days).
 * 3. The module default of {@link DEFAULT_RETENTION_DAYS} (7 days).
 *
 * Affects tables: teams_history, sessions_history, tasks_history, messages_history.
 */
export function deleteExpiredHistory(
  db: Database.Database,
  retentionDays?: number,
): ExpiredHistoryResult {
  const days =
    retentionDays ??
    parseInt(process.env.HISTORY_RETENTION_DAYS ?? String(DEFAULT_RETENTION_DAYS), 10)

  const teamsResult = db
    .prepare(`DELETE FROM teams_history WHERE purged_at <= datetime('now', '-' || ? || ' days')`)
    .run(days)

  const sessionsResult = db
    .prepare(`DELETE FROM sessions_history WHERE purged_at <= datetime('now', '-' || ? || ' days')`)
    .run(days)

  const tasksResult = db
    .prepare(`DELETE FROM tasks_history WHERE purged_at <= datetime('now', '-' || ? || ' days')`)
    .run(days)

  const messagesResult = db
    .prepare(`DELETE FROM messages_history WHERE purged_at <= datetime('now', '-' || ? || ' days')`)
    .run(days)

  return {
    teams_deleted: teamsResult.changes,
    sessions_deleted: sessionsResult.changes,
    tasks_deleted: tasksResult.changes,
    messages_deleted: messagesResult.changes,
  }
}

export function countHistoryRecords(db: Database.Database): {
  teams: number
  sessions: number
  tasks: number
  messages: number
} {
  const teams = (
    db.prepare('SELECT COUNT(*) as count FROM teams_history').get() as { count: number }
  ).count
  const sessions = (
    db.prepare('SELECT COUNT(*) as count FROM sessions_history').get() as { count: number }
  ).count
  const tasks = (
    db.prepare('SELECT COUNT(*) as count FROM tasks_history').get() as { count: number }
  ).count
  const messages = (
    db.prepare('SELECT COUNT(*) as count FROM messages_history').get() as { count: number }
  ).count

  return { teams, sessions, tasks, messages }
}
