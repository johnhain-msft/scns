/**
 * Session branching service.
 *
 * Creates new sessions that inherit the conversation history of an existing
 * session up to a specific message. Useful for orchestration retry, parallel
 * exploration, and rollback scenarios.
 */

import type Database from 'better-sqlite3'
import type { EventLog } from './event-log.js'
import type { Session, Message } from '../types.js'

const MAX_LINEAGE_DEPTH = 50
import {
  findSessionById,
  createSession,
  findSessionChildren as repoFindSessionChildren,
} from '../storage/repositories/session-repository.js'
import { findMessageById } from '../storage/repositories/message-repository.js'
import { NotFoundError, ValidationError } from '../errors.js'

// ── Interfaces ────────────────────────────────────────────────────────────

export interface BranchSessionInput {
  readonly newSessionId: string
  readonly parentSessionId: string
  readonly branchPointMessageId?: string
  readonly purpose: string
  readonly workingDir?: string
}

export interface BranchResult {
  readonly session_id: string
  readonly parent_session_id: string
  readonly branch_point_message_id: string | null
  readonly inherited_messages: number
}

// ── Core functions ────────────────────────────────────────────────────────

/**
 * Create a new session that inherits from a parent session.
 *
 * 1. Validates parent session exists
 * 2. If branchPointMessageId provided, validates it exists and belongs to parent
 * 3. Creates new session with parent_session_id and branch_point_message_id
 * 4. Fires sessionBranched event
 * 5. Returns result with metadata
 */
export function branchSession(
  db: Database.Database,
  eventLog: EventLog,
  input: BranchSessionInput,
): BranchResult {
  const parent = findSessionById(db, input.parentSessionId)
  if (!parent) {
    throw new NotFoundError('Session', input.parentSessionId)
  }

  if (input.branchPointMessageId) {
    validateBranchPointMessage(db, input.parentSessionId, input.branchPointMessageId)
  }

  const workingDir = input.workingDir ?? parent.working_dir

  createSession(db, {
    id: input.newSessionId,
    purpose: input.purpose,
    working_dir: workingDir,
    worktree: parent.worktree ?? null,
    repo_context: parent.repo_context ?? null,
    parent_session_id: input.parentSessionId,
    branch_point_message_id: input.branchPointMessageId ?? null,
  })

  const inheritedMessages = countInheritedMessages(
    db,
    input.parentSessionId,
    input.branchPointMessageId ?? null,
  )

  eventLog.sessionBranched(input.newSessionId, {
    parent_session_id: input.parentSessionId,
    branch_point_message_id: input.branchPointMessageId ?? null,
    inherited_messages: inheritedMessages,
    purpose: input.purpose,
  })

  return {
    session_id: input.newSessionId,
    parent_session_id: input.parentSessionId,
    branch_point_message_id: input.branchPointMessageId ?? null,
    inherited_messages: inheritedMessages,
  }
}

/**
 * Walk up the parent chain to get full session lineage.
 * Returns array from child to root: [sessionId, parentId, grandparentId, ...]
 */
export function getSessionLineage(
  db: Database.Database,
  sessionId: string,
): ReadonlyArray<string> {
  const lineage: string[] = []
  let currentId: string | null = sessionId
  const visited = new Set<string>()

  while (currentId !== null) {
    if (visited.has(currentId)) {
      break // Prevent infinite loops from circular references
    }
    if (visited.size >= MAX_LINEAGE_DEPTH) {
      break // Prevent unbounded traversal on deeply nested branches
    }
    visited.add(currentId)

    const session = findSessionById(db, currentId)
    if (!session) {
      if (lineage.length === 0) {
        throw new NotFoundError('Session', currentId)
      }
      break
    }

    lineage.push(currentId)
    currentId = session.parent_session_id ?? null
  }

  return lineage
}

/**
 * Find all sessions that were branched directly from this one.
 */
