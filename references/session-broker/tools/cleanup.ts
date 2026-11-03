import type Database from 'better-sqlite3'
import type { EventLog } from '../services/event-log.js'
import { deleteMessagesByStory, deleteMessagesBySession, deleteAllMessages } from '../storage/repositories/message-repository.js'
import { releaseIntentsBySession, deleteAllIntents } from '../storage/repositories/intent-repository.js'
import { deleteStateByStory, deleteStateBySession, deleteAllState } from '../storage/repositories/state-repository.js'
import { deleteAllTasks } from '../storage/repositories/task-repository.js'
import { deleteAllTeams } from '../storage/repositories/team-repository.js'
import { deleteAllRespawnPolicies, deleteAllRespawnHistory } from '../storage/repositories/respawn-repository.js'
import { deleteAllScalingPolicies } from '../storage/repositories/scaling-repository.js'
import { deleteAllUsageRecords } from '../storage/repositories/usage-repository.js'
import { deleteAllBranchIntents } from '../storage/repositories/branch-intent-repository.js'
import { type ToolResult, textResult } from './helpers.js'

interface ClearStoryInput {
  readonly story_id: string
}

export function handleClearStoryContext(
  db: Database.Database,
  eventLog: EventLog,
  input: ClearStoryInput,
): ToolResult {
  const messagesDeleted = deleteMessagesByStory(db, input.story_id)
  const stateDeleted = deleteStateByStory(db, input.story_id)

  eventLog.storyCleared(null, {
    story_id: input.story_id,
    messages_deleted: messagesDeleted,
    state_deleted: stateDeleted,
  })

  return textResult({
    messages_deleted: messagesDeleted,
    state_deleted: stateDeleted,
  })
}

interface ClearSessionInput {
  readonly session_id: string
}

export function handleClearSessionContext(
  db: Database.Database,
  eventLog: EventLog,
  input: ClearSessionInput,
): ToolResult {
  const messagesDeleted = deleteMessagesBySession(db, input.session_id)
  const intentsDeleted = releaseIntentsBySession(db, input.session_id)
  const stateDeleted = deleteStateBySession(db, input.session_id)

  eventLog.sessionCleared(input.session_id, {
    messages_deleted: messagesDeleted,
    intents_deleted: intentsDeleted,
    state_deleted: stateDeleted,
  })

  return textResult({
    messages_deleted: messagesDeleted,
    intents_deleted: intentsDeleted,
    state_deleted: stateDeleted,
  })
}

export function handleClearAll(
  db: Database.Database,
  eventLog: EventLog,
): ToolResult {
  const messagesDeleted = deleteAllMessages(db)
  const intentsDeleted = deleteAllIntents(db)
  const stateDeleted = deleteAllState(db)
  const tasksDeleted = deleteAllTasks(db)
  const respawnPoliciesDeleted = deleteAllRespawnPolicies(db)
  const respawnHistoryDeleted = deleteAllRespawnHistory(db)
  const scalingPoliciesDeleted = deleteAllScalingPolicies(db)
  const usageRecordsDeleted = deleteAllUsageRecords(db)
  const branchIntentsDeleted = deleteAllBranchIntents(db)
  const teamsDeleted = deleteAllTeams(db)

  eventLog.allCleared(null, {
    messages_deleted: messagesDeleted,
    intents_deleted: intentsDeleted,
    state_deleted: stateDeleted,
    tasks_deleted: tasksDeleted,
    teams_deleted: teamsDeleted,
    respawn_policies_deleted: respawnPoliciesDeleted,
    respawn_history_deleted: respawnHistoryDeleted,
    scaling_policies_deleted: scalingPoliciesDeleted,
    usage_records_deleted: usageRecordsDeleted,
    branch_intents_deleted: branchIntentsDeleted,
  })

  return textResult({
    messages_deleted: messagesDeleted,
    intents_deleted: intentsDeleted,
    state_deleted: stateDeleted,
    tasks_deleted: tasksDeleted,
    teams_deleted: teamsDeleted,
    respawn_policies_deleted: respawnPoliciesDeleted,
    respawn_history_deleted: respawnHistoryDeleted,
    scaling_policies_deleted: scalingPoliciesDeleted,
    usage_records_deleted: usageRecordsDeleted,
    branch_intents_deleted: branchIntentsDeleted,
  })
}

export interface ClearContextInput {
  readonly scope: 'story' | 'session' | 'all'
  readonly story_id?: string
  readonly session_id?: string
  readonly caller_session_id?: string
}

export function handleClearContext(
  db: Database.Database,
  eventLog: EventLog,
  input: ClearContextInput,
): ToolResult {
  switch (input.scope) {
    case 'story': {
      if (!input.story_id) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'story_id required when scope is story' }) }], isError: true }
      }
      return handleClearStoryContext(db, eventLog, { story_id: input.story_id })
    }
    case 'session': {
      if (!input.session_id) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'session_id required when scope is session' }) }], isError: true }
      }
      return handleClearSessionContext(db, eventLog, { session_id: input.session_id })
    }
    case 'all':
      return handleClearAll(db, eventLog)
  }
}
