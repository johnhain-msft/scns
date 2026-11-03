import type { Request, Response } from 'express'
import type express from 'express'
import { z } from 'zod'
import type Database from 'better-sqlite3'
import type { EventLog } from '../services/event-log.js'
import type { SSEManager } from '../sse-manager.js'
import { BrokerEventTypes, type EventDispatcher, type BrokerEventType } from '../event-dispatcher.js'
import { createWriteLimiter, createSearchLimiter } from '../middleware/rate-limiter.js'
import { NotFoundError, ConflictError } from '../errors.js'
import { logger } from '../logger.js'
import { validateBody } from '../middleware/validation.js'
import { TOOL_RISK_REGISTRY } from '../tool-risk.js'
import { handleRegisterSession, handleDeregisterSession } from '../tools/session.js'
import { handleHeartbeat } from '../tools/heartbeat.js'
import { handleBrokerInfo } from '../tools/broker-info.js'
import { handleWaitForEvent } from '../tools/event-wait.js'
import { handleGetTeamActivity } from '../tools/get-team-activity.js'
import { handleGetMemberStats } from '../tools/get-member-stats.js'
import {
  handleCreateTeam, handleDisbandTeam, handleJoinTeam,
  handleLeaveTeam, handleListTeamMembers, handleListTeams,
  handlePurgeTeam,
} from '../tools/team.js'
import {
  handleCreateTask, handleGetTask, handleUpdateTask,
} from '../tools/task.js'
import {
  handleDeclareCapabilities,
  handleFindCapableAgents,
} from '../tools/capability.js'
import {
  handleSetRespawnPolicy,
  handleGetRespawnPolicy,
  handleListRespawnHistory,
} from '../tools/respawn.js'
import { handleApplyManifest } from '../tools/manifest.js'
import { handleSetScalingPolicy, handleGetScalingPolicy } from '../tools/scaling.js'
import { handleRecordUsage, handleGetUsageSummary, handleGetTeamBudget } from '../tools/usage.js'
import { handleDeclareBranch, handleCheckBranchConflicts } from '../tools/git-conflict.js'
import { handleBroadcastToRepo } from '../tools/cross-repo.js'
import { handleBranchSession } from '../tools/session-branch.js'
import {
  handleWriteScratchpad,
  handleReadScratchpad,
  handleDeleteScratchpad,
} from '../tools/scratchpad.js'
import { transitionSessionStatus, handleGetSessionLifecycle } from '../tools/lifecycle.js'
import { SESSION_STATUSES } from '../lifecycle.js'
import {
  handleCreateOrchestrationPlan,
  handleRequestSubTeam,
  handleReportTeamResults,
  handleCheckOrchestrationStatus,
  handleAggregateResults,
  handleTransitionOrchestrationPhase,
  handleGetOrchestrationPhase,
} from '../tools/orchestration.js'
import { findAllSessions, findByRepoContext } from '../storage/repositories/session-repository.js'
import { findAllMessages } from '../storage/repositories/message-repository.js'
import { declareIntent, findConflicts } from '../storage/repositories/intent-repository.js'
import { findTeamById, findTeamInfoBySession, getTeamStatus } from '../storage/repositories/team-repository.js'
import { findTasksByTeam } from '../storage/repositories/task-repository.js'
import { getEventsSinceFiltered } from '../storage/repositories/event-repository.js'
import {
  listCapabilities as repoListCapabilities,
  findCapableAgents as repoFindCapableAgents,
} from '../storage/repositories/capability-repository.js'
import { queryTeamHistory, querySessionHistory } from '../storage/repositories/history-repository.js'
import { searchSessions, indexSession, getIndexStats } from '../indexing.js'
import {
  getUnreadDirectMessages,
  markMessagesAsRead,
  indexTaskCompletion,
} from '../services/agent-hooks.js'
import {
  RegisterSessionSchema,
  CreateTeamSchema,
  CreateTaskSchema,
  UpdateTaskSchema,
  DeclareIntentSchema,
  HeartbeatSchema,
  SearchSchema,
  JoinTeamSchema,
  MarkMessagesReadSchema,
  IndexTaskCompletionSchema,
  WriteScratchpadSchema,
} from '../schemas.js'

const MAX_QUERY_LIMIT = 1000

/** Parse and cap a query limit parameter to prevent unbounded queries. */
function parseQueryLimit(raw: unknown, defaultLimit?: number): number | undefined {
  if (!raw) return defaultLimit
  const parsed = parseInt(raw as string, 10)
  if (isNaN(parsed) || parsed < 1) return defaultLimit
  return Math.min(parsed, MAX_QUERY_LIMIT)
}

