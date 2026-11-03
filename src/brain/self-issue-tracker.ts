/**
 * Self-issue tracker — the durable status state-machine for self-issue signals.
 *
 * Bug 2 fix: `self-issue-ingest` used to mark an issue persistently "ingested"
 * the instant it was enqueued to the brain's IN-MEMORY task queue, before any
 * work happened (ack-before-process). A broker restart before the brain worked
 * that task lost it forever — the queue is ephemeral, but the ingested flag
 * survived, so the issue was never re-pulled.
 *
 * This tracker replaces that fire-and-forget boolean with a visibility-timeout
 * / lease pattern, mirroring the suggestion pipeline's persisted status
 * state-machine (pending→approved→in-progress→implemented). GitHub itself is the
 * durable source of truth (re-fetched every ingest run via `--state open`), so
 * we only persist the two states that must survive across ticks/restarts:
 *
 *   (no record)   → enqueueable. The signal is not being worked; the ingest run
 *                   will (re-)enqueue it unless it is already sitting in the live
 *                   in-memory queue (checked by the caller).
 *   `in-progress` → leased: the brain has spawned a team for it (teamId stored so
 *                   the gate verdict can be correlated back). A lease older than a
 *                   TTL is swept back to enqueueable so a crash mid-work recovers.
 *   `done`        → terminal: the team's diff PASSED the quality gate; never
 *                   re-enqueue. (scns#36: member exit alone never sets this.)
 *   `abandoned`   → terminal: the attempt cap was exhausted without a gate PASS.
 *                   The honest "gave up" state — never `done`, never re-enqueued.
 *
 * Because a lost-before-spawn signal has NO record, a fresh process (empty queue,
 * no `in-progress` lease) re-enqueues it — which is the fix. Records live in the
 * broker `shared_state` table so they survive restart.
 *
 * ## Attempt cap (runaway-loop guard)
 *
 * The lease alone cannot stop a signal that is spawned, fails, and is swept back
 * to enqueueable over and over. A separate durable counter (`self-issue:attempts:`)
 * records one attempt per spawned team; `isExhausted` lets the caller refuse to
 * re-enqueue past a cap. The counter is deliberately NOT reset by `sweepStale`
 * (otherwise the TTL sweep would reset the cap and the loop would be infinite
 * again) — only resolving the signal (`markDone`) or an explicit `clear` resets it.
 *
 * Once a signal is abandoned it stays abandoned for the life of the broker: no CLI
 * command calls `clear`, so recovery is a manual DB edit against the broker's
 * shared_state (the broker logs the exact statement when it abandons a signal):
 *
 *   DELETE FROM shared_state
 *    WHERE key IN ('self-issue:status:<key>', 'self-issue:attempts:<key>');
 *
 * ## Known limitation — a late success is discarded
 *
 * `sweepStale` deletes only the status record, so a team whose `success` arrives
 * AFTER its lease was swept can no longer be matched by `findInProgressByTeam` and
 * its completion is dropped: the signal is re-enqueued and the work is redone. The
 * attempt cap bounds that to `maxAttempts` repeats rather than a runaway. Keep the
 * stale TTL comfortably above a normal team's runtime (production saw a 20-minute
 * spread between a team's first and last completion event, which is why the broker
 * defaults the TTL to 90m rather than 30m).
 */

import type Database from 'better-sqlite3'

export type SelfIssueStatus = 'in-progress' | 'done' | 'abandoned'

export interface SelfIssueRecord {
  readonly status: SelfIssueStatus
  readonly teamId: string | null
  /** ISO-8601 timestamp of the last transition. */
  readonly updatedAt: string
}

export interface SelfIssueTracker {
  /** True if the signal is leased (`in-progress`) or terminal (`done`/`abandoned`) — do NOT re-enqueue it. */
  isActive(key: string): boolean
  /** The signal's persisted status, or null when it has no record (enqueueable). */
  status(key: string): SelfIssueStatus | null
  /** Lease a signal to a spawned team. `atMs` overridable for tests. */
  markInProgress(key: string, teamId: string, atMs?: number): void
  /** Mark a signal terminal (worked successfully — gate verdict PASS). */
  markDone(key: string, atMs?: number): void
  /**
   * Mark a signal terminally ABANDONED: the attempt cap is exhausted and it
   * will never be retried. This is the HONEST terminal state for a
   * permanently-failing issue — `done` would claim the work landed when it
   * did not. The attempt counter is deliberately preserved as the audit
   * trail; recovery is the same manual `clear`/DELETE documented above.
   */
  markAbandoned(key: string, atMs?: number): void
  /** Remove any status record, reverting the signal to enqueueable. */
  clear(key: string): void
  /** The signal key currently leased to `teamId` (status `in-progress`), or null. */
  findInProgressByTeam(teamId: string): string | null
  /**
   * The signal key recorded against `teamId` in ANY status. The gate-pass
   * publisher runs on the same `quality_gate_verdict` event as the lease
   * resolver, which may already have marked the lease `done` — markDone/
   * markAbandoned preserve `teamId` so this lookup still resolves the
   * verdict's source issue.
   */
  findByTeam(teamId: string): string | null
  /** How many teams have been spawned for this signal since it was last resolved/cleared. */
  attempts(key: string): number
  /**
   * True when the signal has burned through `cap` attempts and must not be
   * re-enqueued again. A `cap` of 0 or less disables the guard.
   */
  isExhausted(key: string, cap: number): boolean
  /**
   * Revert `in-progress` leases whose last transition is older than `ttlMs` back
   * to enqueueable (crash-during-work recovery). `done` records are never swept.
   * Attempt counters are deliberately preserved so a sweep cannot reset the cap.
   * Returns the number of leases reverted.
   */
  sweepStale(ttlMs: number, nowMs?: number): number
}

