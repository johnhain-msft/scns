import type Database from 'better-sqlite3'
import type { EventLog } from './event-log.js'
import type { Team } from '../types.js'
import { deleteRespawnPoliciesByTeam, deleteRespawnHistoryByTeam } from '../storage/repositories/respawn-repository.js'
import { deleteScalingPoliciesByTeam } from '../storage/repositories/scaling-repository.js'
import { deleteUsageRecordsByTeam } from '../storage/repositories/usage-repository.js'
import { deleteTasksByTeam } from '../storage/repositories/task-repository.js'
import { deleteTeam, findArchivedTeamsOlderThan } from '../storage/repositories/team-repository.js'
import { findArchivedSessionsOlderThan, deleteSession } from '../storage/repositories/session-repository.js'
import { deleteMessagesBySession } from '../storage/repositories/message-repository.js'
import { releaseIntentsBySession } from '../storage/repositories/intent-repository.js'
import {
  purgeTeamToHistory,
  purgeSessionToHistory,
  deleteExpiredHistory,
} from '../storage/repositories/history-repository.js'

export interface GcResult {
  readonly teams_purged: number
  readonly team_ids: ReadonlyArray<string>
  readonly sessions_purged: number
  readonly session_ids: ReadonlyArray<string>
  readonly history_expired?: {
    readonly teams_deleted: number
    readonly sessions_deleted: number
    readonly tasks_deleted: number
    readonly messages_deleted: number
  }
}

/** @deprecated Use findArchivedTeamsOlderThan from team-repository instead */
export function findDisbandedTeamsOlderThan(
  db: Database.Database,
  ttlSeconds: number,
): ReadonlyArray<Team> {
  const rows = db.prepare(
    `SELECT * FROM teams
     WHERE status = 'disbanded'
     AND created_at <= datetime('now', '-' || ? || ' seconds')
     ORDER BY created_at`
  ).all(ttlSeconds) as Team[]
  return rows.map((row) => ({ ...row }))
}

export function gcDisbandedTeams(
  db: Database.Database,
  eventLog: EventLog,
  ttlSeconds: number = 86400,
  options?: { readonly expireHistory?: boolean },
): GcResult {
  // Phase 1: GC archived teams (preferred path — uses archived_at)
  const archivedTeams = findArchivedTeamsOlderThan(db, ttlSeconds)
  // Phase 2: Also GC disbanded teams without archived_at (legacy path — uses created_at)
  const legacyTeams = findDisbandedTeamsOlderThan(db, ttlSeconds)
  const seenIds = new Set(archivedTeams.map((t) => t.id))
  const allTeams = [
    ...archivedTeams,
    ...legacyTeams.filter((t) => !seenIds.has(t.id)),
  ]

  const purgedTeamIds: string[] = []

  for (const team of allTeams) {
    // Tier 1: Purge to history tables instead of direct delete
    const historyResult = purgeTeamToHistory(db, team.id)

    if (!historyResult) {
      // Fallback: direct delete if purge-to-history fails (team may already be gone)
      deleteRespawnPoliciesByTeam(db, team.id)
      deleteScalingPoliciesByTeam(db, team.id)
      deleteRespawnHistoryByTeam(db, team.id)
      deleteUsageRecordsByTeam(db, team.id)
      deleteTasksByTeam(db, team.id)
      deleteTeam(db, team.id)
    }

    eventLog.teamPurged(null, {
      team_id: team.id,
      team_name: team.name,
      gc_source: 'team_gc',
      ttl_seconds: ttlSeconds,
      archived_to_history: historyResult !== null,
    })

    purgedTeamIds.push(team.id)
  }

  // Phase 3: GC archived sessions past TTL — also purge to history
  const archivedSessions = findArchivedSessionsOlderThan(db, ttlSeconds)
  const purgedSessionIds: string[] = []

  for (const session of archivedSessions) {
    const historyResult = purgeSessionToHistory(db, session.id)

    if (!historyResult) {
      // Fallback: direct delete
      try { deleteMessagesBySession(db, session.id) } catch { /* best effort */ }
      try { releaseIntentsBySession(db, session.id) } catch { /* best effort */ }
      deleteSession(db, session.id)
    }

    eventLog.sessionDeregistered(session.id, {
      reason: 'gc_archived',
      ttl_seconds: ttlSeconds,
      archived_to_history: historyResult !== null,
    })

    purgedSessionIds.push(session.id)
  }

  // Phase 4: Tier 2 — expire old history records
  let historyExpired: GcResult['history_expired']
  if (options?.expireHistory !== false) {
    const expired = deleteExpiredHistory(db)
    const total = expired.teams_deleted + expired.sessions_deleted + expired.tasks_deleted + expired.messages_deleted
    if (total > 0) {
      historyExpired = expired
    }
  }

  return {
    teams_purged: purgedTeamIds.length,
    team_ids: purgedTeamIds,
    sessions_purged: purgedSessionIds.length,
    session_ids: purgedSessionIds,
    ...(historyExpired ? { history_expired: historyExpired } : {}),
  }
}
