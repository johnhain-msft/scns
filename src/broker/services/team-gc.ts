/**
 * Team GC — garbage-collects disbanded/archived teams past their TTL.
 *
 * Teams are first purged to history tables (tier 1), then history records
 * can be expired separately (tier 2).
 */

import type Database from 'better-sqlite3'
import type { Event } from '../types.js'
import { findArchivedTeamsOlderThan } from '../storage/repositories/team-repository.js'
import { purgeTeamToHistory } from '../storage/repositories/history-repository.js'

// ── Minimal EventLog interface (subset needed by GC) ─────────

export interface EventLog {
  teamPurged(sessionId: string | null, data: Record<string, unknown>): Event
  sessionDeregistered(sessionId: string, data: Record<string, unknown>): Event
}

// ── Result type ──────────────────────────────────────────────

export interface GcResult {
  readonly teams_purged: number
  readonly team_ids: ReadonlyArray<string>
}

// ── Legacy helper ────────────────────────────────────────────

/** @deprecated Use findArchivedTeamsOlderThan from team-repository instead */
function findDisbandedTeamsOlderThan(
  db: Database.Database,
  ttlSeconds: number,
): ReadonlyArray<{ id: string; name: string }> {
  const rows = db
    .prepare(
      `SELECT * FROM teams
     WHERE status = 'disbanded'
     AND created_at <= datetime('now', '-' || ? || ' seconds')
     ORDER BY created_at`,
    )
    .all(ttlSeconds) as Array<{ id: string; name: string }>
  return rows.map((row) => ({ ...row }))
}

// ── Public API ───────────────────────────────────────────────

export function gcDisbandedTeams(
  db: Database.Database,
  eventLog: EventLog,
  ttlSeconds: number = 86400,
): GcResult {
  // Phase 1: archived teams past TTL (preferred path)
  const archivedTeams = findArchivedTeamsOlderThan(db, ttlSeconds)

  // Phase 2: also catch disbanded teams without archived_at (legacy path)
  const legacyTeams = findDisbandedTeamsOlderThan(db, ttlSeconds)
  const seenIds = new Set(archivedTeams.map((t) => t.id))
  const allTeams = [...archivedTeams, ...legacyTeams.filter((t) => !seenIds.has(t.id))]

  const purgedTeamIds: string[] = []

  for (const team of allTeams) {
    const historyResult = purgeTeamToHistory(db, team.id)

    if (!historyResult) {
      // Fallback: direct delete if purge fails (team may already be gone)
      db.prepare('DELETE FROM team_members WHERE team_id = ?').run(team.id)
      db.prepare('DELETE FROM teams WHERE id = ?').run(team.id)
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

  return {
    teams_purged: purgedTeamIds.length,
    team_ids: purgedTeamIds,
  }
}
