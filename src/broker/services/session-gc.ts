/**
 * Session GC — garbage-collects archived sessions past their TTL.
 *
 * Sessions are first purged to history tables (tier 1), then history records
 * can be expired separately (tier 2).
 */

import type Database from 'better-sqlite3'
import type { Event } from '../types.js'
import { findArchivedSessionsOlderThan } from '../storage/repositories/session-repository.js'
import { terminateSession } from './session-retirement.js'

// ── Minimal EventLog interface (subset needed by GC) ─────────

export interface EventLog {
  sessionPurged(sessionId: string | null, data: Record<string, unknown>): Event
}

// ── Result type ──────────────────────────────────────────────

export interface SessionGcResult {
  readonly sessions_purged: number
  readonly session_ids: ReadonlyArray<string>
  /**
   * Issue #70: sessions whose physical delete was deferred because live
   * unread directed mail they sent still needs their identity row. They are
   * retried on later GC passes once that mail settles.
   */
  readonly sessions_deferred: number
}

// ── Public API ───────────────────────────────────────────────

export function gcArchivedSessions(
  db: Database.Database,
  eventLog: EventLog,
  ttlSeconds: number = 86400,
): SessionGcResult {
  const archivedSessions = findArchivedSessionsOlderThan(db, ttlSeconds)

  const purgedSessionIds: string[] = []
  let deferred = 0

  for (const session of archivedSessions) {
    // Issue #70: TTL expiry is the explicit settlement decision — the
    // session's own correspondence archives to history. Unread directed
    // mail it sent to live participants stays live (their inbox), keeping
    // this identity row until that mail settles.
    const result = terminateSession(db, session.id)

    if (result.deferred) {
      deferred += 1
      continue
    }

    eventLog.sessionPurged(null, {
      session_id: session.id,
      session_purpose: session.purpose,
      gc_source: 'session_gc',
      ttl_seconds: ttlSeconds,
      archived_to_history: result.purged,
      messages_archived: result.messages_archived,
    })

    purgedSessionIds.push(session.id)
  }

  return {
    sessions_purged: purgedSessionIds.length,
    session_ids: purgedSessionIds,
    sessions_deferred: deferred,
  }
}
