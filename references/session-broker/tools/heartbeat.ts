import type Database from 'better-sqlite3'
import type { EventLog } from '../services/event-log.js'
import {
  findSessionById,
  findZombieSessions,
  updateHeartbeat,
  deleteSession,
} from '../storage/repositories/session-repository.js'
import { releaseIntentsBySession } from '../storage/repositories/intent-repository.js'
import { deleteMessagesBySession } from '../storage/repositories/message-repository.js'
import { deleteStateBySession } from '../storage/repositories/state-repository.js'
import { type ToolResult, textResult, errorResult } from './helpers.js'

interface HeartbeatInput {
  readonly session_id: string
}

export function handleHeartbeat(
  db: Database.Database,
  eventLog: EventLog,
  input: HeartbeatInput,
): ToolResult {
  const session = findSessionById(db, input.session_id)
  if (!session) {
    return errorResult(`Session '${input.session_id}' not found`)
  }
  if (session.status !== 'active') {
    return errorResult(`Session '${input.session_id}' is not active (status: ${session.status})`)
  }

  updateHeartbeat(db, input.session_id)
  const timestamp = new Date().toISOString()

  eventLog.heartbeatReceived(input.session_id, { timestamp })

  return textResult({
    session_id: input.session_id,
    timestamp,
  })
}

interface DetectZombiesInput {
  readonly threshold_seconds?: number
}

export function handleDetectZombies(
  db: Database.Database,
  input: DetectZombiesInput,
): ToolResult {
  const threshold = input.threshold_seconds ?? 20
  const zombies = findZombieSessions(db, threshold)

  return textResult({
    threshold_seconds: threshold,
    zombies,
  })
}

interface CleanupZombiesInput {
  readonly grace_seconds?: number
}

interface CleanupResult {
  readonly session_id: string
  readonly messages_deleted: number
  readonly intents_released: number
  readonly state_deleted: number
}

export function handleCleanupZombies(
  db: Database.Database,
  eventLog: EventLog,
  input: CleanupZombiesInput,
): ToolResult {
  const grace = input.grace_seconds ?? 300
  const zombies = findZombieSessions(db, grace)

  const cleaned: CleanupResult[] = []

  for (const zombie of zombies) {
    // Delete messages where this session is sender or receiver
    const messagesDeleted = deleteMessagesBySession(db, zombie.id)

    // Release file intents
    const intentsReleased = releaseIntentsBySession(db, zombie.id)

    // Delete state owned by this session
    const stateDeleted = deleteStateBySession(db, zombie.id)

    // Delete the session row itself (full deregistration)
    deleteSession(db, zombie.id)

    eventLog.zombieCleaned(zombie.id, {
      messages_deleted: messagesDeleted,
      intents_released: intentsReleased,
      state_deleted: stateDeleted,
    })

    cleaned.push({
      session_id: zombie.id,
      messages_deleted: messagesDeleted,
      intents_released: intentsReleased,
      state_deleted: stateDeleted,
    })
  }

  return textResult({
    grace_seconds: grace,
    cleaned,
  })
}
