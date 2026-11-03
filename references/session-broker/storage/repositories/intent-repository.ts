import { posix } from 'node:path'
import type Database from 'better-sqlite3'
import type { FileIntent } from '../../types.js'

interface DeclareIntentInput {
  readonly file_path: string
  readonly session_id: string
  readonly intent?: string
}

/**
 * Normalize a file path for consistent storage/lookup:
 * - Strip trailing slashes (except root "/")
 * - Resolve `.` and `..` segments via posix.normalize
 */
export function normalizePath(filePath: string): string {
  const normalized = posix.normalize(filePath)
  return normalized.length > 1 && normalized.endsWith('/')
    ? normalized.slice(0, -1)
    : normalized
}

export interface FileConflict {
  readonly file_path: string
  readonly sessions: ReadonlyArray<{ session_id: string; intent: string }>
}

export function declareIntent(db: Database.Database, input: DeclareIntentInput): FileIntent {
  const intent = input.intent ?? 'edit'
  const filePath = normalizePath(input.file_path)

  db.prepare(
    `INSERT INTO file_intents (file_path, session_id, intent)
     VALUES (@file_path, @session_id, @intent)
     ON CONFLICT(file_path, session_id) DO UPDATE SET
       intent = excluded.intent,
       declared_at = datetime('now')`
  ).run({ file_path: filePath, session_id: input.session_id, intent })

  const row = db.prepare(
    'SELECT * FROM file_intents WHERE file_path = ? AND session_id = ?'
  ).get(filePath, input.session_id) as FileIntent

  return { ...row }
}

export function releaseIntent(db: Database.Database, sessionId: string, filePath: string): boolean {
  const normalized = normalizePath(filePath)
  const result = db.prepare(
    'DELETE FROM file_intents WHERE session_id = ? AND file_path = ?'
  ).run(sessionId, normalized)
  return result.changes > 0
}

export function releaseIntentsBySession(db: Database.Database, sessionId: string): number {
  const result = db.prepare('DELETE FROM file_intents WHERE session_id = ?').run(sessionId)
  return result.changes
}

export function findConflicts(db: Database.Database, filePath?: string): ReadonlyArray<FileConflict> {
  let conflictedFiles: Array<{ file_path: string }>

  if (filePath) {
    const normalized = normalizePath(filePath)
    conflictedFiles = db.prepare(
      `SELECT file_path FROM file_intents
       WHERE file_path = ?
       GROUP BY file_path
       HAVING COUNT(DISTINCT session_id) > 1`
    ).all(normalized) as Array<{ file_path: string }>
  } else {
    conflictedFiles = db.prepare(
      `SELECT file_path FROM file_intents
       GROUP BY file_path
       HAVING COUNT(DISTINCT session_id) > 1`
    ).all() as Array<{ file_path: string }>
  }

  return conflictedFiles.map((cf) => {
    const rows = db.prepare(
      'SELECT session_id, intent FROM file_intents WHERE file_path = ?'
    ).all(cf.file_path) as Array<{ session_id: string; intent: string }>

    return {
      file_path: cf.file_path,
      sessions: rows.map((r) => ({ ...r })),
    }
  })
}

export function findIntentsBySession(db: Database.Database, sessionId: string): ReadonlyArray<FileIntent> {
  const rows = db.prepare(
    'SELECT * FROM file_intents WHERE session_id = ? ORDER BY declared_at'
  ).all(sessionId) as FileIntent[]

  return rows.map((row) => ({ ...row }))
}

export function deleteAllIntents(db: Database.Database): number {
  const result = db.prepare('DELETE FROM file_intents').run()
  return result.changes
}
