/**
 * P5c — retention kill-switch helper.
 *
 * Operator-grade circuit breakers stored in `shared_state` so they can be
 * flipped LIVE without a code deploy or broker restart:
 *
 *   - Master: `broker:retention_disabled`         — kills ALL retention sweeps
 *   - Per-task: `broker:retention_telemetry_disabled` — kills only telemetry rotation
 *   - Per-task: `broker:retention_otel_disabled`      — kills only otel-cleanup
 *
 * Pattern modelled on the proven `broker:self_heal_disabled` switch
 * (src/broker/services/self-heal.ts). Any truthy string (`'1'`, `'true'`,
 * `'yes'`) disables; empty string or absent key = enabled (default).
 *
 * Read-only — never writes shared_state. Failure to read (e.g. missing
 * table during test setup) returns enabled so a transient DB issue can
 * never inadvertently SHUT OFF retention and let disk grow unbounded.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { isRetentionDisabled } from '../../../src/retention/retention-policy.js'

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(`
    CREATE TABLE shared_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME NOT NULL DEFAULT (datetime('now'))
    );
  `)
})

afterEach(() => {
  db.close()
})

function setSwitch(key: string, value: string): void {
  db.prepare(
    "INSERT INTO shared_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(key, value)
}

describe('isRetentionDisabled', () => {
  it('defaults to enabled when no switch is set', () => {
    expect(isRetentionDisabled(db, 'telemetry')).toBe(false)
    expect(isRetentionDisabled(db, 'otel')).toBe(false)
  })

  it('master switch disables all task keys', () => {
    setSwitch('broker:retention_disabled', '1')
    expect(isRetentionDisabled(db, 'telemetry')).toBe(true)
    expect(isRetentionDisabled(db, 'otel')).toBe(true)
  })

  it('per-task telemetry switch disables only telemetry', () => {
    setSwitch('broker:retention_telemetry_disabled', '1')
    expect(isRetentionDisabled(db, 'telemetry')).toBe(true)
    expect(isRetentionDisabled(db, 'otel')).toBe(false)
  })

  it('per-task otel switch disables only otel', () => {
    setSwitch('broker:retention_otel_disabled', '1')
    expect(isRetentionDisabled(db, 'otel')).toBe(true)
    expect(isRetentionDisabled(db, 'telemetry')).toBe(false)
  })

  it('accepts common truthy strings (1, true, yes — case insensitive)', () => {
    for (const value of ['1', 'true', 'TRUE', 'yes', 'YES', 'on']) {
      setSwitch('broker:retention_disabled', value)
      expect(isRetentionDisabled(db, 'telemetry')).toBe(true)
    }
  })

  it('treats empty string and falsy values as enabled', () => {
    for (const value of ['', '0', 'false', 'no', 'off']) {
      setSwitch('broker:retention_disabled', value)
      expect(isRetentionDisabled(db, 'telemetry')).toBe(false)
    }
  })

  it('returns false (enabled) when shared_state table is missing', () => {
    // Drop the table to simulate a not-yet-migrated or broken DB.
    db.exec('DROP TABLE shared_state')
    // Critical: a missing table must NEVER silently disable retention.
    expect(isRetentionDisabled(db, 'telemetry')).toBe(false)
    expect(isRetentionDisabled(db, 'otel')).toBe(false)
  })

  it('master + per-task both work independently — master wins when set', () => {
    setSwitch('broker:retention_telemetry_disabled', '0') // per-task explicitly enabled
    setSwitch('broker:retention_disabled', '1') // master disables anyway
    expect(isRetentionDisabled(db, 'telemetry')).toBe(true)
  })

  it('unknown task key falls back to master only', () => {
    setSwitch('broker:retention_disabled', '1')
    expect(isRetentionDisabled(db, 'mystery')).toBe(true)
    setSwitch('broker:retention_disabled', '0')
    expect(isRetentionDisabled(db, 'mystery')).toBe(false)
  })
})
