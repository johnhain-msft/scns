/**
 * Lifecycle tool handlers.
 *
 * Provides the bridge between the pure state-machine in lifecycle.ts,
 * the session repository (persistence), and the event log (audit trail).
 */

import type Database from 'better-sqlite3'
import type { EventLog } from '../services/event-log.js'
import type { Session } from '../types.js'
import {
  findSessionById,
  updateSessionStatus,
} from '../storage/repositories/session-repository.js'
import { appendEvent } from '../storage/repositories/event-repository.js'
import {
  validateTransition,
  getValidTransitions,
  isTerminalStatus,
  type SessionStatus,
} from '../lifecycle.js'
import { NotFoundError } from '../errors.js'
import { type ToolResult, textResult, errorResult } from './helpers.js'

// ---------------------------------------------------------------------------
// Transition (mutates DB + emits event)
// ---------------------------------------------------------------------------

/**
 * Validates then persists a status transition, emitting a `session.transition`
 * event on success. Throws NotFoundError / ConflictError on failure.
 */
export function transitionSessionStatus(
  db: Database.Database,
  _eventLog: EventLog,
  sessionId: string,
  to: SessionStatus,
): Session {
  const session = findSessionById(db, sessionId)
  if (!session) {
    throw new NotFoundError('Session', sessionId)
  }

  const from = session.status as SessionStatus
  validateTransition(from, to)

  const updated = updateSessionStatus(db, sessionId, to)
  if (!updated) {
    throw new NotFoundError('Session', sessionId)
  }

  appendEvent(db, {
    event_type: 'session.transition',
    session_id: sessionId,
    payload: JSON.stringify({ from, to, sessionId }),
  })

  return updated
}

// ---------------------------------------------------------------------------
// Query tool
// ---------------------------------------------------------------------------

interface GetLifecycleInput {
  readonly session_id: string
}

/**
 * Returns the current status of a session together with its valid next
 * transitions. Useful for orchestrators inspecting what actions are available.
 */
export function handleGetSessionLifecycle(
  db: Database.Database,
  input: GetLifecycleInput,
): ToolResult {
  const session = findSessionById(db, input.session_id)
  if (!session) {
    return errorResult(`Session '${input.session_id}' not found`)
  }

  const status = session.status as SessionStatus
  return textResult({
    session_id: session.id,
    current_status: status,
    valid_transitions: [...getValidTransitions(status)],
    is_terminal: isTerminalStatus(status),
  })
}
