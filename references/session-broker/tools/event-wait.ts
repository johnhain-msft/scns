import type Database from 'better-sqlite3'
import type { EventLog } from '../services/event-log.js'
import { waitForEvent } from '../services/event-waiter.js'
import { type ToolResult, textResult, errorResult } from './helpers.js'

interface WaitForEventInput {
  readonly after_event_id: number
  readonly event_types?: ReadonlyArray<string>
  readonly session_id?: string
  readonly timeout_seconds?: number
}

export async function handleWaitForEvent(
  db: Database.Database,
  _eventLog: EventLog,
  input: WaitForEventInput,
): Promise<ToolResult> {
  const timeoutSeconds = Math.min(input.timeout_seconds ?? 30, 55)

  try {
    const result = await waitForEvent(db, {
      afterId: input.after_event_id,
      eventTypes: input.event_types ? [...input.event_types] : undefined,
      sessionId: input.session_id,
      timeoutMs: timeoutSeconds * 1000,
    })

    return textResult(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResult(`Failed to wait for event: ${message}`)
  }
}
