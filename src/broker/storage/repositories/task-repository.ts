import type Database from 'better-sqlite3'
import type { Task, TaskWithDeps } from '../../types.js'

interface CreateTaskInput {
  readonly team_id: string
  readonly subject: string
  readonly description?: string | null
  readonly active_form?: string | null
}

export function createTask(db: Database.Database, input: CreateTaskInput): Task {
  const seqRow = db
    .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM tasks WHERE team_id = ?')
    .get(input.team_id) as { next_seq: number }

  const result = db
    .prepare(
      `INSERT INTO tasks (team_id, seq, subject, description, active_form)
     VALUES (@team_id, @seq, @subject, @description, @active_form)`,
    )
    .run({
      team_id: input.team_id,
      seq: seqRow.next_seq,
      subject: input.subject,
      description: input.description ?? null,
      active_form: input.active_form ?? null,
    })

  return findTaskById(db, Number(result.lastInsertRowid))!
}

export function findTaskById(db: Database.Database, id: number): Task | null {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined
  return row ? { ...row } : null
}

export function findTaskWithDeps(db: Database.Database, id: number): TaskWithDeps | null {
  const task = findTaskById(db, id)
  if (!task) return null

  const blockedBy = findBlockedBy(db, id)
  const blocks = findBlocks(db, id)

  return { ...task, blocked_by: blockedBy, blocks }
}

export function findTasksByTeam(
  db: Database.Database,
  teamId: string,
  status?: string,
): ReadonlyArray<Task> {
  if (status) {
    const rows = db
      .prepare('SELECT * FROM tasks WHERE team_id = ? AND status = ? ORDER BY id')
      .all(teamId, status) as Task[]
    return rows.map((row) => ({ ...row }))
  }
  const rows = db
    .prepare("SELECT * FROM tasks WHERE team_id = ? AND status != 'deleted' ORDER BY id")
    .all(teamId) as Task[]
  return rows.map((row) => ({ ...row }))
}

interface UpdateTaskInput {
  readonly status?: string
  readonly owner?: string | null
  readonly subject?: string
  readonly description?: string | null
  readonly active_form?: string | null
}

export function updateTask(
  db: Database.Database,
  id: number,
  updates: UpdateTaskInput,
): Task | null {
  const fields: string[] = []
  const values: unknown[] = []

  if (updates.status !== undefined) {
    fields.push('status = ?')
    values.push(updates.status)
  }
  if (updates.owner !== undefined) {
    fields.push('owner = ?')
    values.push(updates.owner)
  }
  if (updates.subject !== undefined) {
    fields.push('subject = ?')
    values.push(updates.subject)
  }
  if (updates.description !== undefined) {
    fields.push('description = ?')
    values.push(updates.description)
  }
  if (updates.active_form !== undefined) {
    fields.push('active_form = ?')
    values.push(updates.active_form)
  }

  if (fields.length === 0) return findTaskById(db, id)

  fields.push("updated_at = datetime('now')")
  values.push(id)

  db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values)

  return findTaskById(db, id)
}

export function deleteTask(db: Database.Database, id: number): boolean {
  const result = db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
  return result.changes > 0
}

export function addDependency(db: Database.Database, taskId: number, dependsOn: number): void {
  db.prepare(
    `INSERT OR IGNORE INTO task_dependencies (task_id, depends_on)
     VALUES (?, ?)`,
  ).run(taskId, dependsOn)
}

export function removeDependency(db: Database.Database, taskId: number, dependsOn: number): void {
  db.prepare('DELETE FROM task_dependencies WHERE task_id = ? AND depends_on = ?').run(
    taskId,
    dependsOn,
  )
}

export function findBlockedBy(db: Database.Database, taskId: number): ReadonlyArray<number> {
  const rows = db
    .prepare(
      `SELECT depends_on FROM task_dependencies
     WHERE task_id = ?
     AND depends_on IN (SELECT id FROM tasks WHERE status != 'completed' AND status != 'deleted')`,
    )
    .all(taskId) as Array<{ depends_on: number }>
  return rows.map((row) => row.depends_on)
}

export function findBlocks(db: Database.Database, taskId: number): ReadonlyArray<number> {
  const rows = db
    .prepare('SELECT task_id FROM task_dependencies WHERE depends_on = ?')
    .all(taskId) as Array<{ task_id: number }>
  return rows.map((row) => row.task_id)
}

export function deleteTasksByTeam(db: Database.Database, teamId: string): number {
  const result = db.prepare('DELETE FROM tasks WHERE team_id = ?').run(teamId)
  return result.changes
}

export function deleteAllTasks(db: Database.Database): number {
  const result = db.prepare('DELETE FROM tasks').run()
  return result.changes
}

export function countTasksByStatus(db: Database.Database, status: string): number {
  const row = db.prepare('SELECT COUNT(*) as count FROM tasks WHERE status = ?').get(status) as {
    count: number
  }
  return row.count
}

