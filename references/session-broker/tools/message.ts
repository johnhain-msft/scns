import crypto from 'node:crypto'
import type Database from 'better-sqlite3'
import type { EventLog } from '../services/event-log.js'
import {
  createMessage,
  findMessageById,
  findMessagesByReceiver,
  markMessageRead,
} from '../storage/repositories/message-repository.js'
import { findSessionById } from '../storage/repositories/session-repository.js'
import { indexMessage } from '../message-indexing.js'
import { type ToolResult, textResult, errorResult } from './helpers.js'

interface SendMessageInput {
  readonly sender_id: string
  readonly receiver_id: string | null
  readonly content: string
  readonly story_id: string | null
  readonly reply_to?: string | null
}

export function handleSendMessage(
  db: Database.Database,
  eventLog: EventLog,
  input: SendMessageInput,
): ToolResult {
  try {
    // Validate sender exists before hitting FK constraint
    const sender = findSessionById(db, input.sender_id)
    if (!sender) {
      return errorResult(
        `sender_id '${input.sender_id}' not found in sessions. Register the session first.`
      )
    }

    if (input.receiver_id !== null) {
      const receiver = findSessionById(db, input.receiver_id)
      if (!receiver) {
        return errorResult(
          `receiver_id '${input.receiver_id}' not found in sessions. Use null for broadcast.`
        )
      }
    }

    // Validate reply_to message exists if provided
    if (input.reply_to) {
      const parent = findMessageById(db, input.reply_to)
      if (!parent) {
        return errorResult(
          `reply_to message '${input.reply_to}' not found.`
        )
      }
    }

    const id = crypto.randomUUID()
    const message = createMessage(db, { id, ...input })
    eventLog.messageSent(input.sender_id, {
      message_id: id,
      receiver_id: input.receiver_id,
      content: input.content,
    })

    // Fire-and-forget embedding indexing
    indexMessage(db, id).catch(() => {/* ignore embedding failures */})

    return textResult(message)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return errorResult(`Failed to send message: ${msg}`)
  }
}

interface GetMessagesInput {
  readonly session_id: string
  readonly unread_only?: boolean
  readonly since?: string
  readonly mark_read?: boolean
}

export function handleGetMessages(
  db: Database.Database,
  eventLog: EventLog,
  input: GetMessagesInput,
): ToolResult {
  const messages = findMessagesByReceiver(db, input.session_id, {
    unreadOnly: input.unread_only,
    since: input.since,
  })

  if (input.mark_read) {
    const marked = messages.map((m) => {
      if (m.read_at === null) {
        const updated = markMessageRead(db, m.id)
        if (updated) {
          eventLog.messageRead(input.session_id, { message_id: m.id })
          return updated
        }
      }
      return m
    })
    return textResult(marked)
  }

  return textResult(messages)
}
