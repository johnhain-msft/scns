/**
 * Phase 7 — Team Orchestration + A2A Wire Protocol integration tests.
 *
 * Exercises the full stack: agent-card registry, A2A task state machine,
 * team templates, orchestration engine, auto-scaler, respawn controller,
 * JSON-RPC message handling, and the TeamOrchestrator façade that ties
 * them together.
 */

import { describe, it, expect, vi } from 'vitest'
import { randomUUID } from 'node:crypto'

import { createTeamOrchestrator } from '../../src/broker/a2a/team-orchestrator.js'
import type { TeamOrchestratorDeps } from '../../src/broker/a2a/team-orchestrator.js'
import { A2ATaskStatus } from '../../src/broker/a2a/task-state.js'
import type { AgentCard } from '../../src/broker/a2a/agent-card.js'
import type { TeamManifest, TeamState } from '../../src/broker/a2a/team-manifest.js'
import { getTeamTemplate, listTeamTemplates } from '../../src/broker/a2a/templates.js'
import { createOrchestrationEngine } from '../../src/broker/a2a/orchestration.js'
import {
  createRequest,
  JsonRpcErrorCode,
  isResponse,
  isError,
} from '../../src/broker/a2a/jsonrpc.js'
import { createRateMonitor } from '../../src/rate-limit/rate-monitor.js'
import { createAutoScaler } from '../../src/broker/a2a/auto-scaler.js'
import type { DeadAgent } from '../../src/broker/a2a/respawn-controller.js'

// ── Helpers ──────────────────────────────────────────────────────────

function makeCard(overrides: Partial<AgentCard> = {}): AgentCard {
  const now = new Date().toISOString()
  return {
    id: randomUUID(),
    name: `agent-${randomUUID().slice(0, 6)}`,
    description: 'test agent',
    version: '1.0.0',
    capabilities: ['code-gen'],
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
    onSpawn: vi.fn(async () => randomUUID()),
    onKill: vi.fn(async () => {}),
    ...overrides,
  }
}

// =====================================================================
// 1. Agent Card Registration → Discovery
// =====================================================================

describe('Agent Card Registration → Discovery', () => {
  it('registers multiple agents and finds them by capability', () => {
    const orch = createTeamOrchestrator(makeDeps())

    const a = makeCard({ capabilities: ['code-gen', 'review'] })
    const b = makeCard({ capabilities: ['code-gen'] })
    const c = makeCard({ capabilities: ['testing'] })

    orch.registerAgent(a)
    orch.registerAgent(b)
    orch.registerAgent(c)

    const found = orch.findAgentsByCapability('code-gen')
    expect(found).toHaveLength(2)
    expect(found.map((f) => f.id).sort()).toEqual([a.id, b.id].sort())
  })

  it('returns well-known JSON with all registered agents', () => {
    const orch = createTeamOrchestrator(makeDeps())

    const a = makeCard()
    const b = makeCard()
    orch.registerAgent(a)
    orch.registerAgent(b)

    const wk = orch.getWellKnownJson() as { agents: AgentCard[] }
    expect(wk).toHaveProperty('agents')
    expect(wk.agents).toHaveLength(2)
    expect(wk.agents.map((x) => x.id).sort()).toEqual([a.id, b.id].sort())
  })

  it('unregisters an agent so it is no longer discoverable', () => {
    const orch = createTeamOrchestrator(makeDeps())

    const card = makeCard()
    orch.registerAgent(card)
    expect(orch.getAgentCard(card.id)).not.toBeNull()

    const removed = orch.unregisterAgent(card.id)
    expect(removed).toBe(true)
    expect(orch.getAgentCard(card.id)).toBeNull()
    expect(orch.findAgentsByCapability('code-gen')).toHaveLength(0)
  })

  it('finds agents by skill — registered skills are visible via getAgentCard', () => {
    const orch = createTeamOrchestrator(makeDeps())

    const a = makeCard({
      skills: [{ id: 'summarise', name: 'Summarise', description: 'text summarisation' }],
    })
    const b = makeCard({
      skills: [{ id: 'translate', name: 'Translate', description: 'translation' }],
    })
    orch.registerAgent(a)
    orch.registerAgent(b)

    // Both have code-gen capability from makeCard defaults
    const found = orch.findAgentsByCapability('code-gen')
    expect(found).toHaveLength(2)

    // Verify skill is preserved on retrieved card
    const card = orch.getAgentCard(a.id)
    expect(card?.skills).toHaveLength(1)
    expect(card?.skills[0]!.id).toBe('summarise')
  })

  it('returns empty array when searching for non-existent capability', () => {
    const orch = createTeamOrchestrator(makeDeps())
    orch.registerAgent(makeCard({ capabilities: ['only-this'] }))

    expect(orch.findAgentsByCapability('nope')).toHaveLength(0)
  })
})

