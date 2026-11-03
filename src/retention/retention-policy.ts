/**
 * P5c — retention kill-switch helper.
 *
 * Operator-grade circuit breakers that can be flipped LIVE via
 * `shared_state` without a code deploy or broker restart. Pattern
 * modelled on `broker:self_heal_disabled` (src/broker/services/self-heal.ts).
 *
 * Keys (read-only — this module never writes shared_state):
 *   - `broker:retention_disabled`           — master kill (covers all tasks)
 *   - `broker:retention_telemetry_disabled` — disable only telemetry rotation+prune
 *   - `broker:retention_otel_disabled`      — disable only otel-cleanup housekeeping
 *
 * Any of `'1'`, `'true'`, `'yes'`, `'on'` (case-insensitive) means
 * disabled. Empty string or any other value means enabled.
 *
 * Read failures (missing table, locked DB, malformed row) deliberately
 * return ENABLED — a transient infrastructure issue must NEVER silently
 * shut off retention and let disk grow unbounded.
 */

import type Database from 'better-sqlite3'

export type RetentionTaskKey = 'telemetry' | 'otel' | (string & {})

const TRUTHY = new Set(['1', 'true', 'yes', 'on'])

function readSwitch(db: Database.Database, key: string): boolean {
  try {
    const row = db.prepare('SELECT value FROM shared_state WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    if (!row || typeof row.value !== 'string') return false
    return TRUTHY.has(row.value.toLowerCase())
  } catch {
    return false
  }
}

export function isRetentionDisabled(db: Database.Database, task: RetentionTaskKey): boolean {
  if (readSwitch(db, 'broker:retention_disabled')) return true
  if (task === 'telemetry' && readSwitch(db, 'broker:retention_telemetry_disabled')) return true
  if (task === 'otel' && readSwitch(db, 'broker:retention_otel_disabled')) return true
  return false
}
