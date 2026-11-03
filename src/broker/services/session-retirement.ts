/**
 * Session retirement — issue #70.
 *
 * Execution liveness, participant identity, and message retention are
 * separate concerns. This service is the single place cleanup paths go
 * through so they all preserve the same invariant:
 *
 *   - No cleanup path removes messages from another live participant's
 *     inbox, and no sessions row is physically deleted while live directed
 *     mail still references it (the messages FKs are ON DELETE SET NULL, and
 *     a NULL receiver reads as broadcast — deleting a referenced row either
 *     destroys provenance or leaks private mail to every inbox).
 *
 * Two operations:
 *   - `expireSessionLease` — liveness lapsed (heartbeat past grace, broker
 *     restart). Transient execution resources are released; the sessions row
 *     survives as 'expired' (archived, non-routable, revivable) and messages
 *     are untouched.
 *   - `terminateSession` — the participant will not return (agent process
 *     exited, TTL GC). Settleable correspondence is archived to
 *     messages_history; if unsettled directed mail to other participants
 *     remains, the row is kept (archived) and termination is deferred until
 *     the mail settles — it is retried on later GC passes (the session GC
 *     runs from the heartbeat poller tick).
 *
 * Deliberate policy decisions (settled with the maintainer, 2026-09-17):
 *   - A terminated sender's BROADCASTS settle to history regardless of read
 *     state. Per-recipient broadcast delivery is not modeled (one row cannot
 *     carry it), so retaining unread broadcasts would retain them forever;
 *     history keeps them queryable. Only directed mail carries the
 *     stay-live-until-read/disposed guarantee.
 *   - An explicit 'deferred' disposition COUNTS AS SETTLED for retention:
 *     the acknowledgement cycle completed, and the verdict (with its note)
 *     survives in messages_history. Blocking settlement on 'deferred' would
 *     keep a dead sender's identity row alive indefinitely.
 */

import type Database from 'better-sqlite3'
import { expireSession, findSessionById } from '../storage/repositories/session-repository.js'
import {
  archiveMessages,
  countRetainedMessagesForSession,
  findSettleableMessageIds,
} from '../storage/repositories/message-repository.js'
import { releaseIntentsBySession } from '../storage/repositories/intent-repository.js'
import { deleteStateBySession } from '../storage/repositories/state-repository.js'
import { deleteHandoffsBySession } from '../storage/repositories/quality-repository.js'

export interface ExpireLeaseResult {
  readonly expired: boolean
  readonly intents_released: number
  readonly state_deleted: number
  readonly handoffs_deleted: number
  readonly messages_preserved: number
}

export interface TerminateSessionResult {
  /** True when the sessions row was physically removed (purged to history). */
  readonly purged: boolean
  /** True when unsettled directed mail kept the identity row alive. */
  readonly deferred: boolean
  readonly messages_archived: number
  readonly messages_retained: number
}

function countMessagesTouching(db: Database.Database, sessionId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS cnt FROM messages WHERE sender_id = ? OR receiver_id = ?')
    .get(sessionId, sessionId) as { cnt: number }
  return row.cnt
}

/**
 * Retire a session's execution lease. Messages and the identity row survive;
 * only transient execution resources (intents, shared state, handoffs) are
 * released. Safe to call for a session that is already expired or missing.
 */
export function expireSessionLease(db: Database.Database, sessionId: string): ExpireLeaseResult {
  const intentsReleased = releaseIntentsBySession(db, sessionId)
  const stateDeleted = deleteStateBySession(db, sessionId)
  const handoffsDeleted = deleteHandoffsBySession(db, sessionId)
  const expired = expireSession(db, sessionId)

  return {
    expired,
    intents_released: intentsReleased,
    state_deleted: stateDeleted,
    handoffs_deleted: handoffsDeleted,
    messages_preserved: countMessagesTouching(db, sessionId),
  }
}

/**
 * Terminate a session that will not return. Settleable messages (its inbox,
 * read/disposed correspondence, broadcasts it sent) are archived to
 * messages_history. If directed mail to other participants is still
 * unsettled, the sessions row is retained (archived, status 'expired') so
 * the mail keeps its sender identity — the caller should retry on a later
 * pass once the recipient reads/disposes it or is itself terminated.
 */
export function terminateSession(db: Database.Database, sessionId: string): TerminateSessionResult {
  const session = findSessionById(db, sessionId)
  if (!session) {
    return { purged: false, deferred: false, messages_archived: 0, messages_retained: 0 }
  }

  releaseIntentsBySession(db, sessionId)
  deleteStateBySession(db, sessionId)
  deleteHandoffsBySession(db, sessionId)

  const run = db.transaction((): TerminateSessionResult => {
    const settleable = findSettleableMessageIds(db, sessionId)
    const archived = archiveMessages(db, settleable)
    const retained = countRetainedMessagesForSession(db, sessionId)

    if (retained > 0) {
      // Identity must outlive the correspondence that references it.
      db.prepare(
        `UPDATE sessions SET status = 'expired', archived_at = COALESCE(archived_at, datetime('now'))
         WHERE id = ?`,
      ).run(sessionId)
      return {
        purged: false,
        deferred: true,
        messages_archived: archived,
        messages_retained: retained,
      }
    }

    const teamInfo = db
      .prepare(
        `SELECT t.name FROM teams t
         JOIN team_members tm ON t.id = tm.team_id
         WHERE tm.session_id = ? LIMIT 1`,
      )
      .get(sessionId) as { name: string } | undefined

    db.prepare(
      `INSERT INTO sessions_history (id, purpose, working_dir, worktree, status, last_heartbeat, created_at, archived_at, team_name)
       VALUES (@id, @purpose, @working_dir, @worktree, @status, @last_heartbeat, @created_at, @archived_at, @team_name)`,
    ).run({
      id: session.id,
      purpose: session.purpose,
      working_dir: session.working_dir,
      worktree: session.worktree ?? null,
      status: session.status,
      last_heartbeat: session.last_heartbeat ?? null,
      created_at: session.created_at ?? null,
      archived_at: (session as { archived_at?: string | null }).archived_at ?? null,
      team_name: teamInfo?.name ?? null,
    })

    db.prepare('DELETE FROM file_intents WHERE session_id = ?').run(sessionId)
    db.prepare('DELETE FROM shared_state WHERE session_id = ?').run(sessionId)
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId)

    return { purged: true, deferred: false, messages_archived: archived, messages_retained: 0 }
  })

  return run()
}
