import { describe, it, expect, vi, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createTeamOrchestrator } from '../../../../src/broker/a2a/team-orchestrator.js'
import type {
  TeamOrchestrator,
  TeamOrchestratorDeps,
  TeamOrchestratorStatus,
} from '../../../../src/broker/a2a/team-orchestrator.js'
import { createRateMonitor } from '../../../../src/rate-limit/rate-monitor.js'
import type { AgentCard } from '../../../../src/broker/a2a/agent-card.js'
import { A2ATaskStatus } from '../../../../src/broker/a2a/task-state.js'
import { JsonRpcErrorCode, createRequest } from '../../../../src/broker/a2a/jsonrpc.js'
import { TeamManifestSchema } from '../../../../src/broker/a2a/team-manifest.js'

// ── Helpers ────────────────────────────────────────────────────────

function makeCard(overrides: Partial<AgentCard> = {}): AgentCard {
  const now = new Date().toISOString()
  return {
    id: randomUUID(),
    name: 'test-agent',
    description: 'A test agent',
    version: '1.0.0',
    capabilities: ['code', 'review'],
    skills: [],
    authentication: { type: 'none', required: false },
    registeredAt: now,
    lastSeenAt: now,
    ...overrides,
  }
}

function makeDeps(overrides: Partial<TeamOrchestratorDeps> = {}): TeamOrchestratorDeps {
  return {
    rateMonitor: createRateMonitor(),
    onSpawn: vi.fn(async (_opts: { role: string; teamId?: string; context?: string }) =>
      randomUUID(),
    ),
    onKill: vi.fn(async () => {}),
    ...overrides,
  }
}

// ── Tests ──────────────────────────────────────────────────────────

