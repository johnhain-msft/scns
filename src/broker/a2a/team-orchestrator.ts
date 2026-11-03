// ---------------------------------------------------------------------------
// Team Orchestrator — top-level coordinator for all A2A Phase 7 components
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto'
import { createAgentCardRegistry } from './agent-card.js'
import type { AgentCard } from './agent-card.js'
import { createA2ATaskStateMachine, A2ATaskStatus } from './task-state.js'
import type { A2ATask } from './task-state.js'
import { getTeamTemplate } from './templates.js'
import type { TeamManifest, ReconcileAction, TeamState } from './team-manifest.js'
import { createOrchestrationEngine } from './orchestration.js'
import type { OrchestrationState } from './orchestration.js'
import { createAutoScaler } from './auto-scaler.js'
import type { ScaleDecision, ScalerStatus } from './auto-scaler.js'
import { createRespawnController } from './respawn-controller.js'
import type { DeadAgent, RespawnResult, RespawnStats, SpawnRequest } from './respawn-controller.js'
import { createResponse, createError, isRequest, JsonRpcErrorCode } from './jsonrpc.js'
import type { JsonRpcResponse, JsonRpcError } from './jsonrpc.js'
import type { createRateMonitor } from '../../rate-limit/rate-monitor.js'
import { NotFoundError } from '../../shared/errors.js'

// ── Types ────────────────────────────────────────────────────────────

export interface TeamOrchestratorDeps {
  readonly rateMonitor: ReturnType<typeof createRateMonitor>
  /**
   * Spawn callback used to materialize a new agent. `teamId` is the team the
   * agent must rejoin — when missing (or the team has been disbanded/archived),
   * implementations should return `null` so the caller records the spawn as
   * skipped/failed rather than attempting an FK-violating insert.
   */
  readonly onSpawn?: (opts: SpawnRequest) => Promise<string | null>
  readonly onKill?: (sessionId: string) => Promise<void>
}

export interface TeamOrchestratorStatus {
  readonly registeredAgents: number
  readonly activeTasks: number
  readonly activeTeams: number
  readonly scalerStatus: ScalerStatus
  readonly respawnStats: RespawnStats
}

export interface TeamOrchestrator {
  registerAgent(card: AgentCard): void
  unregisterAgent(id: string): boolean
  getAgentCard(id: string): AgentCard | null
  findAgentsByCapability(capability: string): readonly AgentCard[]
  getWellKnownJson(): object

  submitTask(submittedBy: string, description: string): A2ATask
  assignTask(taskId: string, agentId: string): A2ATask
  updateTaskStatus(
    taskId: string,
    status: A2ATaskStatus,
    options?: { result?: unknown; error?: string },
  ): A2ATask
  getTask(taskId: string): A2ATask | null
  listTasks(filter?: { status?: A2ATaskStatus }): readonly A2ATask[]

  createTeamFromTemplate(templateName: string, teamId: string): OrchestrationState
  createTeamFromManifest(manifest: TeamManifest, teamId: string): OrchestrationState
  advancePhase(teamId: string): OrchestrationState
  getOrchestrationState(teamId: string): OrchestrationState | null
  reconcile(teamId: string, actualState: TeamState): readonly ReconcileAction[]

  getScalerStatus(): ScalerStatus
  getRespawnStats(): RespawnStats
  tickAutoScaler(): Promise<ScaleDecision>
  respawnDeadAgent(dead: DeadAgent): Promise<RespawnResult>

  handleJsonRpc(message: unknown): JsonRpcResponse | JsonRpcError

  getStatus(): TeamOrchestratorStatus
}

// ── Factory ──────────────────────────────────────────────────────────

