import type Database from 'better-sqlite3'
import type { EventLog } from '../services/event-log.js'
import {
  createSession,
  deleteSession,
  findAllSessions,
} from '../storage/repositories/session-repository.js'
import { deleteMessagesBySession } from '../storage/repositories/message-repository.js'
import { releaseIntentsBySession } from '../storage/repositories/intent-repository.js'
import { deleteStateBySession } from '../storage/repositories/state-repository.js'
import { findTeamInfoBySession } from '../storage/repositories/team-repository.js'
import { type ToolResult, textResult, errorResult } from './helpers.js'

interface RegisterInput {
  readonly id: string
  readonly purpose: string
  readonly working_dir: string
  readonly worktree: string | null
  readonly repo_context?: string | null
}

export function handleRegisterSession(
  db: Database.Database,
  eventLog: EventLog,
  input: RegisterInput,
): ToolResult {
  try {
    const session = createSession(db, {
      ...input,
      repo_context: input.repo_context ?? null,
    })
    eventLog.sessionRegistered(input.id, {
      purpose: input.purpose,
      working_dir: input.working_dir,
      worktree: input.worktree,
      repo_context: input.repo_context ?? null,
    })
    return textResult(session)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResult(`Failed to register session: ${message}`)
  }
}

interface DeregisterInput {
  readonly id: string
}

export function handleDeregisterSession(
  db: Database.Database,
  eventLog: EventLog,
  input: DeregisterInput,
): ToolResult {
  // Clean up related records first (foreign key constraints)
  const messagesDeleted = deleteMessagesBySession(db, input.id)
  const intentsDeleted = releaseIntentsBySession(db, input.id)
  const stateDeleted = deleteStateBySession(db, input.id)

  const deleted = deleteSession(db, input.id)
  if (!deleted) {
    return errorResult(`Session '${input.id}' not found`)
  }
  eventLog.sessionDeregistered(input.id, {
    reason: 'deregistered',
    messages_deleted: messagesDeleted,
    intents_deleted: intentsDeleted,
    state_deleted: stateDeleted,
  })
  return textResult({
    deleted: true,
    id: input.id,
    messages_deleted: messagesDeleted,
    intents_deleted: intentsDeleted,
    state_deleted: stateDeleted,
  })
}

interface ListInput {
  readonly status?: string
  readonly include_archived?: boolean
}

export function handleListSessions(
  db: Database.Database,
  input: ListInput,
): ToolResult {
  const sessions = findAllSessions(db, input.status, input.include_archived)
  const enriched = sessions.map((session) => ({
    ...session,
    team: findTeamInfoBySession(db, session.id),
  }))
  return textResult(enriched)
}
