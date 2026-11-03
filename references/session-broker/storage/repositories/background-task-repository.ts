import type Database from 'better-sqlite3'
import type { BackgroundTask } from '../../types.js'

interface BackgroundTaskRow {
  readonly task_name: string
  readonly last_run_at: string | null
  readonly run_count: number
  readonly lock_holder: string | null
  readonly locked_at: string | null
  readonly interval_ms: number
  readonly enabled: number
}

function rowToTask(row: BackgroundTaskRow): BackgroundTask {
  return {
    task_name: row.task_name,
    last_run_at: row.last_run_at,
    run_count: row.run_count,
    lock_holder: row.lock_holder,
    locked_at: row.locked_at,
    interval_ms: row.interval_ms,
    enabled: row.enabled === 1,
  }
}

export function getBackgroundTask(
  db: Database.Database,
  taskName: string,
): BackgroundTask | null {
  const row = db.prepare(
    'SELECT * FROM background_tasks WHERE task_name = ?',
  ).get(taskName) as BackgroundTaskRow | undefined
  return row ? rowToTask(row) : null
}

export function upsertBackgroundTask(
  db: Database.Database,
  taskName: string,
  intervalMs: number,
): BackgroundTask {
  db.prepare(
    `INSERT INTO background_tasks (task_name, interval_ms)
     VALUES (@task_name, @interval_ms)
     ON CONFLICT(task_name) DO UPDATE SET
       interval_ms = @interval_ms`,
  ).run({ task_name: taskName, interval_ms: intervalMs })

  return getBackgroundTask(db, taskName)!
}

export function acquireLock(
  db: Database.Database,
  taskName: string,
  lockHolder: string,
): boolean {
  const result = db.prepare(
    `UPDATE background_tasks
     SET lock_holder = @lock_holder, locked_at = datetime('now')
     WHERE task_name = @task_name
       AND lock_holder IS NULL`,
  ).run({ task_name: taskName, lock_holder: lockHolder })

  return result.changes > 0
}

export function releaseLock(
  db: Database.Database,
  taskName: string,
  lockHolder: string,
): boolean {
  const result = db.prepare(
    `UPDATE background_tasks
     SET lock_holder = NULL, locked_at = NULL
     WHERE task_name = @task_name
       AND lock_holder = @lock_holder`,
  ).run({ task_name: taskName, lock_holder: lockHolder })

  return result.changes > 0
}

export function recordRun(
  db: Database.Database,
  taskName: string,
): void {
  db.prepare(
    `UPDATE background_tasks
     SET last_run_at = datetime('now'),
         run_count = run_count + 1
     WHERE task_name = ?`,
  ).run(taskName)
}

export function isTimePassed(
  db: Database.Database,
  taskName: string,
): boolean {
  const row = db.prepare(
    `SELECT
       CASE
         WHEN last_run_at IS NULL THEN 1
         WHEN (julianday('now') - julianday(last_run_at)) * 86400000 >= interval_ms THEN 1
         ELSE 0
       END AS time_passed
     FROM background_tasks
     WHERE task_name = ?`,
  ).get(taskName) as { time_passed: number } | undefined

  return row ? row.time_passed === 1 : false
}

export function breakStaleLock(
  db: Database.Database,
  taskName: string,
  maxAgeMs: number,
): boolean {
  const result = db.prepare(
    `UPDATE background_tasks
     SET lock_holder = NULL, locked_at = NULL
     WHERE task_name = @task_name
       AND lock_holder IS NOT NULL
       AND locked_at IS NOT NULL
       AND (julianday('now') - julianday(locked_at)) * 86400000 >= @max_age_ms`,
  ).run({ task_name: taskName, max_age_ms: maxAgeMs })

  return result.changes > 0
}
