/**
 * Heartbeat Poller — periodically scans for zombie sessions and retires
 * their execution lease.
 *
 * A zombie session is one whose last_heartbeat is older than the grace period.
 * On each tick the poller:
 *   1. Finds zombie sessions and expires their lease (intents, state,
 *      handoffs released; the participant row and its messages survive —
 *      issue #70: liveness expiry must never destroy correspondence or
 *      another participant's inbox)
 *   2. Optionally runs team GC on a configurable tick interval
 *
 * Message compaction is not yet implemented (requires message-compaction service).
 */

import type Database from 'better-sqlite3'
import type { EventLog } from './services/event-log.js'
import { findZombieSessions } from './storage/repositories/session-repository.js'
import { expireSessionLease } from './services/session-retirement.js'
import { findTeamMemberInfoBySession } from './storage/repositories/team-repository.js'
import { gcDisbandedTeams } from './services/team-gc.js'
import { gcArchivedSessions } from './services/session-gc.js'
import { initializeTaskGates, withTaskGate } from './services/background-task-gate.js'
import { logger } from '../shared/logger.js'

// ── Defaults ─────────────────────────────────────────────────

const DEFAULT_INTERVAL_MS = 30_000
const DEFAULT_GRACE_SECONDS = 300
const DEFAULT_GC_TTL_SECONDS = 86400
const DEFAULT_GC_INTERVAL_TICKS = 10
const DEFAULT_COMPACTION_INTERVAL_TICKS = 20

// ── Types ────────────────────────────────────────────────────

export interface HeartbeatPollerOptions {
  readonly intervalMs?: number
  readonly graceSeconds?: number
  readonly gcTtlSeconds?: number
  readonly gcIntervalTicks?: number
  readonly compactionIntervalTicks?: number
  readonly useTaskGates?: boolean
  /** Called for each zombie session BEFORE deletion — provides data for respawn */
  readonly onZombieDetected?: (dead: {
    readonly sessionId: string
    readonly role: string
    readonly teamId?: string
    readonly lastHeartbeat: string
  }) => void
}

export interface HeartbeatPoller {
  stop(): void
}

// ── Zombie cleanup ───────────────────────────────────────────

function cleanupZombies(
  db: Database.Database,
  eventLog: EventLog,
  graceSeconds: number,
  onZombieDetected?: HeartbeatPollerOptions['onZombieDetected'],
): number {
  const zombies = findZombieSessions(db, graceSeconds)

  for (const zombie of zombies) {
    // Snapshot team membership BEFORE retirement (state may change under us)
    const teamInfo = findTeamMemberInfoBySession(db, zombie.id)

    // Notify before retirement so respawn has the data it needs
    if (onZombieDetected) {
      onZombieDetected({
        sessionId: zombie.id,
        role: teamInfo?.role ?? 'general',
        teamId: teamInfo?.team_id ?? undefined,
        lastHeartbeat: zombie.last_heartbeat ?? '',
      })
    }

    // Issue #70: expire the lease, never the correspondence. The session row
    // stays (status 'expired', archived) so its messages keep both endpoints
    // and a reconnecting participant can revive under the same id.
    const result = expireSessionLease(db, zombie.id)

    eventLog.zombieCleaned(zombie.id, {
      messages_deleted: 0,
      messages_preserved: result.messages_preserved,
      intents_released: result.intents_released,
      state_deleted: result.state_deleted,
      handoffs_deleted: result.handoffs_deleted,
      cleanup_source: 'heartbeat_poller',
    })
  }

  return zombies.length
}

// ── GC runners ───────────────────────────────────────────────

// Issue #70: session GC is the settlement tier for expired/archived
// participants — it archives their correspondence to history and retries
// deferred terminations (a dead sender's row survives only until its unread
// directed mail settles). It MUST run alongside team GC or expired rows and
// their retained mail accumulate forever.
function runSessionGc(db: Database.Database, eventLog: EventLog, gcTtlSeconds: number): void {
  const result = gcArchivedSessions(db, eventLog, gcTtlSeconds)
  if (result.sessions_purged > 0 || result.sessions_deferred > 0) {
    logger.info(
      { sessionsPurged: result.sessions_purged, sessionsDeferred: result.sessions_deferred },
      'Session GC settled archived sessions',
    )
  }
}

function runGcWithGates(db: Database.Database, eventLog: EventLog, gcTtlSeconds: number): void {
  const gcResult = withTaskGate(
    db,
    {
      taskName: 'team-gc',
      intervalMs: 300_000,
      lockHolder: `heartbeat-poller-${process.pid}`,
    },
    () => {
      runSessionGc(db, eventLog, gcTtlSeconds)
      return gcDisbandedTeams(db, eventLog, gcTtlSeconds)
    },
  )

  if (gcResult && gcResult.teams_purged > 0) {
    logger.info({ teamsPurged: gcResult.teams_purged }, 'Team GC purged disbanded teams')
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
    runSessionGc(db, eventLog, gcTtlSeconds)
    const gcResult = gcDisbandedTeams(db, eventLog, gcTtlSeconds)
    if (gcResult.teams_purged > 0) {
      logger.info({ teamsPurged: gcResult.teams_purged }, 'Team GC purged disbanded teams')
    }
  }
}

// ── Public API ───────────────────────────────────────────────

export function startHeartbeatPoller(
  db: Database.Database,
  eventLog: EventLog,
  options?: HeartbeatPollerOptions,
): HeartbeatPoller {
  const intervalMs = options?.intervalMs ?? DEFAULT_INTERVAL_MS
  const graceSeconds = options?.graceSeconds ?? DEFAULT_GRACE_SECONDS
  const gcTtlSeconds = options?.gcTtlSeconds ?? DEFAULT_GC_TTL_SECONDS
  const gcIntervalTicks = options?.gcIntervalTicks ?? DEFAULT_GC_INTERVAL_TICKS
  const compactionIntervalTicks =
    options?.compactionIntervalTicks ?? DEFAULT_COMPACTION_INTERVAL_TICKS
  void compactionIntervalTicks // reserved for future message-compaction integration
  const useTaskGates = options?.useTaskGates ?? false
  const onZombieDetected = options?.onZombieDetected

  if (useTaskGates) {
    initializeTaskGates(db)
  }

  logger.info({ intervalMs, graceSeconds }, 'Heartbeat poller started')

  let tickCount = 0

  const intervalId = setInterval(() => {
    tickCount += 1

    const cleaned = cleanupZombies(db, eventLog, graceSeconds, onZombieDetected)
    if (cleaned > 0) {
      logger.info({ cleaned }, 'Heartbeat poller cleaned zombie sessions')
    }

    if (useTaskGates) {
      runGcWithGates(db, eventLog, gcTtlSeconds)
    } else {
      runGcWithTicks(db, eventLog, gcTtlSeconds, tickCount, gcIntervalTicks)
    }

    // NOTE: Message compaction skipped — requires message-compaction service (not yet ported)
  }, intervalMs)

  return {
    stop(): void {
      clearInterval(intervalId)
      logger.info('Heartbeat poller stopped')
    },
  }
}
