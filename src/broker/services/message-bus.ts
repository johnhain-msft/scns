/**
 * Message Bus — higher-level routing layer over the message repository.
 * Provides direct messaging, broadcast, threading, and unread tracking.
 */

import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { Message } from '../types.js'
import {
  createMessage,
  findMessagesByReceiver,
  findMessageThread,
  markMessageRead,
} from '../storage/repositories/message-repository.js'

interface SendOptions {
  readonly story_id?: string
  readonly reply_to?: string
}

interface GetMessagesOptions {
  readonly unreadOnly?: boolean
  readonly story_id?: string
  readonly since?: string
}

export function sendDirect(
  db: Database.Database,
  senderId: string,
  receiverId: string,
  content: string,
  options?: SendOptions,
): Message {
  return createMessage(db, {
    id: randomUUID(),
    sender_id: senderId,
    receiver_id: receiverId,
    content,
    story_id: options?.story_id ?? null,
    reply_to: options?.reply_to ?? null,
  })
}

export function broadcast(
  db: Database.Database,
  senderId: string,
  content: string,
  options?: SendOptions,
): Message {
  return createMessage(db, {
    id: randomUUID(),
    sender_id: senderId,
    receiver_id: null,
    content,
    story_id: options?.story_id ?? null,
    reply_to: options?.reply_to ?? null,
  })
}

export function getMessages(
  db: Database.Database,
  receiverId: string,
  options?: GetMessagesOptions,
): ReadonlyArray<Message> {
  const messages = findMessagesByReceiver(db, receiverId, {
    unreadOnly: options?.unreadOnly,
    since: options?.since,
  })

  if (options?.story_id) {
    return messages.filter((m) => m.story_id === options.story_id)
  }

  return messages
}

export function markRead(db: Database.Database, messageIds: ReadonlyArray<string>): void {
  for (const id of messageIds) {
    markMessageRead(db, id)
  }
}

export function getThread(db: Database.Database, messageId: string): ReadonlyArray<Message> {
  return findMessageThread(db, messageId)
}

export function getUnreadCount(db: Database.Database, receiverId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as count FROM messages
     WHERE (receiver_id = ? OR receiver_id IS NULL)
     AND read_at IS NULL`,
    )
    .get(receiverId) as { count: number }
  return row.count
}