// =====================================================================
// 2. A2A Task Lifecycle
// =====================================================================

describe('A2A Task Lifecycle', () => {
  it('walks a task through submit → assign → working → completed', () => {
    const orch = createTeamOrchestrator(makeDeps())

    const agent = makeCard()
    orch.registerAgent(agent)

    let task = orch.submitTask('user-1', 'implement feature X')
    expect(task.status).toBe(A2ATaskStatus.Submitted)

    task = orch.assignTask(task.id, agent.id)
    expect(task.status).toBe(A2ATaskStatus.Assigned)

    task = orch.updateTaskStatus(task.id, A2ATaskStatus.Working)
    expect(task.status).toBe(A2ATaskStatus.Working)

    task = orch.updateTaskStatus(task.id, A2ATaskStatus.Completed, { result: { ok: true } })
    expect(task.status).toBe(A2ATaskStatus.Completed)
    expect(task.result).toEqual({ ok: true })
  })

  it('recovers a failed task via resubmit → assign → complete', () => {
    const orch = createTeamOrchestrator(makeDeps())

    const agent = makeCard()
    orch.registerAgent(agent)

    let task = orch.submitTask('user-1', 'flaky operation')
    task = orch.assignTask(task.id, agent.id)
    task = orch.updateTaskStatus(task.id, A2ATaskStatus.Working)
    task = orch.updateTaskStatus(task.id, A2ATaskStatus.Failed, { error: 'timeout' })
    expect(task.status).toBe(A2ATaskStatus.Failed)

    // Resubmit (failed → submitted is valid)
    task = orch.updateTaskStatus(task.id, A2ATaskStatus.Submitted)
    expect(task.status).toBe(A2ATaskStatus.Submitted)

    task = orch.assignTask(task.id, agent.id)
    task = orch.updateTaskStatus(task.id, A2ATaskStatus.Working)
    task = orch.updateTaskStatus(task.id, A2ATaskStatus.Completed, { result: 'done' })
    expect(task.status).toBe(A2ATaskStatus.Completed)
  })

  it('cancels a task before it is assigned', () => {
    const orch = createTeamOrchestrator(makeDeps())

    let task = orch.submitTask('user-1', 'cancel me')
    task = orch.updateTaskStatus(task.id, A2ATaskStatus.Canceled)
    expect(task.status).toBe(A2ATaskStatus.Canceled)
  })

  it('handles multiple tasks assigned to different agents independently', () => {
    const orch = createTeamOrchestrator(makeDeps())

    const agentA = makeCard({ name: 'alpha' })
    const agentB = makeCard({ name: 'bravo' })
    orch.registerAgent(agentA)
    orch.registerAgent(agentB)

    let t1 = orch.submitTask('user-1', 'task one')
    let t2 = orch.submitTask('user-1', 'task two')

    t1 = orch.assignTask(t1.id, agentA.id)
    t2 = orch.assignTask(t2.id, agentB.id)

    t1 = orch.updateTaskStatus(t1.id, A2ATaskStatus.Working)
    t2 = orch.updateTaskStatus(t2.id, A2ATaskStatus.Working)

    t1 = orch.updateTaskStatus(t1.id, A2ATaskStatus.Completed, { result: 'r1' })
    t2 = orch.updateTaskStatus(t2.id, A2ATaskStatus.Completed, { result: 'r2' })

    expect(t1.status).toBe(A2ATaskStatus.Completed)
    expect(t2.status).toBe(A2ATaskStatus.Completed)
    expect(t1.assignedTo).toBe(agentA.id)
    expect(t2.assignedTo).toBe(agentB.id)
  })

  it('records full state history with timestamps for every transition', () => {
    const orch = createTeamOrchestrator(makeDeps())

    const agent = makeCard()
    orch.registerAgent(agent)

    let task = orch.submitTask('user-1', 'track me')
    task = orch.assignTask(task.id, agent.id)
    task = orch.updateTaskStatus(task.id, A2ATaskStatus.Working)
    task = orch.updateTaskStatus(task.id, A2ATaskStatus.Completed)

    // submitted→assigned, assigned→working, working→completed
    expect(task.history).toHaveLength(3)
    for (const entry of task.history) {
      expect(entry).toHaveProperty('from')
      expect(entry).toHaveProperty('to')
      expect(entry).toHaveProperty('timestamp')
      expect(new Date(entry.timestamp).getTime()).toBeGreaterThan(0)
    }

    expect(task.history[0]!.from).toBe(A2ATaskStatus.Submitted)
    expect(task.history[0]!.to).toBe(A2ATaskStatus.Assigned)
    expect(task.history[2]!.from).toBe(A2ATaskStatus.Working)
    expect(task.history[2]!.to).toBe(A2ATaskStatus.Completed)
  })

  it('getTask returns null for non-existent id', () => {
    const orch = createTeamOrchestrator(makeDeps())
    expect(orch.getTask('does-not-exist')).toBeNull()
  })

  it('listTasks filters by status', () => {
    const orch = createTeamOrchestrator(makeDeps())
    const agent = makeCard()
    orch.registerAgent(agent)

    const t1 = orch.submitTask('u', 'a')
    const t2 = orch.submitTask('u', 'b')
    orch.assignTask(t1.id, agent.id)

    const submitted = orch.listTasks({ status: A2ATaskStatus.Submitted })
    expect(submitted).toHaveLength(1)
    expect(submitted[0]!.id).toBe(t2.id)
  })
})

