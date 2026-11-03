import { EventEmitter } from 'node:events'
import { logger } from '../shared/logger.js'

// ─── Event Type Constants ──────────────────────────────────────────────────

export const BrokerEventTypes = [
  'session_registered',
  'session_deregistered',
  'message_sent',
  'message_read',
  'team_created',
  'team_disbanded',
  'team_archived',
  'team_purged',
  'team_member_joined',
  'team_member_left',
  'task_created',
  'task_updated',
  'task_completed',
  'state_updated',
  'state_deleted',
  'intent_declared',
  'intent_released',
  'conflict_detected',
  'heartbeat_received',
  'zombie_detected',
  'zombie_cleaned',
  // Issue #70: TTL GC settled an archived session / explicit message verdict.
  'session_purged',
  'message_disposition',
  'broker_started',
  'broker_stopped',
  'story_cleared',
  'session_cleared',
  'all_cleared',
  'capabilities_declared',
  'agent_respawned',
  'agent_abandoned',
  'manifest_applied',
  'agent_scaled_up',
  'agent_scaled_down',
  'usage_recorded',
  'branch_intent_declared',
  'branch_conflict_detected',
  'repo_broadcast_sent',
  'activity_reported',
  'messages_compacted',
  'scratchpad_updated',
  'orchestration_phase_transitioned',
  'messages_injected',
  'task_result_indexed',
  'session_branched',
  'hook_received',
  'quality_check_completed',
  'session_handoff_created',
  'team_completed',
  'quality_gate_started',
  'quality_gate_verdict',
  'suggestion_spawned_team',
  'manager_dispatch_incomplete',
  'dev_no_work',
  // WS K (Phase 13.13.x) — ACP / agent-spawn lifecycle instrumentation.
  // Emitted by agent-spawner.ts at the four observable stages of a launch.
  // Used by the WS K diagnostic harness (scripts/wsk-acp-dev-trace.mjs) to
  // pinpoint which stage of dev-spawn is silently failing.
  'agent_launch_started',
  'agent_prompt_delivered',
  'agent_first_output_received',
  'agent_launch_failed',
  // WS L (Phase 13.13.x) — bounded agentic-loop instrumentation. Emitted by
  // agent-spawner.ts each time a follow-up nudge prompt is sent to an ACP
  // dev session that returned `end_turn` without staging any work. Lets the
  // diagnostic harness (and future monitors) observe nudge counts.
  'agent_nudge_sent',
  // WS M (Phase 13.13.x) — strict dispatch_id attribution. Emitted once
  // per broker auto-dispatch with payload binding each spawned dev/qa
  // session_id to its uuid dispatch_id and the wall-clock dispatch start
  // time. Consumed by dev-productivity-monitor & task-completion-gate
  // for strict attribution instead of free-floating mtime heuristics.
  'dispatch_started',
  // WS Q (Phase 13.13.x) — turn-end-anchored work measurement. Emitted
  // by agent-spawner.ts after every ACP `sendPrompt` resolution for
  // dispatch-attributed dev sessions (one per turn, including WS-L
  // nudges). Consumed by dev-productivity-monitor.handleDevTurnEnded
  // to sample the staged numstat strictly AFTER the dev's turn ended
  // — closes the WS-N measurement-window race.
  'dev_turn_ended',
  // Phase 1.5 step 5 — cold-start timing probe. Emitted by
  // agent-spawner.ts after every successful ACP `createSession` resolution
  // (one per spawn) with three latency deltas:
  //   - `process_spawn_to_initialize_ms` (process spawn + Node + Copilot
  //     CLI bootstrap + initialize RPC)
  //   - `session_new_ms` (session/new request + bootstrap stream of
  //     available_commands_update + MCP registration + config_option_update)
  //   - `cold_start_ms` (the sum — total wall-clock from spawn start to
  //     session/new resolved, i.e. the cost a warm pool could save).
  // Used to inform the Step 5b warm-pool design: if `session_new_ms`
  // dominates, a post-initialize/pre-session-new pool only saves a
  // fraction; if `process_spawn_to_initialize_ms` dominates, a pool wins
  // big. Without this probe the design is guesswork.
  'agent_acp_timing',
  // Phase 13.12.32 — QG worktree provisioning observability. Emitted by
  // the quality-gate-arbiter exactly once per verdict, immediately
  // after the node_modules bridge step runs (success OR failure). Lets
  // operators and the brain see what the bridge actually did
  // (`{linked, reason, missing, binDirRealpath, fallbackAttempted}`)
  // instead of inferring from the verdict's findings string. Closes
  // the "ephemeral worktree, no audit trail" gap that left the bridge
  // diagnostic invisible to anything but the broker's structured log.
  'worktree_provisioning',
  // Phase 13.12.34 — auto-merger lifecycle. Emitted by auto-merger.ts
  // when a verdict-PASS branch is fast-forwarded into main (auto_merged)
  // or refused by the structural safety gates (auto_merge_rejected).
  // The service is flag-gated via BROKER_AUTO_MERGE; payloads include
  // the gate outcomes, branch SHA, and the final merge commit (if any).
  'auto_merged',
  'auto_merge_rejected',
  // F1 — gate-pass publisher lifecycle. Emitted by gate-pass-publisher.ts
  // when a verdict-PASS scns/auto/* branch is pushed to origin and opened
  // as a PR (gate_published, payload carries pr_url + quality_check_id +
  // source_issue_number), or when the publish attempt errored
  // (gate_publish_failed, payload carries the failing step + detail).
  // Publishing is post-verdict: neither event can affect the verdict.
  'gate_published',
  'gate_publish_failed',
  // P5c — retention sweep observability. Emitted by the otel-cleanup
  // and telemetry-rotation scheduled task handlers exactly once per
  // tick, including on the kill-switched skip path. Payload fields:
  //   - task: 'telemetry' | 'otel'
  //   - killSwitched: boolean (true when shared_state kill-switch skipped work)
  //   - success: boolean
  //   - freedBytes?: number (bytes reclaimed this tick, when applicable)
  //   - prunedCounts?: Record<string, number> (per-category prune counts)
  //   - durationMs: number
  // Event emission is best-effort: a failure inserting this row must
  // never fail the underlying retention task.
  'retention_sweep',
  // Step 3 (anti-drift) — NORTH_STAR nudge + drift watchdog observability.
  // north_star_nudged: a session-end window landed substantive src//specs/
  //   commits with no docs/NORTH_STAR.md commit; the single reminder issue
  //   was created or reopened (payload: action, issue_number, window_start,
  //   substantive_commits, shas).
  // north_star_nudge_cleared: a later window contained a NORTH_STAR commit
  //   while the reminder was open, so it was closed (payload: issue_number).
  // drift_watchdog_ran: the daily staleness+deferral watchdog completed a
  //   tick (payload: status, action, findings, issue_number, duration_ms).
  'north_star_nudged',
  'north_star_nudge_cleared',
  'drift_watchdog_ran',
] as const

export type BrokerEventType = (typeof BrokerEventTypes)[number]

// ─── Typed Event & Filter Interfaces ───────────────────────────────────────

export interface TypedEvent {
  readonly id: number
  readonly event_type: BrokerEventType
  readonly session_id: string | null
  readonly payload: string
  readonly team_id?: string | null
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

const noopUnsubscribe = (): void => {
  /* no-op */
}

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
