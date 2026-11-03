import type Database from 'better-sqlite3'

export interface DreamState {
  readonly last_run_at: string | null
  readonly sessions_since_last_run: number
  readonly total_runs: number
  readonly last_run_duration_ms: number | null
  readonly last_run_entries_processed: number | null
  readonly lock_holder: string | null
  readonly locked_at: string | null
}

export interface DreamRunResult {
  readonly durationMs: number
  readonly entriesProcessed: number
}

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS dream_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_run_at TEXT,
  sessions_since_last_run INTEGER NOT NULL DEFAULT 0,
  total_runs INTEGER NOT NULL DEFAULT 0,
  last_run_duration_ms INTEGER,
  last_run_entries_processed INTEGER,
  lock_holder TEXT,
  locked_at TEXT
)`

const SEED_SQL = `INSERT OR IGNORE INTO dream_state (id) VALUES (1)`

export function initDreamState(db: Database.Database): void {
  db.exec(CREATE_TABLE_SQL)
  db.prepare(SEED_SQL).run()
}

export function getDreamState(db: Database.Database): DreamState | null {
  const row = db.prepare('SELECT * FROM dream_state WHERE id = 1').get() as DreamState | undefined
  return row ?? null
}

export function recordDreamRun(db: Database.Database, result: DreamRunResult): void {
  db.prepare(
    `UPDATE dream_state
     SET last_run_at = datetime('now'),
         sessions_since_last_run = 0,
         total_runs = total_runs + 1,
         last_run_duration_ms = @durationMs,
         last_run_entries_processed = @entriesProcessed
     WHERE id = 1`,
  ).run({ durationMs: result.durationMs, entriesProcessed: result.entriesProcessed })
}

export function incrementSessionCount(db: Database.Database): void {
  db.prepare(
    `UPDATE dream_state SET sessions_since_last_run = sessions_since_last_run + 1 WHERE id = 1`,
  ).run()
}

export function acquireDreamLock(db: Database.Database, holder: string): boolean {
  const result = db
    .prepare(
      `UPDATE dream_state
     SET lock_holder = @holder, locked_at = datetime('now')
     WHERE id = 1 AND lock_holder IS NULL`,
    )
    .run({ holder })

  return result.changes > 0
}

export function releaseDreamLock(db: Database.Database, holder: string): boolean {
  const result = db
    .prepare(
      `UPDATE dream_state
     SET lock_holder = NULL, locked_at = NULL
     WHERE id = 1 AND lock_holder = @holder`,
    )
    .run({ holder })

  return result.changes > 0
}

export function breakStaleDreamLock(db: Database.Database, maxAgeMs: number): boolean {
  const result = db
    .prepare(
      `UPDATE dream_state
     SET lock_holder = NULL, locked_at = NULL
     WHERE id = 1
       AND lock_holder IS NOT NULL
       AND locked_at IS NOT NULL
       AND (julianday('now') - julianday(locked_at)) * 86400000 >= @maxAgeMs`,
    )
    .run({ maxAgeMs })

  return result.changes > 0
}