// =====================================================================
// 3. Team Creation from Template
// =====================================================================

describe('Team Creation from Template', () => {
  it('creates a research team with 4 agents in 2 phases', () => {
    const orch = createTeamOrchestrator(makeDeps())

    const state = orch.createTeamFromTemplate('research', 'team-r')
    expect(state.teamId).toBe('team-r')
    expect(state.phases).toHaveLength(2)

    const template = getTeamTemplate('research')!
    const totalRoles = template.roles.reduce((s, r) => s + r.count, 0)
    expect(totalRoles).toBe(4)

    expect(state.phases[0]!.phase).toBe('research')
    expect(state.phases[1]!.phase).toBe('synthesis')
  })

  it('creates an implementation team with 4 agents in 3 phases', () => {
    const orch = createTeamOrchestrator(makeDeps())

    const state = orch.createTeamFromTemplate('implementation', 'team-i')
    expect(state.phases).toHaveLength(3)

    const template = getTeamTemplate('implementation')!
    const totalRoles = template.roles.reduce((s, r) => s + r.count, 0)
    expect(totalRoles).toBe(4)
  })

  it('creates teams from all four built-in templates', () => {
    const orch = createTeamOrchestrator(makeDeps())

    const templates = listTeamTemplates()
    expect(templates).toContain('research')
    expect(templates).toContain('implementation')
    expect(templates).toContain('review')
    expect(templates).toContain('full')

    for (const name of templates) {
      const state = orch.createTeamFromTemplate(name, `team-${name}`)
      expect(state.teamId).toBe(`team-${name}`)
      expect(state.overallStatus).toBe('running')
      expect(state.phases.length).toBeGreaterThan(0)
      expect(state.currentPhase).toBeTruthy()
    }
  })

  it('throws on invalid template name', () => {
    const orch = createTeamOrchestrator(makeDeps())

    expect(() => orch.createTeamFromTemplate('nonexistent', 'team-x')).toThrow(
      /Template not found/i,
    )
  })

  it('creates a team from a custom manifest', () => {
    const orch = createTeamOrchestrator(makeDeps())

    const manifest: TeamManifest = {
      id: 'custom-manifest',
      name: 'Custom',
      description: 'custom team',
      roles: [{ role: 'analyst', count: 2 }],
      phases: [{ name: 'analyse', roles: ['analyst'], gateCondition: 'all-complete' }],
      strategy: 'parallel',
      maxConcurrent: 5,
    }

    const state = orch.createTeamFromManifest(manifest, 'custom-team')
    expect(state.teamId).toBe('custom-team')
    expect(state.manifestId).toBe('custom-manifest')
    expect(state.phases).toHaveLength(1)
    expect(state.phases[0]!.tasks).toHaveLength(2)
  })
})

// =====================================================================
// 4. Orchestration Phase Gates
// =====================================================================

