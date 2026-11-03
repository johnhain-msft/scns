import type Database from 'better-sqlite3'
import type { Message } from '../../types.js'
import { toSqliteDateTime } from '../sqlite-time.js'

interface CreateMessageInput {
  readonly id: string
  readonly sender_id: string
  readonly receiver_id: string | null
  readonly content: string
  readonly story_id: string | null
  readonly reply_to?: string | null
  readonly team_id?: string | null
  readonly to_role?: string | null
  readonly to_team?: string | null
  /**
   * Issue #70: stable client-supplied id enabling safe send retries. A replay
   * with the same (sender_id, client_message_id) and identical payload returns
   * the original row; conflicting reuse throws {@link ClientMessageIdConflictError}.
   */
  readonly client_message_id?: string | null
}

interface FindMessagesOptions {
  readonly unreadOnly?: boolean
  readonly since?: string
}

/** Conflicting reuse of a (sender_id, client_message_id) pair. */
export class ClientMessageIdConflictError extends Error {
  readonly code = 'CLIENT_MESSAGE_ID_CONFLICT'
  constructor(clientMessageId: string) {
    super(
      `client_message_id '${clientMessageId}' was already used by this sender with a different payload`,
    )
    this.name = 'ClientMessageIdConflictError'
  }
}

export interface CreateMessageResult {
  readonly message: Message
  /** True when an idempotent replay returned the previously stored row. */
  readonly replayed: boolean
}

/**
 * A replay must carry the SAME logical payload — content, receiver, and the
 * threading/story linkage. A retry that silently dropped or changed reply_to
 * or story_id would make the caller believe linkage was recorded when the
 * stored row carries something else.
 */
function isSameReplayPayload(existing: Message, input: CreateMessageInput): boolean {
  return (
    existing.content === input.content &&
    (existing.receiver_id ?? null) === (input.receiver_id ?? null) &&
    (existing.story_id ?? null) === (input.story_id ?? null) &&
    (existing.reply_to ?? null) === (input.reply_to ?? null)
  )
}