export function getSessionChildren(
  db: Database.Database,
  sessionId: string,
): ReadonlyArray<Session> {
  return repoFindSessionChildren(db, sessionId)
}

/**
 * Get inherited messages for a branched session.
 *
 * If the session has a parent_session_id:
 *   1. Recursively get grandparent messages if parent is also branched
 *   2. Get parent's messages up to branch_point_message_id
 *   3. Return combined, ordered by created_at
 *
 * Returns empty array for unbranched sessions.
 */
export function getInheritedMessages(
  db: Database.Database,
  sessionId: string,
): ReadonlyArray<Message> {
  const session = findSessionById(db, sessionId)
  if (!session || !session.parent_session_id) {
    return []
  }

  return collectInheritedMessages(db, session.parent_session_id, session.branch_point_message_id ?? null)
}

// ── Private helpers ───────────────────────────────────────────────────────

function validateBranchPointMessage(
  db: Database.Database,
  parentSessionId: string,
  messageId: string,
): void {
  const message = findMessageById(db, messageId)
  if (!message) {
    throw new NotFoundError('Message', messageId)
  }

  if (message.sender_id !== parentSessionId && message.receiver_id !== parentSessionId) {
    throw new ValidationError(
      `Message '${messageId}' does not belong to session '${parentSessionId}'`,
    )
  }
}

/**
 * Recursively collect inherited messages from ancestor sessions.
 * Uses a visited set to prevent infinite loops from circular parent references.
 */
function collectInheritedMessages(
  db: Database.Database,
  parentSessionId: string,
  branchPointMessageId: string | null,
  visited: ReadonlySet<string> = new Set(),
): ReadonlyArray<Message> {
  if (visited.has(parentSessionId) || visited.size >= MAX_LINEAGE_DEPTH) {
    return []
  }

  const parent = findSessionById(db, parentSessionId)
  if (!parent) {
    return []
  }

  const nextVisited = new Set([...visited, parentSessionId])

  // First, get grandparent messages if parent is also branched
  const ancestorMessages: Message[] = parent.parent_session_id
    ? [...collectInheritedMessages(db, parent.parent_session_id, parent.branch_point_message_id ?? null, nextVisited)]
    : []

  // Then get messages from this parent
  const parentMessages = getParentMessages(db, parentSessionId, branchPointMessageId)

  return [...ancestorMessages, ...parentMessages]
}

/**
 * Get messages from a specific session, optionally up to a branch point.
 */
function getParentMessages(
  db: Database.Database,
  sessionId: string,
  branchPointMessageId: string | null,
): ReadonlyArray<Message> {
  if (branchPointMessageId) {
    // Use rowid ordering since messages created in the same second share created_at
    const rows = db.prepare(
      `SELECT * FROM messages
       WHERE sender_id = ?
       AND rowid <= (SELECT rowid FROM messages WHERE id = ?)
       ORDER BY rowid ASC`
    ).all(sessionId, branchPointMessageId) as Message[]
    return rows.map((row) => ({ ...row }))
  }

  // No branch point: return all messages from this session
  const rows = db.prepare(
    `SELECT * FROM messages
     WHERE sender_id = ?
     ORDER BY created_at ASC, rowid ASC`
  ).all(sessionId) as Message[]
  return rows.map((row) => ({ ...row }))
}

/**
 * Count messages that would be inherited from a parent session.
 */
function countInheritedMessages(
  db: Database.Database,
  parentSessionId: string,
  branchPointMessageId: string | null,
): number {
  if (branchPointMessageId) {
    const row = db.prepare(
      `SELECT COUNT(*) as count FROM messages
       WHERE sender_id = ?
       AND rowid <= (SELECT rowid FROM messages WHERE id = ?)`
    ).get(parentSessionId, branchPointMessageId) as { count: number }
    return row.count
  }

  const row = db.prepare(
    `SELECT COUNT(*) as count FROM messages WHERE sender_id = ?`
  ).get(parentSessionId) as { count: number }
  return row.count
}
