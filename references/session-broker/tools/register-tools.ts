import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type Database from 'better-sqlite3'
import type { EventLog } from '../services/event-log.js'
import type { AgentSpawner } from '../services/agent-spawner.js'
import { createToolRiskGuard } from '../middleware/tool-risk-guard.js'
import { isHighRisk } from '../tool-risk.js'
import { logger } from '../logger.js'
import { applyProfile, type ToolRegistrationMap } from '../tool-filter.js'
import { roleToProfile } from '../tool-profiles.js'
import { type ToolResult, errorResult } from './helpers.js'
import { handleRegisterSession, handleDeregisterSession, handleListSessions } from './session.js'
import { handleGetState, handleSetState } from './state.js'
import { handleSendMessage, handleGetMessages } from './message.js'
import { handleReleaseIntent, handleUnifiedDeclareIntent, handleUnifiedCheckConflicts } from './conflict.js'
import { handleClearContext } from './cleanup.js'
import { handleHeartbeat, handleDetectZombies, handleCleanupZombies } from './heartbeat.js'
import { searchSessions, indexSession, getIndexStats } from '../indexing.js'
import { searchMessages } from '../message-indexing.js'
import {
  handleCreateTeam, handleDisbandTeam, handleJoinTeam,
  handleLeaveTeam, handleListTeamMembers, handleListTeams,
  handlePurgeTeam,
} from './team.js'
import {
  handleCreateTask, handleGetTask, handleListTasks, handleUpdateTask,
} from './task.js'
import { handleGetMemberStats } from './get-member-stats.js'
import { getTeamStatus } from '../storage/repositories/team-repository.js'
import { handleWaitForEvent } from './event-wait.js'
import { handleBrokerInfo } from './broker-info.js'
import { handleGetTeamActivity } from './get-team-activity.js'
import { handleSpawnAgent } from './spawn-agent.js'
import { getTeamTemplate, listTemplateNames } from '../team-templates.js'
import {
  handleDeclareCapabilities,
  handleListCapabilities,
  handleFindCapableAgents,
} from './capability.js'
import { handleFindAgentsByRepo, handleBroadcastToRepo } from './cross-repo.js'
import {
  handleSetRespawnPolicy,
  handleGetRespawnPolicy,
  handleListRespawnHistory,
} from './respawn.js'
import { handleApplyManifest } from './manifest.js'
import { handleSetScalingPolicy, handleGetScalingPolicy } from './scaling.js'
import { handleRecordUsage, handleGetUsageSummary, handleGetTeamBudget } from './usage.js'

import { handleGcDisbandedTeams } from './team-gc.js'
import { handleCompactTeamMessages } from './message-compaction.js'
import { handleQueryHistory } from './history.js'
import { handleBranchSession } from './session-branch.js'
import {
  handleWriteScratchpad,
  handleReadScratchpad,
  handleDeleteScratchpad,
} from './scratchpad.js'
import { transitionSessionStatus, handleGetSessionLifecycle } from './lifecycle.js'
import { SESSION_STATUSES } from '../lifecycle.js'
import {
  handleCreateOrchestrationPlan,
  handleRequestSubTeam,
  handleReportTeamResults,
  handleCheckOrchestrationStatus,
  handleAggregateResults,
  handleTransitionOrchestrationPhase,
  handleGetOrchestrationPhase,
  handleSetTaskPhase,
} from './orchestration.js'

/**
 * Wraps a tool handler with risk-level logging and access control.
 * For high-risk tools, checks caller role via session context.
 * Prioritizes caller_session_id (explicit caller identity) over other
 * session fields which may refer to the operation target.
 */
function createRiskGuardWrapper(riskGuard: ReturnType<typeof createToolRiskGuard>) {
  return function withRiskGuard<T extends Record<string, unknown>>(
    toolName: string,
    handler: (args: T) => ToolResult | Promise<ToolResult>,
  ): (args: T) => ToolResult | Promise<ToolResult> {
    return (args: T) => {
      // Prioritize caller_session_id — it's the explicit caller identity.
      // Other fields (session_id, id, sender_id) may be the operation target.
      const sessionId = typeof args.caller_session_id === 'string' ? args.caller_session_id
        : typeof args.sender_id === 'string' ? args.sender_id
        : typeof args.session_id === 'string' ? args.session_id
        : typeof args.id === 'string' ? args.id
        : undefined

      riskGuard.logToolInvocation(toolName, sessionId)

      if (isHighRisk(toolName)) {
        if (!sessionId) {
          logger.warn(
            { tool: toolName },
            'High-risk tool invoked without session context — role check skipped',
          )
        } else {
          const check = riskGuard.check(toolName, sessionId)
          if (!check.allowed) {
            return errorResult(check.reason ?? 'Insufficient permissions for high-risk tool')
          }
        }
      }

      return handler(args)
    }
  }
}

