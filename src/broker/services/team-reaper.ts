/**
 * Team Reaper — Phase 13.12.15.
 *
 * Periodically archives orphaned active teams:
 *   - status = 'active' AND archived_at IS NULL
 *   - no members with status in ('working', 'idle')
 *   - no tasks with status = 'in_progress' (WS D exemption)
 *   - last_touched (MAX of created_at and latest member message) older than grace
 *   - name != 'brain-solo' (well-known exempt team)
 *
 * Archiving sets `archived_at = now()` via `archiveTeam()`; rows are preserved
 * so history/dashboard "Show archived" toggles can still surface them.
 */

import type Database from 'better-sqlite3'
import type { EventLog } from './event-log.js'
import { archiveTeam } from '../storage/repositories/team-repository.js'
import { logger } from '../../shared/logger.js'

function childLogger(bindings: Record<string, unknown>): { warn: (...a: unknown[]) => void; info: (...a: unknown[]) => void } {
  try {
    const child = (logger as unknown as { child?: (b: Record<string, unknown>) => unknown })?.child?.(bindings) as
      | { warn: (...a: unknown[]) => void; info: (...a: unknown[]) => void }
      | undefined
    if (child && typeof child.warn === 'function' && typeof child.info === 'function') return child
  } catch {
    // fall through to noop
  }
  const noop = (): void => {}
  return { warn: noop, info: noop }
}

export interface TeamReaperOptions {
  /** Minimum age before an empty team is eligible for reaping. Default 300000 (5min). */
  readonly graceMs?: number
  /** Poll interval. Default 60000 (1min). */
  readonly intervalMs?: number
  /** Team names that are never reaped. Default ['brain-solo']. */
  readonly exemptNames?: ReadonlyArray<string>
  /**
   * F6: probe of currently-active spawner-tracked team IDs. If a candidate
   * team has any session in this set, it is exempted from reaping. This
   * prevents the 300s "live ACP team archived while agent is mid-tool-call"
   * bug — the spawner's in-memory map is authoritative for liveness,
   * team_members.status can lag during long-running prompts.
   */
  readonly getActiveTeamIds?: () => ReadonlySet<string>
  /**
   * Upper bound on how long the `getActiveTeamIds` exemption may hold a team
   * open. The exemption trusts the spawner's in-memory map, but a crashed or
   * permanently-inert ACP child can linger in that map forever — the process
   * still exists, so the team is skipped on every pass, never archived, and
   * its `<baseDir>/<teamId>/wt` sandbox is never reclaimed. Observed in the
   * wild as ~470 consecutive skips holding 8 teams and ~100MB of worktrees.
   *
   * Once a candidate is this far past its last activity, the exemption is
   * overridden and the team is reaped anyway. Set to 0 to disable the floor
   * and restore an unconditional exemption. Default 86400000 (24h) — far
   * beyond any legitimate tool call, so live agents are never affected.
   */
  readonly exemptionMaxAgeMs?: number
  /**
   * Task 43 — post-archive hook. Called with the teamId of each
   * successfully-reaped team AFTER `archiveTeam()` returns true and
   * AFTER the `teamArchived` event is emitted. Used by the
   * team-worktree-manager to reclaim `<baseDir>/<teamId>/wt` on disk so
   * the per-team sandbox directories don't accumulate. Errors are
   * swallowed (logged) so a hook failure cannot interrupt the reap pass.
   */
  readonly onTeamArchived?: (teamId: string) => void
}

export interface TeamReaperResult {
  readonly teams_reaped: number
  readonly team_ids: ReadonlyArray<string>
}

export interface TeamReaper {
  /** Run one reaping pass synchronously. */
  reapOnce(): TeamReaperResult
  /** Start the periodic timer. Safe to call multiple times. */
  start(): void
  /** Stop the periodic timer. */
  stop(): void
}

interface CandidateRow {
  readonly id: string
  readonly name: string
  readonly last_touched_seconds_ago: number
}