describe('Orchestration Phase Gates', () => {
  // Use the orchestration engine directly for gate tests — the orchestrator
  // delegates to the engine but doesn't expose updateTask on phase state.

  it('opens an all-complete gate once every task in the phase finishes', () => {
    const engine = createOrchestrationEngine()
    const template = getTeamTemplate('research')!

    let state = engine.initialize(template, 'team-gate-all')
    const phase0 = state.phases[0]!
    expect(phase0.gateCondition).toBe('all-complete')

    for (const t of phase0.tasks) {
      state = engine.updateTask(state, t.taskId, 'completed')
    }

    const advanced = engine.advance(state)
    expect(advanced.phases[0]!.status).toBe('complete')
    expect(advanced.phases[1]!.status).toBe('active')
    expect(advanced.currentPhase).toBe('synthesis')
  })

  it('blocks advancement when one task is still pending in all-complete gate', () => {
    const engine = createOrchestrationEngine()
    const template = getTeamTemplate('research')!

    let state = engine.initialize(template, 'team-gate-block')
    const phase0 = state.phases[0]!

    // Complete all but the last task
    for (let i = 0; i < phase0.tasks.length - 1; i++) {
      state = engine.updateTask(state, phase0.tasks[i]!.taskId, 'completed')
    }

    const notAdvanced = engine.advance(state)
    expect(notAdvanced.phases[0]!.status).toBe('active')
    expect(notAdvanced.currentPhase).toBe('research')
  })

  it('opens an any-complete gate when a single task completes', () => {
    const engine = createOrchestrationEngine()
    const manifest: TeamManifest = {
      id: 'any-gate',
      name: 'Any gate test',
      description: 'test',
      roles: [{ role: 'worker', count: 3 }],
      phases: [
        { name: 'work', roles: ['worker'], gateCondition: 'any-complete' },
        { name: 'done', roles: ['worker'], gateCondition: 'all-complete' },
      ],
      strategy: 'parallel',
      maxConcurrent: 5,
    }

    let state = engine.initialize(manifest, 'team-any')
    const tasks = state.phases[0]!.tasks
    expect(tasks.length).toBe(3)

    state = engine.updateTask(state, tasks[0]!.taskId, 'completed')

    const advanced = engine.advance(state)
    expect(advanced.phases[0]!.status).toBe('complete')
    expect(advanced.currentPhase).toBe('done')
  })

  it('opens a majority-complete gate when >50% tasks complete', () => {
    const engine = createOrchestrationEngine()
    const manifest: TeamManifest = {
      id: 'majority-gate',
      name: 'Majority gate test',
      description: 'test',
      roles: [{ role: 'voter', count: 4 }],
      phases: [
        { name: 'vote', roles: ['voter'], gateCondition: 'majority-complete' },
        { name: 'decide', roles: ['voter'], gateCondition: 'all-complete' },
      ],
      strategy: 'parallel',
      maxConcurrent: 5,
    }

    let state = engine.initialize(manifest, 'team-majority')
    const tasks = state.phases[0]!.tasks
    expect(tasks.length).toBe(4)

    // 2 of 4 = 50%, NOT > 50%
    state = engine.updateTask(state, tasks[0]!.taskId, 'completed')
    state = engine.updateTask(state, tasks[1]!.taskId, 'completed')

    const blocked = engine.advance(state)
    expect(blocked.phases[0]!.status).toBe('active')

    // 3 of 4 = 75% — opens gate
    state = engine.updateTask(state, tasks[2]!.taskId, 'completed')
    const advanced = engine.advance(state)
    expect(advanced.phases[0]!.status).toBe('complete')
    expect(advanced.currentPhase).toBe('decide')
  })

  it('advances through all phases to completion (full orchestration)', () => {
    const engine = createOrchestrationEngine()
    const template = getTeamTemplate('research')!

    let state = engine.initialize(template, 'team-full-run')

    // Phase 0 (research): complete all 3 tasks
    for (const t of state.phases[0]!.tasks) {
      state = engine.updateTask(state, t.taskId, 'completed')
    }
    state = engine.advance(state)
    expect(state.currentPhase).toBe('synthesis')

    // Phase 1 (synthesis): complete
    for (const t of state.phases[1]!.tasks) {
      state = engine.updateTask(state, t.taskId, 'completed')
    }
    state = engine.advance(state)
    expect(state.overallStatus).toBe('completed')
    expect(state.phases.every((p) => p.status === 'complete')).toBe(true)
  })

  it('reports failed when all tasks in a phase fail', () => {
    const engine = createOrchestrationEngine()
    const manifest: TeamManifest = {
      id: 'fail-manifest',
      name: 'Fail test',
      description: 'test',
      roles: [{ role: 'w', count: 2 }],
      phases: [{ name: 'work', roles: ['w'], gateCondition: 'all-complete' }],
      strategy: 'parallel',
      maxConcurrent: 5,
    }

    let state = engine.initialize(manifest, 'team-fail')
    for (const t of state.phases[0]!.tasks) {
      state = engine.updateTask(state, t.taskId, 'failed')
    }
    state = engine.advance(state)
    expect(state.overallStatus).toBe('failed')
  })
})

