import type Database from 'better-sqlite3'
import type { Event } from '../types.js'
import { appendEvent, getEventsSince, getEventsBySession } from '../storage/repositories/event-repository.js'
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
  activityReported(sessionId: string, data: Record<string, unknown>): Event
  teamCreated(sessionId: string | null, data: Record<string, unknown>): Event
  teamDisbanded(sessionId: string | null, data: Record<string, unknown>): Event
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

    stateUpdated: (sessionId, data) =>
      logEvent(db, dispatcher, 'state_updated', sessionId, data),

    stateDeleted: (sessionId, data) =>
      logEvent(db, dispatcher, 'state_deleted', sessionId, data),

    brokerStarted: (data) =>
      logEvent(db, dispatcher, 'broker_started', null, data),

    brokerStopped: (data) =>
      logEvent(db, dispatcher, 'broker_stopped', null, data),

    messageSent: (sessionId, data) =>
      logEvent(db, dispatcher, 'message_sent', sessionId, data),

    messageRead: (sessionId, data) =>
      logEvent(db, dispatcher, 'message_read', sessionId, data),

    intentDeclared: (sessionId, data) =>
      logEvent(db, dispatcher, 'intent_declared', sessionId, data),

    intentReleased: (sessionId, data) =>
      logEvent(db, dispatcher, 'intent_released', sessionId, data),

    conflictDetected: (sessionId, data) =>
      logEvent(db, dispatcher, 'conflict_detected', sessionId, data),

    storyCleared: (sessionId, data) =>
      logEvent(db, dispatcher, 'story_cleared', sessionId, data),

    sessionCleared: (sessionId, data) =>
      logEvent(db, dispatcher, 'session_cleared', sessionId, data),

    allCleared: (sessionId, data) =>
      logEvent(db, dispatcher, 'all_cleared', sessionId, data),

    heartbeatReceived: (sessionId, data) =>
      logEvent(db, dispatcher, 'heartbeat_received', sessionId, data),

    zombieDetected: (sessionId, data) =>
      logEvent(db, dispatcher, 'zombie_detected', sessionId, data),

    zombieCleaned: (sessionId, data) =>
      logEvent(db, dispatcher, 'zombie_cleaned', sessionId, data),

    activityReported: (sessionId, data) =>
      logEvent(db, dispatcher, 'activity_reported', sessionId, data),

    teamCreated: (sessionId, data) =>
      logEvent(db, dispatcher, 'team_created', sessionId, data),

    teamDisbanded: (sessionId, data) =>
      logEvent(db, dispatcher, 'team_disbanded', sessionId, data),

    teamPurged: (sessionId, data) =>
      logEvent(db, dispatcher, 'team_purged', sessionId, data),

    teamMemberJoined: (sessionId, data) =>
      logEvent(db, dispatcher, 'team_member_joined', sessionId, data),

    teamMemberLeft: (sessionId, data) =>
      logEvent(db, dispatcher, 'team_member_left', sessionId, data),

    taskCreated: (sessionId, data) =>
      logEvent(db, dispatcher, 'task_created', sessionId, data),

    taskUpdated: (sessionId, data) =>
      logEvent(db, dispatcher, 'task_updated', sessionId, data),

    taskCompleted: (sessionId, data) =>
      logEvent(db, dispatcher, 'task_completed', sessionId, data),

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

    usageRecorded: (sessionId, data) =>
      logEvent(db, dispatcher, 'usage_recorded', sessionId, data),

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

    since: (afterId) => getEventsSince(db, afterId),

    forSession: (sessionId) => getEventsBySession(db, sessionId),
  }
}