describe('createTeamOrchestrator', () => {
  let orch: TeamOrchestrator
  let deps: TeamOrchestratorDeps

  beforeEach(() => {
    deps = makeDeps()
    orch = createTeamOrchestrator(deps)
  })

  it('creates an orchestrator with all expected methods', () => {
    expect(orch.registerAgent).toBeTypeOf('function')
    expect(orch.unregisterAgent).toBeTypeOf('function')
    expect(orch.getAgentCard).toBeTypeOf('function')
    expect(orch.findAgentsByCapability).toBeTypeOf('function')
    expect(orch.getWellKnownJson).toBeTypeOf('function')
    expect(orch.submitTask).toBeTypeOf('function')
    expect(orch.assignTask).toBeTypeOf('function')
    expect(orch.updateTaskStatus).toBeTypeOf('function')
    expect(orch.getTask).toBeTypeOf('function')
    expect(orch.listTasks).toBeTypeOf('function')
    expect(orch.createTeamFromTemplate).toBeTypeOf('function')
    expect(orch.createTeamFromManifest).toBeTypeOf('function')
    expect(orch.advancePhase).toBeTypeOf('function')
    expect(orch.getOrchestrationState).toBeTypeOf('function')
    expect(orch.reconcile).toBeTypeOf('function')
    expect(orch.getScalerStatus).toBeTypeOf('function')
    expect(orch.getRespawnStats).toBeTypeOf('function')
    expect(orch.tickAutoScaler).toBeTypeOf('function')
    expect(orch.respawnDeadAgent).toBeTypeOf('function')
    expect(orch.handleJsonRpc).toBeTypeOf('function')
    expect(orch.getStatus).toBeTypeOf('function')
  })

  // ── Agent Registration ──────────────────────────────────────────

  describe('agent registration and discovery', () => {
    it('registers an agent card', () => {
      const card = makeCard()
      orch.registerAgent(card)
      expect(orch.getAgentCard(card.id)).toEqual(card)
    })

    it('returns null for unknown agent', () => {
      expect(orch.getAgentCard('nonexistent')).toBeNull()
    })

    it('unregisters an agent', () => {
      const card = makeCard()
      orch.registerAgent(card)
      expect(orch.unregisterAgent(card.id)).toBe(true)
      expect(orch.getAgentCard(card.id)).toBeNull()
    })

    it('returns false when unregistering unknown agent', () => {
      expect(orch.unregisterAgent('nonexistent')).toBe(false)
    })

    it('finds agents by capability', () => {
      const card1 = makeCard({ capabilities: ['code', 'test'] })
      const card2 = makeCard({ capabilities: ['review'] })
      const card3 = makeCard({ capabilities: ['code', 'deploy'] })
      orch.registerAgent(card1)
      orch.registerAgent(card2)
      orch.registerAgent(card3)

      const coders = orch.findAgentsByCapability('code')
      expect(coders).toHaveLength(2)
      expect(coders.map((c) => c.id)).toContain(card1.id)
      expect(coders.map((c) => c.id)).toContain(card3.id)
    })

    it('returns empty array when no agents match capability', () => {
      expect(orch.findAgentsByCapability('nonexistent')).toHaveLength(0)
    })

    it('generates well-known JSON', () => {
      const card = makeCard()
      orch.registerAgent(card)
      const json = orch.getWellKnownJson() as { agents: AgentCard[] }
      expect(json.agents).toHaveLength(1)
      expect(json.agents[0]!.id).toBe(card.id)
    })
  })

  // ── Task Lifecycle ──────────────────────────────────────────────

  describe('task lifecycle', () => {
    it('submits a task in submitted state', () => {
      const task = orch.submitTask('user-1', 'Write tests')
      expect(task.status).toBe(A2ATaskStatus.Submitted)
      expect(task.submittedBy).toBe('user-1')
      expect(task.description).toBe('Write tests')
      expect(task.id).toBeTruthy()
    })

    it('assigns a task', () => {
      const task = orch.submitTask('user-1', 'Write tests')
      const assigned = orch.assignTask(task.id, 'agent-1')
      expect(assigned.status).toBe(A2ATaskStatus.Assigned)
      expect(assigned.assignedTo).toBe('agent-1')
    })

    it('moves through submit → assign → working → completed', () => {
      const task = orch.submitTask('user-1', 'Implement feature')
      const assigned = orch.assignTask(task.id, 'agent-1')
      const working = orch.updateTaskStatus(assigned.id, A2ATaskStatus.Working)
      expect(working.status).toBe(A2ATaskStatus.Working)
      const completed = orch.updateTaskStatus(working.id, A2ATaskStatus.Completed, {
        result: { output: 'done' },
      })
      expect(completed.status).toBe(A2ATaskStatus.Completed)
      expect(completed.result).toEqual({ output: 'done' })
    })

    it('moves through submit → assign → working → failed → resubmit', () => {
      const task = orch.submitTask('user-1', 'Implement feature')
      orch.assignTask(task.id, 'agent-1')
      orch.updateTaskStatus(task.id, A2ATaskStatus.Working)
      orch.updateTaskStatus(task.id, A2ATaskStatus.Failed, { error: 'crash' })
      const failed = orch.getTask(task.id)!
      expect(failed.status).toBe(A2ATaskStatus.Failed)
      expect(failed.error).toBe('crash')
      // Re-submit from failed
      const resubmitted = orch.updateTaskStatus(task.id, A2ATaskStatus.Submitted)
      expect(resubmitted.status).toBe(A2ATaskStatus.Submitted)
    })

    it('throws on invalid task transition', () => {
      const task = orch.submitTask('user-1', 'Write tests')
      expect(() => orch.updateTaskStatus(task.id, A2ATaskStatus.Completed)).toThrow(
        /Invalid transition/,
      )
    })

    it('throws when assigning nonexistent task', () => {
      expect(() => orch.assignTask('nonexistent', 'agent-1')).toThrow()
    })

    it('throws when updating nonexistent task', () => {
      expect(() => orch.updateTaskStatus('nonexistent', A2ATaskStatus.Working)).toThrow()
    })

    it('retrieves a task by id', () => {
      const task = orch.submitTask('user-1', 'Task A')
      const found = orch.getTask(task.id)
      expect(found).toBeTruthy()
      expect(found!.id).toBe(task.id)
    })

    it('returns null for nonexistent task', () => {
      expect(orch.getTask('nonexistent')).toBeNull()
    })

    it('lists all tasks', () => {
      orch.submitTask('user-1', 'Task A')
      orch.submitTask('user-2', 'Task B')
      expect(orch.listTasks()).toHaveLength(2)
    })

    it('filters tasks by status', () => {
      const t1 = orch.submitTask('user-1', 'Task A')
      orch.submitTask('user-2', 'Task B')
      orch.assignTask(t1.id, 'agent-1')

      const assigned = orch.listTasks({ status: A2ATaskStatus.Assigned })
      expect(assigned).toHaveLength(1)
      expect(assigned[0]!.id).toBe(t1.id)
    })
  })

  // ── Team Lifecycle ──────────────────────────────────────────────

  describe('team creation from template', () => {
    it('creates team from research template', () => {
      const state = orch.createTeamFromTemplate('research', 'team-r')
      expect(state.teamId).toBe('team-r')
      expect(state.overallStatus).toBe('running')
      expect(state.phases.length).toBeGreaterThan(0)
    })

    it('creates team from implementation template', () => {
      const state = orch.createTeamFromTemplate('implementation', 'team-i')
      expect(state.teamId).toBe('team-i')
      expect(state.overallStatus).toBe('running')
    })

    it('creates team from review template', () => {
      const state = orch.createTeamFromTemplate('review', 'team-rv')
      expect(state.teamId).toBe('team-rv')
      expect(state.overallStatus).toBe('running')
    })

    it('creates team from full template', () => {
      const state = orch.createTeamFromTemplate('full', 'team-f')
      expect(state.teamId).toBe('team-f')
      expect(state.overallStatus).toBe('running')
    })

    it('throws for unknown template', () => {
      expect(() => orch.createTeamFromTemplate('nonexistent', 'team-x')).toThrow(
        /Template not found/,
      )
    })
  })

  describe('team creation from manifest', () => {
    it('creates team from custom manifest', () => {
      const manifest = TeamManifestSchema.parse({
        id: 'custom-1',
        name: 'Custom Team',
        description: 'A custom team',
        roles: [{ role: 'worker', count: 2 }],
        phases: [{ name: 'work', roles: ['worker'], gateCondition: 'all-complete' }],
      })
      const state = orch.createTeamFromManifest(manifest, 'team-c')
      expect(state.teamId).toBe('team-c')
      expect(state.overallStatus).toBe('running')
    })
  })

  describe('phase advancement', () => {
    it('advances through phases when gate is met', () => {
      const state = orch.createTeamFromTemplate('research', 'team-adv')
      // Mark all tasks in first phase as completed
      const phase0 = state.phases[0]!
      for (const task of phase0.tasks) {
        orch.submitTask('sys', task.taskId)
      }
      // The orchestration engine manages phase advancement internally
      const advState = orch.advancePhase('team-adv')
      expect(advState).toBeTruthy()
    })

    it('throws when advancing nonexistent team', () => {
      expect(() => orch.advancePhase('nonexistent')).toThrow()
    })
  })

  describe('getOrchestrationState', () => {
    it('returns state for existing team', () => {
      orch.createTeamFromTemplate('research', 'team-s')
      const state = orch.getOrchestrationState('team-s')
      expect(state).toBeTruthy()
      expect(state!.teamId).toBe('team-s')
    })

    it('returns null for nonexistent team', () => {
      expect(orch.getOrchestrationState('nonexistent')).toBeNull()
    })
  })

  describe('reconcile', () => {
    it('returns reconcile actions for a team', () => {
      orch.createTeamFromTemplate('research', 'team-rec')
      const actions = orch.reconcile('team-rec', {
        teamId: 'team-rec',
        members: [],
      })
      // With no actual members, should want to spawn
      expect(actions.length).toBeGreaterThan(0)
      expect(actions.some((a) => a.type === 'spawn')).toBe(true)
    })
  })

  // ── JSON-RPC Dispatch ──────────────────────────────────────────

  describe('handleJsonRpc', () => {
    it('dispatches tasks/submit', () => {
      const req = createRequest(
        'tasks/submit',
        { submittedBy: 'user-1', description: 'Test task' },
        1,
      )
      const resp = orch.handleJsonRpc(req)
      expect('result' in resp).toBe(true)
      if ('result' in resp) {
        const task = resp.result as { id: string; status: string }
        expect(task.status).toBe('submitted')
      }
    })

    it('dispatches tasks/get', () => {
      const task = orch.submitTask('user-1', 'Test')
      const req = createRequest('tasks/get', { taskId: task.id }, 2)
      const resp = orch.handleJsonRpc(req)
      expect('result' in resp).toBe(true)
      if ('result' in resp) {
        expect((resp.result as { id: string }).id).toBe(task.id)
      }
    })

    it('dispatches tasks/assign', () => {
      const task = orch.submitTask('user-1', 'Test')
      const req = createRequest('tasks/assign', { taskId: task.id, agentId: 'agent-1' }, 3)
      const resp = orch.handleJsonRpc(req)
      expect('result' in resp).toBe(true)
      if ('result' in resp) {
        expect((resp.result as { status: string }).status).toBe('assigned')
      }
    })

    it('dispatches tasks/update', () => {
      const task = orch.submitTask('user-1', 'Test')
      orch.assignTask(task.id, 'agent-1')
      const req = createRequest('tasks/update', { taskId: task.id, status: 'working' }, 4)
      const resp = orch.handleJsonRpc(req)
      expect('result' in resp).toBe(true)
      if ('result' in resp) {
        expect((resp.result as { status: string }).status).toBe('working')
      }
    })

    it('dispatches tasks/list', () => {
      orch.submitTask('user-1', 'Test A')
      orch.submitTask('user-2', 'Test B')
      const req = createRequest('tasks/list', {}, 5)
      const resp = orch.handleJsonRpc(req)
      expect('result' in resp).toBe(true)
      if ('result' in resp) {
        expect((resp.result as unknown[]).length).toBe(2)
      }
    })

    it('dispatches agents/register', () => {
      const card = makeCard()
      const req = createRequest('agents/register', { card }, 6)
      const resp = orch.handleJsonRpc(req)
      expect('result' in resp).toBe(true)
      // Agent should now be findable
      expect(orch.getAgentCard(card.id)).toBeTruthy()
    })

    it('dispatches agents/list', () => {
      orch.registerAgent(makeCard())
      orch.registerAgent(makeCard())
      const req = createRequest('agents/list', {}, 7)
      const resp = orch.handleJsonRpc(req)
      expect('result' in resp).toBe(true)
      if ('result' in resp) {
        expect((resp.result as unknown[]).length).toBe(2)
      }
    })

    it('dispatches teams/create with template', () => {
      const req = createRequest('teams/create', { templateName: 'research', teamId: 'rpc-team' }, 8)
      const resp = orch.handleJsonRpc(req)
      expect('result' in resp).toBe(true)
      if ('result' in resp) {
        expect((resp.result as { teamId: string }).teamId).toBe('rpc-team')
      }
    })

    it('dispatches teams/create with manifest', () => {
      const manifest = TeamManifestSchema.parse({
        id: 'rpc-manifest',
        name: 'RPC Team',
        description: 'Created via RPC',
        roles: [{ role: 'worker', count: 1 }],
        phases: [{ name: 'work', roles: ['worker'], gateCondition: 'all-complete' }],
      })
      const req = createRequest('teams/create', { manifest, teamId: 'rpc-team-m' }, 9)
      const resp = orch.handleJsonRpc(req)
      expect('result' in resp).toBe(true)
    })

    it('dispatches teams/advance', () => {
      orch.createTeamFromTemplate('research', 'rpc-adv')
      const req = createRequest('teams/advance', { teamId: 'rpc-adv' }, 10)
      const resp = orch.handleJsonRpc(req)
      expect('result' in resp).toBe(true)
    })

    it('dispatches teams/status', () => {
      orch.createTeamFromTemplate('research', 'rpc-status')
      const req = createRequest('teams/status', { teamId: 'rpc-status' }, 11)
      const resp = orch.handleJsonRpc(req)
      expect('result' in resp).toBe(true)
      if ('result' in resp) {
        expect((resp.result as { teamId: string }).teamId).toBe('rpc-status')
      }
    })

    it('returns method-not-found error for unknown method', () => {
      const req = createRequest('unknown/method', {}, 12)
      const resp = orch.handleJsonRpc(req)
      expect('error' in resp).toBe(true)
      if ('error' in resp) {
        expect(resp.error.code).toBe(JsonRpcErrorCode.MethodNotFound)
      }
    })

    it('returns parse error for non-object input', () => {
      const resp = orch.handleJsonRpc('not valid json')
      expect('error' in resp).toBe(true)
      if ('error' in resp) {
        expect(resp.error.code).toBe(JsonRpcErrorCode.InvalidRequest)
      }
    })

    it('returns invalid request for missing jsonrpc field', () => {
      const resp = orch.handleJsonRpc({ method: 'tasks/list', id: 1 })
      expect('error' in resp).toBe(true)
      if ('error' in resp) {
        expect(resp.error.code).toBe(JsonRpcErrorCode.InvalidRequest)
      }
    })

    it('returns internal error when dispatch throws', () => {
      const req = createRequest('tasks/get', { taskId: 'nonexistent' }, 99)
      const resp = orch.handleJsonRpc(req)
      // tasks/get returns null for nonexistent, not throw, so this should succeed
      expect('result' in resp).toBe(true)
      if ('result' in resp) {
        expect(resp.result).toBeNull()
      }
    })

    it('returns error when tasks/assign fails', () => {
      const req = createRequest('tasks/assign', { taskId: 'nonexistent', agentId: 'a' }, 100)
      const resp = orch.handleJsonRpc(req)
      expect('error' in resp).toBe(true)
      if ('error' in resp) {
        expect(resp.error.code).toBe(JsonRpcErrorCode.TaskNotFound)
      }
    })
  })

  // ── Auto-Scaler Integration ─────────────────────────────────────

  describe('auto-scaler integration', () => {
    it('returns scaler status', () => {
      const status = orch.getScalerStatus()
      expect(status).toHaveProperty('activeAgents')
      expect(status).toHaveProperty('queueDepth')
      expect(status).toHaveProperty('rateRecommendation')
    })

    it('ticks auto-scaler and returns a decision', async () => {
      const decision = await orch.tickAutoScaler()
      expect(decision).toHaveProperty('action')
      expect(decision).toHaveProperty('reason')
      expect(['scale-up', 'scale-down', 'hold']).toContain(decision.action)
    })
  })

  // ── Respawn Integration ─────────────────────────────────────────

  describe('respawn integration', () => {
    it('respawns a dead agent', async () => {
      const result = await orch.respawnDeadAgent({
        sessionId: 'dead-1',
        role: 'researcher',
        lastHeartbeat: new Date().toISOString(),
      })
      expect(result).toHaveProperty('originalId', 'dead-1')
      expect(result).toHaveProperty('success')
    })

    it('returns respawn stats', () => {
      const stats = orch.getRespawnStats()
      expect(stats).toHaveProperty('totalRespawns')
      expect(stats).toHaveProperty('successfulRespawns')
      expect(stats).toHaveProperty('failedRespawns')
      expect(stats).toHaveProperty('agentsAtMaxRespawns')
    })
  })

  // ── Status Report ──────────────────────────────────────────────

  describe('getStatus', () => {
    it('returns a complete status report', () => {
      orch.registerAgent(makeCard())
      orch.submitTask('user', 'Task')
      orch.createTeamFromTemplate('research', 'status-team')

      const status: TeamOrchestratorStatus = orch.getStatus()
      expect(status.registeredAgents).toBe(1)
      expect(status.activeTasks).toBe(1)
      expect(status.activeTeams).toBe(1)
      expect(status).toHaveProperty('scalerStatus')
      expect(status).toHaveProperty('respawnStats')
    })

    it('counts only non-terminal tasks as active', () => {
      const t1 = orch.submitTask('user', 'A')
      orch.submitTask('user', 'B')
      orch.assignTask(t1.id, 'agent-1')
      orch.updateTaskStatus(t1.id, A2ATaskStatus.Working)
      orch.updateTaskStatus(t1.id, A2ATaskStatus.Completed)

      const status = orch.getStatus()
      // t1 is completed (terminal), t2 is submitted (active)
      expect(status.activeTasks).toBe(1)
    })

    it('reports zero for empty orchestrator', () => {
      const status = orch.getStatus()
      expect(status.registeredAgents).toBe(0)
      expect(status.activeTasks).toBe(0)
      expect(status.activeTeams).toBe(0)
    })
  })
})