// =====================================================================
// 5. Auto-scaler Integration
// =====================================================================

describe('Auto-scaler Integration', () => {
  it('recommends scale-up when queue depth is high', () => {
    const rateMonitor = createRateMonitor()
    const scaler = createAutoScaler(
      {
        rateMonitor,
        getQueueDepth: () => 10,
        getActiveCount: () => 1,
      },
      { scaleUpThreshold: 3, maxAgents: 8 },
    )

    const decision = scaler.evaluate()
    expect(decision.action).toBe('scale-up')
    expect(decision.count).toBeGreaterThan(0)
    expect(decision.reason).toContain('queue depth')
  })

  it('recommends scale-down/hold when rate monitor warns', () => {
    const rateMonitor = createRateMonitor({ globalBucket: { capacity: 1, refillRate: 0 } })
    // Drain global bucket so recommendation flips to yield/pause/scaleDown
    rateMonitor.recordRequest('drain-session')
    rateMonitor.recordRequest('drain-session')

    const scaler = createAutoScaler({
      rateMonitor,
      getActiveCount: () => 3,
      getQueueDepth: () => 0,
    })

    const decision = scaler.evaluate()
    expect(['scale-down', 'hold']).toContain(decision.action)
  })

  it('recommends scale-down for idle agents beyond timeout', () => {
    const rateMonitor = createRateMonitor()
    const scaler = createAutoScaler(
      {
        rateMonitor,
        getActiveCount: () => 3,
        getQueueDepth: () => 0,
      },
      { scaleDownIdleMs: 0 },
    )

    // Mark an agent idle with 0ms timeout — immediately beyond threshold
    scaler.recordIdle('idle-agent-1')

    const decision = scaler.evaluate()
    expect(decision.action).toBe('scale-down')
    expect(decision.reason).toContain('idle')
  })

  it('integrates with the orchestrator via tickAutoScaler', async () => {
    // Submit many tasks to increase the internal queue depth
    const orch = createTeamOrchestrator(makeDeps())

    // Register one agent so activeCount = 1
    orch.registerAgent(makeCard())

    // Submit several tasks (unassigned → queue depth rises)
    for (let i = 0; i < 6; i++) orch.submitTask('user', `task-${i}`)

    const decision = await orch.tickAutoScaler()
    // With 6 submitted tasks and threshold=3 (default), should scale-up
    expect(decision.action).toBe('scale-up')
  })
})

// =====================================================================
// 6. Respawn Controller Integration
// =====================================================================