export function createTeamOrchestrator(deps: TeamOrchestratorDeps): TeamOrchestrator {
  const registry = createAgentCardRegistry()
  const taskMachine = createA2ATaskStateMachine()
  const engine = createOrchestrationEngine()

  // Task store: id → A2ATask
  const tasks = new Map<string, A2ATask>()

  // Team store: teamId → { state, manifest }
  const teams = new Map<string, { state: OrchestrationState; manifest: TeamManifest }>()

  const autoScaler = createAutoScaler({
    rateMonitor: deps.rateMonitor,
    // Auto-scaler scale-up is intentionally NOT wired to the shared `onSpawn`
    // in production: fleet-level "worker" spawns have no team context, would
    // FK-fail against `team_members.team_id`, and the SCNS role enum doesn't
    // include "worker" anyway. Auto-scaler is therefore scale-down-only at
    // the orchestrator level until a team-aware scale-up design lands. Tests
    // that exercise scale-up still work because they instantiate
    // `createAutoScaler` directly with their own `onSpawn` mock.
    onKill: deps.onKill,
    getActiveCount: () => registry.list().length,
    getQueueDepth: () =>
      [...tasks.values()].filter((t) => t.status === A2ATaskStatus.Submitted).length,
  })

  const respawnCtrl = createRespawnController({
    rateMonitor: deps.rateMonitor,
    onSpawn: deps.onSpawn,
    onKill: deps.onKill,
  })

  const TERMINAL_STATUSES = new Set<A2ATaskStatus>([
    A2ATaskStatus.Completed,
    A2ATaskStatus.Failed,
    A2ATaskStatus.Canceled,
  ])

  // ── JSON-RPC dispatch helpers ────────────────────────────────────

  function classifyErrorCode(message: string): number {
    if (message.startsWith('Task not found:') || message.startsWith('Invalid transition')) {
      return JsonRpcErrorCode.TaskNotFound
    }
    if (message.startsWith('Agent not found:')) {
      return JsonRpcErrorCode.AgentNotFound
    }
    return JsonRpcErrorCode.InternalError
  }

  function dispatchRpc(
    method: string,
    params: Record<string, unknown> | unknown[] | undefined,
    id: string | number | null,
  ): JsonRpcResponse | JsonRpcError {
    const p = (params ?? {}) as Record<string, unknown>

    try {
      switch (method) {
        case 'tasks/submit': {
          const task = orch.submitTask(p.submittedBy as string, p.description as string)
          return createResponse(task, id)
        }
        case 'tasks/assign': {
          const task = orch.assignTask(p.taskId as string, p.agentId as string)
          return createResponse(task, id)
        }
        case 'tasks/update': {
          const task = orch.updateTaskStatus(p.taskId as string, p.status as A2ATaskStatus, {
            result: p.result,
            error: p.error as string | undefined,
          })
          return createResponse(task, id)
        }
        case 'tasks/get': {
          const task = orch.getTask(p.taskId as string)
          return createResponse(task, id)
        }
        case 'tasks/list': {
          const list = orch.listTasks(p.status ? { status: p.status as A2ATaskStatus } : undefined)
          return createResponse(list, id)
        }
        case 'agents/register': {
          orch.registerAgent(p.card as AgentCard)
          return createResponse({ ok: true }, id)
        }
        case 'agents/list': {
          return createResponse(registry.list(), id)
        }
        case 'teams/create': {
          let state: OrchestrationState
          if (p.templateName) {
            state = orch.createTeamFromTemplate(p.templateName as string, p.teamId as string)
          } else {
            state = orch.createTeamFromManifest(p.manifest as TeamManifest, p.teamId as string)
          }
          return createResponse(state, id)
        }
        case 'teams/advance': {
          const state = orch.advancePhase(p.teamId as string)
          return createResponse(state, id)
        }
        case 'teams/status': {
          const state = orch.getOrchestrationState(p.teamId as string)
          return createResponse(state, id)
        }
        default:
          return createError(JsonRpcErrorCode.MethodNotFound, `Method not found: ${method}`, id)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const code = classifyErrorCode(message)
      return createError(code, message, id)
    }
  }

  // ── Orchestrator object ──────────────────────────────────────────

  const orch: TeamOrchestrator = {
    // Agent Card management
    registerAgent(card: AgentCard): void {
      registry.register(card)
    },

    unregisterAgent(id: string): boolean {
      return registry.unregister(id)
    },

    getAgentCard(id: string): AgentCard | null {
      return registry.get(id)
    },

    findAgentsByCapability(capability: string): readonly AgentCard[] {
      return registry.findByCapability(capability)
    },

    getWellKnownJson(): object {
      return registry.toWellKnownJson()
    },

    // Task management
    submitTask(submittedBy: string, description: string): A2ATask {
      const task = taskMachine.create({
        id: randomUUID(),
        submittedBy,
        description,
      })
      tasks.set(task.id, task)
      return task
    },

    assignTask(taskId: string, agentId: string): A2ATask {
      const task = tasks.get(taskId)
      if (!task) throw new NotFoundError('Task', taskId)
      const updated = taskMachine.transition(task, A2ATaskStatus.Assigned, {
        assignedTo: agentId,
      })
      tasks.set(taskId, updated)
      return updated
    },

    updateTaskStatus(
      taskId: string,
      status: A2ATaskStatus,
      options?: { result?: unknown; error?: string },
    ): A2ATask {
      const task = tasks.get(taskId)
      if (!task) throw new NotFoundError('Task', taskId)
      const updated = taskMachine.transition(task, status, options)
      tasks.set(taskId, updated)
      return updated
    },

    getTask(taskId: string): A2ATask | null {
      return tasks.get(taskId) ?? null
    },

    listTasks(filter?: { status?: A2ATaskStatus }): readonly A2ATask[] {
      const all = [...tasks.values()]
      if (filter?.status) {
        return all.filter((t) => t.status === filter.status)
      }
      return all
    },

    // Team lifecycle
    createTeamFromTemplate(templateName: string, teamId: string): OrchestrationState {
      const manifest = getTeamTemplate(templateName)
      if (!manifest) throw new NotFoundError('Template', templateName)
      return this.createTeamFromManifest(manifest, teamId)
    },

    createTeamFromManifest(manifest: TeamManifest, teamId: string): OrchestrationState {
      const state = engine.initialize(manifest, teamId)
      teams.set(teamId, { state, manifest })
      return state
    },

    advancePhase(teamId: string): OrchestrationState {
      const entry = teams.get(teamId)
      if (!entry) throw new NotFoundError('Team', teamId)
      const newState = engine.advance(entry.state)
      teams.set(teamId, { ...entry, state: newState })
      return newState
    },

    getOrchestrationState(teamId: string): OrchestrationState | null {
      return teams.get(teamId)?.state ?? null
    },

    reconcile(teamId: string, actualState: TeamState): readonly ReconcileAction[] {
      const entry = teams.get(teamId)
      if (!entry) throw new NotFoundError('Team', teamId)
      return engine.reconcile(entry.manifest, actualState)
    },

    // Auto-scaler + Respawn
    getScalerStatus(): ScalerStatus {
      return autoScaler.getStatus()
    },

    getRespawnStats(): RespawnStats {
      return respawnCtrl.getStats()
    },

    async tickAutoScaler(): Promise<ScaleDecision> {
      return autoScaler.tick()
    },

    async respawnDeadAgent(dead: DeadAgent): Promise<RespawnResult> {
      return respawnCtrl.respawn(dead)
    },

    // JSON-RPC
    handleJsonRpc(message: unknown): JsonRpcResponse | JsonRpcError {
      if (!isRequest(message)) {
        return createError(JsonRpcErrorCode.InvalidRequest, 'Invalid JSON-RPC request', null)
      }
      return dispatchRpc(message.method, message.params, message.id)
    },

    // Status
    getStatus(): TeamOrchestratorStatus {
      const allTasks = [...tasks.values()]
      const activeTasks = allTasks.filter((t) => !TERMINAL_STATUSES.has(t.status)).length

      return {
        registeredAgents: registry.list().length,
        activeTasks,
        activeTeams: teams.size,
        scalerStatus: autoScaler.getStatus(),
        respawnStats: respawnCtrl.getStats(),
      }
    },
  }

  return orch
}
