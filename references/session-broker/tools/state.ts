import type Database from 'better-sqlite3'
import type { EventLog } from '../services/event-log.js'
import {
  getState,
  setState,
} from '../storage/repositories/state-repository.js'
import { type ToolResult, textResult } from './helpers.js'

interface SetStateInput {
  readonly key: string
  readonly value: string
  readonly story_id: string | null
  readonly session_id: string | null
}

export function handleSetState(
  db: Database.Database,
  eventLog: EventLog,
  input: SetStateInput,
): ToolResult {
  const entry = setState(db, input)
  eventLog.stateUpdated(input.session_id, { key: input.key, value: input.value })
  return textResult(entry)
}

interface GetStateInput {
  readonly key: string
}

export function handleGetState(
  db: Database.Database,
  input: GetStateInput,
): ToolResult {
  const entry = getState(db, input.key)
  return textResult(entry)
}
