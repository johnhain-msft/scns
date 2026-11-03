import { EventEmitter } from 'node:events'
import { logger } from './logger.js'

// ─── Event Type Constants ──────────────────────────────────────────────────

export const BrokerEventTypes = [
  'session_registered', 'session_deregistered', 'message_sent', 'message_read',
  'team_created', 'team_disbanded', 'team_purged', 'team_member_joined', 'team_member_left',
  'task_created', 'task_updated', 'task_completed',
  'state_updated', 'state_deleted',
  'intent_declared', 'intent_released', 'conflict_detected',
  'heartbeat_received', 'zombie_detected', 'zombie_cleaned',
  'broker_started', 'broker_stopped',
  'story_cleared', 'session_cleared', 'all_cleared',
  'capabilities_declared', 'agent_respawned', 'agent_abandoned',
  'manifest_applied', 'agent_scaled_up', 'agent_scaled_down',
  'usage_recorded', 'branch_intent_declared', 'branch_conflict_detected',
  'repo_broadcast_sent', 'activity_reported',
  'messages_compacted', 'scratchpad_updated',
  'orchestration_phase_transitioned',
  'messages_injected', 'task_result_indexed',
  'session_branched',
] as const

export type BrokerEventType = (typeof BrokerEventTypes)[number]

// ─── Typed Event & Filter Interfaces ───────────────────────────────────────

export interface TypedEvent {
  readonly id: number
  readonly event_type: BrokerEventType
  readonly session_id: string | null
  readonly payload: string  // JSON string
  readonly team_id?: string | null  // extracted for filtering
  readonly created_at: string
}

export interface EventFilter {
  readonly event_types?: readonly BrokerEventType[]
  readonly team_id?: string
  readonly session_id?: string
}

export type EventHandler = (event: TypedEvent) => void

export interface EventDispatcher {
  dispatch(event: TypedEvent): void
  subscribe(filter: EventFilter, handler: EventHandler): () => void
  subscriberCount(): number
}

// ─── Internal Types ────────────────────────────────────────────────────────

interface Subscription {
  readonly filter: EventFilter
  readonly handler: EventHandler
}

// ─── Filter Matching ───────────────────────────────────────────────────────

const DISPATCH_CHANNEL = 'broker_event'

function matchesFilter(event: TypedEvent, filter: EventFilter): boolean {
  if (filter.event_types && filter.event_types.length > 0) {
    if (!filter.event_types.includes(event.event_type)) {
      return false
    }
  }

  if (filter.team_id !== undefined) {
    if (event.team_id !== filter.team_id) {
      return false
    }
  }

  if (filter.session_id !== undefined) {
    if (event.session_id !== filter.session_id) {
      return false
    }
  }

  return true
}

// ─── Team ID Extraction ────────────────────────────────────────────────────

export function extractTeamId(data: Record<string, unknown>): string | null {
  if (typeof data.team_id === 'string') {
    return data.team_id
  }
  return null
}

// ─── Real Dispatcher (EventEmitter-backed) ─────────────────────────────────

export function createEventDispatcher(): EventDispatcher {
  const emitter = new EventEmitter()
  emitter.setMaxListeners(200)

  const subscriptions = new Map<symbol, Subscription>()

  const onEvent = (event: TypedEvent): void => {
    for (const [, sub] of subscriptions) {
      if (matchesFilter(event, sub.filter)) {
        try {
          sub.handler(event)
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error)
          logger.error({ err: message }, 'Event handler threw an error')
        }
      }
    }
  }

  emitter.on(DISPATCH_CHANNEL, onEvent)

  return {
    dispatch(event: TypedEvent): void {
      emitter.emit(DISPATCH_CHANNEL, event)
    },

    subscribe(filter: EventFilter, handler: EventHandler): () => void {
      const id = Symbol('subscription')
      subscriptions.set(id, { filter, handler })

      let unsubscribed = false
      return (): void => {
        if (unsubscribed) {
          return
        }
        unsubscribed = true
        subscriptions.delete(id)
      }
    },

    subscriberCount(): number {
      return subscriptions.size
    },
  }
}

// ─── Null Dispatcher (no-op for batch/CI/testing) ──────────────────────────

const noopUnsubscribe = (): void => { /* no-op */ }

export function createNullDispatcher(): EventDispatcher {
  return {
    dispatch(_event: TypedEvent): void {
      // intentionally empty
    },

    subscribe(_filter: EventFilter, _handler: EventHandler): () => void {
      return noopUnsubscribe
    },

    subscriberCount(): number {
      return 0
    },
  }
}