export function createTeamReaper(deps: {
  readonly db: Database.Database
  readonly eventLog: EventLog
  readonly options?: TeamReaperOptions
}): TeamReaper {
  const { db, eventLog } = deps
  const opts = deps.options ?? {}
  const graceMs = opts.graceMs ?? 300_000
  const intervalMs = opts.intervalMs ?? 60_000
  const exemptNames = opts.exemptNames ?? ['brain-solo']
  const getActiveTeamIds = opts.getActiveTeamIds
  const exemptionMaxAgeMs = opts.exemptionMaxAgeMs ?? 86_400_000
  const onTeamArchived = opts.onTeamArchived
  const log = childLogger({ module: 'team-reaper' })

  let timer: NodeJS.Timeout | null = null

  function reapOnce(): TeamReaperResult {
    const graceSeconds = Math.max(0, Math.floor(graceMs / 1000))

    // Build placeholders for exempt-name list
    const placeholders = exemptNames.length > 0 ? exemptNames.map(() => '?').join(',') : "''"
    const nameFilter =
      exemptNames.length > 0 ? `AND t.name NOT IN (${placeholders})` : ''

    // Candidate teams:
    //   - active, not archived
    //   - not in exempt names
    //   - 0 members in ('working','idle') AND no member with recent
    //     last_activity_at (Phase 13.12.25 — a live ACP agent may briefly
    //     drop out of 'working'/'idle' during a long tool call; the
    //     heartbeat keeps the team alive)
    //   - MAX(created_at, latest message timestamp) older than graceSeconds
    const sql = `
      WITH team_message_latest AS (
        SELECT team_id, MAX(created_at) AS latest
        FROM messages
        WHERE team_id IS NOT NULL
        GROUP BY team_id
      ),
      live_member_counts AS (
        SELECT team_id, COUNT(*) AS live_count
        FROM team_members
        WHERE status IN ('working', 'idle')
           OR (
             last_activity_at IS NOT NULL
             AND CAST((julianday('now') - julianday(last_activity_at)) * 86400 AS INTEGER) < ?
           )
        GROUP BY team_id
      ),
      -- WS D: a team with at least one in-progress task is exempt from
      -- reaping regardless of member-status bucket. A long ACP tool call
      -- can drop every member out of working/idle and out of the
      -- last_activity_at heartbeat window while real work is still
      -- under way; the task-status signal is the authoritative one.
      in_progress_task_counts AS (
        SELECT team_id, COUNT(*) AS in_progress_count
        FROM tasks
        WHERE status = 'in_progress'
        GROUP BY team_id
      )
      SELECT t.id AS id,
             t.name AS name,
             CAST((julianday('now') - julianday(
               MAX(
                 COALESCE(tml.latest, '1970-01-01'),
                 COALESCE(t.created_at, '1970-01-01')
               )
             )) * 86400 AS INTEGER) AS last_touched_seconds_ago
      FROM teams t
      LEFT JOIN team_message_latest tml ON tml.team_id = t.id
      LEFT JOIN live_member_counts lmc ON lmc.team_id = t.id
      LEFT JOIN in_progress_task_counts iptc ON iptc.team_id = t.id
      WHERE t.status = 'active'
        AND t.archived_at IS NULL
        ${nameFilter}
        AND COALESCE(lmc.live_count, 0) = 0
        AND COALESCE(iptc.in_progress_count, 0) = 0
        AND CAST((julianday('now') - julianday(
               MAX(
                 COALESCE(tml.latest, '1970-01-01'),
                 COALESCE(t.created_at, '1970-01-01')
               )
             )) * 86400 AS INTEGER) >= ?
    `

    let rows: CandidateRow[]
    try {
      rows = db.prepare(sql).all(graceSeconds, ...exemptNames, graceSeconds) as CandidateRow[]
    } catch (err) {
      log.warn({ err }, 'team-reaper: candidate query failed')
      return { teams_reaped: 0, team_ids: [] }
    }

    const reapedIds: string[] = []
    const activeTeamIds = getActiveTeamIds ? getActiveTeamIds() : null
    const exemptionMaxAgeSeconds = Math.max(0, Math.floor(exemptionMaxAgeMs / 1000))
    for (const row of rows) {
      // F6: never archive a team the spawner still has live members for —
      // unless that claim has gone stale. A dead-but-unreaped ACP child stays
      // in the spawner's map indefinitely, so without this floor the team is
      // skipped forever and its worktree leaks.
      if (activeTeamIds && activeTeamIds.has(row.id)) {
        const exemptionExpired =
          exemptionMaxAgeSeconds > 0 && row.last_touched_seconds_ago >= exemptionMaxAgeSeconds
        if (!exemptionExpired) {
          log.info(
            { teamId: row.id, teamName: row.name },
            'team-reaper: skipped — spawner still has live ACP member(s) for this team',
          )
          continue
        }
        log.warn(
          {
            teamId: row.id,
            teamName: row.name,
            lastTouchedSecondsAgo: row.last_touched_seconds_ago,
            exemptionMaxAgeSeconds,
          },
          'team-reaper: overriding stale spawner exemption — reaping anyway',
        )
      }
      const ok = archiveTeam(db, row.id)
      if (!ok) continue
      reapedIds.push(row.id)
      try {
        eventLog.teamArchived(null, {
          team_id: row.id,
          team_name: row.name,
          source: 'team-reaper',
          last_touched_seconds_ago: row.last_touched_seconds_ago,
          grace_seconds: graceSeconds,
        })
      } catch (err) {
        log.warn({ err, teamId: row.id }, 'team-reaper: event emit failed')
      }
      // Task 43 — post-archive cleanup hook. Wired by startup.ts to the
      // team-worktree-manager so `<baseDir>/<teamId>/wt` is reclaimed
      // on disk. Best-effort; never throws out of the reap loop because
      // a hook failure must not abort reaping of other teams.
      if (onTeamArchived) {
        try {
          onTeamArchived(row.id)
        } catch (err) {
          log.warn(
            { err, teamId: row.id },
            'team-reaper: onTeamArchived hook failed',
          )
        }
      }
    }

    if (reapedIds.length > 0) {
      log.info({ count: reapedIds.length, team_ids: reapedIds }, 'team-reaper: archived empty teams')
    }

    return { teams_reaped: reapedIds.length, team_ids: reapedIds }
  }

  function start(): void {
    if (timer) return
    timer = setInterval(() => {
      try {
        reapOnce()
      } catch (err) {
        log.warn({ err }, 'team-reaper: tick failed')
      }
    }, intervalMs)
    timer.unref?.()
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  return { reapOnce, start, stop }
}
