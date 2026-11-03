import type Database from 'better-sqlite3'
import type { EventLog } from './services/event-log.js'
import {
  findStaleSessions,
  markSessionsAsZombie,
  resetHookAndDiscoveredSessions,
} from './storage/repositories/session-repository.js'
import { expireSessionLease } from './services/session-retirement.js'
import { purgeTeamToHistory } from './storage/repositories/history-repository.js'
import { findAllTeams, disbandTeam } from './storage/repositories/team-repository.js'
import { countPendingTasksByTeam } from './storage/repositories/task-repository.js'
import { createTeamReaper } from './services/team-reaper.js'
import { logger } from '../shared/logger.js'

export interface StartupCleanupResult {
  readonly sessions: number
  readonly teams: number
  readonly tasks: number
  readonly teams_archived_to_history: number
  readonly teams_reaped: number
  /** Count of stale sessions whose cleanup threw and was skipped. */
  readonly sessions_failed: number
  /** Count of teams whose cleanup threw and was skipped. */
  readonly teams_failed: number
}

/**
 * On broker startup, clean up ALL stale data from previous runs.
 *
 * When the broker restarts, every session, team, and in-flight task from the
 * previous run is orphaned — the agent processes that owned them are dead.
 *
 * Cleanup order:
 *   1. Sessions: expire the execution lease (intents, state, handoffs);
 *      participant rows and messages survive (issue #70)
 *   2. Teams: purge all active/paused teams to history tables
 *   3. Tasks: handled via team purge cascade
 *
 * Error handling: per-session and per-team steps are wrapped in try/catch.
 * A FK-constraint violation on one session row (observed in prod 2026-04-22
 * with `handoff-sess-1`) MUST NOT abort cleanup for the remaining rows and
 * MUST NOT propagate out of this function — that regression caused the
 * broker to crash-loop with C++ mutex aborts.
 */
export function cleanupStaleSessionsOnStartup(
  db: Database.Database,
  eventLog: EventLog,
  options?: { readonly reaperGraceMs?: number },
): StartupCleanupResult {
  // Use the root logger directly rather than a child scope — keeps the
  // mock shape minimal for unit tests (no need to stub `logger.child`).

  // --- Sessions: all non-terminal sessions are stale after broker restart ---
  // EXCEPT hook-registered and discovered sessions (purpose = 'copilot-hook' or
  // 'discovered') — those are external Copilot CLI sessions that survive broker
  // restarts. They'll re-announce themselves via hooks or process discovery.
  const preservedPurposes = ['copilot-hook', 'discovered']
  const staleSessions = findStaleSessions(db, preservedPurposes)

  let sessionsFailed = 0

  if (staleSessions.length > 0) {
    try {
      markSessionsAsZombie(db, preservedPurposes)
    } catch (err) {
      logger.warn({ err }, 'markSessionsAsZombie failed — continuing with cleanup')
    }

    for (const session of staleSessions) {
      try {
        // Issue #70: a broker restart orphans the EXECUTION of these sessions,
        // not their correspondence. Expire the lease (intents, state, handoffs
        // released; row survives as 'expired') — messages are preserved so a
        // still-live external participant's inbox is untouched and hook/
        // discovered sessions that reconnect keep their mail.
        const result = expireSessionLease(db, session.id)

        eventLog.zombieCleaned(session.id, {
          messages_deleted: 0,
          messages_preserved: result.messages_preserved,
          intents_released: result.intents_released,
          state_deleted: result.state_deleted,
          handoffs_deleted: result.handoffs_deleted,
          cleanup_source: 'startup_cleanup',
        })
      } catch (err) {
        sessionsFailed += 1
        // Log and continue. A single failed row must not abort cleanup for
        // the rest.
        logger.warn(
          { err, sessionId: session.id, code: (err as { code?: string })?.code },
          'startup-cleanup: failed to retire session — continuing with remaining sessions',
        )
      }
    }
  }

  // Reset hook/discovered sessions to 'active' — they'll heartbeat via hooks or discovery.
  // Wrapped because `resetHookAndDiscoveredSessions` can throw SQLITE_BUSY if a
  // sibling broker briefly held the db (observed 2026-04-22); the repository
  // already retries with backoff, but we still defend against a final throw.
  try {
    resetHookAndDiscoveredSessions(db)
  } catch (err) {
    logger.warn(
      { err, code: (err as { code?: string })?.code },
      'startup-cleanup: resetHookAndDiscoveredSessions failed after retries — continuing',
    )
  }

  // --- Teams: purge to history instead of just disbanding ---
  const staleTeams = findAllTeams(db, 'active').concat(findAllTeams(db, 'paused'))

  let teamsArchivedToHistory = 0
  let totalTasks = 0
  let teamsFailed = 0

  for (const team of staleTeams) {
    try {
      totalTasks += countPendingTasksByTeam(db, team.id)

      const result = purgeTeamToHistory(db, team.id)
      if (result) {
        teamsArchivedToHistory += 1
      } else {
        disbandTeam(db, team.id)
      }
    } catch (err) {
      teamsFailed += 1
      logger.warn(
        { err, teamId: team.id },
        'startup-cleanup: failed to purge/disband team — continuing',
      )
    }
  }

  // --- Reaper pass: archive any remaining empty/active teams immediately ---
  // Uses grace=0 at startup so orphan teams from previous runs are caught
  // without waiting a full cycle. brain-solo remains exempt.
  let teamsReaped = 0
  try {
    const reaper = createTeamReaper({
      db,
      eventLog,
      options: { graceMs: options?.reaperGraceMs ?? 0 },
    })
    const reaperResult = reaper.reapOnce()
    teamsReaped = reaperResult.teams_reaped
  } catch (err) {
    logger.warn({ err }, 'startup-cleanup: reaper pass failed — continuing')
  }

  if (sessionsFailed > 0 || teamsFailed > 0) {
    logger.warn(
      {
        sessionsFailed,
        teamsFailed,
        sessionsTotal: staleSessions.length,
        teamsTotal: staleTeams.length,
      },
      'startup-cleanup: completed with per-row failures',
    )
  }

  return {
    sessions: staleSessions.length,
    teams: staleTeams.length,
    tasks: totalTasks,
    teams_archived_to_history: teamsArchivedToHistory,
    teams_reaped: teamsReaped,
    sessions_failed: sessionsFailed,
    teams_failed: teamsFailed,
  }
}
