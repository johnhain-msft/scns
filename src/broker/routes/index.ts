/**
 * REST API routes for the session broker.
 * Registers all endpoints on the Express app.
 */

import { randomUUID } from 'node:crypto'
import type { Request, Response, NextFunction } from 'express'
import type express from 'express'
import type Database from 'better-sqlite3'
import type { EventLog } from '../services/event-log.js'
import type { SSEManager } from '../sse-manager.js'
import type { EventDispatcher } from '../event-dispatcher.js'
import type { RotationController } from '../../context/rotation-controller.js'
import type { CompactionDetector } from '../../context/compaction-detector.js'
import type { CostTracker } from '../../shared/cost-tracker.js'
import { BrokerError, ConflictError, NotFoundError } from '../errors.js'
import { isPathInside } from '../path-containment.js'
import { logger } from '../../shared/logger.js'
import type { AgentSpawner } from '../services/agent-spawner.js'
import { RateRecommendation, type createRateMonitor } from '../../rate-limit/rate-monitor.js'
import {
  RegisterSessionSchema,
  HeartbeatSchema,
  SendMessageSchema,
  CreateTeamSchema,
  JoinTeamSchema,
  DeclareIntentSchema,
  MarkMessagesReadSchema,
  MarkMessagesDeliveredSchema,
  AckMessageSchema,
  SetStateSchema,
  RotateSessionSchema,
  SessionHookEventSchema,
  CreateTaskSchema,
  UpdateTaskSchema,
  SpawnAgentSchema,
  AgentMessageSchema,
  SpawnForTaskSchema,
  SessionStatusQuery,
  QualityCheckRequestSchema,
  CreateHandoffSchema,
  ConsumeHandoffSchema,
} from '../schemas.js'
import {
  createSession,
  findSessionById,
  findAllSessions,
  updateHeartbeat,
  updateSessionStatus,
  reviveSession,
} from '../storage/repositories/session-repository.js'
import {
  createMessage,
  createMessageWithReplay,
  ClientMessageIdConflictError,
  findMessagesByReceiver,
  markMessageRead,
  markMessagesDelivered,
  setMessageDisposition,
  findMessageById,
  findMessagesByTeamMembers,
  countMessagesByTeamMembers,
  findTeamMessagesSince,
  getMaxTeamSeq,
} from '../storage/repositories/message-repository.js'
import {
  declareIntent,
  releaseIntent,
  normalizePath,
  findConflicts,
  findIntentsBySession,
} from '../storage/repositories/intent-repository.js'
import { setState, getState, deleteState } from '../storage/repositories/state-repository.js'
import { findTeamInfoBySession } from '../storage/repositories/team-repository.js'
import { getEventsSince } from '../storage/repositories/event-repository.js'
import {
  findQualityChecksBySession,
  createHandoff,
  findLatestHandoff,
  findHandoffsBySession,
  consumeHandoff,
} from '../storage/repositories/quality-repository.js'
import {
  registerCapabilities,
  clearSessionCapabilities,
  findCapabilitiesBySession,
  findSessionsByCapability,
  findAllCapabilities,
} from '../storage/repositories/capability-repository.js'
import {
  recordUsage,
  findUsageBySession,
  getSessionCostSummary,
  getCostSummary,
} from '../storage/repositories/usage-repository.js'
import {
  upsertRespawnPolicy,
  findRespawnPoliciesByTeam,
  deleteRespawnPolicy,
  findRespawnHistory,
} from '../storage/repositories/respawn-repository.js'
import {
  upsertScalingPolicy,
  findScalingPoliciesByTeam,
  deleteScalingPolicy,
} from '../storage/repositories/scaling-repository.js'
import { createTeam, disbandTeam, joinTeam } from '../services/team-orchestration.js'
import { buildTaskSpawnPrompt } from '../services/task-spawn-prompt.js'
import {
  isTaskSpawnRoleSupported,
  SUPPORTED_TASK_SPAWN_ROLES,
} from '../services/task-spawn-prompt.js'
import { evaluateCompletionGate } from '../services/task-completion-gate.js'
import { listProjects } from '../project-registry.js'
import { registerRole, listRoles } from '../role-registry.js'
import {
  findAllTeams,
  findTeamById,
  findTeamMembers,
  removeTeamMember,
} from '../storage/repositories/team-repository.js'
import {
  loadAutonomy,
  promote as promoteAutonomy,
  demote as demoteAutonomy,
} from '../../shared/autonomy.js'
import {
  createTask,
  findTaskById,
  findTasksByTeam,
  findTaskWithDeps,
  updateTask,
  deleteTask,
} from '../storage/repositories/task-repository.js'
import { resolveScnsHome } from '../../shared/scns-home.js'
import { join } from 'node:path'

/** Extract Express 5 path param (handles string | string[] union). */
const param = (req: Request, name: string): string => {
  const val = req.params[name]
  return Array.isArray(val) ? val[0]! : (val ?? '')
}

export type HandleSessionEventFn = (event: {
  readonly event: string
  readonly sessionId?: string
  readonly tool?: string
  readonly timestamp: string
  readonly metadata?: Record<string, unknown>
  readonly model?: string
  readonly toolArgs?: string
  readonly toolResult?: string
  readonly mcpServer?: string
  readonly skillName?: string
  readonly exitCode?: number
  readonly errorMessage?: string
  readonly traceId?: string
  readonly tokenUsage?: {
    readonly input?: number
    readonly output?: number
  }
}) => { readonly id: string } | null

export interface RouteDeps {
  readonly db: Database.Database
  readonly eventLog: EventLog
  /**
   * Multi-project foundation (P3): when set, teams/sessions created through
   * REST are stamped with this project id so the project-scoped autospawner
   * acts on them. Omit to preserve legacy NULL behaviour.
   */
  readonly projectId?: string
  /**
   * Project root of a per-project child broker (`BROKER_PROJECT_ROOT`). When
   * set, `/api/register` refuses sessions whose working directory lies outside
   * it, and an omitted working_dir defaults to it. Omit on the global broker
   * to preserve legacy behaviour.
   */
  readonly projectRoot?: string
  readonly sseManager?: SSEManager
  readonly dispatcher?: EventDispatcher
  readonly shutdownFn?: () => Promise<void>
  readonly rotationController?: RotationController
  readonly compactionDetector?: CompactionDetector
  readonly costTracker?: CostTracker
  readonly handleSessionEvent?: HandleSessionEventFn
  readonly agentSpawner?: AgentSpawner
  readonly orchestrator?: import('../a2a/team-orchestrator.js').TeamOrchestrator
  readonly rateMonitor?: ReturnType<typeof createRateMonitor>
  readonly sentimentAnalyzer?: (text: string) => {
    readonly isNegative: boolean
    readonly overallScore: number
    readonly signals: ReadonlyArray<{ type: string; score: number; triggers: readonly string[] }>
    readonly dontRule?: string
    readonly subject?: string
    readonly recommendedTarget?: string
  }
  readonly negativeMemoryStore?: {
    storeFromHeuristic(input: {
      originalText: string
      dontRule: string
      category: string
      recommendedTarget: string
      confidence: number
      sessionId?: string
    }): { id: string }
  }
  readonly onSessionCompleted?: () => void
  /**
   * Phase 13.12.24 — completion gate. Returns true when `git -C <cwd> diff
   * --cached` would show changes. Injectable so tests don't shell out.
   */
  readonly gitDiffChecker?: (cwd: string) => boolean
}

