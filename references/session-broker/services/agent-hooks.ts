/**
 * Agent Hooks Service — Server-side helpers for the session-context extension.
 *
 * Provides targeted message fetching (direct messages only, no broadcasts),
 * message formatting for context injection, batch read-marking, and task
 * completion indexing.
 */

import type Database from 'better-sqlite3'
import type { EventLog } from './event-log.js'
import type { SharedStateEntry } from '../types.js'
import { setState } from '../storage/repositories/state-repository.js'
import { logger } from '../logger.js'

// ── Types ─────────────────────────────────────────────────────────────────

export interface UnreadMessagesResult {
  readonly messages: ReadonlyArray<{
    readonly id: string
    readonly sender_id: string
    readonly content: string
    readonly created_at: string
  }>
  readonly count: number
}

export interface TaskCompletionInput {
  readonly task_id: number
  readonly team_id: string
  readonly subject: string
  readonly result: string
}

export interface SessionContextState {
  readonly sessionId: string | null
  readonly brokerUrl: string
}

interface SessionContextHooks {
  getState(): SessionContextState
  fetchUnreadMessages(receiverId: string): Promise<UnreadMessagesResult>
  formatAsContext(messages: ReadonlyArray<{ readonly id: string; readonly sender_id: string; readonly content: string; readonly created_at: string }>): string
  markAsRead(messageIds: ReadonlyArray<string>): Promise<number>
  indexCompletion(input: TaskCompletionInput): Promise<boolean>
}

// ── Core Service Functions ────────────────────────────────────────────────

/**
 * Get unread direct messages for a specific receiver.
 * CRITICAL: Uses exact match `receiver_id = ?` — NOT broadcasts (receiver_id IS NULL).
 */
export function getUnreadDirectMessages(
  db: Database.Database,
  receiverId: string,
): UnreadMessagesResult {
  const rows = db.prepare(
    `SELECT id, sender_id, content, created_at
     FROM messages
     WHERE receiver_id = ? AND read_at IS NULL
     ORDER BY created_at ASC`
  ).all(receiverId) as ReadonlyArray<{
    id: string
    sender_id: string
    content: string
    created_at: string
  }>

  return {
    messages: rows.map((row) => ({ ...row })),
    count: rows.length,
  }
}

/**
 * Format messages into a human-readable context string for injection.
 * Returns empty string if no messages.
 */
export function formatMessagesAsContext(
  messages: ReadonlyArray<{
    readonly id: string
    readonly sender_id: string
    readonly content: string
    readonly created_at: string
  }>,
): string {
  if (messages.length === 0) return ''

  const header = `## 📨 Unread Messages (${messages.length})\n`
  const lines = messages.map(
    (msg) => `- **${msg.sender_id}** (${msg.created_at}): ${msg.content}`,
  )

  return `${header}\n${lines.join('\n')}`
}

/**
 * Mark multiple messages as read in a single transaction.
 * Returns the count of messages that were actually marked (skips already-read).
 */
export function markMessagesAsRead(
  db: Database.Database,
  messageIds: ReadonlyArray<string>,
): number {
  if (messageIds.length === 0) return 0

  const stmt = db.prepare(
    `UPDATE messages SET read_at = datetime('now') WHERE id = ? AND read_at IS NULL`
  )

  let marked = 0
  const markTransaction = db.transaction((ids: ReadonlyArray<string>) => {
    for (const id of ids) {
      const result = stmt.run(id)
      marked += result.changes
    }
  })

  markTransaction(messageIds)
  return marked
}

/**
 * Index a completed task result into shared_state and fire an event.
 */
export function indexTaskCompletion(
  db: Database.Database,
  eventLog: EventLog,
  input: TaskCompletionInput,
): SharedStateEntry {
  const key = `task-completion:${input.team_id}:${input.task_id}`
  const value = JSON.stringify({
    task_id: input.task_id,
    team_id: input.team_id,
    subject: input.subject,
    result: input.result,
    indexed_at: new Date().toISOString(),
  })

  const entry = setState(db, {
    key,
    value,
    story_id: null,
    session_id: null,
  })

  eventLog.taskResultIndexed(null, {
    task_id: input.task_id,
    team_id: input.team_id,
    subject: input.subject,
  })

  logger.info({ key, task_id: input.task_id }, 'Task completion indexed')

  return entry
}

// ── Extension Helper (Client-Side Hooks Factory) ──────────────────────────

const FETCH_TIMEOUT_MS = 3000

async function safeFetch(
  url: string,
  options?: RequestInit,
): Promise<Record<string, unknown> | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { ...options, signal: controller.signal })
    if (!res.ok) return null
    return (await res.json()) as Record<string, unknown>
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Creates hook functions for the session-context extension.
 * These call the broker REST API to fetch/modify data.
 */
export function createSessionContextHooks(brokerUrl: string): SessionContextHooks {
  const state: { sessionId: string | null } = { sessionId: null }

  return {
    getState(): SessionContextState {
      return { sessionId: state.sessionId, brokerUrl }
    },

    async fetchUnreadMessages(receiverId: string): Promise<UnreadMessagesResult> {
      const data = await safeFetch(
        `${brokerUrl}/api/messages/unread/${encodeURIComponent(receiverId)}`,
      )
      if (!data?.success) return { messages: [], count: 0 }

      const inner = data.data
      if (
        typeof inner !== 'object' || inner === null ||
        !Array.isArray((inner as Record<string, unknown>).messages) ||
        typeof (inner as Record<string, unknown>).count !== 'number'
      ) {
        return { messages: [], count: 0 }
      }
      const validated = inner as { messages: UnreadMessagesResult['messages']; count: number }
      return { messages: validated.messages, count: validated.count }
    },

    formatAsContext(
      messages: ReadonlyArray<{ readonly id: string; readonly sender_id: string; readonly content: string; readonly created_at: string }>,
    ): string {
      return formatMessagesAsContext(messages)
    },

    async markAsRead(messageIds: ReadonlyArray<string>): Promise<number> {
      const data = await safeFetch(`${brokerUrl}/api/messages/mark-read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message_ids: messageIds }),
      })
      if (!data?.success) return 0

      const inner = data.data as { marked_count: number }
      return inner.marked_count
    },

    async indexCompletion(input: TaskCompletionInput): Promise<boolean> {
      const data = await safeFetch(`${brokerUrl}/api/index/task-completion`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      })
      return data?.success === true
    },
  }
}