export function createMessageWithReplay(
  db: Database.Database,
  input: CreateMessageInput,
): CreateMessageResult {
  const teamId = input.team_id ?? null
  const clientMessageId = input.client_message_id ?? null

  const insert = db.transaction((): CreateMessageResult | null => {
    if (clientMessageId !== null) {
      const existing = db
        .prepare('SELECT * FROM messages WHERE sender_id = ? AND client_message_id = ?')
        .get(input.sender_id, clientMessageId) as Message | undefined
      if (existing) {
        if (!isSameReplayPayload(existing, input)) {
          throw new ClientMessageIdConflictError(clientMessageId)
        }
        return { message: { ...existing }, replayed: true }
      }
    }

    let seq: number | null = null
    if (teamId !== null) {
      const row = db
        .prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE team_id = ?`)
        .get(teamId) as { next: number }
      seq = row.next
    }

    db.prepare(
      `INSERT INTO messages (id, sender_id, receiver_id, content, story_id, reply_to, team_id, seq, to_role, to_team, client_message_id)
       VALUES (@id, @sender_id, @receiver_id, @content, @story_id, @reply_to, @team_id, @seq, @to_role, @to_team, @client_message_id)`,
    ).run({
      id: input.id,
      sender_id: input.sender_id,
      receiver_id: input.receiver_id,
      content: input.content,
      story_id: input.story_id,
      reply_to: input.reply_to ?? null,
      team_id: teamId,
      seq,
      to_role: input.to_role ?? null,
      to_team: input.to_team ?? null,
      client_message_id: clientMessageId,
    })
    return null
  })

  let replay: CreateMessageResult | null
  try {
    replay = insert.immediate()
  } catch (err) {
    // Cross-process race on idx_messages_client_id: a sibling broker won the
    // insert between our SELECT and INSERT. Resolve like a replay attempt.
    const code = (err as { code?: string })?.code
    if (clientMessageId !== null && code === 'SQLITE_CONSTRAINT_UNIQUE') {
      const existing = db
        .prepare('SELECT * FROM messages WHERE sender_id = ? AND client_message_id = ?')
        .get(input.sender_id, clientMessageId) as Message | undefined
      if (existing) {
        if (!isSameReplayPayload(existing, input)) {
          throw new ClientMessageIdConflictError(clientMessageId)
        }
        return { message: { ...existing }, replayed: true }
      }
    }
    throw err
  }
  if (replay) return replay

  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(input.id) as Message
  return { message: { ...row }, replayed: false }
}

export function createMessage(db: Database.Database, input: CreateMessageInput): Message {
  return createMessageWithReplay(db, input).message
}

export function findMessageById(db: Database.Database, messageId: string): Message | null {
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as
    | Message
    | undefined
  return row ? { ...row } : null
}

export function findMessageThread(
  db: Database.Database,
  messageId: string,
): ReadonlyArray<Message> {
  const rows = db
    .prepare(`SELECT * FROM messages WHERE id = ? OR reply_to = ? ORDER BY created_at`)
    .all(messageId, messageId) as Message[]

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
    params.push(toSqliteDateTime(options.since))
  }

  const where = conditions.join(' AND ')
  const rows = db
    .prepare(`SELECT * FROM messages WHERE ${where} ORDER BY created_at`)
    .all(...params) as Message[]

  return rows.map((row) => ({ ...row }))
}

export function markMessageRead(db: Database.Database, messageId: string): Message | null {
  db.prepare(`UPDATE messages SET read_at = datetime('now') WHERE id = ? AND read_at IS NULL`).run(
    messageId,
  )

  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as
    | Message
    | undefined
  return row ? { ...row } : null
}

/**
 * Issue #70: record that directed messages reached their recipient's context
 * (injection or explicit fetch). Delivery is weaker than read_at (explicit
 * read) and much weaker than a disposition. Broadcasts are never marked —
 * a single timestamp column cannot carry per-recipient delivery.
 */
export function markMessagesDelivered(
  db: Database.Database,
  messageIds: ReadonlyArray<string>,
  receiverId: string,
): number {
  if (messageIds.length === 0) return 0
  const stmt = db.prepare(
    `UPDATE messages SET delivered_at = datetime('now')
     WHERE id = ? AND receiver_id = ? AND delivered_at IS NULL`,
  )
  let updated = 0
  const run = db.transaction((ids: ReadonlyArray<string>) => {
    for (const id of ids) {
      updated += stmt.run(id, receiverId).changes
    }
  })
  run(messageIds)
  return updated
}

export type MessageDisposition = 'accepted' | 'rejected' | 'deferred'

/**
 * Issue #70: explicit recipient verdict on a directed message. Distinct from
 * a successful send (acceptance by the broker) and from read_at (the
 * recipient saw it). Also stamps delivered_at/read_at if still unset — an
 * explicit disposition subsumes both.
 */
export function setMessageDisposition(
  db: Database.Database,
  messageId: string,
  disposition: MessageDisposition,
  note?: string,
): Message | null {
  db.prepare(
    `UPDATE messages SET
       disposition = ?,
       disposition_at = datetime('now'),
       disposition_note = ?,
       delivered_at = COALESCE(delivered_at, datetime('now')),
       read_at = COALESCE(read_at, datetime('now'))
     WHERE id = ?`,
  ).run(disposition, note ?? null, messageId)

  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as
    | Message
    | undefined
  return row ? { ...row } : null
}

/**
 * Issue #70 retention invariant: messages that must REMAIN in the live queue
 * when `sessionId` is settled/terminated — directed mail this session sent
 * that its recipient has neither read nor disposed. Deleting these (or the
 * sender row they reference) would empty another participant's inbox, and a
 * receiver-row delete would leak them as broadcast via ON DELETE SET NULL.
 * A non-NULL receiver_id always references an existing sessions row.
 */
export function countRetainedMessagesForSession(db: Database.Database, sessionId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM messages
       WHERE sender_id = ?
         AND receiver_id IS NOT NULL
         AND receiver_id != ?
         AND read_at IS NULL
         AND disposition IS NULL`,
    )
    .get(sessionId, sessionId) as { cnt: number }
  return row.cnt
}

/**
 * The complement of {@link countRetainedMessagesForSession}: message ids that
 * are settleable when `sessionId` terminates — its own inbox, correspondence
 * already read or disposed, and broadcasts it sent. Broadcasts settle
 * regardless of read state (deliberate — see session-retirement.ts header):
 * per-recipient broadcast delivery is not modeled, so only directed mail
 * carries the stay-live-until-read/disposed guarantee.
 */
export function findSettleableMessageIds(
  db: Database.Database,
  sessionId: string,
): ReadonlyArray<string> {
  const rows = db
    .prepare(
      `SELECT id FROM messages
       WHERE receiver_id = ?
          OR (sender_id = ? AND (read_at IS NOT NULL OR disposition IS NOT NULL OR receiver_id IS NULL))`,
    )
    .all(sessionId, sessionId) as Array<{ id: string }>
  return rows.map((r) => r.id)
}

export function deleteMessagesByStory(db: Database.Database, storyId: string): number {
  const result = db.prepare('DELETE FROM messages WHERE story_id = ?').run(storyId)
  return result.changes
}

export function deleteMessagesBySession(db: Database.Database, sessionId: string): number {
  const result = db
    .prepare('DELETE FROM messages WHERE sender_id = ? OR receiver_id = ?')
    .run(sessionId, sessionId)
  return result.changes
}

export function deleteAllMessages(db: Database.Database): number {
  const result = db.prepare('DELETE FROM messages').run()
  return result.changes
}

export function findAllMessages(
  db: Database.Database,
  options?: { limit?: number; since?: string },
): ReadonlyArray<Message> {
  const limit = options?.limit ?? 100
  if (options?.since) {
    const rows = db
      .prepare(`SELECT * FROM messages WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?`)
      .all(toSqliteDateTime(options.since), limit) as Message[]
    return rows.map((row) => ({ ...row }))
  }
  const rows = db
    .prepare(`SELECT * FROM messages ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as Message[]

  return rows.map((row) => ({ ...row }))
}

interface TeamMessageQueryOptions {
  readonly limit?: number
  readonly offset?: number
}

export function countMessagesByTeamMembers(db: Database.Database, teamId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as count FROM messages m
     WHERE m.sender_id IN (
       SELECT tm.session_id FROM team_members tm WHERE tm.team_id = ?
     )`,
    )
    .get(teamId) as { count: number }
  return row.count
}

export function findMessagesByTeamMembers(
  db: Database.Database,
  teamId: string,
  options?: TeamMessageQueryOptions,
): ReadonlyArray<Message> {
  const limit = options?.limit ?? 10000
  const offset = options?.offset ?? 0
  const rows = db
    .prepare(
      `SELECT m.* FROM messages m
     WHERE m.sender_id IN (
       SELECT tm.session_id FROM team_members tm WHERE tm.team_id = ?
     )
     ORDER BY m.created_at ASC
     LIMIT ? OFFSET ?`,
    )
    .all(teamId, limit, offset) as Message[]

  return rows.map((row) => ({ ...row }))
}

/**
 * Find team-scoped messages with seq > cursor, ordered by seq ASC.
 * Used by GET /api/teams/:id/messages/since/:cursor for resumable polling.
 */
export function findTeamMessagesSince(
  db: Database.Database,
  teamId: string,
  cursor: number,
  options?: { limit?: number },
): ReadonlyArray<Message> {
  const limit = options?.limit ?? 1000
  const rows = db
    .prepare(
      `SELECT * FROM messages
       WHERE team_id = ? AND seq > ?
       ORDER BY seq ASC
       LIMIT ?`,
    )
    .all(teamId, cursor, limit) as Message[]
  return rows.map((row) => ({ ...row }))
}

export function getMaxTeamSeq(db: Database.Database, teamId: string): number {
  const row = db
    .prepare(`SELECT COALESCE(MAX(seq), 0) AS max_seq FROM messages WHERE team_id = ?`)
    .get(teamId) as { max_seq: number }
  return row.max_seq
}

/**
 * WS J — readback-race fix.
 *
 * Returns the body of the latest broadcast authored by `managerSessionId`
 * within `teamId`, looking first in the live `messages` table and falling
 * back to `messages_history`. The fallback is required because the
 * manager-exit-monitor races `purgeSessionToHistory`: the session GC may
 * delete the manager's broadcast row from `messages` before the monitor's
 * post-exit lookup runs, producing a false-positive
 * `manager_dispatch_incomplete=no_readback` event.
 *
 * `messages_history` does not carry `team_id`, so the fallback can only be
 * filtered by `sender_id`. Manager session ids are unique to a single team
 * for their lifetime, so this remains correctly scoped in practice.
 */
export function findLatestManagerBroadcast(
  db: Database.Database,
  teamId: string,
  managerSessionId: string,
): string | null {
  try {
    const liveRow = db
      .prepare(
        `SELECT content FROM messages
         WHERE team_id = ? AND sender_id = ?
         ORDER BY seq DESC, created_at DESC
         LIMIT 1`,
      )
      .get(teamId, managerSessionId) as { content?: string } | undefined
    if (liveRow?.content) return liveRow.content

    const historyRow = db
      .prepare(
        `SELECT content FROM messages_history
         WHERE sender_id = ?
         ORDER BY purged_at DESC, created_at DESC
         LIMIT 1`,
      )
      .get(managerSessionId) as { content?: string } | undefined
    return historyRow?.content ?? null
  } catch {
    return null
  }
}

export function archiveMessages(db: Database.Database, messageIds: ReadonlyArray<string>): number {
  if (messageIds.length === 0) return 0

  // Issue #70: the acknowledgement record (delivery, read, explicit
  // disposition + note) travels with the message into history.
  const insertStmt = db.prepare(
    `INSERT INTO messages_history (id, sender_id, receiver_id, content, story_id, reply_to, client_message_id, created_at, delivered_at, read_at, disposition, disposition_at, disposition_note)
     SELECT id, sender_id, receiver_id, content, story_id, reply_to, client_message_id, created_at, delivered_at, read_at, disposition, disposition_at, disposition_note
     FROM messages WHERE id = ?`,
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