export function registerRoutes(app: express.Express, deps: RouteDeps): void {
  const { db, eventLog } = deps
  const projectId = deps.projectId
  // Child brokers are spawned with BROKER_PROJECT_ROOT; the global broker has
  // none, and then the guard below is inert.
  const projectRoot = deps.projectRoot ?? process.env['BROKER_PROJECT_ROOT'] ?? null

  function rejectForeignWorkingDir(res: Response, workingDir: string): boolean {
    if (projectRoot === null || isPathInside(workingDir, projectRoot)) return false
    res.status(409).json({
      error: 'project_mismatch',
      message:
        `broker for project '${projectId ?? 'unknown'}' does not serve working_dir ` +
        `'${workingDir}' (outside '${projectRoot}') — the session is addressing the ` +
        'wrong child broker; start a new session to re-resolve',
      project_id: projectId ?? null,
      project_root: projectRoot,
      working_dir: workingDir,
    })
    return true
  }

  // Wire SSE manager for push-based event streaming
  if (deps.sseManager && deps.dispatcher) {
    deps.sseManager.start()
  }

  // ── Sessions ────────────────────────────────────────────────

  app.post('/api/register', async (req: Request, res: Response, next) => {
    try {
      const parsed = RegisterSessionSchema.parse(req.body)
      // Default to the project root rather than the broker's cwd: every child
      // runs from the SCNS package root, so cwd would be the wrong project for
      // all but one of them.
      const workingDir = parsed.working_dir ?? projectRoot ?? process.cwd()
      // Last line of defence against a session pinned to a reassigned port.
      // Ports are re-dealt on every meta-broker restart, so a live session can
      // address the wrong child; refusing here keeps foreign rows out of this
      // project's database entirely.
      if (rejectForeignWorkingDir(res, workingDir)) return
      // Issue #70: participant identity is durable. Re-registering a known id
      // (a session whose lease expired, that resumed after session-end, or
      // that startup marked zombie) revives the existing row instead of
      // failing on the primary key — mail addressed to it in the interim is
      // still in its inbox.
      const existing = findSessionById(db, parsed.id)
      if (existing) {
        const revived = reviveSession(db, parsed.id, ['expired', 'completed', 'zombie'])
        eventLog.sessionRegistered(parsed.id, {
          purpose: existing.purpose,
          working_dir: existing.working_dir,
          revived: true,
          previous_status: existing.status,
        })
        res.json({ ...revived, revived: true })
        return
      }
      const session = createSession(db, {
        id: parsed.id,
        purpose: parsed.purpose,
        working_dir: workingDir,
        worktree: parsed.worktree ?? null,
        project_id: projectId ?? null,
      })
      eventLog.sessionRegistered(session.id, {
        purpose: session.purpose,
        working_dir: session.working_dir,
      })
      res.json(session)
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/deregister/:id', async (req: Request, res: Response, next) => {
    try {
      const id = param(req, 'id')
      const session = findSessionById(db, id)
      if (!session) {
        throw new NotFoundError('Session', id)
      }
      updateSessionStatus(db, id, 'completed')
      clearSessionCapabilities(db, id)
      eventLog.sessionDeregistered(id, { id })
      res.json({ success: true, id })
    } catch (error) {
      next(error)
    }
  })

  // ── Capabilities ────────────────────────────────────────────

  app.post('/api/sessions/:id/capabilities', (req: Request, res: Response, next) => {
    try {
      const sessionId = param(req, 'id')
      const session = findSessionById(db, sessionId)
      if (!session) throw new NotFoundError('Session', sessionId)
      const { capabilities } = req.body as { capabilities?: string[] }
      if (!Array.isArray(capabilities) || capabilities.length === 0) {
        res.status(400).json({ error: 'capabilities must be a non-empty array of strings' })
        return
      }
      registerCapabilities(db, sessionId, capabilities)
      const all = findCapabilitiesBySession(db, sessionId)
      res.json({ session_id: sessionId, capabilities: all })
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/sessions/:id/capabilities', (req: Request, res: Response, next) => {
    try {
      const sessionId = param(req, 'id')
      const capabilities = findCapabilitiesBySession(db, sessionId)
      res.json({ session_id: sessionId, capabilities })
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/capabilities/:capability', (req: Request, res: Response, next) => {
    try {
      const capability = param(req, 'capability')
      const sessions = findSessionsByCapability(db, capability)
      res.json({ capability, sessions })
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/capabilities', (_req: Request, res: Response, next) => {
    try {
      const capabilities = findAllCapabilities(db)
      res.json({ capabilities })
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/heartbeat', async (req: Request, res: Response, next) => {
    try {
      const parsed = HeartbeatSchema.parse(req.body)
      const session = findSessionById(db, parsed.session_id)
      if (!session) {
        throw new NotFoundError('Session', parsed.session_id)
      }
      // Issue #70: a heartbeat is proof of life — it undoes lease expiry.
      // It does NOT resurrect an explicitly deregistered ('completed')
      // session; that requires re-registration or a session-start.
      const revived = session.status === 'expired'
      if (revived) {
        reviveSession(db, parsed.session_id)
      } else {
        updateHeartbeat(db, parsed.session_id)
      }
      eventLog.heartbeatReceived(parsed.session_id, revived ? { revived: true } : {})
      res.json({ success: true, session_id: parsed.session_id, ...(revived && { revived }) })
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/list_sessions', (req: Request, res: Response, next) => {
    try {
      const query = SessionStatusQuery.safeParse(req.query)
      const status = query.success ? query.data.status : (req.query.status as string | undefined)
      const includeArchived = query.success
        ? query.data.include_archived === 'true'
        : req.query.include_archived === 'true'
      const sessions = findAllSessions(db, status, includeArchived)
      const enriched = sessions.map((session) => ({
        ...session,
        team: findTeamInfoBySession(db, session.id),
      }))
      res.json({ sessions: enriched })
    } catch (error) {
      next(error)
    }
  })

  // ── Messages ────────────────────────────────────────────────

  app.post('/api/messages', async (req: Request, res: Response, next) => {
    try {
      const parsed = SendMessageSchema.parse(req.body)
      // Issue #70: validate participants up front so callers get an
      // actionable, distinguishable error instead of a collapsed FK 500.
      // An expired/completed receiver still ACCEPTS mail — identity is
      // durable and the row revives on reconnect; only an id the broker
      // has never known is refused.
      const sender = findSessionById(db, parsed.sender_id)
      if (!sender) {
        throw new BrokerError(
          `sender '${parsed.sender_id}' is not a registered participant — register the session (POST /api/register) before sending`,
          404,
          'UNKNOWN_PARTICIPANT',
        )
      }
      let receiverStatus: string | null = null
      if (parsed.receiver_id != null) {
        const receiver = findSessionById(db, parsed.receiver_id)
        if (!receiver) {
          throw new BrokerError(
            `receiver '${parsed.receiver_id}' is not a registered participant — verify the id via GET /api/list_sessions?include_archived=true (expired participants are archived but still addressable)`,
            404,
            'UNKNOWN_PARTICIPANT',
          )
        }
        receiverStatus = receiver.status
      }
      const { message, replayed } = createMessageWithReplay(db, {
        id: randomUUID(),
        sender_id: parsed.sender_id,
        receiver_id: parsed.receiver_id ?? null,
        content: parsed.content,
        story_id: parsed.story_id ?? null,
        reply_to: parsed.reply_to ?? null,
        client_message_id: parsed.client_message_id ?? null,
      })
      if (!replayed) {
        eventLog.messageSent(parsed.sender_id, {
          message_id: message.id,
          receiver_id: parsed.receiver_id ?? null,
        })
      }
      // Acceptance by the broker is NOT delivery or acknowledgement — the
      // receiver_status hint tells the sender whether delivery is pending on
      // a revive (expired/completed receivers keep their inbox).
      res.status(replayed ? 200 : 201).json({
        ...message,
        replayed,
        receiver_status: receiverStatus,
      })
    } catch (error) {
      if (error instanceof ClientMessageIdConflictError) {
        next(new ConflictError(error.message))
        return
      }
      // A participant purged between validation and INSERT still surfaces as
      // a distinguishable error, not a collapsed FK 500 (issue #70).
      if ((error as { code?: string })?.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
        next(
          new BrokerError(
            'a participant was deregistered while the send was in flight — re-check sender and receiver ids and retry',
            404,
            'UNKNOWN_PARTICIPANT',
          ),
        )
        return
      }
      next(error)
    }
  })

  app.get('/api/messages/:receiverId', (req: Request, res: Response, next) => {
    try {
      const receiverId = param(req, 'receiverId')
      const unreadOnly = req.query.unread_only === 'true'
      const messages = findMessagesByReceiver(db, receiverId, { unreadOnly })
      res.json({ messages })
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/messages/mark-read', async (req: Request, res: Response, next) => {
    try {
      const parsed = MarkMessagesReadSchema.parse(req.body)
      for (const id of parsed.message_ids) {
        markMessageRead(db, id)
      }
      res.json({ success: true, count: parsed.message_ids.length })
    } catch (error) {
      next(error)
    }
  })

  // Issue #70: delivery receipt — directed messages that reached the
  // recipient's context (auto-injection or an explicit fetch). Weaker than
  // read_at; never applies to broadcasts (a single column cannot carry
  // per-recipient delivery).
  app.post('/api/messages/mark-delivered', async (req: Request, res: Response, next) => {
    try {
      const parsed = MarkMessagesDeliveredSchema.parse(req.body)
      const delivered = markMessagesDelivered(db, parsed.message_ids, parsed.receiver_id)
      res.json({ success: true, delivered })
    } catch (error) {
      next(error)
    }
  })

  // Issue #70: explicit recipient disposition — the acknowledgement that a
  // send response must never be inferred to imply. Directed mail only: a
  // broadcast has many recipients and one row, so a single ack would hide it
  // from every other inbox and record a verdict nobody else gave (the same
  // reason mark-delivered refuses broadcasts).
  app.post('/api/messages/ack', async (req: Request, res: Response, next) => {
    try {
      const parsed = AckMessageSchema.parse(req.body)
      const existing = findMessageById(db, parsed.message_id)
      if (!existing) {
        throw new NotFoundError('Message', parsed.message_id)
      }
      if (existing.receiver_id === null) {
        throw new BrokerError(
          `message '${parsed.message_id}' is a broadcast — dispositions are per-recipient and broadcasts cannot carry one`,
          409,
          'BROADCAST_NOT_ACKABLE',
        )
      }
      const message = setMessageDisposition(
        db,
        parsed.message_id,
        parsed.disposition,
        parsed.note ?? undefined,
      )
      eventLog.messageDisposition(existing.receiver_id, {
        message_id: parsed.message_id,
        disposition: parsed.disposition,
      })
      res.json({ success: true, message })
    } catch (error) {
      next(error)
    }
  })

  // ── Intents / Conflicts ─────────────────────────────────────

  app.post('/api/declare_intent', async (req: Request, res: Response, next) => {
    try {
      const parsed = DeclareIntentSchema.parse(req.body)
      declareIntent(db, {
        file_path: parsed.file,
        session_id: parsed.session_id,
        intent: parsed.operation,
      })
      eventLog.intentDeclared(parsed.session_id, {
        file_path: parsed.file,
        intent: parsed.operation ?? 'edit',
      })

      const conflicts = findConflicts(db, parsed.file)
      const hasConflict = conflicts.length > 0
      if (hasConflict && conflicts[0]) {
        eventLog.conflictDetected(parsed.session_id, {
          file_path: parsed.file,
          sessions: conflicts[0].sessions.map((s) => s.session_id),
        })
      }

      res.json({
        conflict: hasConflict,
        conflicting_sessions:
          hasConflict && conflicts[0]
            ? conflicts[0].sessions.filter((s) => s.session_id !== parsed.session_id)
            : [],
      })
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/release_intent', (req: Request, res: Response, next: NextFunction) => {
    try {
      const { session_id, file } = DeclareIntentSchema.parse(req.body)
      const released = releaseIntent(db, session_id, normalizePath(file))
      res.json({ released })
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/conflicts', (_req: Request, res: Response, next) => {
    try {
      const conflicts = findConflicts(db)
      res.json({ conflicts })
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/intents', (req: Request, res: Response, next) => {
    try {
      const filePath = req.query.file as string | undefined
      const sessionId = req.query.session_id as string | undefined

      if (sessionId) {
        const intents = findIntentsBySession(db, sessionId)
        res.json({ intents })
        return
      }

      if (filePath) {
        const normalized = normalizePath(filePath)
        const rows = db
          .prepare('SELECT * FROM file_intents WHERE file_path = ? ORDER BY declared_at')
          .all(normalized)
        res.json({ intents: rows })
        return
      }

      // All active intents
      const rows = db.prepare('SELECT * FROM file_intents ORDER BY declared_at').all()
      res.json({ intents: rows })
    } catch (error) {
      next(error)
    }
  })

  // ── Shared State ────────────────────────────────────────────

  app.post('/api/state', async (req: Request, res: Response, next) => {
    try {
      const parsed = SetStateSchema.safeParse(req.body)
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request body' })
        return
      }
      const { key, value, story_id, session_id } = parsed.data
      const entry = setState(db, {
        key,
        value,
        story_id: story_id ?? null,
        session_id: session_id ?? null,
      })
      eventLog.stateUpdated(session_id ?? null, { key })
      res.json(entry)
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/state/:key', (req: Request, res: Response, next) => {
    try {
      const key = param(req, 'key')
      const entry = getState(db, key)
      if (!entry) {
        throw new NotFoundError('State', key)
      }
      res.json(entry)
    } catch (error) {
      next(error)
    }
  })

  app.delete('/api/state/:key', (req: Request, res: Response, next) => {
    try {
      const key = param(req, 'key')
      const deleted = deleteState(db, key)
      if (!deleted) {
        throw new NotFoundError('State', key)
      }
      eventLog.stateDeleted(null, { key })
      res.json({ success: true, key })
    } catch (error) {
      next(error)
    }
  })

  // ── Teams ───────────────────────────────────────────────────

  app.post('/api/teams', async (req: Request, res: Response, next) => {
    try {
      const parsed = CreateTeamSchema.parse(req.body)
      const team = createTeam(
        db,
        parsed.name,
        parsed.description ?? undefined,
        parsed.parent_team_id ?? undefined,
        projectId,
      )
      eventLog.teamCreated(null, { team_id: team.id, name: team.name })
      res.status(201).json(team)
    } catch (error) {
      next(error)
    }
  })

  // Multi-project foundation (P3): supervisor view. Read-only cross-project
  // summary (team/session counts per project, including the legacy NULL
  // bucket) — the seed of a meta-broker dashboard. `current` echoes the
  // project this broker is bound to.
  app.get('/api/admin/projects', (_req: Request, res: Response, next) => {
    try {
      res.json({ current: projectId ?? null, projects: listProjects(db) })
    } catch (error) {
      next(error)
    }
  })

  // Agent role registry (P4: de-hardcode roles). Runtime self-service so the
  // system — not just maintainers — can mint novel agent roles. GET lists the
  // discoverability catalogue; POST registers a new role.
  app.get('/api/agent-roles', (_req: Request, res: Response, next) => {
    try {
      res.json({ roles: listRoles(db) })
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/agent-roles', (req: Request, res: Response, next) => {
    try {
      const body = (req.body ?? {}) as {
        role?: unknown
        description?: unknown
        spawnable?: unknown
      }
      const role = typeof body.role === 'string' ? body.role.trim() : ''
      if (role.length === 0 || role.length > 256) {
        res.status(400).json({ error: 'role must be a non-empty string (<=256 chars)' })
        return
      }
      registerRole(db, {
        role,
        description: typeof body.description === 'string' ? body.description : null,
        spawnable: body.spawnable === true,
      })
      const created = listRoles(db).find((r) => r.role === role)
      res.status(201).json(created ?? { role })
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/teams', (req: Request, res: Response, next) => {
    try {
      const status = req.query.status as string | undefined
      const includeArchived = req.query.include_archived === 'true'
      const teams = findAllTeams(db, status, includeArchived)
      res.json({ teams })
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/teams/:id', (req: Request, res: Response, next) => {
    try {
      const teamId = param(req, 'id')
      const team = findTeamById(db, teamId)
      if (!team) {
        throw new NotFoundError('Team', teamId)
      }
      const members = findTeamMembers(db, teamId)
      res.json({ ...team, members })
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/teams/:id/members', async (req: Request, res: Response, next) => {
    try {
      const parsed = JoinTeamSchema.parse(req.body)
      const teamId = param(req, 'id')
      const member = joinTeam(
        db,
        teamId,
        parsed.session_id,
        parsed.name,
        parsed.role,
        parsed.agent_type ?? undefined,
      )
      eventLog.teamMemberJoined(parsed.session_id, {
        team_id: teamId,
        name: parsed.name,
      })
      res.status(201).json(member)
    } catch (error) {
      next(error)
    }
  })

  app.delete('/api/teams/:id/members/:sessionId', (req: Request, res: Response, next) => {
    try {
      const teamId = param(req, 'id')
      const sessionId = param(req, 'sessionId')
      const removed = removeTeamMember(db, teamId, sessionId)
      if (!removed) {
        throw new NotFoundError('TeamMember', sessionId)
      }
      eventLog.teamMemberLeft(sessionId, { team_id: teamId })
      res.json({ success: true })
    } catch (error) {
      next(error)
    }
  })

  app.delete('/api/teams/:id', (req: Request, res: Response, next) => {
    try {
      const teamId = param(req, 'id')
      const team = disbandTeam(db, teamId)
      eventLog.teamDisbanded(null, { team_id: teamId })
      res.json(team)
    } catch (error) {
      next(error)
    }
  })

  // ── Team Messages ──────────────────────────────────────────────

  app.get('/api/teams/:id/messages', (req: Request, res: Response, next) => {
    try {
      const teamId = param(req, 'id')
      const team = findTeamById(db, teamId)
      if (!team) throw new NotFoundError('Team', teamId)
      const limit = parseInt(String(req.query.limit ?? '100'), 10)
      const offset = parseInt(String(req.query.offset ?? '0'), 10)
      const messages = findMessagesByTeamMembers(db, teamId, {
        limit: Math.min(limit, 1000),
        offset: Math.max(offset, 0),
      })
      const total = countMessagesByTeamMembers(db, teamId)
      res.json({ messages, total, limit, offset })
    } catch (error) {
      next(error)
    }
  })

  // POST a team-scoped message. Supports direct (to_agent_id), role-based
  // (to_role), broadcast (neither), and cross-team (to_team) addressing.
  // Messages are assigned a monotonic `seq` scoped to the delivery team so
  // consumers can resume from a cursor across broker restarts.
  app.post('/api/teams/:id/messages', async (req: Request, res: Response, next) => {
    try {
      const postingTeamId = param(req, 'id')
      const postingTeam = findTeamById(db, postingTeamId)
      if (!postingTeam) throw new NotFoundError('Team', postingTeamId)

      const body = req.body as {
        sender_id?: string
        content?: string
        to_agent_id?: string | null
        to_role?: string | null
        to_team?: string | null
        story_id?: string | null
        reply_to?: string | null
      }
      if (!body.sender_id || typeof body.sender_id !== 'string') {
        res.status(400).json({ error: 'sender_id is required' })
        return
      }
      if (!body.content || typeof body.content !== 'string') {
        res.status(400).json({ error: 'content is required' })
        return
      }

      // Resolve delivery team: cross-team routing when to_team is set and
      // differs from posting team. Validate that the target team exists.
      let deliveryTeamId = postingTeamId
      if (body.to_team && body.to_team !== postingTeamId) {
        const targetTeam = findTeamById(db, body.to_team)
        if (!targetTeam) {
          res.status(404).json({ error: `Target team ${body.to_team} not found` })
          return
        }
        deliveryTeamId = body.to_team
      }

      const message = createMessage(db, {
        id: randomUUID(),
        sender_id: body.sender_id,
        receiver_id: body.to_agent_id ?? null,
        content: body.content,
        story_id: body.story_id ?? null,
        reply_to: body.reply_to ?? null,
        team_id: deliveryTeamId,
        to_role: body.to_role ?? null,
        to_team: body.to_team ?? null,
      })
      eventLog.messageSent(body.sender_id, {
        message_id: message.id,
        receiver_id: message.receiver_id,
        team_id: deliveryTeamId,
        seq: message.seq,
      })
      res.status(201).json(message)
    } catch (error) {
      next(error)
    }
  })

  // Resumable cursor-based read. Returns messages with seq > cursor in order.
  // The response includes a `cursor` field equal to the max seq delivered,
  // which clients should pass on the next call.
  app.get('/api/teams/:id/messages/since/:cursor', (req: Request, res: Response, next) => {
    try {
      const teamId = param(req, 'id')
      const team = findTeamById(db, teamId)
      if (!team) throw new NotFoundError('Team', teamId)
      const cursorRaw = param(req, 'cursor')
      const cursor = Number.parseInt(cursorRaw, 10)
      if (!Number.isFinite(cursor) || cursor < 0) {
        res.status(400).json({ error: 'cursor must be a non-negative integer' })
        return
      }
      const limit = Math.min(
        Math.max(parseInt(String(req.query.limit ?? '500'), 10) || 500, 1),
        5000,
      )
      const forAgent = typeof req.query.for_agent === 'string' ? req.query.for_agent : undefined
      const forRole = typeof req.query.for_role === 'string' ? req.query.for_role : undefined

      const all = findTeamMessagesSince(db, teamId, cursor, { limit })
      // Optional server-side filtering: if for_agent/for_role specified, return
      // only messages addressed to that agent, to that role, or broadcast.
      const filtered =
        forAgent || forRole
          ? all.filter((m) => {
              if (m.receiver_id === null && m.to_role === null) return true
              if (forAgent && m.receiver_id === forAgent) return true
              if (forRole && m.to_role === forRole) return true
              return false
            })
          : all

      const maxSeq = all.length > 0 ? (all[all.length - 1]!.seq ?? cursor) : cursor
      res.json({
        messages: filtered,
        cursor: maxSeq,
        head: getMaxTeamSeq(db, teamId),
      })
    } catch (error) {
      next(error)
    }
  })

  // ── Respawn Policies ─────────────────────────────────────────

  app.get('/api/teams/:id/respawn-policies', (req: Request, res: Response, next) => {
    try {
      const teamId = param(req, 'id')
      const policies = findRespawnPoliciesByTeam(db, teamId)
      res.json({ team_id: teamId, policies })
    } catch (error) {
      next(error)
    }
  })

  app.put('/api/teams/:id/respawn-policies', (req: Request, res: Response, next) => {
    try {
      const teamId = param(req, 'id')
      const { role, min_count, max_retries, backoff_base_ms, enabled } = req.body as {
        role?: string
        min_count?: number
        max_retries?: number
        backoff_base_ms?: number
        enabled?: number
      }
      if (!role) {
        res.status(400).json({ error: 'role is required' })
        return
      }
      const policy = upsertRespawnPolicy(db, {
        team_id: teamId,
        role,
        min_count,
        max_retries,
        backoff_base_ms,
        enabled,
      })
      res.json(policy)
    } catch (error) {
      next(error)
    }
  })

  app.delete('/api/teams/:id/respawn-policies/:role', (req: Request, res: Response, next) => {
    try {
      const teamId = param(req, 'id')
      const role = param(req, 'role')
      const deleted = deleteRespawnPolicy(db, teamId, role)
      if (!deleted) {
        res.status(404).json({ error: `No respawn policy for team ${teamId} role ${role}` })
        return
      }
      res.json({ success: true })
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/teams/:id/respawn-history', (req: Request, res: Response, next) => {
    try {
      const teamId = param(req, 'id')
      const limit = parseInt(String(req.query.limit ?? '50'), 10)
      const history = findRespawnHistory(db, teamId, { limit: Math.min(limit, 500) })
      res.json({ team_id: teamId, history })
    } catch (error) {
      next(error)
    }
  })

  // ── Scaling Policies ─────────────────────────────────────────

  app.get('/api/teams/:id/scaling-policies', (req: Request, res: Response, next) => {
    try {
      const teamId = param(req, 'id')
      const policies = findScalingPoliciesByTeam(db, teamId)
      res.json({ team_id: teamId, policies })
    } catch (error) {
      next(error)
    }
  })

  app.put('/api/teams/:id/scaling-policies', (req: Request, res: Response, next) => {
    try {
      const teamId = param(req, 'id')
      const {
        role,
        min_count,
        max_count,
        scale_up_threshold,
        scale_down_threshold,
        cooldown_ms,
        enabled,
      } = req.body as {
        role?: string
        min_count?: number
        max_count?: number
        scale_up_threshold?: number
        scale_down_threshold?: number
        cooldown_ms?: number
        enabled?: number
      }
      if (!role) {
        res.status(400).json({ error: 'role is required' })
        return
      }
      const policy = upsertScalingPolicy(db, {
        team_id: teamId,
        role,
        min_count,
        max_count,
        scale_up_threshold,
        scale_down_threshold,
        cooldown_ms,
        enabled,
      })
      res.json(policy)
    } catch (error) {
      next(error)
    }
  })

  app.delete('/api/teams/:id/scaling-policies/:role', (req: Request, res: Response, next) => {
    try {
      const teamId = param(req, 'id')
      const role = param(req, 'role')
      const deleted = deleteScalingPolicy(db, teamId, role)
      if (!deleted) {
        res.status(404).json({ error: `No scaling policy for team ${teamId} role ${role}` })
        return
      }
      res.json({ success: true })
    } catch (error) {
      next(error)
    }
  })

  // ── Events ──────────────────────────────────────────────────

  app.get('/api/events/since/:afterId', (req: Request, res: Response, next) => {
    try {
      const afterId = parseInt(param(req, 'afterId'), 10)
      const events = getEventsSince(db, isNaN(afterId) ? 0 : afterId)
      res.json({ events })
    } catch (error) {
      next(error)
    }
  })

  // Push-based SSE endpoint using SSEManager + EventDispatcher
  app.get('/api/events/live', (req: Request, res: Response) => {
    if (!deps.sseManager || !deps.dispatcher) {
      res.status(503).json({ error: 'SSE streaming not available' })
      return
    }

    const clientIp = req.ip ?? req.socket.remoteAddress ?? 'unknown'
    if (!deps.sseManager.addConnection(clientIp, res)) {
      res.status(429).json({ error: 'Too many SSE connections' })
      return
    }

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()

    deps.sseManager.subscribeConnection(res, deps.dispatcher)

    res.on('close', () => {
      deps.sseManager!.removeConnection(clientIp, res)
    })
  })

  // ── Rotation ───────────────────────────────────────────────

  app.get('/api/rotate/status', (_req: Request, res: Response) => {
    const ctrl = deps.rotationController
    if (!ctrl) {
      res.status(503).json({ error: 'Rotation controller not initialized' })
      return
    }
    res.json(ctrl.getStats())
  })

  app.get('/api/rotate/candidates', (_req: Request, res: Response) => {
    const ctrl = deps.rotationController
    if (!ctrl) {
      res.status(503).json({ error: 'Rotation controller not initialized', candidates: [] })
      return
    }
    const detector = deps.compactionDetector
    const candidates = detector ? detector.getRotationCandidates() : []
    res.json({ candidates })
  })

  app.post('/api/rotate/:sessionId', async (req: Request, res: Response, next) => {
    try {
      const ctrl = deps.rotationController
      if (!ctrl) {
        res.status(503).json({ error: 'Rotation controller not initialized' })
        return
      }
      const sessionId = param(req, 'sessionId')
      const parsed = RotateSessionSchema.safeParse(req.body)
      const body = parsed.success ? parsed.data : {}
      const result = await ctrl.rotateSession(sessionId, body as Record<string, unknown>)
      res.json(result)
    } catch (error) {
      next(error)
    }
  })

  // ── Cost ─────────────────────────────────────────────────────

  app.get('/api/cost/summary', (_req: Request, res: Response) => {
    const tracker = deps.costTracker
    if (!tracker) {
      res.json({
        error: 'Cost tracker not initialized',
        sessionCount: 0,
        totalTokens: 0,
        estimatedTotalCostUSD: 0,
      })
      return
    }
    res.json(tracker.getSummary())
  })

  app.get('/api/cost/session/:id', (req: Request, res: Response) => {
    const tracker = deps.costTracker
    if (!tracker) {
      res.status(404).json({ error: 'Cost tracker not initialized' })
      return
    }
    const sessionId = param(req, 'id')
    const cost = tracker.getSessionCost(sessionId)
    if (!cost) {
      res.status(404).json({ error: `No cost data for session ${sessionId}` })
      return
    }
    res.json(cost)
  })

  // ── Usage (DB-backed cost persistence) ─────────────────────

  app.post('/api/usage', (req: Request, res: Response, next) => {
    try {
      const { session_id, team_id, task_id, tokens_in, tokens_out, model, cost_usd } = req.body as {
        session_id?: string
        team_id?: string
        task_id?: number
        tokens_in?: number
        tokens_out?: number
        model?: string
        cost_usd?: number
      }
      if (!session_id || tokens_in == null || tokens_out == null) {
        res.status(400).json({ error: 'session_id, tokens_in, and tokens_out are required' })
        return
      }
      const record = recordUsage(db, {
        session_id,
        team_id: team_id ?? undefined,
        task_id: task_id ?? undefined,
        tokens_in,
        tokens_out,
        model: model ?? undefined,
        cost_usd: cost_usd ?? 0,
      })
      res.status(201).json(record)
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/usage/session/:id', (req: Request, res: Response, next) => {
    try {
      const sessionId = param(req, 'id')
      const records = findUsageBySession(db, sessionId)
      const summary = getSessionCostSummary(db, sessionId)
      res.json({ records, summary })
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/usage/summary', (_req: Request, res: Response, next) => {
    try {
      const summary = getCostSummary(db)
      res.json(summary)
    } catch (error) {
      next(error)
    }
  })

  // ── Autonomy ───────────────────────────────────────────────
  // These routes persist autonomy level changes to disk (~/.scns/state/).
  // The running brain agent reads its autonomy level at startup; changes via
  // these endpoints take effect on the next brain wake cycle (the brain
  // re-reads from disk each cycle). For immediate effect, restart the system.

  app.get('/api/autonomy', (_req: Request, res: Response) => {
    try {
      const stateDir = join(resolveScnsHome(), '.scns', 'state')
      res.json(loadAutonomy(stateDir))
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  app.post('/api/autonomy/promote', (_req: Request, res: Response) => {
    try {
      const stateDir = join(resolveScnsHome(), '.scns', 'state')
      res.json(promoteAutonomy(stateDir))
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  app.post('/api/autonomy/demote', (_req: Request, res: Response) => {
    try {
      const stateDir = join(resolveScnsHome(), '.scns', 'state')
      res.json(demoteAutonomy(stateDir))
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  // ── Session Hooks ────────────────────────────────────────────

  app.post('/api/hooks/:event', async (req: Request, res: Response, next) => {
    try {
      const eventParam = param(req, 'event')
      // Coerce event from URL param when missing from body (defense-in-depth)
      if (req.body && typeof req.body === 'object' && !req.body.event) {
        req.body.event = eventParam
      }
      const parsed = SessionHookEventSchema.parse(req.body)
      if (eventParam !== parsed.event) {
        res.status(400).json({
          error: `URL event '${eventParam}' does not match body event '${parsed.event}'`,
        })
        return
      }

      const cwd = parsed.metadata?.cwd
      if (cwd != null && (typeof cwd !== 'string' || cwd.trim() === '')) {
        res.status(400).json({ error: 'metadata.cwd must be a non-empty string' })
        return
      }
      const workingDir = typeof cwd === 'string' ? cwd : (projectRoot ?? process.cwd())
      if (rejectForeignWorkingDir(res, workingDir)) return

      // Auto-register session on any hook event (except session-end) if not already known.
      // Sessions may start before the broker, so we can't rely on session-start alone.
      if (parsed.sessionId && parsed.event !== 'session-end') {
        const existing = findSessionById(db, parsed.sessionId)
        if (!existing) {
          try {
            createSession(db, {
              id: parsed.sessionId,
              purpose: 'copilot-hook',
              working_dir: workingDir,
              worktree: null,
              project_id: projectId ?? null,
            })
            eventLog.sessionRegistered(parsed.sessionId, {
              source: 'hook',
              event: parsed.event,
            })
          } catch (err) {
            logger.warn({ err, sessionId: parsed.sessionId }, 'Hook: session auto-register failed')
          }
        } else if (parsed.event === 'session-start') {
          // Issue #70: a session-start for a known id is a resume — revive it
          // even from 'completed' (a prior session-end) so its retained inbox
          // becomes deliverable again.
          try {
            reviveSession(db, parsed.sessionId, ['expired', 'completed', 'zombie'])
          } catch (err) {
            logger.warn({ err, sessionId: parsed.sessionId }, 'Hook: session revive failed')
          }
        } else if (existing.status === 'expired') {
          // Issue #70: any hook activity is proof of life — undo lease expiry.
          try {
            reviveSession(db, parsed.sessionId)
          } catch (err) {
            logger.warn({ err, sessionId: parsed.sessionId }, 'Hook: session revive failed')
          }
        }
      }

      // Mark session completed on session-end hook
      if (parsed.event === 'session-end' && parsed.sessionId) {
        try {
          updateSessionStatus(db, parsed.sessionId, 'completed')
        } catch (err) {
          logger.warn({ err, sessionId: parsed.sessionId }, 'Hook: session status update failed')
        }
        // Increment dream daemon session counter so consolidation gates can pass
        try {
          deps.onSessionCompleted?.()
        } catch (err) {
          logger.debug({ err }, 'Hook: dream session counter increment failed')
        }
      }

      // Dual-write: forward to observation manager AND persist to event log
      const observation = deps.handleSessionEvent?.(parsed) ?? null
      // Metadata is spread FIRST so a body carrying metadata.hookEvent
      // (or tool/model) cannot spoof the schema-validated fields —
      // downstream subscribers (e.g. the NORTH_STAR nudge) key on
      // payload.hookEvent to detect session-end.
      eventLog.hookReceived(parsed.sessionId ?? null, {
        ...parsed.metadata,
        hookEvent: parsed.event,
        tool: parsed.tool,
        model: parsed.model,
      })

      // Update heartbeat so hook-registered sessions stay alive
      if (parsed.sessionId) {
        try {
          updateHeartbeat(db, parsed.sessionId)
        } catch (err) {
          logger.debug({ err, sessionId: parsed.sessionId }, 'Hook: heartbeat update skipped')
        }
      }

      // Async sentiment analysis on user-prompt events (non-blocking)
      if (parsed.event === 'user-prompt' && deps.sentimentAnalyzer && deps.negativeMemoryStore) {
        const promptText = parsed.metadata?.prompt as string | undefined
        if (promptText && typeof promptText === 'string' && promptText.length > 10) {
          // Fire-and-forget — never delay the hook response
          Promise.resolve().then(() => {
            try {
              const analysis = deps.sentimentAnalyzer!(promptText)
              if (analysis.isNegative && analysis.overallScore >= 0.7) {
                deps.negativeMemoryStore!.storeFromHeuristic({
                  originalText: promptText.slice(0, 2000),
                  dontRule:
                    analysis.dontRule ??
                    analysis.signals[0]?.triggers[0] ??
                    'Negative feedback detected',
                  category: analysis.signals[0]?.type ?? 'frustration',
                  recommendedTarget: analysis.recommendedTarget ?? 'general',
                  confidence: analysis.overallScore,
                  sessionId: parsed.sessionId,
                })
                logger.info(
                  { score: analysis.overallScore, category: analysis.signals[0]?.type },
                  'Heuristic negative memory stored',
                )
              }
            } catch (err) {
              logger.debug({ err }, 'Sentiment analysis failed (non-critical)')
            }
          })
        }
      }

      res.json({
        acknowledged: true,
        observationId: observation?.id ?? randomUUID(),
      })
    } catch (error) {
      next(error)
    }
  })

  // ── Tasks ──────────────────────────────────────────────────

  app.post('/api/tasks', (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = CreateTaskSchema.parse(req.body)
      const team = findTeamById(db, parsed.team_id)
      if (!team) {
        throw new NotFoundError('Team', parsed.team_id)
      }
      const task = createTask(db, {
        team_id: parsed.team_id,
        subject: parsed.subject,
        description: parsed.description ?? null,
        active_form: parsed.active_form ?? null,
      })
      res.status(201).json(task)
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/tasks', (req: Request, res: Response, next: NextFunction) => {
    try {
      const teamId = req.query.team_id as string | undefined
      if (!teamId) {
        res.status(400).json({ error: 'team_id query parameter is required' })
        return
      }
      const status = req.query.status as string | undefined
      const tasks = findTasksByTeam(db, teamId, status)
      res.json({ tasks })
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/tasks/:id', (req: Request, res: Response, next: NextFunction) => {
    try {
      const raw = param(req, 'id')
      const id = parseInt(raw, 10)
      if (String(id) !== raw || id < 1) {
        res.status(400).json({ error: 'Invalid task id' })
        return
      }
      const task = findTaskWithDeps(db, id)
      if (!task) {
        throw new NotFoundError('Task', String(id))
      }
      res.json(task)
    } catch (error) {
      next(error)
    }
  })

  app.patch('/api/tasks/:id', (req: Request, res: Response, next: NextFunction) => {
    try {
      const raw = param(req, 'id')
      const id = parseInt(raw, 10)
      if (String(id) !== raw || id < 1) {
        res.status(400).json({ error: 'Invalid task id' })
        return
      }
      const parsed = UpdateTaskSchema.parse(req.body)

      // Phase 13.12.24 — completion gate. Reject status='completed' unless
      // the owner has either (a) a non-empty staged diff in their working
      // directory or (b) a session_handoff with a passing quality_check.
      if (parsed.status === 'completed') {
        const current = findTaskById(db, id)
        if (!current) {
          throw new NotFoundError('Task', String(id))
        }
        const effectiveOwner = parsed.owner !== undefined ? parsed.owner : (current.owner ?? null)
        const gateResult = evaluateCompletionGate(db, effectiveOwner, deps.gitDiffChecker)
        if (!gateResult.allowed) {
          res.status(409).json({
            error:
              'Task completion blocked: no staged diff and no passing QA handoff for owner. ' +
              'Set status=failed to abandon, or stage changes / record a handoff first.',
            reason: gateResult.reason,
          })
          return
        }
      }

      const task = updateTask(db, id, parsed)
      if (!task) {
        throw new NotFoundError('Task', String(id))
      }
      res.json(task)
    } catch (error) {
      next(error)
    }
  })

  app.delete('/api/tasks/:id', (req: Request, res: Response, next: NextFunction) => {
    try {
      const raw = param(req, 'id')
      const id = parseInt(raw, 10)
      if (String(id) !== raw || id < 1) {
        res.status(400).json({ error: 'Invalid task id' })
        return
      }
      const deleted = deleteTask(db, id)
      if (!deleted) {
        throw new NotFoundError('Task', String(id))
      }
      res.json({ deleted: true })
    } catch (error) {
      next(error)
    }
  })

  // ── Agent Spawn ────────────────────────────────────────────

  app.post('/api/spawn', async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!deps.agentSpawner) {
        res.status(503).json({ error: 'Agent spawner not available' })
        return
      }

      // Enforce rate limits: reject spawns when rate monitor recommends stopping
      if (deps.rateMonitor) {
        const rec = deps.rateMonitor.getRecommendation()
        if (
          rec === RateRecommendation.Pause ||
          rec === RateRecommendation.ScaleDown ||
          rec === RateRecommendation.YieldToUser
        ) {
          res.status(429).json({ error: `Spawn blocked: rate limit recommendation is ${rec}` })
          return
        }
      }

      const body = SpawnAgentSchema.parse(req.body)

      // Validate team exists before attempting spawn
      const team = findTeamById(db, body.team_id)
      if (!team) {
        throw new NotFoundError('Team', body.team_id)
      }

      const result = await deps.agentSpawner.spawn({
        team_id: body.team_id,
        name: body.name,
        role: body.role,
        working_dir: body.working_dir,
        prompt: body.prompt,
        agent: body.agent,
        permissions: body.permissions,
        launch_method: body.launch_method,
      })
      res.status(201).json(result)
    } catch (error) {
      next(error)
    }
  })

  // Send follow-up message to a running ACP agent
  app.post(
    '/api/agents/:sessionId/message',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!deps.agentSpawner) {
          res.status(503).json({ error: 'Agent spawner not available' })
          return
        }

        const sessionId = param(req, 'sessionId')
        const { message } = AgentMessageSchema.parse(req.body)

        const result = await deps.agentSpawner.sendMessage(sessionId, message)
        if (!result.accepted) {
          const status = result.error?.includes('not found') ? 404 : 409
          res.status(status).json({ error: result.error })
          return
        }

        eventLog.messageSent(sessionId, { type: 'acp_followup', message: message.slice(0, 200) })
        res.json({ success: true })
      } catch (error) {
        next(error)
      }
    },
  )

  // ── A2A (Agent-to-Agent) Routes ─────────────────────────────
  // All orchestrator-backed routes live under /api/a2a to avoid
  // collision with the existing DB-backed /api/teams and /api/tasks.

  // Task-driven spawn: builds role-aware prompt from a stored task and
  // spawns an agent onto the task's team. Tie goes to the existing owner.
  app.post('/api/tasks/:id/spawn', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const taskId = Number(param(req, 'id'))
      if (!Number.isInteger(taskId) || taskId <= 0) {
        res.status(400).json({ error: 'Invalid task id' })
        return
      }

      const body = SpawnForTaskSchema.parse(req.body)

      // P4: role is free-text at the schema layer; enforce task-spawnability
      // here (a role must have a bespoke prompt strategy to be auto-spawned)
      // and fail with a clean 400 rather than a deep prompt-builder throw.
      if (!isTaskSpawnRoleSupported(body.role)) {
        res.status(400).json({
          error: `Role '${body.role}' is not task-spawnable`,
          supported_roles: SUPPORTED_TASK_SPAWN_ROLES,
        })
        return
      }

      const task = findTaskById(db, taskId)
      if (!task) {
        throw new NotFoundError('Task', String(taskId))
      }

      const team = findTeamById(db, task.team_id)
      if (!team) {
        throw new NotFoundError('Team', task.team_id)
      }
      const archivedRow = db.prepare('SELECT archived_at FROM teams WHERE id = ?').get(team.id) as
        | { archived_at: string | null }
        | undefined
      if (archivedRow?.archived_at != null || team.status === 'disbanded') {
        res.status(410).json({
          error: `Team '${team.id}' is archived or disbanded`,
        })
        return
      }

      if (task.owner) {
        res.status(409).json({
          error: 'Task already has an owner; tie goes to existing owner',
          current_owner: task.owner,
        })
        return
      }

      if (!deps.agentSpawner) {
        res.status(503).json({ error: 'Agent spawner not available' })
        return
      }

      if (deps.rateMonitor) {
        const rec = deps.rateMonitor.getRecommendation()
        if (
          rec === RateRecommendation.Pause ||
          rec === RateRecommendation.ScaleDown ||
          rec === RateRecommendation.YieldToUser
        ) {
          res.status(429).json({ error: `Spawn blocked: rate limit recommendation is ${rec}` })
          return
        }
      }

      const workingDir = body.working_dir ?? process.cwd()
      const prompt = buildTaskSpawnPrompt({
        role: body.role,
        team: { id: team.id, name: team.name },
        task: {
          id: task.id,
          subject: task.subject,
          description: task.description,
        },
        projectRoot: workingDir,
        extraContext: body.extra_context,
      })

      const safeRole = body.role.replace(/[^A-Za-z0-9._-]/g, '-')
      const name = `task-${task.id}-${safeRole}-${randomUUID().slice(0, 8)}`

      const result = await deps.agentSpawner.spawn({
        team_id: team.id,
        name,
        role: body.role,
        working_dir: workingDir,
        prompt,
        launch_method: body.launch_method ?? 'acp',
        permissions: 'default',
        // WS F (Phase 13.13.x): pass the task + team_name so the spawner
        // runs broker-mechanical auto-dispatch when role=scns-manager
        // (see auto-dispatch.ts). No-op for non-manager roles.
        task: {
          id: task.id,
          subject: task.subject,
          description: task.description,
        },
        team_name: team.name,
      })

      updateTask(db, task.id, {
        owner: result.sessionId,
        status: 'in_progress',
      })

      res.status(201).json({
        session_id: result.sessionId,
        acp_session_id: result.acpSessionId,
        role: result.role,
        team_id: result.teamId,
        task_id: task.id,
        name: result.name,
        launch_method: result.launchMethod,
      })
    } catch (error) {
      next(error)
    }
  })

  // ── A2A (Agent-to-Agent) Routes ─────────────────────────────

  app.post('/api/a2a', (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!deps.orchestrator) {
        res.status(503).json({ error: 'A2A orchestrator not available' })
        return
      }
      const result = deps.orchestrator.handleJsonRpc(req.body)
      res.json(result)
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/a2a/status', (_req: Request, res: Response, next: NextFunction) => {
    try {
      if (!deps.orchestrator) {
        res.status(503).json({ error: 'A2A orchestrator not available' })
        return
      }
      res.json(deps.orchestrator.getStatus())
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/a2a/teams/:id/tasks', (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!deps.orchestrator) {
        res.status(503).json({ error: 'A2A orchestrator not available' })
        return
      }
      const teamId = param(req, 'id')
      const state = deps.orchestrator.getOrchestrationState(teamId)
      if (!state) {
        res.status(404).json({ error: `A2A team not found: ${teamId}` })
        return
      }
      const { description } = req.body as { description?: string }
      const task = deps.orchestrator.submitTask(teamId, description ?? 'No description')
      res.status(201).json(task)
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/a2a/teams/:id/tasks', (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!deps.orchestrator) {
        res.status(503).json({ error: 'A2A orchestrator not available' })
        return
      }
      const teamId = param(req, 'id')
      const state = deps.orchestrator.getOrchestrationState(teamId)
      if (!state) {
        res.status(404).json({ error: `A2A team not found: ${teamId}` })
        return
      }
      const tasks = deps.orchestrator.listTasks()
      res.json({ tasks })
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/a2a/teams/:id/status', (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!deps.orchestrator) {
        res.status(503).json({ error: 'A2A orchestrator not available' })
        return
      }
      const teamId = param(req, 'id')
      const state = deps.orchestrator.getOrchestrationState(teamId)
      if (!state) {
        res.status(404).json({ error: `A2A team not found: ${teamId}` })
        return
      }
      res.json(state)
    } catch (error) {
      next(error)
    }
  })

  // ── Quality Gate + Session Handoff (Phase 12.4) ─────────────────

  app.post('/api/quality-check', async (req: Request, res: Response, next) => {
    try {
      const parsed = QualityCheckRequestSchema.parse(req.body)
      const { createQualityChecker } = await import('../services/quality-checker.js')
      const checker = createQualityChecker(db)
      const result = checker.check({
        sessionId: parsed.sessionId,
        output: parsed.output,
        taskType: parsed.taskType,
      })
      eventLog.qualityCheckCompleted(parsed.sessionId ?? null, {
        checkId: result.id,
        passed: result.passed,
        score: result.score,
        findings: result.findings,
      })
      res.status(201).json({
        success: true,
        id: result.id,
        passed: result.passed,
        score: result.score,
        findings: result.findings,
      })
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/quality-checks/:sessionId', async (req: Request, res: Response, next) => {
    try {
      const sessionId = param(req, 'sessionId')
      const checks = findQualityChecksBySession(db, sessionId)
      res.json({ qualityChecks: checks })
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/sessions/:id/handoff', async (req: Request, res: Response, next) => {
    try {
      const sessionId = param(req, 'id')
      const existing = findSessionById(db, sessionId)
      if (!existing) {
        throw new NotFoundError(`Session not found: ${sessionId}`)
      }
      const parsed = CreateHandoffSchema.parse(req.body)
      const handoff = createHandoff(db, {
        session_id: sessionId,
        progress: parsed.progress,
        files_modified: parsed.filesModified,
        tests_status: parsed.testsStatus ?? null,
        remaining_work: parsed.remainingWork ?? null,
        context: parsed.context ?? null,
      })
      eventLog.sessionHandoffCreated(sessionId, {
        handoffId: handoff.id,
        progress: parsed.progress,
      })
      res.status(201).json({ success: true, id: handoff.id })
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/sessions/:id/handoff', async (req: Request, res: Response, next) => {
    try {
      const sessionId = param(req, 'id')
      const handoff = findLatestHandoff(db, sessionId)
      if (!handoff) {
        res.status(404).json({ error: `No ready handoff for session: ${sessionId}` })
        return
      }
      res.json(handoff)
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/sessions/:id/handoffs', async (req: Request, res: Response, next) => {
    try {
      const sessionId = param(req, 'id')
      const handoffs = findHandoffsBySession(db, sessionId)
      res.json({ handoffs })
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/handoffs/:id/consume', async (req: Request, res: Response, next) => {
    try {
      const id = param(req, 'id')
      const parsed = ConsumeHandoffSchema.parse(req.body)
      const ok = consumeHandoff(db, id, parsed.consumedBy)
      if (!ok) {
        res.status(409).json({ error: 'Handoff not available for consumption' })
        return
      }
      res.json({ success: true })
    } catch (error) {
      next(error)
    }
  })

  // ── Shutdown ───────────────────────────────────────────────

  app.post('/api/shutdown', (_req: Request, res: Response) => {
    res.json({ success: true, message: 'Shutting down...' })
    const exitDelayMs = Number(process.env.SCNS_SHUTDOWN_EXIT_DELAY_MS ?? '750')
    if (deps.shutdownFn) {
      deps
        .shutdownFn()
        .catch((err) => {
          logger.error({ err }, 'Shutdown failed')
          process.exitCode = 1
        })
        .finally(() => {
          // See src/cli.ts start command: short settle delay then process.exit()
          // so native worker threads quiesce before libuv tears them down.
          // Prevents the libc++abi mutex abort observed on launchctl bootout.
          setTimeout(() => process.exit(), exitDelayMs).unref()
        })
    } else {
      setTimeout(() => process.exit(0), Math.max(500, exitDelayMs)).unref()
    }
  })

  // ── System Stop ─────────────────────────────────────────────

  app.post('/api/system/stop', (_req: Request, res: Response) => {
    res.json({ acknowledged: true, message: 'Shutdown initiated' })
    if (deps.shutdownFn) {
      const exitDelayMs = Number(process.env.SCNS_SHUTDOWN_EXIT_DELAY_MS ?? '750')
      deps
        .shutdownFn()
        .catch((err) => {
          logger.error({ err }, 'Shutdown failed')
          process.exitCode = 1
        })
        .finally(() => {
          setTimeout(() => process.exit(), exitDelayMs).unref()
        })
    }
  })
}