export function countPendingTasksByTeam(db: Database.Database, teamId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) as count FROM tasks WHERE team_id = ? AND status = 'pending'")
    .get(teamId) as { count: number }
  return row.count
}

/**
 * WS P (Phase 13.13.x) — durable dispatch audit on the tasks row.
 *
 * markDispatched stamps the five `dispatch_*` columns in a single
 * synchronous UPDATE. The task row is the audit trail that survives
 * messages + messages_history purging, so manager-exit-monitor can
 * short-circuit no_readback false-positives without depending on
 * still-resident message rows.
 *
 * Idempotency: the WHERE clause filters on `dispatch_id IS NULL`, so the
 * first call wins. Subsequent calls return `stamped:false` with the
 * existing dispatch_id surfaced for caller-side warning logs (no error).
 */
export interface MarkDispatchedInput {
  readonly taskId: number
  readonly dispatchId: string
  readonly readbackAt: string
  readonly managerSessionId: string
  readonly devSessionId: string
  readonly qaSessionId: string
}

export interface MarkDispatchedResult {
  readonly stamped: boolean
  readonly existingDispatchId: string | null
}

export function markDispatched(
  db: Database.Database,
  input: MarkDispatchedInput,
): MarkDispatchedResult {
  const result = db
    .prepare(
      `UPDATE tasks
         SET dispatch_id = ?,
             dispatch_readback_at = ?,
             dispatch_manager_session_id = ?,
             dispatch_dev_session_id = ?,
             dispatch_qa_session_id = ?,
             updated_at = datetime('now')
       WHERE id = ? AND dispatch_id IS NULL`,
    )
    .run(
      input.dispatchId,
      input.readbackAt,
      input.managerSessionId,
      input.devSessionId,
      input.qaSessionId,
      input.taskId,
    )

  if (result.changes > 0) {
    return { stamped: true, existingDispatchId: null }
  }

  const row = db
    .prepare('SELECT dispatch_id AS dispatchId FROM tasks WHERE id = ?')
    .get(input.taskId) as { dispatchId: string | null } | undefined
  return { stamped: false, existingDispatchId: row?.dispatchId ?? null }
}

export interface DispatchInfo {
  readonly dispatchId: string
  readonly dispatchReadbackAt: string
  readonly dispatchManagerSessionId: string | null
  readonly dispatchDevSessionId: string | null
  readonly dispatchQaSessionId: string | null
}

export function getDispatchInfo(db: Database.Database, taskId: number): DispatchInfo | null {
  const row = db
    .prepare(
      `SELECT dispatch_id           AS dispatchId,
              dispatch_readback_at  AS dispatchReadbackAt,
              dispatch_manager_session_id AS dispatchManagerSessionId,
              dispatch_dev_session_id     AS dispatchDevSessionId,
              dispatch_qa_session_id      AS dispatchQaSessionId
         FROM tasks
        WHERE id = ?`,
    )
    .get(taskId) as
    | {
        dispatchId: string | null
        dispatchReadbackAt: string | null
        dispatchManagerSessionId: string | null
        dispatchDevSessionId: string | null
        dispatchQaSessionId: string | null
      }
    | undefined
  if (!row || !row.dispatchId || !row.dispatchReadbackAt) return null
  return {
    dispatchId: row.dispatchId,
    dispatchReadbackAt: row.dispatchReadbackAt,
    dispatchManagerSessionId: row.dispatchManagerSessionId,
    dispatchDevSessionId: row.dispatchDevSessionId,
    dispatchQaSessionId: row.dispatchQaSessionId,
  }
}

/**
 * Lookup used by manager-exit-monitor: returns the readback metadata for the
 * most recently stamped task on this team whose `dispatch_manager_session_id`
 * matches the exiting manager. Manager-session correlation prevents a stale
 * stamped row from masking a no_readback for a different manager on the
 * same team. Returns null when no stamped row matches.
 */
export interface DispatchByManagerExitRow {
  readonly readbackAt: string
  readonly devSessionId: string | null
  readonly qaSessionId: string | null
}

export function findDispatchForManagerExit(
  db: Database.Database,
  teamId: string,
  managerSessionId: string,
): DispatchByManagerExitRow | null {
  const row = db
    .prepare(
      `SELECT dispatch_readback_at  AS readbackAt,
              dispatch_dev_session_id AS devSessionId,
              dispatch_qa_session_id  AS qaSessionId
         FROM tasks
        WHERE team_id = ?
          AND dispatch_manager_session_id = ?
          AND dispatch_readback_at IS NOT NULL
        ORDER BY dispatch_readback_at DESC
        LIMIT 1`,
    )
    .get(teamId, managerSessionId) as
    | { readbackAt: string; devSessionId: string | null; qaSessionId: string | null }
    | undefined
  return row ?? null
}
