import type Database from 'better-sqlite3'
import type { EventLog } from '../services/event-log.js'
import {
  declareIntent,
  releaseIntent,
  findConflicts,
} from '../storage/repositories/intent-repository.js'
import { handleDeclareBranch, handleCheckBranchConflicts } from './git-conflict.js'
import { type ToolResult, textResult, errorResult } from './helpers.js'

interface DeclareIntentInput {
  readonly session_id: string
  readonly file_path: string
  readonly intent?: string
}

export function handleDeclareIntent(
  db: Database.Database,
  eventLog: EventLog,
  input: DeclareIntentInput,
): ToolResult {
  try {
    const intent = declareIntent(db, {
      file_path: input.file_path,
      session_id: input.session_id,
      intent: input.intent,
    })

    eventLog.intentDeclared(input.session_id, {
      file_path: input.file_path,
      intent: intent.intent,
    })

    const conflicts = findConflicts(db, input.file_path)

    if (conflicts.length > 0) {
      eventLog.conflictDetected(input.session_id, {
        file_path: input.file_path,
        sessions: conflicts[0].sessions.map((s) => s.session_id),
      })
    }

    return textResult({ intent, conflicts })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return errorResult(`Failed to declare intent: ${msg}`)
  }
}

interface ReleaseIntentInput {
  readonly session_id: string
  readonly file_path: string
}

export function handleReleaseIntent(
  db: Database.Database,
  eventLog: EventLog,
  input: ReleaseIntentInput,
): ToolResult {
  const released = releaseIntent(db, input.session_id, input.file_path)
  if (!released) {
    return errorResult(`Intent not found for session '${input.session_id}' on '${input.file_path}'`)
  }
  eventLog.intentReleased(input.session_id, { file_path: input.file_path })
  return textResult({ released: true, session_id: input.session_id, file_path: input.file_path })
}

interface CheckConflictsInput {
  readonly file_path?: string
}

export function handleCheckConflicts(
  db: Database.Database,
  input: CheckConflictsInput,
): ToolResult {
  const conflicts = findConflicts(db, input.file_path)
  return textResult(conflicts)
}

// ─── Unified Handlers (Phase 3B merges) ──────────────────────────────────

export interface UnifiedDeclareIntentInput {
  readonly scope: 'file' | 'branch'
  readonly session_id: string
  readonly file_path: string
  readonly intent?: string
  readonly branch?: string
  readonly commit_sha?: string | null
}

export function handleUnifiedDeclareIntent(
  db: Database.Database,
  eventLog: EventLog,
  input: UnifiedDeclareIntentInput,
): ToolResult {
  if (input.scope === 'branch') {
    if (!input.branch) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'branch required when scope is branch' }) }], isError: true }
    }
    return handleDeclareBranch(db, eventLog, {
      session_id: input.session_id,
      branch: input.branch,
      file_path: input.file_path,
      commit_sha: input.commit_sha,
    })
  }
  return handleDeclareIntent(db, eventLog, {
    session_id: input.session_id,
    file_path: input.file_path,
    intent: input.intent,
  })
}

export interface UnifiedCheckConflictsInput {
  readonly scope: 'file' | 'branch'
  readonly file_path?: string
  readonly branch?: string
}

export function handleUnifiedCheckConflicts(
  db: Database.Database,
  input: UnifiedCheckConflictsInput,
): ToolResult {
  if (input.scope === 'branch') {
    return handleCheckBranchConflicts(db, { file_path: input.file_path, branch: input.branch })
  }
  return handleCheckConflicts(db, { file_path: input.file_path })
}
