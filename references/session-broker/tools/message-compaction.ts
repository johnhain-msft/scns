import type Database from 'better-sqlite3'
import type { EventLog } from '../services/event-log.js'
import { compactTeamMessages } from '../services/message-compaction.js'
import { type ToolResult, textResult, errorResult } from './helpers.js'

interface CompactTeamMessagesInput {
  readonly team_id: string
  readonly threshold?: number
  readonly retain_recent?: number
}

export function handleCompactTeamMessages(
  db: Database.Database,
  eventLog: EventLog,
  input: CompactTeamMessagesInput,
): ToolResult {
  if (!input.team_id) {
    return errorResult('team_id is required')
  }

  try {
    const result = compactTeamMessages(db, eventLog, input.team_id, {
      threshold: input.threshold,
      retainRecent: input.retain_recent,
    })

    return textResult(result)
  } catch (error) {
    return errorResult(
      `Failed to compact messages: ${error instanceof Error ? error.message : 'Unknown error'}`,
    )
  }
}
