import type Database from 'better-sqlite3'
import type { Task, TaskWithDeps } from '../../types.js'

interface CreateTaskInput {
  readonly team_id: string
  readonly subject: string
  readonly description?: string | null
  readonly active_form?: string | null
}

export function createTask(db: Database.Database, input: CreateTaskInput): Task {
  const seqRow = db.prepare(
    'SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM tasks WHERE team_id = ?'
  ).get(input.team_id) as { next_seq: number }

  const result = db.prepare(
    `INSERT INTO tasks (team_id, seq, subject, description, active_form)
     VALUES (@team_id, @seq, @subject, @description, @active_form)`
  ).run({
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
    const rows = db.prepare(
      'SELECT * FROM tasks WHERE team_id = ? AND status = ? ORDER BY id'
    ).all(teamId, status) as Task[]
    return rows.map((row) => ({ ...row }))
  }
  const rows = db.prepare(
    "SELECT * FROM tasks WHERE team_id = ? AND status != 'deleted' ORDER BY id"
  ).all(teamId) as Task[]
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

  db.prepare(
    `UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`
  ).run(...values)

  return findTaskById(db, id)
}

export function deleteTask(db: Database.Database, id: number): boolean {
  const result = db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
  return result.changes > 0
}

export function addDependency(
  db: Database.Database,
  taskId: number,
  dependsOn: number,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO task_dependencies (task_id, depends_on)
     VALUES (?, ?)`
  ).run(taskId, dependsOn)
}

export function removeDependency(
  db: Database.Database,
  taskId: number,
  dependsOn: number,
): void {
  db.prepare(
    'DELETE FROM task_dependencies WHERE task_id = ? AND depends_on = ?'
  ).run(taskId, dependsOn)
}

export function findBlockedBy(
  db: Database.Database,
  taskId: number,
): ReadonlyArray<number> {
  const rows = db.prepare(
    `SELECT depends_on FROM task_dependencies
     WHERE task_id = ?
     AND depends_on IN (SELECT id FROM tasks WHERE status != 'completed' AND status != 'deleted')`
  ).all(taskId) as Array<{ depends_on: number }>
  return rows.map((row) => row.depends_on)
}

export function findBlocks(
  db: Database.Database,
  taskId: number,
): ReadonlyArray<number> {
  const rows = db.prepare(
    'SELECT task_id FROM task_dependencies WHERE depends_on = ?'
  ).all(taskId) as Array<{ task_id: number }>
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
  const row = db.prepare('SELECT COUNT(*) as count FROM tasks WHERE status = ?').get(status) as { count: number }
  return row.count
}

export function countPendingTasksByTeam(db: Database.Database, teamId: string): number {
  const row = db.prepare(
    "SELECT COUNT(*) as count FROM tasks WHERE team_id = ? AND status = 'pending'"
  ).get(teamId) as { count: number }
  return row.count
}