describe('Respawn Controller Integration', () => {
  it('spawns a replacement for a dead agent', async () => {
    const orch = createTeamOrchestrator(makeDeps())

    const dead: DeadAgent = {
      sessionId: randomUUID(),
      role: 'worker',
      lastHeartbeat: new Date(Date.now() - 60_000).toISOString(),
    }

    const result = await orch.respawnDeadAgent(dead)
    expect(result.success).toBe(true)
    expect(result.newId).toBeTruthy()
    expect(result.originalId).toBe(dead.sessionId)
  })

  it('refuses to respawn when max respawns reached (default 3)', async () => {
    const orch = createTeamOrchestrator(makeDeps())

    const dead: DeadAgent = {
      sessionId: randomUUID(),
      role: 'worker',
      lastHeartbeat: new Date(Date.now() - 60_000).toISOString(),
    }

    // Respawn 3 times (default max)
    for (let i = 0; i < 3; i++) {
      const r = await orch.respawnDeadAgent(dead)
      expect(r.success).toBe(true)
    }

    // 4th attempt should be refused
    const r4 = await orch.respawnDeadAgent(dead)
    expect(r4.success).toBe(false)
    expect(r4.error).toContain('max respawns')
  })

  it('defers respawn when rate-limited', async () => {
    const rateMonitor = createRateMonitor({ globalBucket: { capacity: 1, refillRate: 0 } })
    // Drain tokens so recommendation becomes Pause/ScaleDown
    for (let i = 0; i < 20; i++) rateMonitor.recordRequest(`drain-${i}`)

    const orch = createTeamOrchestrator(makeDeps({ rateMonitor }))

    const dead: DeadAgent = {
      sessionId: randomUUID(),
      role: 'worker',
      lastHeartbeat: new Date(Date.now() - 60_000).toISOString(),
    }

    const result = await orch.respawnDeadAgent(dead)
    expect(result.success).toBe(false)
    expect(result.error).toContain('rate')
  })

  it('tracks respawn stats correctly', async () => {
    const orch = createTeamOrchestrator(makeDeps())

    const dead: DeadAgent = {
      sessionId: randomUUID(),
      role: 'worker',
      lastHeartbeat: new Date(Date.now() - 60_000).toISOString(),
    }

    await orch.respawnDeadAgent(dead)
    const stats = orch.getRespawnStats()
    expect(stats.totalRespawns).toBeGreaterThanOrEqual(1)
    expect(stats.successfulRespawns).toBeGreaterThanOrEqual(1)
  })
})

// =====================================================================
// 7. JSON-RPC Message Handling
// =====================================================================

describe('JSON-RPC Message Handling', () => {
  it('handles a valid tasks/submit request', () => {
    const orch = createTeamOrchestrator(makeDeps())

    const req = createRequest(
      'tasks/submit',
      { submittedBy: 'user-1', description: 'write tests' },
      1,
    )

    const resp = orch.handleJsonRpc(req)
    expect(isResponse(resp)).toBe(true)
    if (isResponse(resp)) {
      const task = resp.result as { id: string; status: string }
      expect(task.id).toBeDefined()
      expect(task.status).toBe(A2ATaskStatus.Submitted)
    }
  })

  it('handles a valid agents/register request', () => {
    const orch = createTeamOrchestrator(makeDeps())

    const card = makeCard()
    const req = createRequest('agents/register', { card }, 2)

    const resp = orch.handleJsonRpc(req)
    expect(isResponse(resp)).toBe(true)

    // Verify the agent was actually registered
    expect(orch.getAgentCard(card.id)).not.toBeNull()
  })

  it('returns MethodNotFound for unknown method', () => {
    const orch = createTeamOrchestrator(makeDeps())

    const req = createRequest('unknown/method', {}, 3)
    const resp = orch.handleJsonRpc(req)

    expect(isError(resp)).toBe(true)
    if (isError(resp)) {
      expect(resp.error.code).toBe(JsonRpcErrorCode.MethodNotFound)
    }
  })

  it('returns appropriate error for malformed request', () => {
    const orch = createTeamOrchestrator(makeDeps())

    // Not a valid JSON-RPC structure
    const resp = orch.handleJsonRpc({ garbage: true })

    expect(isError(resp)).toBe(true)
    if (isError(resp)) {
      expect(resp.error.code).toBe(JsonRpcErrorCode.InvalidRequest)
    }
  })

  it('handles teams/create via JSON-RPC', () => {
    const orch = createTeamOrchestrator(makeDeps())

    const req = createRequest('teams/create', { templateName: 'research', teamId: 'rpc-team' }, 4)

    const resp = orch.handleJsonRpc(req)
    expect(isResponse(resp)).toBe(true)
    if (isResponse(resp)) {
      const state = resp.result as { teamId: string; overallStatus: string }
      expect(state.teamId).toBe('rpc-team')
      expect(state.overallStatus).toBe('running')
    }
  })

  it('handles tasks/get via JSON-RPC', () => {
    const orch = createTeamOrchestrator(makeDeps())
    const task = orch.submitTask('user-1', 'test task')

    const req = createRequest('tasks/get', { taskId: task.id }, 5)
    const resp = orch.handleJsonRpc(req)

    expect(isResponse(resp)).toBe(true)
    if (isResponse(resp)) {
      const fetched = resp.result as { id: string; description: string }
      expect(fetched.id).toBe(task.id)
      expect(fetched.description).toBe('test task')
    }
  })
})

// =====================================================================
// 8. End-to-End Team Flow
// =====================================================================

