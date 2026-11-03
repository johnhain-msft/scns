import type Database from 'better-sqlite3'
import type { Event } from '../types.js'
import {
  appendEvent,
  getEventsSince,
  getEventsBySession,
} from '../storage/repositories/event-repository.js'
import type { EventDispatcher, BrokerEventType } from '../event-dispatcher.js'
import { extractTeamId } from '../event-dispatcher.js'

export interface EventLog {
  sessionRegistered(sessionId: string, data: Record<string, unknown>): Event
  sessionDeregistered(sessionId: string, data: Record<string, unknown>): Event
  stateUpdated(sessionId: string | null, data: Record<string, unknown>): Event
  stateDeleted(sessionId: string | null, data: Record<string, unknown>): Event
  brokerStarted(data: Record<string, unknown>): Event
  brokerStopped(data: Record<string, unknown>): Event
  messageSent(sessionId: string, data: Record<string, unknown>): Event
  messageRead(sessionId: string, data: Record<string, unknown>): Event
  intentDeclared(sessionId: string, data: Record<string, unknown>): Event
  intentReleased(sessionId: string, data: Record<string, unknown>): Event
  conflictDetected(sessionId: string, data: Record<string, unknown>): Event
  storyCleared(sessionId: string | null, data: Record<string, unknown>): Event
  sessionCleared(sessionId: string, data: Record<string, unknown>): Event
  allCleared(sessionId: string | null, data: Record<string, unknown>): Event
  heartbeatReceived(sessionId: string, data: Record<string, unknown>): Event
  zombieDetected(sessionId: string, data: Record<string, unknown>): Event
  zombieCleaned(sessionId: string, data: Record<string, unknown>): Event
  /** Issue #70: TTL GC settled an archived session (or deferred it). */
  sessionPurged(sessionId: string | null, data: Record<string, unknown>): Event
  /** Issue #70: explicit accepted/rejected/deferred verdict on a message. */
  messageDisposition(sessionId: string | null, data: Record<string, unknown>): Event
  activityReported(sessionId: string, data: Record<string, unknown>): Event
  teamCreated(sessionId: string | null, data: Record<string, unknown>): Event
  teamDisbanded(sessionId: string | null, data: Record<string, unknown>): Event
  teamArchived(sessionId: string | null, data: Record<string, unknown>): Event
  teamPurged(sessionId: string | null, data: Record<string, unknown>): Event
  teamMemberJoined(sessionId: string, data: Record<string, unknown>): Event
  teamMemberLeft(sessionId: string, data: Record<string, unknown>): Event
  taskCreated(sessionId: string | null, data: Record<string, unknown>): Event
  taskUpdated(sessionId: string | null, data: Record<string, unknown>): Event
  taskCompleted(sessionId: string | null, data: Record<string, unknown>): Event
  capabilitiesDeclared(sessionId: string, data: Record<string, unknown>): Event
  agentRespawned(sessionId: string | null, data: Record<string, unknown>): Event
  agentAbandoned(sessionId: string | null, data: Record<string, unknown>): Event
  manifestApplied(sessionId: string | null, data: Record<string, unknown>): Event
  agentScaledUp(sessionId: string | null, data: Record<string, unknown>): Event
  agentScaledDown(sessionId: string | null, data: Record<string, unknown>): Event
  usageRecorded(sessionId: string, data: Record<string, unknown>): Event
  branchIntentDeclared(sessionId: string, data: Record<string, unknown>): Event
  branchConflictDetected(sessionId: string | null, data: Record<string, unknown>): Event
  repoBroadcastSent(sessionId: string, data: Record<string, unknown>): Event
  messagesCompacted(sessionId: string | null, data: Record<string, unknown>): Event
  orchestrationPhaseTransitioned(sessionId: string | null, data: Record<string, unknown>): Event
  sessionBranched(sessionId: string, data: Record<string, unknown>): Event
  scratchpadUpdated(sessionId: string | null, data: Record<string, unknown>): Event
  messagesInjected(sessionId: string, data: Record<string, unknown>): Event
  taskResultIndexed(sessionId: string | null, data: Record<string, unknown>): Event
  hookReceived(sessionId: string | null, data: Record<string, unknown>): Event
  qualityCheckCompleted(sessionId: string | null, data: Record<string, unknown>): Event
  sessionHandoffCreated(sessionId: string | null, data: Record<string, unknown>): Event
  teamCompleted(sessionId: string | null, data: Record<string, unknown>): Event
  qualityGateStarted(sessionId: string | null, data: Record<string, unknown>): Event
  qualityGateVerdict(sessionId: string | null, data: Record<string, unknown>): Event
  suggestionSpawnedTeam(sessionId: string | null, data: Record<string, unknown>): Event
  managerDispatchIncomplete(sessionId: string | null, data: Record<string, unknown>): Event
  devNoWork(sessionId: string | null, data: Record<string, unknown>): Event
  agentLaunchStarted(sessionId: string, data: Record<string, unknown>): Event
  agentPromptDelivered(sessionId: string, data: Record<string, unknown>): Event
  agentFirstOutputReceived(sessionId: string, data: Record<string, unknown>): Event
  agentLaunchFailed(sessionId: string, data: Record<string, unknown>): Event
  agentNudgeSent(sessionId: string, data: Record<string, unknown>): Event
  dispatchStarted(sessionId: string | null, data: Record<string, unknown>): Event
  devTurnEnded(sessionId: string | null, data: Record<string, unknown>): Event
  /**
   * Phase 1.5 step 5 — emitted by agent-spawner.ts after every successful
   * ACP `createSession` resolution, carrying the three cold-start latency
   * deltas captured by `AcpClient.timings`. The Step-5b warm-pool design
   * keys on the distribution of `process_spawn_to_initialize_ms` vs
   * `session_new_ms`: if the former dominates, a warm pool wins big; if
   * the latter dominates, a post-initialize/pre-session-new pool only
   * saves a fraction. Payload fields:
   *   - `process_spawn_to_initialize_ms` (number)
   *   - `session_new_ms` (number)
   *   - `cold_start_ms` (number, sum of the two)
   *   - `role` (string), `team_id` (string)
   *   - plus the raw epoch marks for ad-hoc analysis
   */
  agentAcpTiming(sessionId: string, data: Record<string, unknown>): Event
  /**
   * Phase 13.12.32 — emitted by the quality-gate-arbiter after the QG
   * worktree's node_modules bridge runs (whether the bridge succeeded
   * or fell through). Lets operators and the brain see the actual
   * bridge `{linked, reason, missing, binDirRealpath, fallbackAttempted}`
   * payload instead of inferring it from the verdict's findings.
   */
  worktreeProvisioning(sessionId: string | null, data: Record<string, unknown>): Event
  // Phase 13.12.34 — auto-merger events.
  autoMerged(sessionId: string | null, data: Record<string, unknown>): Event
  autoMergeRejected(sessionId: string | null, data: Record<string, unknown>): Event
  gatePublished(sessionId: string | null, data: Record<string, unknown>): Event
  gatePublishFailed(sessionId: string | null, data: Record<string, unknown>): Event
  /**
   * P5c — emitted by the otel-cleanup and telemetry-rotation scheduled
   * task handlers exactly once per tick (including kill-switched skip).
   * Payload: `{task, killSwitched, success, freedBytes?, prunedCounts?, durationMs, error?}`.
   * Event-emit failure must never fail the underlying task — wrap caller
   * sites in try/catch.
   */
  retentionSwept(sessionId: string | null, data: Record<string, unknown>): Event
  // Step 3 (anti-drift) — emitted by north-star-nudge.ts on a session-end
  // whose window had substantive commits but no NORTH_STAR refresh
  // (northStarNudged), and when a later refresh clears the open reminder
  // (northStarNudgeCleared). driftWatchdogRan is emitted by the daily
  // drift-watchdog scheduled task once per tick.
  northStarNudged(sessionId: string | null, data: Record<string, unknown>): Event
  northStarNudgeCleared(sessionId: string | null, data: Record<string, unknown>): Event
  driftWatchdogRan(sessionId: string | null, data: Record<string, unknown>): Event
  since(afterId: number): ReadonlyArray<Event>
  forSession(sessionId: string): ReadonlyArray<Event>
}

