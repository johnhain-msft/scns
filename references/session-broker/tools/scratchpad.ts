import type Database from 'better-sqlite3'
import type { EventLog } from '../services/event-log.js'
import {
  writeScratchpad,
  readScratchpad,
  listScratchpad,
  deleteScratchpad,
} from '../services/team-scratchpad.js'
import { type ToolResult, textResult, errorResult } from './helpers.js'

// ── Input types ───────────────────────────────────────────────────────────

interface WriteScratchpadInput {
  readonly team_id: string
  readonly key: string
  readonly value: string
  readonly session_id?: string
}

interface ReadScratchpadInput {
  readonly team_id: string
  readonly key?: string
}

interface DeleteScratchpadInput {
  readonly team_id: string
  readonly key: string
}

// ── Handlers ──────────────────────────────────────────────────────────────

export function handleWriteScratchpad(
  db: Database.Database,
  eventLog: EventLog,
  input: WriteScratchpadInput,
): ToolResult {
  if (!input.team_id) {
    return errorResult('team_id is required')
  }
  if (!input.key) {
    return errorResult('key is required')
  }
  if (input.value === undefined || input.value === null) {
    return errorResult('value is required')
  }
  if (input.value.length === 0) {
    return errorResult('value must not be empty — use delete_scratchpad to remove an entry')
  }

  const entry = writeScratchpad(
    db,
    eventLog,
    input.team_id,
    input.key,
    input.value,
    input.session_id,
  )

  return textResult(entry)
}

export function handleReadScratchpad(
  db: Database.Database,
  input: ReadScratchpadInput,
): ToolResult {
  if (!input.team_id) {
    return errorResult('team_id is required')
  }

  if (input.key) {
    const entry = readScratchpad(db, input.team_id, input.key)
    return textResult(entry)
  }

  const entries = listScratchpad(db, input.team_id)
  return textResult(entries)
}

export function handleDeleteScratchpad(
  db: Database.Database,
  eventLog: EventLog,
  input: DeleteScratchpadInput,
): ToolResult {
  if (!input.team_id) {
    return errorResult('team_id is required')
  }
  if (!input.key) {
    return errorResult('key is required')
  }

  const deleted = deleteScratchpad(db, eventLog, input.team_id, input.key)
  return textResult({ deleted, team_id: input.team_id, key: input.key })
}
