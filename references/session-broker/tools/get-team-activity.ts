import type Database from 'better-sqlite3'
import { findTeamById } from '../storage/repositories/team-repository.js'
import { getTeamActivity } from '../storage/repositories/event-repository.js'
import { type ToolResult, textResult, errorResult } from './helpers.js'

interface GetTeamActivityInput {
  readonly team_id: string
  readonly limit?: number
  readonly offset?: number
  readonly event_types?: ReadonlyArray<string>
  readonly since?: string
}

export function handleGetTeamActivity(
  db: Database.Database,
  input: GetTeamActivityInput,
): ToolResult {
  const team = findTeamById(db, input.team_id)
  if (!team) {
    return errorResult(`Team '${input.team_id}' not found`)
  }

  try {
    const events = getTeamActivity(db, {
      teamId: input.team_id,
      limit: input.limit,
      offset: input.offset,
      eventTypes: input.event_types ? [...input.event_types] : undefined,
      since: input.since,
    })

    return textResult({
      team_id: input.team_id,
      events: events.map((e) => ({
        ...e,
        payload: JSON.parse(e.payload),
      })),
      count: events.length,
      limit: input.limit ?? 50,
      offset: input.offset ?? 0,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResult(`Failed to get team activity: ${message}`)
  }
}