describe('End-to-End Team Flow', () => {
  it('runs full team flow: create → submit → assign → complete → advance all phases', () => {
    const orch = createTeamOrchestrator(makeDeps())
    const engine = createOrchestrationEngine()

    // Register agents
    const agents = Array.from({ length: 4 }, (_, i) =>
      makeCard({ name: `agent-${i}`, capabilities: ['research', 'planning'] }),
    )
    for (const a of agents) orch.registerAgent(a)

    // Create team from template — get initial orchestration state
    const template = getTeamTemplate('research')!
    let orchState = engine.initialize(template, 'e2e-team')

    // Phase 0: research — submit real A2A tasks, assign, complete
    const p0Tasks = orchState.phases[0]!.tasks
    for (let i = 0; i < p0Tasks.length; i++) {
      let t = orch.submitTask('orchestrator', `research-${i}`)
      t = orch.assignTask(t.id, agents[i % agents.length]!.id)
      orch.updateTaskStatus(t.id, A2ATaskStatus.Working)
      orch.updateTaskStatus(t.id, A2ATaskStatus.Completed, { result: `result-${i}` })

      // Update orchestration tracking
      orchState = engine.updateTask(orchState, p0Tasks[i]!.taskId, 'completed')
    }

    orchState = engine.advance(orchState)
    expect(orchState.currentPhase).toBe('synthesis')

    // Phase 1: synthesis
    const p1Tasks = orchState.phases[1]!.tasks
    for (const t of p1Tasks) {
      orchState = engine.updateTask(orchState, t.taskId, 'completed')
    }

    orchState = engine.advance(orchState)
    expect(orchState.overallStatus).toBe('completed')

    // Verify overall orchestrator status
    const status = orch.getStatus()
    expect(status.registeredAgents).toBe(4)
    // All real A2A tasks completed
    const completed = orch.listTasks({ status: A2ATaskStatus.Completed })
    expect(completed.length).toBe(p0Tasks.length)
  })

  it('handles worker death and respawn during team execution', async () => {
    const spawnFn = vi.fn(async () => randomUUID())
    const orch = createTeamOrchestrator(makeDeps({ onSpawn: spawnFn }))

    // Register an initial agent
    const agent = makeCard({ name: 'mortal-worker' })
    orch.registerAgent(agent)

    // Submit and begin a task
    let task = orch.submitTask('orchestrator', 'risky work')
    task = orch.assignTask(task.id, agent.id)
    task = orch.updateTaskStatus(task.id, A2ATaskStatus.Working)

    // Simulate worker death — fail the task, then respawn
    task = orch.updateTaskStatus(task.id, A2ATaskStatus.Failed, { error: 'agent crashed' })
    expect(task.status).toBe(A2ATaskStatus.Failed)

    const dead: DeadAgent = {
      sessionId: agent.id,
      role: 'worker',
      lastHeartbeat: new Date(Date.now() - 30_000).toISOString(),
    }
    const respawnResult = await orch.respawnDeadAgent(dead)
    expect(respawnResult.success).toBe(true)

    // Register the new agent and reassign
    const newAgent = makeCard({ id: respawnResult.newId!, name: 'resurrected-worker' })
    orch.registerAgent(newAgent)

    // Resubmit and complete
    task = orch.updateTaskStatus(task.id, A2ATaskStatus.Submitted)
    task = orch.assignTask(task.id, newAgent.id)
    task = orch.updateTaskStatus(task.id, A2ATaskStatus.Working)
    task = orch.updateTaskStatus(task.id, A2ATaskStatus.Completed, {
      result: 'success after respawn',
    })

    expect(task.status).toBe(A2ATaskStatus.Completed)
    expect(task.assignedTo).toBe(newAgent.id)
    expect(task.history.length).toBeGreaterThanOrEqual(6)
  })

  it('reconcile detects missing agents and recommends spawn', () => {
    const orch = createTeamOrchestrator(makeDeps())

    orch.createTeamFromTemplate('research', 'reconcile-team')

    // Actual state: no members yet
    const actual: TeamState = {
      teamId: 'reconcile-team',
      members: [],
    }

    const actions = orch.reconcile('reconcile-team', actual)
    const spawns = actions.filter((a) => a.type === 'spawn')
    expect(spawns.length).toBeGreaterThan(0)

    // Research template needs researchers and a planner
    const researcherSpawn = spawns.find((a) => a.role === 'researcher')
    expect(researcherSpawn).toBeDefined()
    expect(researcherSpawn!.count).toBe(3)
  })
})
