import type Database from 'better-sqlite3'
import type { EventLog } from '../services/event-log.js'
import { gcDisbandedTeams } from '../services/team-gc.js'
import { type ToolResult, textResult } from './helpers.js'

interface GcDisbandedTeamsInput {
  readonly ttl_seconds?: number
}

export function handleGcDisbandedTeams(
  db: Database.Database,
  eventLog: EventLog,
  input: GcDisbandedTeamsInput,
): ToolResult {
  const ttlSeconds = input.ttl_seconds ?? 86400
  const result = gcDisbandedTeams(db, eventLog, ttlSeconds)
  return textResult({
    ...result,
    ttl_seconds: ttlSeconds,
  })
}
