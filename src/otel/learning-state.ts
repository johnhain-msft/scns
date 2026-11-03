/**
 * Learning state — tracks what sessions have been processed by the learning pipeline.
 *
 * Uses a simple key-value table in the OTel database to persist cursor
 * position and aggregate counts between pipeline runs.
 */

import type Database from 'better-sqlite3'

// ── Types ────────────────────────────────────────────────────

export interface LearningState {
  readonly lastProcessedAt: string | null
  readonly totalSessionsProcessed: number
  readonly totalPatternsExtracted: number
  readonly latestPatternsJson: string | null
}

// ── Schema ───────────────────────────────────────────────────

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS learning_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`

/** Ensure the learning_state table exists (idempotent). */
export function ensureLearningStateTable(db: Database.Database): void {
  db.exec(CREATE_TABLE_SQL)
}

// ── State keys ───────────────────────────────────────────────

const KEY_LAST_PROCESSED_AT = 'lastProcessedAt'
const KEY_TOTAL_SESSIONS = 'totalSessionsProcessed'
const KEY_TOTAL_PATTERNS = 'totalPatternsExtracted'
const KEY_LATEST_PATTERNS = 'latestPatternsJson'

// ── Load / Save ──────────────────────────────────────────────

interface StateRow {
  readonly key: string
  readonly value: string
}

/** Load current learning state from the database. */
export function loadLearningState(db: Database.Database): LearningState {
  const rows = db.prepare('SELECT key, value FROM learning_state').all() as StateRow[]

  const map = new Map(rows.map((r) => [r.key, r.value]))

  return {
    lastProcessedAt: map.get(KEY_LAST_PROCESSED_AT) ?? null,
    totalSessionsProcessed: parseInt(map.get(KEY_TOTAL_SESSIONS) ?? '0', 10),
    totalPatternsExtracted: parseInt(map.get(KEY_TOTAL_PATTERNS) ?? '0', 10),
    latestPatternsJson: map.get(KEY_LATEST_PATTERNS) ?? null,
  }
}

/** Persist learning state to the database. */
export function saveLearningState(db: Database.Database, state: LearningState): void {
  const upsert = db.prepare(`
    INSERT INTO learning_state (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `)

  const tx = db.transaction(() => {
    if (state.lastProcessedAt !== null) {
      upsert.run(KEY_LAST_PROCESSED_AT, state.lastProcessedAt)
    }
    upsert.run(KEY_TOTAL_SESSIONS, String(state.totalSessionsProcessed))
    upsert.run(KEY_TOTAL_PATTERNS, String(state.totalPatternsExtracted))
    if (state.latestPatternsJson !== null) {
      upsert.run(KEY_LATEST_PATTERNS, state.latestPatternsJson)
    }
  })

  tx()
}