/** Extract Express 5 path param (handles string | string[] union). */
const param = (req: Request, name: string): string => {
  const val = req.params[name]
  return Array.isArray(val) ? val[0] : val
}

export interface RouteDeps {
  readonly db: Database.Database
  readonly eventLog: EventLog
  readonly sseManager: SSEManager
  readonly dispatcher?: EventDispatcher
}

export function registerRoutes(app: express.Express, deps: RouteDeps): void {
  const { db, eventLog, sseManager, dispatcher } = deps

  // Rate limiting — write limiter for all mutating API endpoints
  const writeLimiterMiddleware = createWriteLimiter()
  app.post('/api/{*path}', writeLimiterMiddleware)
  app.patch('/api/{*path}', writeLimiterMiddleware)
  app.delete('/api/{*path}', writeLimiterMiddleware)

  // Rate limiting — search limiter for search endpoints
  const searchLimiterMiddleware = createSearchLimiter()
  app.post('/api/search_sessions', searchLimiterMiddleware)

  app.get('/api/broker/info', (_req: Request, res: Response) => {
    try {
      const result = handleBrokerInfo(db)
      res.json(JSON.parse(result.content[0].text))
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  // REST API endpoints for hooks (simpler than MCP for curl-based access)
  app.post('/api/register', validateBody(RegisterSessionSchema), async (req: Request, res: Response, next) => {
    try {
      const { id, purpose, working_dir, worktree } = (req as Request & { validatedBody: z.infer<typeof RegisterSessionSchema> }).validatedBody
      const result = await handleRegisterSession(db, eventLog, {
        id,
        purpose,
        working_dir: working_dir ?? process.cwd(),
        worktree: worktree ?? null,
      })

      // Auto-index for semantic search (Task 2.3)
      indexSession(db, id, { forceReindex: false }).catch((err) => {
        logger.error({ sessionId: id, err }, 'Failed to index session')
      })

      res.json(result)
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/deregister', async (req: Request, res: Response) => {
    try {
      const { id } = req.body
      if (!id) {
        res.status(400).json({ error: 'Missing required field: id' })
        return
      }
      const result = await handleDeregisterSession(db, eventLog, { id })
      res.json(result)
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  app.post('/api/heartbeat', validateBody(HeartbeatSchema), async (req: Request, res: Response) => {
    try {
      const { session_id } = (req as Request & { validatedBody: z.infer<typeof HeartbeatSchema> }).validatedBody
      const result = await handleHeartbeat(db, eventLog, { session_id })
      res.json(result)
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  // Stream 1 REST endpoints
  app.get('/api/list_sessions', (_req: Request, res: Response) => {
    try {
      const status = _req.query.status as string | undefined
      const includeArchived = _req.query.include_archived === 'true'
      const sessions = findAllSessions(db, status, includeArchived)
      const enriched = sessions.map((session) => ({
        ...session,
        team: findTeamInfoBySession(db, session.id),
      }))
      res.json({ sessions: enriched })
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  app.get('/api/list_messages', (req: Request, res: Response) => {
    try {
      const limit = parseQueryLimit(req.query.limit, 100)
      const messages = findAllMessages(db, { limit })
      res.json({ messages })
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  // SSE endpoint for real-time events (supports filtering via query params)
  app.get('/events', (req: Request, res: Response) => {
    const clientIp = req.ip ?? req.socket.remoteAddress ?? 'unknown'

    // Check connection limit BEFORE flushing headers
    const added = sseManager.addConnection(clientIp, res)
    if (!added) {
      res.status(429).json({ error: 'Too many SSE connections' })
      return
    }

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.flushHeaders()

    // Parse optional filter query params
    const typesParam = req.query.types as string | undefined
    const eventTypes = typesParam
      ? typesParam.split(',').map((t) => t.trim()) as BrokerEventType[]
      : undefined
    const sessionId = req.query.session_id as string | undefined
    const teamId = req.query.team_id as string | undefined

    // Send initial ping
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`)

    if (dispatcher) {
      // Push-based: subscribe to the event dispatcher for immediate delivery
      sseManager.subscribeConnection(res, dispatcher, {
        event_types: eventTypes,
        session_id: sessionId,
        team_id: teamId,
      })

      req.on('close', () => {
        sseManager.removeConnection(clientIp, res)
      })
    } else {
      // Fallback: poll the DB for new events (legacy behavior)
      let lastEventId = 0

      const sendEvents = (): void => {
        try {
          const events = getEventsSinceFiltered(db, {
            afterId: lastEventId,
            eventTypes,
            sessionId,
          })
          for (const event of events) {
            const data = JSON.stringify({
              id: event.id,
              type: event.event_type,
              session_id: event.session_id,
              payload: event.payload ? JSON.parse(event.payload) : null,
              created_at: event.created_at,
            })
            res.write(`data: ${data}\n\n`)
            lastEventId = event.id
          }
        } catch {
          // Ignore errors during event sending
        }
      }

      const interval = setInterval(sendEvents, 1000)

      req.on('close', () => {
        clearInterval(interval)
        sseManager.removeConnection(clientIp, res)
      })
    }
  })

  // REST endpoint for known event types (useful for dashboard filtering)
  app.get('/api/event-types', (_req: Request, res: Response) => {
    res.json({ event_types: BrokerEventTypes })
  })

  // REST endpoint for wait_for_event (long-poll)
  app.get('/api/events/wait', async (req: Request, res: Response) => {
    try {
      const afterId = req.query.after_id ? parseInt(req.query.after_id as string, 10) : 0
      const typesParam = req.query.types as string | undefined
      const eventTypes = typesParam ? typesParam.split(',').map((t) => t.trim()) : undefined
      const sessionId = req.query.session_id as string | undefined
      const timeout = req.query.timeout ? parseInt(req.query.timeout as string, 10) : 30

      const result = await handleWaitForEvent(db, eventLog, {
        after_event_id: afterId,
        event_types: eventTypes,
        session_id: sessionId,
        timeout_seconds: timeout,
      })

      res.json(JSON.parse(result.content[0].text))
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  app.post('/api/declare_intent', validateBody(DeclareIntentSchema), (req: Request, res: Response) => {
    try {
      const { session_id, file, operation } = (req as Request & { validatedBody: z.infer<typeof DeclareIntentSchema> }).validatedBody

      // Declare intent (operation maps to intent field)
      declareIntent(db, {
        file_path: file,
        session_id,
        intent: operation,
      })

      eventLog.intentDeclared(session_id, {
        file_path: file,
        intent: operation ?? 'edit',
      })

      // Check for conflicts on this file
      const conflicts = findConflicts(db, file)
      const hasConflict = conflicts.length > 0

      if (hasConflict) {
        eventLog.conflictDetected(session_id, {
          file_path: file,
          sessions: conflicts[0].sessions.map((s) => s.session_id),
        })
      }

      res.json({
        conflict: hasConflict,
        conflicting_sessions: hasConflict
          ? conflicts[0].sessions.filter((s) => s.session_id !== session_id)
          : [],
      })
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  // Stream 2 REST endpoints (semantic search)
  app.post('/api/search_sessions', validateBody(SearchSchema), async (req: Request, res: Response) => {
    try {
      const { query, top_k, min_similarity } = (req as Request & { validatedBody: z.infer<typeof SearchSchema> }).validatedBody
      const results = await searchSessions(
        db,
        query,
        top_k ?? 5,
        min_similarity ?? 0.3
      )
      res.json({
        results,
        query,
        model: 'fastembed:fast-bge-small-en-v1.5',
      })
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  app.get('/api/index_stats', (_req: Request, res: Response) => {
    try {
      const stats = getIndexStats(db)
      res.json(stats)
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  // Stream 4 REST endpoints (activity reporting from hooks)
  app.post('/api/report_activity', (req: Request, res: Response) => {
    try {
      const { session_id, tool, files_modified, timestamp } = req.body

      if (!session_id) {
        res.status(400).json({ error: 'Missing required field: session_id' })
        return
      }

      eventLog.activityReported(session_id, {
        tool: tool ?? 'unknown',
        files_modified: files_modified ?? [],
        timestamp: timestamp ?? new Date().toISOString(),
      })

      res.json({ logged: true })
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  // Phase 5 REST endpoints: Agent Teams
  app.post('/api/teams', validateBody(CreateTeamSchema), (req: Request, res: Response, next) => {
    try {
      const { name, description, parent_team_id } = (req as Request & { validatedBody: z.infer<typeof CreateTeamSchema> }).validatedBody
      const result = handleCreateTeam(db, eventLog, { name, description, parent_team_id })
      if (result.isError) {
        const parsed = JSON.parse(result.content[0].text) as { error?: string }
        const err = new ConflictError(parsed.error ?? 'Team already exists')
        res.status(err.statusCode).json(JSON.parse(result.content[0].text))
        return
      }
      res.status(201).json(JSON.parse(result.content[0].text))
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/teams', (req: Request, res: Response) => {
    try {
      const status = req.query.status as string | undefined
      const includeArchived = req.query.include_archived === 'true'
      const result = handleListTeams(db, { status, include_archived: includeArchived })
      res.json(JSON.parse(result.content[0].text))
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  app.get('/api/teams/:id', (req: Request, res: Response, next) => {
    try {
      const teamId = param(req, 'id')
      const team = findTeamById(db, teamId)
      if (!team) {
        const err = new NotFoundError('Team', teamId)
        res.status(err.statusCode).json({ error: err.message })
        return
      }
      const membersResult = handleListTeamMembers(db, { team_id: teamId })
      res.json(JSON.parse(membersResult.content[0].text))
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/teams/:id/status', (req: Request, res: Response) => {
    try {
      const teamId = param(req, 'id')
      const status = getTeamStatus(db, teamId)
      if (!status) {
        res.status(404).json({ error: `Team '${teamId}' not found` })
        return
      }
      res.json(status)
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  app.delete('/api/teams/:id', (req: Request, res: Response) => {
    try {
      const result = handleDisbandTeam(db, eventLog, { team_id: param(req, 'id') })
      if (result.isError) {
        res.status(404).json(JSON.parse(result.content[0].text))
        return
      }
      res.json(JSON.parse(result.content[0].text))
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  app.post('/api/teams/:id/purge', (req: Request, res: Response) => {
    try {
      const result = handlePurgeTeam(db, eventLog, { team_id: param(req, 'id') })
      if (result.isError) {
        res.status(404).json(JSON.parse(result.content[0].text))
        return
      }
      res.json(JSON.parse(result.content[0].text))
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  app.post('/api/teams/:id/members', validateBody(JoinTeamSchema), (req: Request, res: Response) => {
    try {
      const { session_id, name, role, agent_type } = (req as Request & { validatedBody: z.infer<typeof JoinTeamSchema> }).validatedBody
      const result = handleJoinTeam(db, eventLog, {
        team_id: param(req, 'id'),
        session_id,
        name,
        role,
        agent_type,
      })
      if (result.isError) {
        res.status(404).json(JSON.parse(result.content[0].text))
        return
      }
      res.status(201).json(JSON.parse(result.content[0].text))
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  app.delete('/api/teams/:id/members/:sessionId', (req: Request, res: Response) => {
    try {
      const result = handleLeaveTeam(db, eventLog, {
        team_id: param(req, 'id'),
        session_id: param(req, 'sessionId'),
      })
      if (result.isError) {
        res.status(404).json(JSON.parse(result.content[0].text))
        return
      }
      res.json(JSON.parse(result.content[0].text))
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  app.get('/api/teams/:id/members/stats', (req: Request, res: Response) => {
    try {
      const result = handleGetMemberStats(db, { team_id: param(req, 'id') })
      if (result.isError) {
        res.status(404).json(JSON.parse(result.content[0].text))
        return
      }
      res.json(JSON.parse(result.content[0].text))
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  app.post('/api/teams/:id/tasks', validateBody(CreateTaskSchema), (req: Request, res: Response) => {
    try {
      const { subject, description, active_form } = (req as Request & { validatedBody: z.infer<typeof CreateTaskSchema> }).validatedBody
      const result = handleCreateTask(db, eventLog, {
        team_id: param(req, 'id'),
        subject,
        description,
        active_form,
      })
      if (result.isError) {
        res.status(404).json(JSON.parse(result.content[0].text))
        return
      }
      res.status(201).json(JSON.parse(result.content[0].text))
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  app.get('/api/teams/:id/tasks', (req: Request, res: Response) => {
    try {
      const status = req.query.status as string | undefined
      const tasks = findTasksByTeam(db, param(req, 'id'), status)
      res.json(tasks)
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  app.get('/api/teams/:id/activity', (req: Request, res: Response) => {
    try {
      const teamId = param(req, 'id')
      const limit = parseQueryLimit(req.query.limit)
      const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : undefined
      const eventTypes = req.query.event_types
        ? (req.query.event_types as string).split(',')
        : undefined
      const since = req.query.since as string | undefined

      const result = handleGetTeamActivity(db, {
        team_id: teamId,
        limit,
        offset,
        event_types: eventTypes,
        since,
      })

      if (result.isError) {
        res.status(404).json(JSON.parse(result.content[0].text))
        return
      }
      res.json(JSON.parse(result.content[0].text))
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  app.get('/api/tasks/:id', (req: Request, res: Response) => {
    try {
      const taskId = parseInt(param(req, 'id'), 10)
      if (Number.isNaN(taskId)) {
        res.status(400).json({ error: 'Invalid task ID' })
        return
      }
      const result = handleGetTask(db, { task_id: taskId })
      if (result.isError) {
        res.status(404).json(JSON.parse(result.content[0].text))
        return
      }
      res.json(JSON.parse(result.content[0].text))
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  app.patch('/api/tasks/:id', validateBody(UpdateTaskSchema), (req: Request, res: Response) => {
    try {
      const taskId = parseInt(param(req, 'id'), 10)
      if (Number.isNaN(taskId)) {
        res.status(400).json({ error: 'Invalid task ID' })
        return
      }
      const { status, owner, subject, description, active_form, add_blocks, add_blocked_by } = (req as Request & { validatedBody: z.infer<typeof UpdateTaskSchema> }).validatedBody
      const result = handleUpdateTask(db, eventLog, {
        task_id: taskId,
        status,
        owner,
        subject,
        description,
        active_form,
        add_blocks,
        add_blocked_by,
      })
      if (result.isError) {
        res.status(404).json(JSON.parse(result.content[0].text))
        return
      }
      res.json(JSON.parse(result.content[0].text))
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  // Stream 12: Capabilities REST endpoints
  app.post('/api/sessions/:id/capabilities', (req: Request, res: Response) => {
    try {
      const sessionId = param(req, 'id')
      const { capabilities } = req.body
      if (!capabilities || !Array.isArray(capabilities)) {
        res.status(400).json({ error: 'Missing required field: capabilities (array of strings)' })
        return
      }
      const result = handleDeclareCapabilities(db, eventLog, {
        session_id: sessionId,
        capabilities,
      })
      if (result.isError) {
        res.status(404).json(JSON.parse(result.content[0].text))
        return
      }
      res.status(201).json(JSON.parse(result.content[0].text))
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  app.get('/api/sessions/:id/capabilities', (req: Request, res: Response) => {
    try {
      const sessionId = param(req, 'id')
      const capabilities = repoListCapabilities(db, sessionId)
      res.json(capabilities.map((c) => c.capability))
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  app.get('/api/capabilities/:capability/agents', (req: Request, res: Response) => {
    try {
      const capability = param(req, 'capability')
      const agents = repoFindCapableAgents(db, capability)
      res.json({ capability, agents })
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  // Stream 10: Respawn REST endpoints
  app.post('/api/teams/:id/respawn-policy', (req: Request, res: Response) => {
    try {
      const teamId = param(req, 'id')
      const { role, min_count, max_retries, backoff_base_ms, enabled } = req.body
      if (!role) {
        res.status(400).json({ error: 'Missing required field: role' })
        return
      }
      const result = handleSetRespawnPolicy(db, eventLog, {
        team_id: teamId, role, min_count, max_retries, backoff_base_ms, enabled,
      })
      if (result.isError) {
        res.status(404).json(JSON.parse(result.content[0].text))
        return
      }
      res.json(JSON.parse(result.content[0].text))
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  app.get('/api/teams/:id/respawn-policy', (req: Request, res: Response) => {
    try {
      const teamId = param(req, 'id')
      const result = handleGetRespawnPolicy(db, { team_id: teamId })
      if (result.isError) {
        res.status(404).json(JSON.parse(result.content[0].text))
        return
      }
      res.json(JSON.parse(result.content[0].text))
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  app.get('/api/teams/:id/respawn-history', (req: Request, res: Response) => {
    try {
      const teamId = param(req, 'id')
      const limit = parseQueryLimit(req.query.limit)
      const status = req.query.status as string | undefined
      const result = handleListRespawnHistory(db, { team_id: teamId, limit, status })
      if (result.isError) {
        res.status(404).json(JSON.parse(result.content[0].text))
        return
      }
      res.json(JSON.parse(result.content[0].text))
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  // Stream 11: Manifest REST endpoint
  app.post('/api/teams/apply', async (req: Request, res: Response) => {
    try {
      const { manifest_yaml } = req.body
      if (!manifest_yaml) {
        res.status(400).json({ error: 'Missing required field: manifest_yaml' })
        return
      }
      const result = await handleApplyManifest(db, eventLog, { manifest_yaml })
      if (result.isError) {
        res.status(400).json(JSON.parse(result.content[0].text))
        return
      }
      res.status(201).json(JSON.parse(result.content[0].text))
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  // P1: Auto-Scaling REST endpoints
  app.post('/api/teams/:id/scaling-policy', (req: Request, res: Response) => {
    try {
      const teamId = param(req, 'id')
      const { role, min_count, max_count, scale_up_threshold, scale_down_threshold, cooldown_ms, enabled } = req.body
      if (!role) {
        res.status(400).json({ error: 'Missing required field: role' })
        return
      }
      const result = handleSetScalingPolicy(db, eventLog, {
        team_id: teamId, role, min_count, max_count, scale_up_threshold, scale_down_threshold, cooldown_ms, enabled,
      })
      if (result.isError) {
        res.status(404).json(JSON.parse(result.content[0].text))
        return
      }
      res.json(JSON.parse(result.content[0].text))
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  app.get('/api/teams/:id/scaling-policy', (req: Request, res: Response) => {
    try {
      const teamId = param(req, 'id')
      const result = handleGetScalingPolicy(db, { team_id: teamId })
      if (result.isError) {
        res.status(404).json(JSON.parse(result.content[0].text))
        return
      }
      res.json(JSON.parse(result.content[0].text))
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  // P1: Usage/Cost Tracking REST endpoints
  app.post('/api/usage', (req: Request, res: Response) => {
    try {
      const { session_id, tokens_in, tokens_out, cost_usd, team_id, task_id, model } = req.body
      if (!session_id || tokens_in === undefined || tokens_out === undefined || cost_usd === undefined) {
        res.status(400).json({ error: 'Missing required fields: session_id, tokens_in, tokens_out, cost_usd' })
        return
      }
      const result = handleRecordUsage(db, eventLog, {
        session_id, tokens_in, tokens_out, cost_usd, team_id, task_id, model,
      })
      res.status(201).json(JSON.parse(result.content[0].text))
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  app.get('/api/usage/summary', (req: Request, res: Response) => {
    try {
      const session_id = req.query.session_id as string | undefined
      const team_id = req.query.team_id as string | undefined
      const task_id = req.query.task_id ? parseInt(req.query.task_id as string, 10) : undefined
      const result = handleGetUsageSummary(db, { session_id, team_id, task_id })
      if (result.isError) {
        res.status(400).json(JSON.parse(result.content[0].text))
        return
      }
      res.json(JSON.parse(result.content[0].text))
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  app.get('/api/teams/:id/budget', (req: Request, res: Response) => {
    try {
      const teamId = param(req, 'id')
      const result = handleGetTeamBudget(db, { team_id: teamId })
      res.json(JSON.parse(result.content[0].text))
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  // P1: Git-Level Conflict Detection REST endpoints
  app.post('/api/branch-intents', (req: Request, res: Response) => {
    try {
      const { session_id, branch, file_path, commit_sha } = req.body
      if (!session_id || !branch || !file_path) {
        res.status(400).json({ error: 'Missing required fields: session_id, branch, file_path' })
        return
      }
      const result = handleDeclareBranch(db, eventLog, { session_id, branch, file_path, commit_sha })
      res.status(201).json(JSON.parse(result.content[0].text))
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  app.get('/api/branch-conflicts', (req: Request, res: Response) => {
    try {
      const file_path = req.query.file_path as string | undefined
      const branch = req.query.branch as string | undefined
      const result = handleCheckBranchConflicts(db, { file_path, branch })
      res.json(JSON.parse(result.content[0].text))
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  // History REST endpoints (two-tier archival)
  app.get('/api/history/teams', (req: Request, res: Response) => {
    try {
      const limit = parseQueryLimit(req.query.limit)
      const since = req.query.since as string | undefined
      const name = req.query.name as string | undefined
      const records = queryTeamHistory(db, { limit, since, name })
      const enriched = records.map((r) => ({
        ...r,
        member_summary: r.member_summary ? JSON.parse(r.member_summary) : null,
        task_summary: r.task_summary ? JSON.parse(r.task_summary) : null,
      }))
      res.json({ count: enriched.length, records: enriched })
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  app.get('/api/history/sessions', (req: Request, res: Response) => {
    try {
      const limit = parseQueryLimit(req.query.limit)
      const since = req.query.since as string | undefined
      const records = querySessionHistory(db, { limit, since })
      res.json({ count: records.length, records })
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  app.post('/api/capabilities/match', (req: Request, res: Response) => {
    try {
      const { capabilities } = req.body
      if (!capabilities || !Array.isArray(capabilities)) {
        res.status(400).json({ error: 'Missing required field: capabilities (array of strings)' })
        return
      }
      const result = handleFindCapableAgents(db, { capabilities })
      res.json(JSON.parse(result.content[0].text))
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  // Cross-Repo REST endpoints
  app.get('/api/sessions', (req: Request, res: Response) => {
    try {
      const repoContext = req.query.repo_context as string | undefined
      if (repoContext) {
        const sessions = findByRepoContext(db, repoContext)
        res.json({ repo_context: repoContext, sessions })
      } else {
        const status = req.query.status as string | undefined
        const includeArchived = req.query.include_archived === 'true'
        const sessions = findAllSessions(db, status, includeArchived)
        const enriched = sessions.map((session) => ({
          ...session,
          team: findTeamInfoBySession(db, session.id),
        }))
        res.json({ sessions: enriched })
      }
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  app.post('/api/messages/broadcast-repo', (req: Request, res: Response) => {
    try {
      const { sender_id, repo_context, content } = req.body
      if (!sender_id || !repo_context || !content) {
        res.status(400).json({ error: 'Missing required fields: sender_id, repo_context, content' })
        return
      }
      const result = handleBroadcastToRepo(db, eventLog, { sender_id, repo_context, content })
      if (result.isError) {
        res.status(400).json(JSON.parse(result.content[0].text))
        return
      }
      res.json(JSON.parse(result.content[0].text))
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  // Lifecycle REST endpoints
  app.get('/api/sessions/:id/lifecycle', (req: Request, res: Response) => {
    try {
      const sessionId = param(req, 'id')
      const result = handleGetSessionLifecycle(db, { session_id: sessionId })
      if (result.isError) {
        res.status(404).json(JSON.parse(result.content[0].text))
        return
      }
      res.json(JSON.parse(result.content[0].text))
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  app.post('/api/sessions/:id/transition', (req: Request, res: Response) => {
    try {
      const sessionId = param(req, 'id')
      const { to } = req.body
      if (!to || !SESSION_STATUSES.includes(to)) {
        res.status(400).json({ error: `Invalid status. Must be one of: ${SESSION_STATUSES.join(', ')}` })
        return
      }
      const session = transitionSessionStatus(db, eventLog, sessionId, to)
      res.json(session)
    } catch (error) {
      if (error instanceof ConflictError) {
        res.status(409).json({ error: error.message })
        return
      }
      if (error instanceof NotFoundError) {
        res.status(404).json({ error: error.message })
        return
      }
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  // ─── Session Branching REST endpoint ──────────────────────────────────────

  app.post('/api/sessions/:id/branch', (req: Request, res: Response) => {
    try {
      const parentSessionId = param(req, 'id')
      const { new_session_id, purpose, branch_point_message_id, working_dir } = req.body
      if (!new_session_id || !purpose) {
        res.status(400).json({ error: 'Missing required fields: new_session_id, purpose' })
        return
      }
      const result = handleBranchSession(db, eventLog, {
        new_session_id,
        parent_session_id: parentSessionId,
        branch_point_message_id,
        purpose,
        working_dir,
      })
      if (result.isError) {
        res.status(400).json(JSON.parse(result.content[0].text))
        return
      }
      res.status(201).json(JSON.parse(result.content[0].text))
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  // ─── Orchestration Protocol REST endpoints ──────────────────────────────

  app.post('/api/orchestration/plan', (req: Request, res: Response) => {
    try {
      const result = handleCreateOrchestrationPlan(db, eventLog, req.body)
      if (result.isError) {
        res.status(400).json(JSON.parse(result.content[0].text))
        return
      }
      res.status(201).json(JSON.parse(result.content[0].text))
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  app.post('/api/orchestration/sub-team', (req: Request, res: Response) => {
    try {
      const result = handleRequestSubTeam(db, eventLog, req.body)
      if (result.isError) {
        res.status(400).json(JSON.parse(result.content[0].text))
        return
      }
      res.status(201).json(JSON.parse(result.content[0].text))
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  app.post('/api/orchestration/results', (req: Request, res: Response) => {
    try {
      const result = handleReportTeamResults(db, eventLog, req.body)
      if (result.isError) {
        res.status(400).json(JSON.parse(result.content[0].text))
        return
      }
      res.json(JSON.parse(result.content[0].text))
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  app.get('/api/orchestration/:rootTeamId/status', (req: Request, res: Response) => {
    try {
      const rootTeamId = param(req, 'rootTeamId')
      const result = handleCheckOrchestrationStatus(db, { root_team_id: rootTeamId })
      if (result.isError) {
        res.status(400).json(JSON.parse(result.content[0].text))
        return
      }
      res.json(JSON.parse(result.content[0].text))
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  app.get('/api/orchestration/:rootTeamId/results', (req: Request, res: Response) => {
    try {
      const rootTeamId = param(req, 'rootTeamId')
      const result = handleAggregateResults(db, { root_team_id: rootTeamId })
      if (result.isError) {
        res.status(400).json(JSON.parse(result.content[0].text))
        return
      }
      res.json(JSON.parse(result.content[0].text))
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  app.get('/api/orchestration/:id/phase', (req: Request, res: Response) => {
    try {
      const rootTeamId = param(req, 'id')
      const result = handleGetOrchestrationPhase(db, { root_team_id: rootTeamId })
      if (result.isError) {
        res.status(400).json(JSON.parse(result.content[0].text))
        return
      }
      res.json(JSON.parse(result.content[0].text))
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  app.post('/api/orchestration/:id/phase', (req: Request, res: Response) => {
    try {
      const rootTeamId = param(req, 'id')
      const { target_phase } = req.body as { target_phase: string }
      const result = handleTransitionOrchestrationPhase(db, eventLog, {
        root_team_id: rootTeamId,
        target_phase: target_phase ?? '',
      })
      if (result.isError) {
        res.status(409).json(JSON.parse(result.content[0].text))
        return
      }
      res.json(JSON.parse(result.content[0].text))
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  // ─── Agent Hooks REST endpoints ──────────────────────────────────────────

  app.get('/api/messages/unread/:receiverId', (req: Request, res: Response) => {
    try {
      const receiverId = param(req, 'receiverId')
      const result = getUnreadDirectMessages(db, receiverId)
      res.json({ success: true, data: result })
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  app.post('/api/messages/mark-read', validateBody(MarkMessagesReadSchema), (req: Request, res: Response) => {
    try {
      const { message_ids } = (req as Request & { validatedBody: z.infer<typeof MarkMessagesReadSchema> }).validatedBody
      const markedCount = markMessagesAsRead(db, message_ids)
      res.json({ success: true, data: { marked_count: markedCount } })
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  app.post('/api/index/task-completion', validateBody(IndexTaskCompletionSchema), (req: Request, res: Response) => {
    try {
      const body = (req as Request & { validatedBody: z.infer<typeof IndexTaskCompletionSchema> }).validatedBody
      const entry = indexTaskCompletion(db, eventLog, body)
      res.json({ success: true, data: { key: entry.key, indexed: true } })
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  // ─── Team Scratchpad REST endpoints ───────────────────────────────────────

  app.post('/api/teams/:id/scratchpad', validateBody(WriteScratchpadSchema), (req: Request, res: Response) => {
    try {
      const teamId = param(req, 'id')
      const { key, value, session_id } = req.body as { key: string; value: string; session_id?: string }
      const result = handleWriteScratchpad(db, eventLog, {
        team_id: teamId,
        key,
        value,
        session_id,
      })
      if (result.isError) {
        res.status(400).json(JSON.parse(result.content[0].text))
        return
      }
      res.json(JSON.parse(result.content[0].text))
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  app.get('/api/teams/:id/scratchpad', (req: Request, res: Response) => {
    try {
      const teamId = param(req, 'id')
      const result = handleReadScratchpad(db, { team_id: teamId })
      if (result.isError) {
        res.status(400).json(JSON.parse(result.content[0].text))
        return
      }
      res.json(JSON.parse(result.content[0].text))
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  app.get('/api/teams/:id/scratchpad/:key', (req: Request, res: Response) => {
    try {
      const teamId = param(req, 'id')
      const key = param(req, 'key')
      const result = handleReadScratchpad(db, { team_id: teamId, key })
      if (result.isError) {
        res.status(400).json(JSON.parse(result.content[0].text))
        return
      }
      const data = JSON.parse(result.content[0].text)
      if (data === null) {
        res.status(404).json({ error: `Scratchpad entry '${key}' not found for team '${teamId}'` })
        return
      }
      res.json(data)
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  app.delete('/api/teams/:id/scratchpad/:key', (req: Request, res: Response) => {
    try {
      const teamId = param(req, 'id')
      const key = param(req, 'key')
      const result = handleDeleteScratchpad(db, eventLog, { team_id: teamId, key })
      if (result.isError) {
        res.status(400).json(JSON.parse(result.content[0].text))
        return
      }
      res.json(JSON.parse(result.content[0].text))
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  // ─── Tool Risk Introspection REST endpoints ─────────────────────────────

  app.get('/api/tools/risk', (_req: Request, res: Response) => {
    res.json(TOOL_RISK_REGISTRY)
  })

  app.get('/api/tools/risk/:toolName', (req: Request, res: Response) => {
    const toolName = param(req, 'toolName')
    const entry = TOOL_RISK_REGISTRY[toolName]
    if (!entry) {
      res.json({ toolName, riskLevel: 'medium', note: 'Unknown tool — defaults to medium' })
      return
    }
    res.json(entry)
  })
}
