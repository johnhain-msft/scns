import type { Observation, ObservationType } from './types.js'

/** Standardized event envelope for all observer plugins */
export interface ObservationEvent {
  readonly id: string
  readonly source: string
  readonly type: string
  readonly timestamp: string
  readonly payload: Record<string, unknown>
  readonly tags: readonly string[]
}

/** Safely serialize a payload, handling values that would fail JSON.stringify */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '{}'
  } catch {
    return '{}'
  }
}

/** Convert an ObservationEvent to the existing Observation format */
export function toObservation(
  event: ObservationEvent,
  observationType: ObservationType,
): Observation {
  const content =
    Object.keys(event.payload).length > 0
      ? `[${event.source}] ${event.type}: ${safeStringify(event.payload)}`
      : `[${event.source}] ${event.type}`

  return {
    id: event.id,
    type: observationType,
    timestamp: event.timestamp,
    source: event.source,
    content,
    tags: [...event.tags],
    metadata: {
      eventType: event.type,
      payload: event.payload,
    },
  }
}
