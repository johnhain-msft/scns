import type Database from 'better-sqlite3'
import type { BranchIntent } from '../../types.js'

interface DeclareBranchIntentInput {
  readonly session_id: string
  readonly branch: string
  readonly file_path: string
  readonly commit_sha?: string | null
}

export function declareBranchIntent(
  db: Database.Database,
  input: DeclareBranchIntentInput,
): BranchIntent {
  db.prepare(
    `INSERT INTO branch_intents (session_id, branch, file_path, commit_sha)
     VALUES (@session_id, @branch, @file_path, @commit_sha)
     ON CONFLICT(session_id, branch, file_path) DO UPDATE SET
       commit_sha = COALESCE(@commit_sha, commit_sha),
       declared_at = datetime('now')`
  ).run({
    session_id: input.session_id,
    branch: input.branch,
    file_path: input.file_path,
    commit_sha: input.commit_sha ?? null,
  })

  const row = db.prepare(
    'SELECT * FROM branch_intents WHERE session_id = ? AND branch = ? AND file_path = ?'
  ).get(input.session_id, input.branch, input.file_path) as BranchIntent

  return { ...row }
}

export interface BranchConflict {
  readonly file_path: string
  readonly branches: ReadonlyArray<{
    readonly branch: string
    readonly session_id: string
    readonly commit_sha: string | null
  }>
}

export function findBranchConflicts(
  db: Database.Database,
  options?: {
    readonly file_path?: string
    readonly branch?: string
  },
): ReadonlyArray<BranchConflict> {
  let conflictedFiles: Array<{ file_path: string }>

  if (options?.file_path) {
    conflictedFiles = db.prepare(
      `SELECT file_path FROM branch_intents
       WHERE file_path = ?
       GROUP BY file_path
       HAVING COUNT(DISTINCT branch) > 1`
    ).all(options.file_path) as Array<{ file_path: string }>
  } else {
    conflictedFiles = db.prepare(
      `SELECT file_path FROM branch_intents
       GROUP BY file_path
       HAVING COUNT(DISTINCT branch) > 1`
    ).all() as Array<{ file_path: string }>
  }

  return conflictedFiles.map((cf) => {
    let rows: Array<{ branch: string; session_id: string; commit_sha: string | null }>

    if (options?.branch) {
      rows = db.prepare(
        'SELECT branch, session_id, commit_sha FROM branch_intents WHERE file_path = ? AND branch = ?'
      ).all(cf.file_path, options.branch) as typeof rows
    } else {
      rows = db.prepare(
        'SELECT branch, session_id, commit_sha FROM branch_intents WHERE file_path = ?'
      ).all(cf.file_path) as typeof rows
    }

    return {
      file_path: cf.file_path,
      branches: rows.map((r) => ({ ...r })),
    }
  })
}

export function findBranchIntentsBySession(
  db: Database.Database,
  sessionId: string,
): ReadonlyArray<BranchIntent> {
  const rows = db.prepare(
    'SELECT * FROM branch_intents WHERE session_id = ? ORDER BY declared_at'
  ).all(sessionId) as BranchIntent[]
  return rows.map((row) => ({ ...row }))
}

export function releaseBranchIntentsBySession(
  db: Database.Database,
  sessionId: string,
): number {
  const result = db.prepare(
    'DELETE FROM branch_intents WHERE session_id = ?'
  ).run(sessionId)
  return result.changes
}

export function deleteAllBranchIntents(db: Database.Database): number {
  const result = db.prepare('DELETE FROM branch_intents').run()
  return result.changes
}
