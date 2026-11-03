import type Database from 'better-sqlite3'
import type { Message } from '../../types.js'

interface CreateMessageInput {
  readonly id: string
  readonly sender_id: string
  readonly receiver_id: string | null
  readonly content: string
  readonly story_id: string | null
  readonly reply_to?: string | null
}

interface FindMessagesOptions {
  readonly unreadOnly?: boolean
  readonly since?: string
}

export function createMessage(db: Database.Database, input: CreateMessageInput): Message {
  db.prepare(
    `INSERT INTO messages (id, sender_id, receiver_id, content, story_id, reply_to)
     VALUES (@id, @sender_id, @receiver_id, @content, @story_id, @reply_to)`
  ).run({ ...input, reply_to: input.reply_to ?? null })

  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(input.id) as Message
  return { ...row }
}

export function findMessageById(db: Database.Database, messageId: string): Message | null {
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as Message | undefined
  return row ? { ...row } : null
}

export function findMessageThread(
  db: Database.Database,
  messageId: string,
): ReadonlyArray<Message> {
  const rows = db.prepare(
    `SELECT * FROM messages WHERE id = ? OR reply_to = ? ORDER BY created_at`
  ).all(messageId, messageId) as Message[]

  return rows.map((row) => ({ ...row }))
}

export function findMessagesByReceiver(
  db: Database.Database,
  receiverId: string,
  options?: FindMessagesOptions,
): ReadonlyArray<Message> {
  const conditions: string[] = ['(receiver_id = ? OR receiver_id IS NULL)']
  const params: unknown[] = [receiverId]

  if (options?.unreadOnly) {
    conditions.push('read_at IS NULL')
  }

  if (options?.since) {
    conditions.push('created_at > ?')
    params.push(options.since)
  }

  const where = conditions.join(' AND ')
  const rows = db.prepare(
    `SELECT * FROM messages WHERE ${where} ORDER BY created_at`
  ).all(...params) as Message[]

  return rows.map((row) => ({ ...row }))
}

export function markMessageRead(db: Database.Database, messageId: string): Message | null {
  db.prepare(
    `UPDATE messages SET read_at = datetime('now') WHERE id = ? AND read_at IS NULL`
  ).run(messageId)

  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as Message | undefined
  return row ? { ...row } : null
}

export function deleteMessagesByStory(db: Database.Database, storyId: string): number {
  const result = db.prepare('DELETE FROM messages WHERE story_id = ?').run(storyId)
  return result.changes
}

export function deleteMessagesBySession(db: Database.Database, sessionId: string): number {
  const result = db.prepare('DELETE FROM messages WHERE sender_id = ? OR receiver_id = ?').run(sessionId, sessionId)
  return result.changes
}

export function deleteAllMessages(db: Database.Database): number {
  const result = db.prepare('DELETE FROM messages').run()
  return result.changes
}

export function findAllMessages(
  db: Database.Database,
  options?: { limit?: number },
): ReadonlyArray<Message> {
  const limit = options?.limit ?? 100
  const rows = db.prepare(
    `SELECT * FROM messages ORDER BY created_at DESC LIMIT ?`
  ).all(limit) as Message[]

  return rows.map((row) => ({ ...row }))
}

interface TeamMessageQueryOptions {
  readonly limit?: number
  readonly offset?: number
}

export function countMessagesByTeamMembers(
  db: Database.Database,
  teamId: string,
): number {
  const row = db.prepare(
    `SELECT COUNT(*) as count FROM messages m
     WHERE m.sender_id IN (
       SELECT tm.session_id FROM team_members tm WHERE tm.team_id = ?
     )`
  ).get(teamId) as { count: number }
  return row.count
}

export function findMessagesByTeamMembers(
  db: Database.Database,
  teamId: string,
  options?: TeamMessageQueryOptions,
): ReadonlyArray<Message> {
  const limit = options?.limit ?? 10000
  const offset = options?.offset ?? 0
  const rows = db.prepare(
    `SELECT m.* FROM messages m
     WHERE m.sender_id IN (
       SELECT tm.session_id FROM team_members tm WHERE tm.team_id = ?
     )
     ORDER BY m.created_at ASC
     LIMIT ? OFFSET ?`
  ).all(teamId, limit, offset) as Message[]

  return rows.map((row) => ({ ...row }))
}

export function archiveMessages(
  db: Database.Database,
  messageIds: ReadonlyArray<string>,
): number {
  if (messageIds.length === 0) return 0

  const insertStmt = db.prepare(
    `INSERT INTO messages_history (id, sender_id, receiver_id, content, story_id, reply_to, created_at, read_at)
     SELECT id, sender_id, receiver_id, content, story_id, reply_to, created_at, read_at
     FROM messages WHERE id = ?`
  )

  const deleteStmt = db.prepare('DELETE FROM messages WHERE id = ?')

  let archived = 0
  const archiveTransaction = db.transaction((ids: ReadonlyArray<string>) => {
    for (const id of ids) {
      const insertResult = insertStmt.run(id)
      if (insertResult.changes > 0) {
        deleteStmt.run(id)
        archived += 1
      }
    }
  })

  archiveTransaction(messageIds)
  return archived
}
