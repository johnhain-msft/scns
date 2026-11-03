/**
 * Consolidation scheduler — tracks when weekly/monthly consolidation should run.
 *
 * Uses SQLite for state persistence (shares the dream DB).
 */

import type Database from 'better-sqlite3'

// ── Types ──────────────────────────────────────────────────────────

export interface ConsolidationSchedule {
  readonly lastWeeklyAt: string | null
  readonly lastMonthlyAt: string | null
}

// ── Schema init ────────────────────────────────────────────────────

export function initConsolidationState(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS consolidation_schedule (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_weekly_at TEXT,
      last_monthly_at TEXT
    );
    INSERT OR IGNORE INTO consolidation_schedule (id) VALUES (1);
  `)
}

// ── Factory ────────────────────────────────────────────────────────

const WEEKLY_INTERVAL_DAYS = 7
const MONTHLY_INTERVAL_DAYS = 30

export function createConsolidationScheduler(db: Database.Database) {
  function getRow(): { last_weekly_at: string | null; last_monthly_at: string | null } {
    return db.prepare('SELECT last_weekly_at, last_monthly_at FROM consolidation_schedule WHERE id = 1').get() as {
      last_weekly_at: string | null
      last_monthly_at: string | null
    }
  }

  function shouldRunWeekly(): boolean {
    const row = getRow()
    if (!row.last_weekly_at) return true

    const result = db
      .prepare(
        `SELECT CASE
           WHEN (julianday('now') - julianday(?)) >= ? THEN 1
           ELSE 0
         END AS due`,
      )
      .get(row.last_weekly_at, WEEKLY_INTERVAL_DAYS) as { due: number }

    return result.due === 1
  }

  function shouldRunMonthly(): boolean {
    const row = getRow()
    if (!row.last_monthly_at) return true

    const result = db
      .prepare(
        `SELECT CASE
           WHEN (julianday('now') - julianday(?)) >= ? THEN 1
           ELSE 0
         END AS due`,
      )
      .get(row.last_monthly_at, MONTHLY_INTERVAL_DAYS) as { due: number }

    return result.due === 1
  }

  function recordWeeklyRun(): void {
    db.prepare("UPDATE consolidation_schedule SET last_weekly_at = datetime('now') WHERE id = 1").run()
  }

  function recordMonthlyRun(): void {
    db.prepare("UPDATE consolidation_schedule SET last_monthly_at = datetime('now') WHERE id = 1").run()
  }

  function getSchedule(): ConsolidationSchedule {
    const row = getRow()
    return {
      lastWeeklyAt: row.last_weekly_at,
      lastMonthlyAt: row.last_monthly_at,
    }
  }

  return { shouldRunWeekly, shouldRunMonthly, recordWeeklyRun, recordMonthlyRun, getSchedule }
}
