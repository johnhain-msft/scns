import type Database from 'better-sqlite3'
import type { EventLog } from './services/event-log.js'
import type { Session } from './types.js'
import { deleteSession } from './storage/repositories/session-repository.js'
import { deleteMessagesBySession } from './storage/repositories/message-repository.js'
import { releaseIntentsBySession } from './storage/repositories/intent-repository.js'
import { deleteStateBySession } from './storage/repositories/state-repository.js'
import { purgeTeamToHistory } from './storage/repositories/history-repository.js'

export interface StartupCleanupResult {
  readonly sessions: number
  readonly teams: number
  readonly tasks: number
  readonly teams_archived_to_history: number
}

/**
 * On broker startup, clean up ALL stale data from previous runs.
 *
 * When the broker restarts, every session, team, and in-flight task from the
 * previous run is orphaned — the agent processes that owned them are dead.
 *
 * Cleanup order:
 *   1. Sessions: delete messages, intents, state, then session rows
 *   2. Teams: purge all active/paused teams to history tables
 *   3. Tasks: handled via team purge cascade
 */
export function cleanupStaleSessionsOnStartup(
  db: Database.Database,
  eventLog: EventLog,
): StartupCleanupResult {
  // --- Sessions ---
  const staleSessions = db
    .prepare("SELECT * FROM sessions WHERE status = 'active'")
    .all() as Session[]

  if (staleSessions.length > 0) {
    db.prepare("UPDATE sessions SET status = 'zombie' WHERE status = 'active'").run()

    for (const session of staleSessions) {
      const messagesDeleted = deleteMessagesBySession(db, session.id)
      const intentsReleased = releaseIntentsBySession(db, session.id)
      const stateDeleted = deleteStateBySession(db, session.id)
      deleteSession(db, session.id)

      eventLog.zombieCleaned(session.id, {
        messages_deleted: messagesDeleted,
        intents_released: intentsReleased,
        state_deleted: stateDeleted,
        cleanup_source: 'startup_cleanup',
      })
    }
  }

  // --- Teams: purge to history instead of just disbanding ---
  const staleTeams = db
    .prepare("SELECT id FROM teams WHERE status IN ('active', 'paused')")
    .all() as ReadonlyArray<{ id: string }>

  let teamsArchivedToHistory = 0
  let totalTasks = 0

  for (const team of staleTeams) {
    // Count tasks before purge for reporting
    const taskCount = (db.prepare(
      "SELECT COUNT(*) as count FROM tasks WHERE team_id = ? AND status IN ('pending', 'in_progress')"
    ).get(team.id) as { count: number }).count
    totalTasks += taskCount

    const result = purgeTeamToHistory(db, team.id)
    if (result) {
      teamsArchivedToHistory += 1
    } else {
      // Fallback: just disband if purge fails
      db.prepare("DELETE FROM team_members WHERE team_id = ?").run(team.id)
      db.prepare("UPDATE teams SET status = 'disbanded' WHERE id = ?").run(team.id)
    }
  }

  return {
    sessions: staleSessions.length,
    teams: staleTeams.length,
    tasks: totalTasks,
    teams_archived_to_history: teamsArchivedToHistory,
  }
}
