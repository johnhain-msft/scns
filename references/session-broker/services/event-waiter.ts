import type Database from 'better-sqlite3'
import type { Event } from '../types.js'
import { getEventsSinceFiltered } from '../storage/repositories/event-repository.js'

export interface WaitOptions {
  readonly afterId: number
  readonly eventTypes?: ReadonlyArray<string>
  readonly sessionId?: string
  readonly timeoutMs?: number
  readonly pollIntervalMs?: number
}

export interface WaitResult {
  readonly events: ReadonlyArray<Event>
  readonly last_event_id: number
  readonly timed_out: boolean
}

export async function waitForEvent(
  db: Database.Database,
  options: WaitOptions,
): Promise<WaitResult> {
  const timeoutMs = options.timeoutMs ?? 30_000
  const pollIntervalMs = options.pollIntervalMs ?? 500
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const events = getEventsSinceFiltered(db, {
      afterId: options.afterId,
      eventTypes: options.eventTypes,
      sessionId: options.sessionId,
    })

    if (events.length > 0) {
      return {
        events,
        last_event_id: events[events.length - 1].id,
        timed_out: false,
      }
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }

  return {
    events: [],
    last_event_id: options.afterId,
    timed_out: true,
  }
}
