import type Database from 'better-sqlite3'
import type { EventLog } from './services/event-log.js'
import type { RespawnController } from './services/respawn-controller.js'
import { findZombieSessions, deleteSession } from './storage/repositories/session-repository.js'
import { deleteMessagesBySession } from './storage/repositories/message-repository.js'
import { releaseIntentsBySession } from './storage/repositories/intent-repository.js'
import { deleteStateBySession } from './storage/repositories/state-repository.js'
import { findTeamMemberInfoBySession } from './storage/repositories/team-repository.js'
import { gcDisbandedTeams } from './services/team-gc.js'
import { compactAllTeams } from './services/message-compaction.js'
import { initializeTaskGates, withTaskGate } from './services/background-task-gate.js'

const DEFAULT_INTERVAL_MS = 30_000  // 30 seconds
const DEFAULT_GRACE_SECONDS = 300   // 300 seconds
const DEFAULT_GC_TTL_SECONDS = 86400       // 24 hours
const DEFAULT_GC_INTERVAL_TICKS = 10       // every 10th tick = every 5 minutes at 30s interval
const DEFAULT_COMPACTION_INTERVAL_TICKS = 20  // every 20th tick = every 10 minutes at 30s interval

interface HeartbeatPollerOptions {
  readonly intervalMs?: number
  readonly graceSeconds?: number
  readonly respawnController?: RespawnController
  readonly gcTtlSeconds?: number
  readonly gcIntervalTicks?: number
  readonly compactionIntervalTicks?: number
  readonly useTaskGates?: boolean
}

export interface HeartbeatPoller {
  stop(): void
}

function cleanupZombies(
  db: Database.Database,
  eventLog: EventLog,
  graceSeconds: number,
  respawnController?: RespawnController,
): number {
  const zombies = findZombieSessions(db, graceSeconds)

  for (const zombie of zombies) {
    // Snapshot team membership BEFORE deletion (cascade deletes team_members)
    const memberInfo = findTeamMemberInfoBySession(db, zombie.id)

    // Full deregistration: delete messages, intents, state, then session
    const messagesDeleted = deleteMessagesBySession(db, zombie.id)
    const intentsReleased = releaseIntentsBySession(db, zombie.id)
    const stateDeleted = deleteStateBySession(db, zombie.id)
    deleteSession(db, zombie.id)

    eventLog.zombieCleaned(zombie.id, {
      messages_deleted: messagesDeleted,
      intents_released: intentsReleased,
      state_deleted: stateDeleted,
      cleanup_source: 'heartbeat_poller',
    })

    // Check respawn policy (async, fire-and-forget)
    if (memberInfo && respawnController) {
      respawnController.checkAndRespawn({
        session_id: zombie.id,
        team_id: memberInfo.team_id,
        role: memberInfo.role,
        name: memberInfo.name,
        agent_type: memberInfo.agent_type,
      }).catch((err) => {
        process.stdout.write(`Respawn check failed for ${zombie.id}: ${err}\n`)
      })
    }
  }

  return zombies.length
}

function runGcWithGates(
  db: Database.Database,
  eventLog: EventLog,
  gcTtlSeconds: number,
): void {
  const gcResult = withTaskGate(db, {
    taskName: 'team-gc',
    intervalMs: 300_000,
    lockHolder: `heartbeat-poller-${process.pid}`,
  }, () => gcDisbandedTeams(db, eventLog, gcTtlSeconds))

  if (gcResult && gcResult.teams_purged > 0) {
    process.stdout.write(`Team GC purged ${gcResult.teams_purged} disbanded team(s)\n`)
  }
}

function runGcWithTicks(
  db: Database.Database,
  eventLog: EventLog,
  gcTtlSeconds: number,
  tickCount: number,
  gcIntervalTicks: number,
): void {
  if (tickCount % gcIntervalTicks === 0) {
    const gcResult = gcDisbandedTeams(db, eventLog, gcTtlSeconds)
    if (gcResult.teams_purged > 0) {
      process.stdout.write(`Team GC purged ${gcResult.teams_purged} disbanded team(s)\n`)
    }
  }
}

export function startHeartbeatPoller(
  db: Database.Database,
  eventLog: EventLog,
  options?: HeartbeatPollerOptions,
): HeartbeatPoller {
  const intervalMs = options?.intervalMs ?? DEFAULT_INTERVAL_MS
  const graceSeconds = options?.graceSeconds ?? DEFAULT_GRACE_SECONDS
  const respawnController = options?.respawnController
  const gcTtlSeconds = options?.gcTtlSeconds ?? DEFAULT_GC_TTL_SECONDS
  const gcIntervalTicks = options?.gcIntervalTicks ?? DEFAULT_GC_INTERVAL_TICKS
  const compactionIntervalTicks = options?.compactionIntervalTicks ?? DEFAULT_COMPACTION_INTERVAL_TICKS
  const useTaskGates = options?.useTaskGates ?? false

  if (useTaskGates) {
    initializeTaskGates(db)
  }

  process.stdout.write(
    `Heartbeat poller started (interval: ${intervalMs}ms, grace: ${graceSeconds}s)\n`
  )

  let tickCount = 0

  const intervalId = setInterval(() => {
    tickCount += 1

    const cleaned = cleanupZombies(db, eventLog, graceSeconds, respawnController)
    if (cleaned > 0) {
      process.stdout.write(`Heartbeat poller cleaned ${cleaned} zombie session(s)\n`)
    }

    if (useTaskGates) {
      runGcWithGates(db, eventLog, gcTtlSeconds)
    } else {
      runGcWithTicks(db, eventLog, gcTtlSeconds, tickCount, gcIntervalTicks)
    }

    // Message compaction on configured tick interval
    if (tickCount % compactionIntervalTicks === 0) {
      const compactionResults = compactAllTeams(db, eventLog)
      const totalArchived = compactionResults.reduce((sum, r) => sum + r.messages_archived, 0)
      if (totalArchived > 0) {
        process.stdout.write(`Message compaction archived ${totalArchived} message(s)\n`)
      }
    }
  }, intervalMs)

  return {
    stop(): void {
      clearInterval(intervalId)
      process.stdout.write('Heartbeat poller stopped\n')
    },
  }
}
