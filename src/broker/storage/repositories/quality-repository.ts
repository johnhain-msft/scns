/**
 * Quality check and session handoff DB operations.
 * CRUD for quality_checks and session_handoffs tables.
 */

import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { QualityCheck, SessionHandoff } from '../../types.js'

// ── Quality Checks ────────────────────────────────────────────────────

interface CreateQualityCheckInput {
  readonly session_id?: string | null
  readonly task_type?: string
  readonly output: string
  readonly passed: boolean
  readonly score: number
  readonly findings: readonly string[]
}

export function createQualityCheck(
  db: Database.Database,
  input: CreateQualityCheckInput,
): QualityCheck {
  const id = randomUUID()
  db.prepare(
    `INSERT INTO quality_checks (id, session_id, task_type, output, passed, score, findings)
     VALUES (@id, @session_id, @task_type, @output, @passed, @score, @findings)`,
  ).run({
    id,
    session_id: input.session_id ?? null,
    task_type: input.task_type ?? 'implementation',
    output: input.output,
    passed: input.passed ? 1 : 0,
    score: input.score,
    findings: JSON.stringify(input.findings),
  })

  return findQualityCheckById(db, id)!
}

export function findQualityCheckById(
  db: Database.Database,
  id: string,
): QualityCheck | null {
  const row = db.prepare('SELECT * FROM quality_checks WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined
  if (!row) return null
  return {
    ...row,
    passed: row.passed === 1,
  } as unknown as QualityCheck
}

export function findQualityChecksBySession(
  db: Database.Database,
  sessionId: string,
): readonly QualityCheck[] {
  const rows = db
    .prepare('SELECT * FROM quality_checks WHERE session_id = ? ORDER BY created_at DESC')
    .all(sessionId) as Array<Record<string, unknown>>
  return rows.map((row) => ({ ...row, passed: row.passed === 1 }) as unknown as QualityCheck)
}

// ── Session Handoffs ──────────────────────────────────────────────────

interface CreateHandoffInput {
  readonly session_id: string
  readonly progress: string
  readonly files_modified?: readonly string[]
  readonly tests_status?: string | null
  readonly remaining_work?: string | null
  readonly context?: string | null
  readonly handoff_payload?: string | null
}

export function createHandoff(
  db: Database.Database,
  input: CreateHandoffInput,
): SessionHandoff {
  const id = randomUUID()
  db.prepare(
    `INSERT INTO session_handoffs (id, session_id, status, progress, files_modified, tests_status, remaining_work, context, handoff_payload)
     VALUES (@id, @session_id, 'ready', @progress, @files_modified, @tests_status, @remaining_work, @context, @handoff_payload)`,
  ).run({
    id,
    session_id: input.session_id,
    progress: input.progress,
    files_modified: JSON.stringify(input.files_modified ?? []),
    tests_status: input.tests_status ?? null,
    remaining_work: input.remaining_work ?? null,
    context: input.context ?? null,
    handoff_payload: input.handoff_payload ?? null,
  })

  return findHandoffById(db, id)!
}

export function findHandoffById(
  db: Database.Database,
  id: string,
): SessionHandoff | null {
  const row = db.prepare('SELECT * FROM session_handoffs WHERE id = ?').get(id) as
    | SessionHandoff
    | undefined
  return row ? { ...row } : null
}

export function findLatestHandoff(
  db: Database.Database,
  sessionId: string,
): SessionHandoff | null {
  const row = db
    .prepare(
      `SELECT * FROM session_handoffs
       WHERE session_id = ? AND status = 'ready'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(sessionId) as SessionHandoff | undefined
  return row ? { ...row } : null
}

export function findHandoffsBySession(
  db: Database.Database,
  sessionId: string,
): readonly SessionHandoff[] {
  const rows = db
    .prepare('SELECT * FROM session_handoffs WHERE session_id = ? ORDER BY created_at DESC')
    .all(sessionId) as SessionHandoff[]
  return rows.map((row) => ({ ...row }))
}

export function claimHandoff(
  db: Database.Database,
  id: string,
  claimedBy: string,
): boolean {
  const result = db
    .prepare(
      `UPDATE session_handoffs
       SET status = 'claimed', claimed_by = @claimed_by, claimed_at = datetime('now')
       WHERE id = @id AND status = 'ready'`,
    )
    .run({ id, claimed_by: claimedBy })
  return result.changes > 0
}

export function consumeHandoff(
  db: Database.Database,
  id: string,
  consumedBy: string,
): boolean {
  const result = db
    .prepare(
      `UPDATE session_handoffs
       SET status = 'consumed', claimed_by = @consumed_by, consumed_at = datetime('now')
       WHERE id = @id AND status IN ('ready', 'claimed')`,
    )
    .run({ id, consumed_by: consumedBy })
  return result.changes > 0
}

export function expireHandoffs(
  db: Database.Database,
  sessionId: string,
): number {
  const result = db
    .prepare(
      `UPDATE session_handoffs
       SET status = 'expired'
       WHERE session_id = ? AND status = 'ready'`,
    )
    .run(sessionId)
  return result.changes
}

/**
 * Hard-delete all handoffs for a session. Used by zombie cleanup so the
 * FK from session_handoffs.session_id → sessions.id does not block
 * session row deletion.
 */
export function deleteHandoffsBySession(
  db: Database.Database,
  sessionId: string,
): number {
  const result = db.prepare('DELETE FROM session_handoffs WHERE session_id = ?').run(sessionId)
  return result.changes
}

export function countUncheckedCompletedSessions(
  db: Database.Database,
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as cnt FROM sessions s
       WHERE s.status = 'completed'
       AND NOT EXISTS (
         SELECT 1 FROM quality_checks qc WHERE qc.session_id = s.id
       )`,
    )
    .get() as { cnt: number }
  return row.cnt
}

export function findUncheckedCompletedSessions(
  db: Database.Database,
): readonly string[] {
  const rows = db
    .prepare(
      `SELECT s.id FROM sessions s
       WHERE s.status = 'completed'
       AND NOT EXISTS (
         SELECT 1 FROM quality_checks qc WHERE qc.session_id = s.id
       )
       ORDER BY s.created_at ASC`,
    )
    .all() as Array<{ id: string }>
  return rows.map((r) => r.id)
}