const STATUS_KEY_PREFIX = 'self-issue:status:'
const ATTEMPTS_KEY_PREFIX = 'self-issue:attempts:'

function statusKey(signalKey: string): string {
  return `${STATUS_KEY_PREFIX}${signalKey}`
}

function attemptsKey(signalKey: string): string {
  return `${ATTEMPTS_KEY_PREFIX}${signalKey}`
}

function signalKeyFromStatusKey(rowKey: string): string {
  return rowKey.slice(STATUS_KEY_PREFIX.length)
}

/**
 * Deterministic, unique-per-task broker team id for a self-issue brain task.
 * A UNIQUE team (not the shared `brain-solo` team) is required so the
 * `team_completed` event can be correlated back to exactly one signal. The
 * `team-selfissue-` prefix marks it as a self-issue team for the completion
 * subscriber.
 */
export function selfIssueTeamId(taskId: string): string {
  return `team-selfissue-${taskId}`
}

export function createSelfIssueTracker(db: Database.Database): SelfIssueTracker {
  const getStmt = db.prepare<[string], { value: string }>(
    'SELECT value FROM shared_state WHERE key = ?',
  )
  const upsertStmt = db.prepare(
    "INSERT INTO shared_state (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  )
  const deleteStmt = db.prepare('DELETE FROM shared_state WHERE key = ?')
  const listStmt = db.prepare<[string], { key: string; value: string }>(
    'SELECT key, value FROM shared_state WHERE key LIKE ?',
  )
  const likePattern = `${STATUS_KEY_PREFIX}%`

  function read(key: string): SelfIssueRecord | null {
    const row = getStmt.get(statusKey(key))
    if (!row) return null
    try {
      return JSON.parse(row.value) as SelfIssueRecord
    } catch {
      return null
    }
  }

  function write(key: string, record: SelfIssueRecord): void {
    upsertStmt.run(statusKey(key), JSON.stringify(record))
  }

  function readAttempts(key: string): number {
    const row = getStmt.get(attemptsKey(key))
    if (!row) return 0
    const parsed = Number.parseInt(row.value, 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
  }

  function eachRecord(fn: (signalKey: string, record: SelfIssueRecord) => void): void {
    for (const row of listStmt.all(likePattern)) {
      let record: SelfIssueRecord
      try {
        record = JSON.parse(row.value) as SelfIssueRecord
      } catch {
        continue
      }
      fn(signalKeyFromStatusKey(row.key), record)
    }
  }

  return {
    isActive(key: string): boolean {
      return read(key) !== null
    },

    status(key: string): SelfIssueStatus | null {
      return read(key)?.status ?? null
    },

    markInProgress(key: string, teamId: string, atMs?: number): void {
      upsertStmt.run(attemptsKey(key), String(readAttempts(key) + 1))
      write(key, {
        status: 'in-progress',
        teamId,
        updatedAt: new Date(atMs ?? Date.now()).toISOString(),
      })
    },

    markDone(key: string, atMs?: number): void {
      const existing = read(key)
      deleteStmt.run(attemptsKey(key))
      write(key, {
        status: 'done',
        teamId: existing?.teamId ?? null,
        updatedAt: new Date(atMs ?? Date.now()).toISOString(),
      })
    },

    markAbandoned(key: string, atMs?: number): void {
      // Attempts are NOT deleted (unlike markDone): the counter is the audit
      // trail of how many teams were burned before the cap terminated it.
      const existing = read(key)
      write(key, {
        status: 'abandoned',
        teamId: existing?.teamId ?? null,
        updatedAt: new Date(atMs ?? Date.now()).toISOString(),
      })
    },

    clear(key: string): void {
      deleteStmt.run(statusKey(key))
      deleteStmt.run(attemptsKey(key))
    },

    attempts(key: string): number {
      return readAttempts(key)
    },

    isExhausted(key: string, cap: number): boolean {
      if (cap <= 0) return false
      return readAttempts(key) >= cap
    },

    findInProgressByTeam(teamId: string): string | null {
      let found: string | null = null
      eachRecord((signalKey, record) => {
        if (found === null && record.status === 'in-progress' && record.teamId === teamId) {
          found = signalKey
        }
      })
      return found
    },

    findByTeam(teamId: string): string | null {
      let found: string | null = null
      eachRecord((signalKey, record) => {
        if (found === null && record.teamId === teamId) {
          found = signalKey
        }
      })
      return found
    },

    sweepStale(ttlMs: number, nowMs?: number): number {
      const now = nowMs ?? Date.now()
      const stale: string[] = []
      eachRecord((signalKey, record) => {
        if (record.status !== 'in-progress') return
        const updated = Date.parse(record.updatedAt)
        if (Number.isFinite(updated) && now - updated >= ttlMs) stale.push(signalKey)
      })
      for (const signalKey of stale) deleteStmt.run(statusKey(signalKey))
      return stale.length
    },
  }
}
