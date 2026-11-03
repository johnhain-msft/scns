/**
 * MCP tool handler for session branching.
 */

import type Database from 'better-sqlite3'
import type { EventLog } from '../services/event-log.js'
import { branchSession } from '../services/session-branching.js'
import { type ToolResult, textResult, errorResult } from './helpers.js'

export interface BranchSessionToolInput {
  readonly new_session_id: string
  readonly parent_session_id: string
  readonly branch_point_message_id?: string
  readonly purpose: string
  readonly working_dir?: string
}

export function handleBranchSession(
  db: Database.Database,
  eventLog: EventLog,
  input: BranchSessionToolInput,
): ToolResult {
  try {
    const result = branchSession(db, eventLog, {
      newSessionId: input.new_session_id,
      parentSessionId: input.parent_session_id,
      branchPointMessageId: input.branch_point_message_id,
      purpose: input.purpose,
      workingDir: input.working_dir,
    })
    return textResult(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResult(`Failed to branch session: ${message}`)
  }
}
