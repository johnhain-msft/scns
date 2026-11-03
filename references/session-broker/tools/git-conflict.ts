import type Database from 'better-sqlite3'
import type { EventLog } from '../services/event-log.js'
import {
  declareBranchIntent,
  findBranchConflicts,
} from '../storage/repositories/branch-intent-repository.js'
import { type ToolResult, textResult } from './helpers.js'

interface DeclareBranchInput {
  readonly session_id: string
  readonly branch: string
  readonly file_path: string
  readonly commit_sha?: string | null
}

export function handleDeclareBranch(
  db: Database.Database,
  eventLog: EventLog,
  input: DeclareBranchInput,
): ToolResult {
  const intent = declareBranchIntent(db, {
    session_id: input.session_id,
    branch: input.branch,
    file_path: input.file_path,
    commit_sha: input.commit_sha,
  })

  eventLog.branchIntentDeclared(input.session_id, {
    branch: input.branch,
    file_path: input.file_path,
    commit_sha: input.commit_sha ?? null,
  })

  // Check for conflicts on this file across branches
  const conflicts = findBranchConflicts(db, { file_path: input.file_path })
  const hasConflict = conflicts.length > 0

  if (hasConflict) {
    eventLog.branchConflictDetected(input.session_id, {
      file_path: input.file_path,
      branches: conflicts[0].branches.map((b) => b.branch),
    })
  }

  return textResult({
    intent,
    conflict: hasConflict,
    conflicts: hasConflict ? conflicts : [],
  })
}

interface CheckBranchConflictsInput {
  readonly file_path?: string
  readonly branch?: string
}

export function handleCheckBranchConflicts(
  db: Database.Database,
  input: CheckBranchConflictsInput,
): ToolResult {
  const conflicts = findBranchConflicts(db, {
    file_path: input.file_path,
    branch: input.branch,
  })

  return textResult({
    conflicts,
    total: conflicts.length,
  })
}