export function registerTools(mcpServer: McpServer, db: Database.Database, eventLog: EventLog, spawner?: AgentSpawner): ToolRegistrationMap {
  const riskGuard = createToolRiskGuard({ logger, db })
  const withRiskGuard = createRiskGuardWrapper(riskGuard)

  // toolMap is populated at the end of this function from McpServer internals.
  // Handlers capture it by reference — safe because handlers run async after registration.
  const toolMap: ToolRegistrationMap = new Map()

  mcpServer.registerTool('register_session', {
    description: 'Register a new session with the broker',
    inputSchema: {
      id: z.string().describe('Unique session identifier'),
      purpose: z.string().describe('What this session is working on'),
      working_dir: z.string().describe('Working directory path'),
      worktree: z.string().nullable().describe('Git worktree path, or null'),
      repo_context: z.string().nullable().optional().describe('Repository context in owner/repo format (e.g. "github/everything-copilot"), or null'),
    },
  }, async (args) => {
    const result = handleRegisterSession(db, eventLog, {
      id: args.id,
      purpose: args.purpose,
      working_dir: args.working_dir,
      worktree: args.worktree,
      repo_context: args.repo_context ?? null,
    })

    // Auto-index for semantic search (Task 2.3)
    indexSession(db, args.id, { forceReindex: false }).catch((err) => {
      logger.error({ sessionId: args.id, err }, 'Failed to index session')
    })

    return result
  })

  mcpServer.registerTool('deregister_session', {
    description: 'Deregister a session from the broker',
    inputSchema: {
      id: z.string().describe('Session ID to deregister'),
      caller_session_id: z.string().optional().describe('Session ID of the caller for role-based access control (distinct from target id)'),
    },
  }, withRiskGuard('deregister_session', async (args: { id: string; caller_session_id?: string }) => {
    return handleDeregisterSession(db, eventLog, { id: args.id })
  }))

  mcpServer.registerTool('list_sessions', {
    description: 'List all registered sessions',
    inputSchema: {
      status: z.string().optional().describe('Filter by status: active, paused, completed, zombie'),
      include_archived: z.boolean().optional().describe('Include archived sessions (default: false). Archived sessions are excluded from default queries.'),
    },
  }, async (args) => {
    return handleListSessions(db, { status: args.status, include_archived: args.include_archived })
  })

  mcpServer.registerTool('get_state', {
    description: 'Get a shared state value by key',
    inputSchema: {
      key: z.string().describe('State key to retrieve'),
    },
  }, async (args) => {
    return handleGetState(db, { key: args.key })
  })

  mcpServer.registerTool('set_state', {
    description: 'Set a shared state value',
    inputSchema: {
      key: z.string().describe('State key'),
      value: z.string().describe('State value (JSON string recommended)'),
      story_id: z.string().nullable().describe('Story/effort ID for scoped cleanup'),
      session_id: z.string().nullable().describe('Session that owns this state'),
    },
  }, async (args) => {
    return handleSetState(db, eventLog, {
      key: args.key,
      value: args.value,
      story_id: args.story_id,
      session_id: args.session_id,
    })
  })

  // Phase 2: Message passing tools
  mcpServer.registerTool('send_message', {
    description: 'Send a message to another session or broadcast to all',
    inputSchema: {
      sender_id: z.string().describe('Session ID of the sender'),
      receiver_id: z.string().nullable().describe('Session ID of receiver, or null for broadcast'),
      content: z.string().describe('Message content'),
      story_id: z.string().nullable().optional().default(null).describe('Story/effort ID for scoped cleanup'),
      reply_to: z.string().nullable().optional().describe('Message ID to reply to (for threading)'),
    },
  }, async (args) => {
    return handleSendMessage(db, eventLog, {
      sender_id: args.sender_id,
      receiver_id: args.receiver_id,
      content: args.content,
      story_id: args.story_id,
      reply_to: args.reply_to,
    })
  })

  mcpServer.registerTool('get_messages', {
    description: 'Get messages for a session (includes broadcasts)',
    inputSchema: {
      session_id: z.string().describe('Session ID to get messages for'),
      unread_only: z.boolean().optional().describe('Only return unread messages'),
      since: z.string().optional().describe('Only return messages after this ISO timestamp'),
      mark_read: z.boolean().optional().describe('Mark returned messages as read'),
    },
  }, async (args) => {
    return handleGetMessages(db, eventLog, {
      session_id: args.session_id,
      unread_only: args.unread_only,
      since: args.since,
      mark_read: args.mark_read,
    })
  })

  // Phase 2: Conflict detection tools (unified — scope selects file vs. branch)
  mcpServer.registerTool('declare_intent', {
    description: 'Declare intent to work on a file. Scope "file" declares a file-level intent (returns conflict warnings). Scope "branch" declares a branch-level intent for git-aware conflict detection.',
    inputSchema: {
      scope: z.enum(['file', 'branch']).default('file').describe('Intent scope: "file" for file-level intent, "branch" for git-branch-level intent'),
      session_id: z.string().describe('Session ID declaring intent'),
      file_path: z.string().describe('File path being worked on'),
      intent: z.string().optional().describe('Type of intent: edit, read, create, or delete (file scope only)'),
      branch: z.string().optional().describe('Git branch name (required when scope is "branch")'),
      commit_sha: z.string().nullable().optional().describe('Current commit SHA (branch scope only)'),
    },
  }, async (args) => {
    return handleUnifiedDeclareIntent(db, eventLog, {
      scope: args.scope,
      session_id: args.session_id,
      file_path: args.file_path,
      intent: args.intent,
      branch: args.branch,
      commit_sha: args.commit_sha,
    })
  })

  mcpServer.registerTool('release_intent', {
    description: 'Release intent on a file (done working on it)',
    inputSchema: {
      session_id: z.string().describe('Session ID releasing intent'),
      file_path: z.string().describe('File path to release'),
    },
  }, async (args) => {
    return handleReleaseIntent(db, eventLog, {
      session_id: args.session_id,
      file_path: args.file_path,
    })
  })

  mcpServer.registerTool('check_conflicts', {
    description: 'Check for conflicting intents. Scope "file" checks file-level conflicts across sessions. Scope "branch" checks branch-level conflicts indicating potential merge issues.',
    inputSchema: {
      scope: z.enum(['file', 'branch']).default('file').describe('Conflict scope: "file" for file-level, "branch" for git-branch-level'),
      file_path: z.string().optional().describe('Specific file to check, or omit for all conflicts'),
      branch: z.string().optional().describe('Filter by branch name (branch scope only)'),
    },
  }, async (args) => {
    return handleUnifiedCheckConflicts(db, {
      scope: args.scope,
      file_path: args.file_path,
      branch: args.branch,
    })
  })

  // Phase 2: Cleanup tool (unified — replaces clear_story_context, clear_session_context, clear_all)
  mcpServer.registerTool('clear_context', {
    description: 'Clear messages, intents, and state. Scope controls what is cleared: "story" clears messages/state for a story, "session" clears messages/intents/state for a session, "all" performs a full reset.',
    inputSchema: {
      scope: z.enum(['story', 'session', 'all']).describe('What to clear: story (messages+state), session (messages+intents+state), all (full reset)'),
      story_id: z.string().optional().describe('Story ID to clear (required when scope is "story")'),
      session_id: z.string().optional().describe('Session ID to clear (required when scope is "session")'),
      caller_session_id: z.string().optional().describe('Session ID of the caller for role-based access control'),
    },
  }, withRiskGuard('clear_context', async (args: { scope: 'story' | 'session' | 'all'; story_id?: string; session_id?: string; caller_session_id?: string }) => {
    return handleClearContext(db, eventLog, {
      scope: args.scope,
      story_id: args.story_id,
      session_id: args.session_id,
      caller_session_id: args.caller_session_id,
    })
  }))

  // Phase 3: Heartbeat and zombie detection tools
  mcpServer.registerTool('heartbeat', {
    description: 'Send heartbeat to keep session alive',
    inputSchema: {
      session_id: z.string().describe('Session ID sending heartbeat'),
    },
  }, async (args) => {
    return handleHeartbeat(db, eventLog, { session_id: args.session_id })
  })

  mcpServer.registerTool('detect_zombies', {
    description: 'Detect sessions with stale heartbeats (read-only)',
    inputSchema: {
      threshold_seconds: z.number().optional().describe('Seconds since last heartbeat (default: 20)'),
    },
  }, async (args) => {
    return handleDetectZombies(db, { threshold_seconds: args.threshold_seconds })
  })

  mcpServer.registerTool('cleanup_zombies', {
    description: 'Clean up zombie sessions (release intents, mark status)',
    inputSchema: {
      grace_seconds: z.number().optional().describe('Grace period before cleanup (default: 300)'),
    },
  }, async (args) => {
    return handleCleanupZombies(db, eventLog, { grace_seconds: args.grace_seconds })
  })

  // Phase 4: Semantic search (unified — type selects sessions vs. messages)
  mcpServer.registerTool('search', {
    description: 'Semantic search across sessions or messages. Type "sessions" finds sessions by purpose/context similarity. Type "messages" finds relevant conversations.',
    inputSchema: {
      type: z.enum(['sessions', 'messages']).describe('What to search: "sessions" or "messages"'),
      query: z.string().describe('Search query text'),
      session_id: z.string().optional().describe('Filter by session ID (messages type only)'),
      top_k: z.number().optional().describe('Maximum results to return (default: 5 for sessions, 10 for messages)'),
      min_similarity: z.number().optional().describe('Minimum similarity threshold 0-1 (default: 0.3)'),
    },
  }, async (args) => {
    if (args.type === 'sessions') {
      const results = await searchSessions(db, args.query, args.top_k ?? 5, args.min_similarity ?? 0.3)
      return { content: [{ type: 'text' as const, text: JSON.stringify({ results, query: args.query }, null, 2) }] }
    }
    const results = await searchMessages(db, args.query, {
      session_id: args.session_id,
      top_k: args.top_k,
      min_similarity: args.min_similarity,
    })
    return { content: [{ type: 'text' as const, text: JSON.stringify({ results, query: args.query }, null, 2) }] }
  })

  mcpServer.registerTool('index_session', {
    description: 'Generate or regenerate embedding for a session',
    inputSchema: {
      session_id: z.string().describe('Session ID to index'),
      force: z.boolean().optional().describe('Force re-indexing even if already indexed'),
    },
  }, async (args) => {
    const indexed = await indexSession(db, args.session_id, { forceReindex: args.force ?? false })
    return {
      content: [{ type: 'text', text: JSON.stringify({ indexed, session_id: args.session_id }) }],
    }
  })

  mcpServer.registerTool('get_index_stats', {
    description: 'Get semantic search index statistics',
    inputSchema: {},
  }, async () => {
    const stats = getIndexStats(db)
    return {
      content: [{ type: 'text', text: JSON.stringify(stats) }],
    }
  })

  // Phase 5: Agent Teams — Team Management
  mcpServer.registerTool('create_team', {
    description: 'Create a new agent team for coordinating multi-session work',
    inputSchema: {
      name: z.string().describe('Unique team name'),
      description: z.string().optional().describe('Team purpose/description'),
    },
  }, async (args) => {
    return handleCreateTeam(db, eventLog, {
      name: args.name,
      description: args.description,
    })
  })

  mcpServer.registerTool('disband_team', {
    description: 'Disband a team, removing all members and tasks',
    inputSchema: {
      team_id: z.string().describe('Team ID to disband'),
      caller_session_id: z.string().optional().describe('Session ID of the caller for role-based access control'),
    },
  }, withRiskGuard('disband_team', async (args: { team_id: string; caller_session_id?: string }) => {
    return handleDisbandTeam(db, eventLog, { team_id: args.team_id })
  }))

  mcpServer.registerTool('purge_team', {
    description: 'Fully purge a team: clear all member session data, deregister sessions, then disband team and delete tasks',
    inputSchema: {
      team_id: z.string().describe('Team ID to purge completely'),
      caller_session_id: z.string().optional().describe('Session ID of the caller for role-based access control'),
    },
  }, withRiskGuard('purge_team', async (args: { team_id: string; caller_session_id?: string }) => {
    return handlePurgeTeam(db, eventLog, { team_id: args.team_id })
  }))

  mcpServer.registerTool('list_teams', {
    description: 'List all teams, optionally filtered by status',
    inputSchema: {
      status: z.string().optional().describe('Filter by status: active, paused, disbanded'),
      include_archived: z.boolean().optional().describe('Include archived teams (default: false). Archived teams are excluded from default queries.'),
    },
  }, async (args) => {
    return handleListTeams(db, { status: args.status, include_archived: args.include_archived })
  })

  mcpServer.registerTool('join_team', {
    description: 'Add a session as a member of a team',
    inputSchema: {
      team_id: z.string().describe('Team ID to join'),
      session_id: z.string().describe('Session ID of the agent joining'),
      name: z.string().describe('Display name for the agent'),
      role: z.string().optional().describe('Role: lead, dev, qa, reviewer, general, manager, pm, scrum-master, orchestrator, or admin'),
      agent_type: z.string().optional().describe('Agent type/profile name'),
    },
  }, async (args, extra) => {
    const result = handleJoinTeam(db, eventLog, {
      team_id: args.team_id,
      session_id: args.session_id,
      name: args.name,
      role: args.role,
      agent_type: args.agent_type,
    })

    // Apply role-based tool profile — upgrade from bootstrap to role's profile
    if (!result.isError) {
      const profile = roleToProfile(args.role)
      applyProfile(toolMap, profile)
      logger.info({ sessionId: args.session_id, role: args.role, profile }, 'Applied tool profile on join_team')
      extra.sendNotification({ method: 'notifications/tools/list_changed' }).catch(() => {
        // Best-effort: notification failure shouldn't break the join
      })
    }

    return result
  })

  mcpServer.registerTool('leave_team', {
    description: 'Remove a session from a team',
    inputSchema: {
      team_id: z.string().describe('Team ID to leave'),
      session_id: z.string().describe('Session ID of the agent leaving'),
    },
  }, async (args, extra) => {
    const result = handleLeaveTeam(db, eventLog, {
      team_id: args.team_id,
      session_id: args.session_id,
    })

    // Revert to bootstrap profile — agent no longer has team role
    if (!result.isError) {
      applyProfile(toolMap, 'bootstrap')
      logger.info({ sessionId: args.session_id }, 'Reverted to bootstrap profile on leave_team')
      extra.sendNotification({ method: 'notifications/tools/list_changed' }).catch(() => {
        // Best-effort
      })
    }

    return result
  })

  mcpServer.registerTool('list_team_members', {
    description: 'List all members of a team with their roles and status',
    inputSchema: {
      team_id: z.string().describe('Team ID to list members for'),
    },
  }, async (args) => {
    return handleListTeamMembers(db, { team_id: args.team_id })
  })

  // Phase 5: Agent Teams — Task Management
  mcpServer.registerTool('create_task', {
    description: 'Create a task on a team board',
    inputSchema: {
      team_id: z.string().describe('Team ID the task belongs to'),
      subject: z.string().describe('Brief task title in imperative form'),
      description: z.string().optional().describe('Detailed task description'),
      active_form: z.string().optional().describe('Present continuous form for progress display'),
    },
  }, async (args) => {
    return handleCreateTask(db, eventLog, {
      team_id: args.team_id,
      subject: args.subject,
      description: args.description,
      active_form: args.active_form,
    })
  })

  mcpServer.registerTool('get_task', {
    description: 'Get full details of a task including dependencies',
    inputSchema: {
      task_id: z.number().describe('Task ID to retrieve'),
    },
  }, async (args) => {
    return handleGetTask(db, { task_id: args.task_id })
  })

  mcpServer.registerTool('list_tasks', {
    description: 'List tasks for a team, optionally filtered by status',
    inputSchema: {
      team_id: z.string().describe('Team ID to list tasks for'),
      status: z.string().optional().describe('Filter: pending, in_progress, completed, deleted'),
    },
  }, async (args) => {
    return handleListTasks(db, {
      team_id: args.team_id,
      status: args.status,
    })
  })

  mcpServer.registerTool('update_task', {
    description: 'Update task status, owner, or details',
    inputSchema: {
      task_id: z.number().describe('Task ID to update'),
      status: z.string().optional().describe('New status: pending, in_progress, completed, deleted'),
      owner: z.string().optional().describe('Agent name to assign task to'),
      subject: z.string().optional().describe('Updated task title'),
      description: z.string().optional().describe('Updated description'),
      active_form: z.string().optional().describe('Updated progress display text'),
      add_blocks: z.array(z.number()).optional().describe('Task IDs that this task blocks'),
      add_blocked_by: z.array(z.number()).optional().describe('Task IDs that block this task'),
    },
  }, async (args) => {
    return handleUpdateTask(db, eventLog, {
      task_id: args.task_id,
      status: args.status,
      owner: args.owner,
      subject: args.subject,
      description: args.description,
      active_form: args.active_form,
      add_blocks: args.add_blocks,
      add_blocked_by: args.add_blocked_by,
    })
  })

  mcpServer.registerTool('get_team_status', {
    description: 'Get a summary of team status including member count, task counts, and idle flag',
    inputSchema: {
      team_id: z.string().describe('Team ID to get status for'),
    },
  }, async (args) => {
    const status = getTeamStatus(db, args.team_id)
    if (!status) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Team '${args.team_id}' not found` }) }], isError: true }
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(status) }] }
  })

  mcpServer.registerTool('get_member_stats', {
    description: 'Get per-member performance stats for a team (messages sent, tasks completed/in-progress, avg task duration, active intents, last heartbeat)',
    inputSchema: {
      team_id: z.string().describe('Team ID to get member stats for'),
    },
  }, async (args) => {
    return handleGetMemberStats(db, { team_id: args.team_id })
  })

  // Stream 7: Real-time event waiting
  mcpServer.registerTool('wait_for_event', {
    description: 'Block until matching events appear (long-poll). Replaces sleep-poll loops for faster agent coordination.',
    inputSchema: {
      after_event_id: z.number().describe('Only return events with ID greater than this (use 0 for all, or last_event_id from previous call)'),
      event_types: z.array(z.string()).optional().describe('Filter by event types (e.g. ["task_completed", "message_sent"])'),
      session_id: z.string().optional().describe('Filter events by session ID'),
      timeout_seconds: z.number().optional().describe('Max seconds to wait (default: 30, max: 55)'),
    },
  }, async (args) => {
    return handleWaitForEvent(db, eventLog, {
      after_event_id: args.after_event_id,
      event_types: args.event_types,
      session_id: args.session_id,
      timeout_seconds: args.timeout_seconds,
    })
  })

  // Stream 8: Broker observability
  mcpServer.registerTool('broker_info', {
    description: 'Get broker metadata: version, uptime, and counts of active sessions, teams, and tasks',
    inputSchema: {},
  }, async () => {
    return handleBrokerInfo(db)
  })

  // Stream 9: Team activity feed
  mcpServer.registerTool('get_team_activity', {
    description: 'Get chronological activity feed for a team (member joins/leaves, task changes, messages, conflicts)',
    inputSchema: {
      team_id: z.string().describe('Team ID to get activity for'),
      limit: z.number().optional().describe('Max events to return (default 50)'),
      offset: z.number().optional().describe('Offset for pagination'),
      event_types: z.array(z.string()).optional().describe('Filter by event types (e.g. ["task_updated", "message_sent"])'),
      since: z.string().optional().describe('Only return events after this ISO timestamp'),
    },
  }, async (args) => {
    return handleGetTeamActivity(db, {
      team_id: args.team_id,
      limit: args.limit,
      offset: args.offset,
      event_types: args.event_types,
      since: args.since,
    })
  })

  mcpServer.registerTool('spawn_agent', {
    description: 'Spawn a new teammate agent in a tmux window. The agent starts immediately with the given prompt. Requires tmux to be available.',
    inputSchema: {
      team_id: z.string().describe('Team UUID to assign the agent to (from create_team response)'),
      name: z.string().describe('Agent name (e.g. "dev-1", "qa-1")'),
      role: z.string().optional().describe('Role: lead, dev, qa, reviewer, general, manager, pm, or scrum-master (default: dev)'),
      prompt: z.string().optional().describe('Initial task prompt for the agent'),
      agent: z.string().optional().describe('Agent profile to use (default: teammate)'),
      working_dir: z.string().optional().describe('Working directory for the agent. Defaults to the broker server CWD. Set this to the target project path when orchestrating work on a different project.'),
      caller_session_id: z.string().optional().describe('Session ID of the caller for role-based access control'),
    },
  }, withRiskGuard('spawn_agent', async (args: { team_id: string; name: string; role?: string; prompt?: string; agent?: string; working_dir?: string; caller_session_id?: string }) => {
    return handleSpawnAgent(db, eventLog, {
      team_id: args.team_id,
      name: args.name,
      role: args.role,
      prompt: args.prompt,
      agent: args.agent,
      working_dir: args.working_dir,
    }, spawner)
  }))

  mcpServer.registerTool('get_team_template', {
    description: 'Get a team composition template by name. Returns the role composition for a given task type (e.g. feature, bugfix, research, full).',
    inputSchema: {
      template_name: z.string().describe('Template name (e.g. "feature", "bugfix", "research", "full")'),
    },
  }, async (args) => {
    const template = getTeamTemplate(args.template_name)
    if (!template) {
      const available = listTemplateNames()
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: `Unknown template '${args.template_name}'. Available: ${available.join(', ')}` }) }],
        isError: true,
      }
    }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(template, null, 2) }],
    }
  })

  // Stream 12: Agent Capabilities
  mcpServer.registerTool('declare_capabilities', {
    description: 'Declare capabilities for an agent session (e.g. typescript, testing, security-review). Idempotent — re-declaring existing capabilities is safe.',
    inputSchema: {
      session_id: z.string().describe('Session ID declaring capabilities'),
      capabilities: z.array(z.string()).describe('List of capability strings (e.g. ["typescript", "testing"])'),
    },
  }, async (args) => {
    return handleDeclareCapabilities(db, eventLog, {
      session_id: args.session_id,
      capabilities: args.capabilities,
    })
  })

  mcpServer.registerTool('list_capabilities', {
    description: 'List all capabilities declared by a session',
    inputSchema: {
      session_id: z.string().describe('Session ID to list capabilities for'),
    },
  }, async (args) => {
    return handleListCapabilities(db, { session_id: args.session_id })
  })

  mcpServer.registerTool('find_capable_agents', {
    description: 'Find active agent sessions that have a specific capability or all of multiple capabilities',
    inputSchema: {
      capability: z.string().optional().describe('Single capability to search for'),
      capabilities: z.array(z.string()).optional().describe('Multiple capabilities — returns agents with ALL of these'),
    },
  }, async (args) => {
    return handleFindCapableAgents(db, {
      capability: args.capability,
      capabilities: args.capabilities,
    })
  })

  // Cross-Repo Message Routing
  mcpServer.registerTool('find_agents_by_repo', {
    description: 'Find all active agent sessions registered in a specific repository context',
    inputSchema: {
      repo_context: z.string().describe('Repository context in owner/repo format (e.g. "contoso/storefront")'),
    },
  }, async (args) => {
    return handleFindAgentsByRepo(db, { repo_context: args.repo_context })
  })

  mcpServer.registerTool('broadcast_to_repo', {
    description: 'Send a message to all active agents in a specific repository context',
    inputSchema: {
      sender_id: z.string().describe('Session ID of the sender'),
      repo_context: z.string().describe('Repository context to broadcast to (e.g. "contoso/storefront")'),
      content: z.string().describe('Message content to broadcast'),
    },
  }, withRiskGuard('broadcast_to_repo', async (args: { sender_id: string; repo_context: string; content: string }) => {
    return handleBroadcastToRepo(db, eventLog, {
      sender_id: args.sender_id,
      repo_context: args.repo_context,
      content: args.content,
    })
  }))

  // Stream 10 + P1: Unified policy management (set_policy replaces set_respawn_policy + set_scaling_policy)
  mcpServer.registerTool('set_policy', {
    description: 'Configure a team policy. Type "respawn" sets auto-respawn policy (min agent count, retries, backoff). Type "scaling" sets auto-scaling policy (min/max counts, thresholds, cooldown).',
    inputSchema: {
      type: z.enum(['respawn', 'scaling']).describe('Policy type: "respawn" or "scaling"'),
      team_id: z.string().describe('Team ID to configure'),
      role: z.string().describe('Role to set policy for (e.g. dev, qa, lead)'),
      min_count: z.number().optional().describe('Minimum agent count for this role'),
      max_retries: z.number().optional().describe('Max respawn attempts before abandoning (respawn only)'),
      backoff_base_ms: z.number().optional().describe('Base backoff delay in ms (respawn only)'),
      max_count: z.number().optional().describe('Maximum agent count (scaling only)'),
      scale_up_threshold: z.number().optional().describe('Pending task count that triggers scale-up (scaling only)'),
      scale_down_threshold: z.number().optional().describe('Pending task count at or below which to scale down (scaling only)'),
      cooldown_ms: z.number().optional().describe('Cooldown between scaling actions in ms (scaling only)'),
      enabled: z.boolean().optional().describe('Enable/disable the policy (default: true)'),
      caller_session_id: z.string().optional().describe('Session ID of the caller for role-based access control'),
    },
  }, withRiskGuard('set_policy', async (args: {
    type: 'respawn' | 'scaling'
    team_id: string
    role: string
    min_count?: number
    max_retries?: number
    backoff_base_ms?: number
    max_count?: number
    scale_up_threshold?: number
    scale_down_threshold?: number
    cooldown_ms?: number
    enabled?: boolean
    caller_session_id?: string
  }) => {
    if (args.type === 'respawn') {
      return handleSetRespawnPolicy(db, eventLog, {
        team_id: args.team_id,
        role: args.role,
        min_count: args.min_count,
        max_retries: args.max_retries,
        backoff_base_ms: args.backoff_base_ms,
        enabled: args.enabled,
      })
    }
    return handleSetScalingPolicy(db, eventLog, {
      team_id: args.team_id,
      role: args.role,
      min_count: args.min_count,
      max_count: args.max_count,
      scale_up_threshold: args.scale_up_threshold,
      scale_down_threshold: args.scale_down_threshold,
      cooldown_ms: args.cooldown_ms,
      enabled: args.enabled,
    })
  }))

  // Unified get_policy replaces get_respawn_policy + get_scaling_policy
  mcpServer.registerTool('get_policy', {
    description: 'Get team policies. Type "respawn" returns auto-respawn policies. Type "scaling" returns auto-scaling policies.',
    inputSchema: {
      type: z.enum(['respawn', 'scaling']).describe('Policy type: "respawn" or "scaling"'),
      team_id: z.string().describe('Team ID to get policies for'),
    },
  }, async (args) => {
    if (args.type === 'respawn') {
      return handleGetRespawnPolicy(db, { team_id: args.team_id })
    }
    return handleGetScalingPolicy(db, { team_id: args.team_id })
  })

  mcpServer.registerTool('list_respawn_history', {
    description: 'List respawn attempts for a team, showing successes and failures',
    inputSchema: {
      team_id: z.string().describe('Team ID to list history for'),
      limit: z.number().optional().describe('Max entries to return (default: 50)'),
      status: z.string().optional().describe('Filter by status: pending, spawned, failed, abandoned'),
    },
  }, async (args) => {
    return handleListRespawnHistory(db, {
      team_id: args.team_id,
      limit: args.limit,
      status: args.status,
    })
  })

  // Stream 11: Declarative Team Manifests
  mcpServer.registerTool('apply_manifest', {
    description: 'Apply a YAML team manifest to create or reconcile a team. Creates team if missing, spawns agents to match role counts, creates tasks with dependencies, and sets respawn policies.',
    inputSchema: {
      manifest_yaml: z.string().describe('YAML string containing the team manifest'),
      caller_session_id: z.string().optional().describe('Session ID of the caller for role-based access control'),
    },
  }, withRiskGuard('apply_manifest', async (args: { manifest_yaml: string; caller_session_id?: string }) => {
    return handleApplyManifest(db, eventLog, {
      manifest_yaml: args.manifest_yaml,
    })
  }))

  // P1: Token/Cost Tracking
  mcpServer.registerTool('record_usage', {
    description: 'Record token usage and cost for an agent session',
    inputSchema: {
      session_id: z.string().describe('Session ID reporting usage'),
      tokens_in: z.number().describe('Input tokens consumed'),
      tokens_out: z.number().describe('Output tokens generated'),
      cost_usd: z.number().describe('Cost in USD'),
      team_id: z.string().nullable().optional().describe('Team ID for team-level aggregation'),
      task_id: z.number().nullable().optional().describe('Task ID for task-level aggregation'),
      model: z.string().nullable().optional().describe('Model name (e.g. claude-sonnet-4-5-20250929)'),
    },
  }, async (args) => {
    return handleRecordUsage(db, eventLog, {
      session_id: args.session_id,
      tokens_in: args.tokens_in,
      tokens_out: args.tokens_out,
      cost_usd: args.cost_usd,
      team_id: args.team_id,
      task_id: args.task_id,
      model: args.model,
    })
  })

  // Unified get_usage replaces get_usage_summary + get_team_budget
  mcpServer.registerTool('get_usage', {
    description: 'Get token usage and cost data. Scope "summary" returns aggregated usage by session/team/task. Scope "team_budget" returns total usage for a team.',
    inputSchema: {
      scope: z.enum(['summary', 'team_budget']).describe('What to retrieve: "summary" for aggregated usage, "team_budget" for team total'),
      session_id: z.string().optional().describe('Session ID to get usage for (summary scope)'),
      team_id: z.string().optional().describe('Team ID to get usage for (both scopes — required for team_budget)'),
      task_id: z.number().optional().describe('Task ID to get usage for (summary scope)'),
    },
  }, async (args) => {
    if (args.scope === 'team_budget') {
      if (!args.team_id) {
        return errorResult('team_id is required when scope is "team_budget"')
      }
      return handleGetTeamBudget(db, { team_id: args.team_id })
    }
    return handleGetUsageSummary(db, {
      session_id: args.session_id,
      team_id: args.team_id,
      task_id: args.task_id,
    })
  })

  // Team GC: garbage-collect disbanded teams
  mcpServer.registerTool('gc_disbanded_teams', {
    description: 'Garbage-collect disbanded teams older than a TTL. Moves data to history tables, then deletes from active tables. History records expire after HISTORY_RETENTION_DAYS (default: 7).',
    inputSchema: {
      ttl_seconds: z.number().optional().describe('Only purge teams disbanded longer than this many seconds ago (default: 86400 = 24 hours)'),
      caller_session_id: z.string().optional().describe('Session ID of the caller for role-based access control'),
    },
  }, withRiskGuard('gc_disbanded_teams', async (args: { ttl_seconds?: number; caller_session_id?: string }) => {
    return handleGcDisbandedTeams(db, eventLog, {
      ttl_seconds: args.ttl_seconds,
    })
  }))

  mcpServer.registerTool('compact_team_messages', {
    description: 'Compact messages for a team. Archives old messages to history, creates a digest summary, and retains recent messages. Uses circuit breaker to prevent frequent re-compaction.',
    inputSchema: {
      team_id: z.string().describe('Team ID to compact messages for'),
      threshold: z.number().optional().describe('Message count threshold before compaction triggers (default: 100)'),
      retain_recent: z.number().optional().describe('Number of recent messages to retain (default: 20)'),
      caller_session_id: z.string().optional().describe('Session ID of the caller for role-based access control'),
    },
  }, withRiskGuard('compact_team_messages', async (args: { team_id: string; threshold?: number; retain_recent?: number; caller_session_id?: string }) => {
    return handleCompactTeamMessages(db, eventLog, {
      team_id: args.team_id,
      threshold: args.threshold,
      retain_recent: args.retain_recent,
    })
  }))

  // History: query archived teams/sessions/tasks/messages
  mcpServer.registerTool('query_history', {
    description: 'Query history tables to review past teams, sessions, tasks, or messages that were purged from active tables. Useful for auditing and reporting.',
    inputSchema: {
      type: z.enum(['teams', 'sessions', 'tasks', 'messages']).describe('Type of history to query'),
      limit: z.number().optional().describe('Max records to return (default: 50)'),
      since: z.string().optional().describe('Only return records purged after this ISO timestamp'),
      name: z.string().optional().describe('Filter teams by name (substring match)'),
      team_id: z.string().optional().describe('Filter tasks by team ID'),
      session_id: z.string().optional().describe('Filter messages by session ID'),
    },
  }, async (args) => {
    return handleQueryHistory(db, {
      type: args.type,
      limit: args.limit,
      since: args.since,
      name: args.name,
      team_id: args.team_id,
      session_id: args.session_id,
    })
  })

  // Lifecycle: get session status and valid transitions
  mcpServer.registerTool('get_session_lifecycle', {
    description: 'Returns the current lifecycle status of a session and its valid next transitions. Useful for orchestrators to understand what actions are available.',
    inputSchema: {
      session_id: z.string().describe('Session ID to inspect'),
    },
  }, async (args) => {
    return handleGetSessionLifecycle(db, { session_id: args.session_id })
  })

  // Lifecycle: transition a session to a new status
  mcpServer.registerTool('transition_session', {
    description: 'Transition a session to a new lifecycle status. Validates the transition against the state machine and emits a session.transition event.',
    inputSchema: {
      session_id: z.string().describe('Session ID to transition'),
      to: z.enum(SESSION_STATUSES).describe('Target status (e.g. active, working, reporting, idle, completed, paused)'),
    },
  }, async (args) => {
    try {
      const session = transitionSessionStatus(db, eventLog, args.session_id, args.to)
      return { content: [{ type: 'text' as const, text: JSON.stringify(session) }] }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true }
    }
  })

  // Orchestration Protocol tools
  mcpServer.registerTool('create_orchestration_plan', {
    description: 'Create an orchestration plan with a root team and initial tasks. Used by the orchestrator to set up coordinated work.',
    inputSchema: {
      orchestrator_session_id: z.string().describe('Session ID of the orchestrator'),
      team_name: z.string().describe('Name for the root team'),
      tasks: z.array(z.object({
        description: z.string().describe('Task description'),
        repo_context: z.string().optional().describe('Repository context (e.g. org/repo)'),
      })).describe('Array of tasks to create'),
    },
  }, async (args) => {
    return handleCreateOrchestrationPlan(db, eventLog, args)
  })

  mcpServer.registerTool('request_sub_team', {
    description: 'Request a sub-team for cross-repo or delegated work. Creates a child team under the specified parent.',
    inputSchema: {
      parent_team_id: z.string().describe('ID of the parent team'),
      name: z.string().describe('Name for the sub-team'),
      repo_context: z.string().describe('Repository context for the sub-team'),
      tasks: z.array(z.object({
        description: z.string().describe('Task description'),
      })).describe('Tasks to assign to the sub-team'),
    },
  }, async (args) => {
    return handleRequestSubTeam(db, eventLog, args)
  })

  mcpServer.registerTool('report_team_results', {
    description: 'Report results from a team. Called by managers when their team completes work.',
    inputSchema: {
      team_id: z.string().describe('Team ID reporting results'),
      results: z.array(z.object({
        task_id: z.string().describe('Task ID'),
        status: z.enum(['completed', 'failed']).describe('Task outcome'),
        result: z.string().describe('Result description or error message'),
      })).describe('Array of task results'),
    },
  }, async (args) => {
    return handleReportTeamResults(db, eventLog, args)
  })

  // Unified get_orchestration_info replaces check_orchestration_status + aggregate_results + get_orchestration_phase
  mcpServer.registerTool('get_orchestration_info', {
    description: 'Get orchestration information for a team tree. Use "include" to select which data to return: "status" checks if all work is complete, "phase" returns the current orchestration phase, "results" returns aggregated results from the full tree.',
    inputSchema: {
      root_team_id: z.string().describe('Root team ID to query'),
      include: z.array(z.enum(['status', 'phase', 'results'])).describe('Which data to include in the response'),
    },
  }, async (args) => {
    const response: Record<string, unknown> = { root_team_id: args.root_team_id }

    for (const item of args.include) {
      switch (item) {
        case 'status': {
          const statusResult = handleCheckOrchestrationStatus(db, { root_team_id: args.root_team_id })
          if (statusResult.isError) return statusResult
          response.status = JSON.parse((statusResult.content[0] as { text: string }).text)
          break
        }
        case 'phase': {
          const phaseResult = handleGetOrchestrationPhase(db, { root_team_id: args.root_team_id })
          if (phaseResult.isError) return phaseResult
          response.phase = JSON.parse((phaseResult.content[0] as { text: string }).text)
          break
        }
        case 'results': {
          const resultsResult = handleAggregateResults(db, { root_team_id: args.root_team_id })
          if (resultsResult.isError) return resultsResult
          response.results = JSON.parse((resultsResult.content[0] as { text: string }).text)
          break
        }
      }
    }

    return { content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }] }
  })

  mcpServer.registerTool('transition_orchestration_phase', {
    description: 'Transition an orchestration plan to the next phase. Phases flow: research → synthesis → implementation → verification. Validates task completion gates.',
    inputSchema: {
      root_team_id: z.string().describe('Root team ID of the orchestration plan'),
      target_phase: z.string().describe('Target phase to transition to (research, synthesis, implementation, verification)'),
    },
  }, async (args) => {
    return handleTransitionOrchestrationPhase(db, eventLog, args)
  })

  mcpServer.registerTool('set_task_phase', {
    description: 'Tag a task with an orchestration phase. Tasks tagged for a gated phase (research, implementation) must be completed before the phase can transition. Without tagging, phase gates pass vacuously.',
    inputSchema: {
      root_team_id: z.string().describe('Root team ID of the orchestration plan'),
      task_id: z.string().describe('Task ID to tag (as string)'),
      phase: z.enum(['research', 'synthesis', 'implementation', 'verification']).describe('Phase to tag the task with'),
    },
  }, async (args) => {
    return handleSetTaskPhase(db, args)
  })

  mcpServer.registerTool('branch_session', {
    description: 'Create a new session that inherits history from a parent session up to a branch point. Useful for orchestration retry, parallel exploration, and rollback.',
    inputSchema: {
      new_session_id: z.string().describe('Unique ID for the new branched session'),
      parent_session_id: z.string().describe('ID of the parent session to branch from'),
      branch_point_message_id: z.string().optional().describe('Message ID to branch from. Inherits messages up to this point. If omitted, inherits all messages.'),
      purpose: z.string().describe('Purpose of the new session'),
      working_dir: z.string().optional().describe('Working directory for the new session. Inherits from parent if not specified.'),
    },
  }, withRiskGuard('branch_session', async (args: {
    new_session_id: string
    parent_session_id: string
    branch_point_message_id?: string
    purpose: string
    working_dir?: string
  }) => {
    return handleBranchSession(db, eventLog, {
      new_session_id: args.new_session_id,
      parent_session_id: args.parent_session_id,
      branch_point_message_id: args.branch_point_message_id,
      purpose: args.purpose,
      working_dir: args.working_dir,
    })
  }))

  // ─── Team Scratchpad tools ───────────────────────────────────────────────

  mcpServer.registerTool('write_scratchpad', {
    description: 'Write or update a team scratchpad entry. Scratchpad is a persistent key-value store for accumulated team knowledge (API contracts, design decisions, file ownership maps, etc.).',
    inputSchema: {
      team_id: z.string().describe('Team ID to write scratchpad entry for'),
      key: z.string().describe('Scratchpad entry key (e.g. "api-contract", "file-ownership")'),
      value: z.string().describe('Scratchpad entry value (freeform text or JSON string)'),
      session_id: z.string().optional().describe('Session ID of the writer (for attribution)'),
    },
  }, async (args) => {
    return handleWriteScratchpad(db, eventLog, {
      team_id: args.team_id,
      key: args.key,
      value: args.value,
      session_id: args.session_id,
    })
  })

  mcpServer.registerTool('read_scratchpad', {
    description: 'Read a team scratchpad entry by key, or list all entries for a team if key is omitted. Scratchpad stores persistent team knowledge.',
    inputSchema: {
      team_id: z.string().describe('Team ID to read scratchpad from'),
      key: z.string().optional().describe('Specific key to read. If omitted, lists all entries for the team.'),
    },
  }, async (args) => {
    return handleReadScratchpad(db, {
      team_id: args.team_id,
      key: args.key,
    })
  })

  mcpServer.registerTool('delete_scratchpad', {
    description: 'Delete a team scratchpad entry by key.',
    inputSchema: {
      team_id: z.string().describe('Team ID to delete scratchpad entry from'),
      key: z.string().describe('Scratchpad entry key to delete'),
    },
  }, async (args) => {
    return handleDeleteScratchpad(db, eventLog, {
      team_id: args.team_id,
      key: args.key,
    })
  })

  // Build tool map from McpServer's internal registered tools.
  // This gives us enable()/disable() handles for profile-based filtering.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internal = (mcpServer as any)._registeredTools as Record<string, ToolRegistrationMap extends Map<string, infer V> ? V : never>
  for (const [name, handle] of Object.entries(internal)) {
    toolMap.set(name, handle)
  }

  return toolMap
}
