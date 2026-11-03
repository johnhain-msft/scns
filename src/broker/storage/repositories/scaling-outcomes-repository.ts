/**
 * Phase 13.12.13 — Scaling outcomes + decisions repository.
 *
 * `scaling_outcomes` records how each spawned shape fared for a given
 * task signature; `scaling_decisions` logs the policy's choice for audit.
 */

import type Database from 'better-sqlite3'
import type { ScalingOutcome, TaskShape } from '../../../brain/scaling-policy.js'
import { toSqliteDateTime } from '../sqlite-time.js'

// ── Types ────────────────────────────────────────────────────────────

export interface ScalingOutcomeRow extends ScalingOutcome {
  readonly id: number
  readonly source_suggestion_id: string | null
  readonly team_id: string | null
}

export interface RecordOutcomeInput {
  readonly task_signature: string
  readonly spawned_as: TaskShape
  readonly success: boolean
  readonly duration_ms?: number | null
  readonly quality_score?: number | null
  readonly source_suggestion_id?: string | null
  readonly team_id?: string | null
}

export interface ScalingDecisionRow {
  readonly id: number
  readonly task_signature: string
  readonly task_snippet: string
  readonly hint_shape: TaskShape
  readonly chosen_shape: TaskShape
  readonly roles_json: string
  readonly reasoning: string
  readonly history_count: number
  readonly source_suggestion_id: string | null
  readonly created_at: string
}

export interface RecordDecisionInput {
  readonly task_signature: string
  readonly task_snippet: string
  readonly hint_shape: TaskShape
  readonly chosen_shape: TaskShape
  readonly roles: readonly string[]
  readonly reasoning: string
  readonly history_count: number
  readonly source_suggestion_id?: string | null
}

// ── Outcomes ─────────────────────────────────────────────────────────

/**
 * Insert an outcome row. Idempotent when source_suggestion_id is present —
 * a second call with the same (source_suggestion_id, spawned_as) is a no-op
 * so wake loops and async completion hooks can't double-count.
 */
export function recordScalingOutcome(
  db: Database.Database,
  input: RecordOutcomeInput,
): ScalingOutcomeRow | null {
  const info = db
    .prepare(
      `INSERT INTO scaling_outcomes
         (task_signature, spawned_as, success, duration_ms, quality_score, source_suggestion_id, team_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source_suggestion_id, spawned_as) DO NOTHING`,
    )
    .run(
      input.task_signature,
      input.spawned_as,
      input.success ? 1 : 0,
      input.duration_ms ?? null,
      input.quality_score ?? null,
      input.source_suggestion_id ?? null,
      input.team_id ?? null,
    )

  if (info.changes === 0) {
    // Already recorded for this (suggestion, shape) — return existing row.
    if (input.source_suggestion_id) {
      const row = db
        .prepare('SELECT * FROM scaling_outcomes WHERE source_suggestion_id = ? AND spawned_as = ?')
        .get(input.source_suggestion_id, input.spawned_as) as ScalingOutcomeRow | undefined
      return row ? { ...row } : null
    }
    return null
  }

  const row = db
    .prepare('SELECT * FROM scaling_outcomes WHERE id = ?')
    .get(info.lastInsertRowid) as ScalingOutcomeRow | undefined
  return row ? { ...row } : null
}

export function findOutcomesBySignature(
  db: Database.Database,
  signature: string,
  limit = 50,
): ReadonlyArray<ScalingOutcomeRow> {
  const rows = db
    .prepare(
      `SELECT * FROM scaling_outcomes
       WHERE task_signature = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(signature, limit) as ScalingOutcomeRow[]
  return rows.map((r) => ({ ...r }))
}

// ── Decisions ────────────────────────────────────────────────────────

export function recordScalingDecision(
  db: Database.Database,
  input: RecordDecisionInput,
): ScalingDecisionRow {
  const info = db
    .prepare(
      `INSERT INTO scaling_decisions
         (task_signature, task_snippet, hint_shape, chosen_shape, roles_json,
          reasoning, history_count, source_suggestion_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.task_signature,
      input.task_snippet.slice(0, 500),
      input.hint_shape,
      input.chosen_shape,
      JSON.stringify(input.roles),
      input.reasoning,
      input.history_count,
      input.source_suggestion_id ?? null,
    )

  const row = db
    .prepare('SELECT * FROM scaling_decisions WHERE id = ?')
    .get(info.lastInsertRowid) as ScalingDecisionRow
  return { ...row }
}

export interface ScalingDecisionWithOutcome extends ScalingDecisionRow {
  readonly outcome_success: number | null
  readonly outcome_quality: number | null
}

/**
 * Recent decisions joined with their matching outcome (by source_suggestion_id
 * + chosen shape) so the dashboard can show whether the policy's call panned out.
 */
export function findRecentScalingDecisions(
  db: Database.Database,
  limit = 20,
  since?: string,
): ReadonlyArray<ScalingDecisionWithOutcome> {
  if (since) {
    const rows = db
      .prepare(
        `SELECT d.*, o.success AS outcome_success, o.quality_score AS outcome_quality
         FROM scaling_decisions d
         LEFT JOIN scaling_outcomes o
           ON o.source_suggestion_id = d.source_suggestion_id
          AND o.spawned_as = d.chosen_shape
         WHERE d.created_at >= ?
         ORDER BY d.created_at DESC
         LIMIT ?`,
      )
      .all(toSqliteDateTime(since), limit) as ScalingDecisionWithOutcome[]
    return rows.map((r) => ({ ...r }))
  }
  const rows = db
    .prepare(
      `SELECT d.*, o.success AS outcome_success, o.quality_score AS outcome_quality
       FROM scaling_decisions d
       LEFT JOIN scaling_outcomes o
         ON o.source_suggestion_id = d.source_suggestion_id
        AND o.spawned_as = d.chosen_shape
       ORDER BY d.created_at DESC
       LIMIT ?`,
    )
    .all(limit) as ScalingDecisionWithOutcome[]
  return rows.map((r) => ({ ...r }))
}