function logEvent(
  db: Database.Database,
  dispatcher: EventDispatcher | undefined,
  eventType: string,
  sessionId: string | null,
  data: Record<string, unknown>,
): Event {
  const event = appendEvent(db, {
    event_type: eventType,
    session_id: sessionId,
    payload: JSON.stringify(data),
  })

  if (dispatcher) {
    dispatcher.dispatch({
      id: event.id,
      event_type: eventType as BrokerEventType,
      session_id: sessionId,
      payload: JSON.stringify(data),
      team_id: extractTeamId(data),
      created_at: event.created_at ?? new Date().toISOString(),
    })
  }

  return event
}

export function createEventLog(db: Database.Database, dispatcher?: EventDispatcher): EventLog {
  return {
    sessionRegistered: (sessionId, data) =>
      logEvent(db, dispatcher, 'session_registered', sessionId, data),

    sessionDeregistered: (sessionId, data) =>
      logEvent(db, dispatcher, 'session_deregistered', sessionId, data),

    stateUpdated: (sessionId, data) => logEvent(db, dispatcher, 'state_updated', sessionId, data),

    stateDeleted: (sessionId, data) => logEvent(db, dispatcher, 'state_deleted', sessionId, data),

    brokerStarted: (data) => logEvent(db, dispatcher, 'broker_started', null, data),

    brokerStopped: (data) => logEvent(db, dispatcher, 'broker_stopped', null, data),

    messageSent: (sessionId, data) => logEvent(db, dispatcher, 'message_sent', sessionId, data),

    messageRead: (sessionId, data) => logEvent(db, dispatcher, 'message_read', sessionId, data),

    intentDeclared: (sessionId, data) =>
      logEvent(db, dispatcher, 'intent_declared', sessionId, data),

    intentReleased: (sessionId, data) =>
      logEvent(db, dispatcher, 'intent_released', sessionId, data),

    conflictDetected: (sessionId, data) =>
      logEvent(db, dispatcher, 'conflict_detected', sessionId, data),

    storyCleared: (sessionId, data) => logEvent(db, dispatcher, 'story_cleared', sessionId, data),

    sessionCleared: (sessionId, data) =>
      logEvent(db, dispatcher, 'session_cleared', sessionId, data),

    allCleared: (sessionId, data) => logEvent(db, dispatcher, 'all_cleared', sessionId, data),

    heartbeatReceived: (sessionId, data) =>
      logEvent(db, dispatcher, 'heartbeat_received', sessionId, data),

    zombieDetected: (sessionId, data) =>
      logEvent(db, dispatcher, 'zombie_detected', sessionId, data),

    zombieCleaned: (sessionId, data) => logEvent(db, dispatcher, 'zombie_cleaned', sessionId, data),

    sessionPurged: (sessionId, data) => logEvent(db, dispatcher, 'session_purged', sessionId, data),

    messageDisposition: (sessionId, data) =>
      logEvent(db, dispatcher, 'message_disposition', sessionId, data),

    activityReported: (sessionId, data) =>
      logEvent(db, dispatcher, 'activity_reported', sessionId, data),

    teamCreated: (sessionId, data) => logEvent(db, dispatcher, 'team_created', sessionId, data),

    teamDisbanded: (sessionId, data) => logEvent(db, dispatcher, 'team_disbanded', sessionId, data),

    teamArchived: (sessionId, data) => logEvent(db, dispatcher, 'team_archived', sessionId, data),

    teamPurged: (sessionId, data) => logEvent(db, dispatcher, 'team_purged', sessionId, data),

    teamMemberJoined: (sessionId, data) =>
      logEvent(db, dispatcher, 'team_member_joined', sessionId, data),

    teamMemberLeft: (sessionId, data) =>
      logEvent(db, dispatcher, 'team_member_left', sessionId, data),

    taskCreated: (sessionId, data) => logEvent(db, dispatcher, 'task_created', sessionId, data),

    taskUpdated: (sessionId, data) => logEvent(db, dispatcher, 'task_updated', sessionId, data),

    taskCompleted: (sessionId, data) => logEvent(db, dispatcher, 'task_completed', sessionId, data),

    capabilitiesDeclared: (sessionId, data) =>
      logEvent(db, dispatcher, 'capabilities_declared', sessionId, data),

    agentRespawned: (sessionId, data) =>
      logEvent(db, dispatcher, 'agent_respawned', sessionId, data),

    agentAbandoned: (sessionId, data) =>
      logEvent(db, dispatcher, 'agent_abandoned', sessionId, data),

    manifestApplied: (sessionId, data) =>
      logEvent(db, dispatcher, 'manifest_applied', sessionId, data),

    agentScaledUp: (sessionId, data) =>
      logEvent(db, dispatcher, 'agent_scaled_up', sessionId, data),

    agentScaledDown: (sessionId, data) =>
      logEvent(db, dispatcher, 'agent_scaled_down', sessionId, data),

    usageRecorded: (sessionId, data) => logEvent(db, dispatcher, 'usage_recorded', sessionId, data),

    branchIntentDeclared: (sessionId, data) =>
      logEvent(db, dispatcher, 'branch_intent_declared', sessionId, data),

    branchConflictDetected: (sessionId, data) =>
      logEvent(db, dispatcher, 'branch_conflict_detected', sessionId, data),

    repoBroadcastSent: (sessionId, data) =>
      logEvent(db, dispatcher, 'repo_broadcast_sent', sessionId, data),

    messagesCompacted: (sessionId, data) =>
      logEvent(db, dispatcher, 'messages_compacted', sessionId, data),

    orchestrationPhaseTransitioned: (sessionId, data) =>
      logEvent(db, dispatcher, 'orchestration_phase_transitioned', sessionId, data),

    sessionBranched: (sessionId, data) =>
      logEvent(db, dispatcher, 'session_branched', sessionId, data),

    scratchpadUpdated: (sessionId, data) =>
      logEvent(db, dispatcher, 'scratchpad_updated', sessionId, data),

    messagesInjected: (sessionId, data) =>
      logEvent(db, dispatcher, 'messages_injected', sessionId, data),

    taskResultIndexed: (sessionId, data) =>
      logEvent(db, dispatcher, 'task_result_indexed', sessionId, data),

    hookReceived: (sessionId, data) => logEvent(db, dispatcher, 'hook_received', sessionId, data),

    qualityCheckCompleted: (sessionId, data) =>
      logEvent(db, dispatcher, 'quality_check_completed', sessionId, data),

    sessionHandoffCreated: (sessionId, data) =>
      logEvent(db, dispatcher, 'session_handoff_created', sessionId, data),

    teamCompleted: (sessionId, data) => logEvent(db, dispatcher, 'team_completed', sessionId, data),

    qualityGateStarted: (sessionId, data) =>
      logEvent(db, dispatcher, 'quality_gate_started', sessionId, data),

    qualityGateVerdict: (sessionId, data) =>
      logEvent(db, dispatcher, 'quality_gate_verdict', sessionId, data),

    suggestionSpawnedTeam: (sessionId, data) =>
      logEvent(db, dispatcher, 'suggestion_spawned_team', sessionId, data),

    managerDispatchIncomplete: (sessionId, data) =>
      logEvent(db, dispatcher, 'manager_dispatch_incomplete', sessionId, data),

    devNoWork: (sessionId, data) => logEvent(db, dispatcher, 'dev_no_work', sessionId, data),

    agentLaunchStarted: (sessionId, data) =>
      logEvent(db, dispatcher, 'agent_launch_started', sessionId, data),

    agentPromptDelivered: (sessionId, data) =>
      logEvent(db, dispatcher, 'agent_prompt_delivered', sessionId, data),

    agentFirstOutputReceived: (sessionId, data) =>
      logEvent(db, dispatcher, 'agent_first_output_received', sessionId, data),

    agentLaunchFailed: (sessionId, data) =>
      logEvent(db, dispatcher, 'agent_launch_failed', sessionId, data),

    agentNudgeSent: (sessionId, data) =>
      logEvent(db, dispatcher, 'agent_nudge_sent', sessionId, data),

    dispatchStarted: (sessionId, data) =>
      logEvent(db, dispatcher, 'dispatch_started', sessionId, data),

    devTurnEnded: (sessionId, data) => logEvent(db, dispatcher, 'dev_turn_ended', sessionId, data),

    agentAcpTiming: (sessionId, data) =>
      logEvent(db, dispatcher, 'agent_acp_timing', sessionId, data),

    worktreeProvisioning: (sessionId, data) =>
      logEvent(db, dispatcher, 'worktree_provisioning', sessionId, data),

    autoMerged: (sessionId, data) => logEvent(db, dispatcher, 'auto_merged', sessionId, data),

    autoMergeRejected: (sessionId, data) =>
      logEvent(db, dispatcher, 'auto_merge_rejected', sessionId, data),

    gatePublished: (sessionId, data) => logEvent(db, dispatcher, 'gate_published', sessionId, data),

    gatePublishFailed: (sessionId, data) =>
      logEvent(db, dispatcher, 'gate_publish_failed', sessionId, data),

    retentionSwept: (sessionId, data) =>
      logEvent(db, dispatcher, 'retention_sweep', sessionId, data),

    northStarNudged: (sessionId, data) =>
      logEvent(db, dispatcher, 'north_star_nudged', sessionId, data),

    northStarNudgeCleared: (sessionId, data) =>
      logEvent(db, dispatcher, 'north_star_nudge_cleared', sessionId, data),

    driftWatchdogRan: (sessionId, data) =>
      logEvent(db, dispatcher, 'drift_watchdog_ran', sessionId, data),

    since: (afterId) => getEventsSince(db, afterId),

    forSession: (sessionId) => getEventsBySession(db, sessionId),
  }
}
