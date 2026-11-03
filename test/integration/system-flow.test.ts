/**
 * Full system integration flow — the "gate test" from the Phase 9 spec.
 *
 * Tests the complete SCNS lifecycle:
 *   start → observe → suggest → review → team task → rotate → stop
 *
 * Uses real SQLite, real broker, real HTTP, real module instances.
 * Only mocks: process spawning and adapters that need OS-level access.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { openDatabase, closeDatabase } from '../../src/broker/storage/db.js'
import { createEventLog } from '../../src/broker/services/event-log.js'
import { createEventDispatcher } from '../../src/broker/event-dispatcher.js'
import { createBrokerServer, type BrokerServer } from '../../src/broker/server.js'
import { createHealthMonitor } from '../../src/context/health-monitor.js'
import { createCompactionDetector } from '../../src/context/compaction-detector.js'
import { createRotationController } from '../../src/context/rotation-controller.js'
import { createHandoffGenerator } from '../../src/context/handoff-generator.js'
import { createHandoffStore } from '../../src/context/handoff-store.js'
import { createBrainAgent } from '../../src/brain/agent-loop.js'
import { createTaskQueue } from '../../src/brain/task-queue.js'
import { createDecisionTree } from '../../src/brain/decision-tree.js'
import { createTaskClassifier } from '../../src/brain/classifier.js'
import { createTemplateEngine } from '../../src/brain/templates.js'
import { createSuggestionStore } from '../../src/suggest/suggestion-store.js'
import { createExecutor } from '../../src/suggest/executor.js'
import { createReviewWorkflow } from '../../src/suggest/review.js'
import { createCostTracker, estimateCost } from '../../src/shared/cost-tracker.js'
import { loadAutonomy, promote, demote, getAutonomyDescription } from '../../src/shared/autonomy.js'
import { loadObservationConfig } from '../../src/observe/config.js'
import type Database from 'better-sqlite3'

// ── Test helpers ─────────────────────────────────────────────────

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'scns-system-flow-'))

function tempDir(name: string): string {
  const dir = join(TEST_ROOT, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

// Mock process.exit — the /api/shutdown endpoint calls
// setTimeout(() => process.exit(0), 500) which would crash vitest.
// Must be in beforeEach since restoreMocks: true restores it between tests.
beforeEach(() => {
  vi.spyOn(process, 'exit').mockImplementation((() => {}) as never)
})

afterEach(() => {
  if (existsSync(TEST_ROOT)) {
    rmSync(TEST_ROOT, { recursive: true, force: true })
  }
})

// ── Broker test fixture ──────────────────────────────────────────

interface BrokerFixture {
  db: Database.Database
  broker: BrokerServer
  server: Server
  base: string
  dispatcher: ReturnType<typeof createEventDispatcher>
}

function createTestBroker(): BrokerFixture {
  const db = openDatabase(':memory:')
  const dispatcher = createEventDispatcher()
  const eventLog = createEventLog(db, dispatcher)
  const broker = createBrokerServer(db, eventLog, undefined, dispatcher, { authToken: null })
  const server = createServer(broker.app)
  server.listen(0)
  const addr = server.address() as AddressInfo
  const base = `http://127.0.0.1:${addr.port}`
  return { db, broker, server, base, dispatcher }
}

async function destroyBroker(f: BrokerFixture): Promise<void> {
  await f.broker.close()
  await new Promise<void>((r) => f.server.close(() => r()))
  closeDatabase(f.db)
}

async function req(
  base: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, body: json }
}

// ═══════════════════════════════════════════════════════════════════
// 1. Broker lifecycle
// ═══════════════════════════════════════════════════════════════════

describe('Broker lifecycle', () => {
  let f: BrokerFixture

  beforeEach(() => {
    f = createTestBroker()
  })
  afterEach(async () => {
    await destroyBroker(f)
  })

  it('health endpoint returns 200 with status ok', async () => {
    const res = await req(f.base, 'GET', '/health')
    expect(res.status).toBe(200)
    const data = res.body as Record<string, unknown>
    expect(data.status).toBe('ok')
  })

  it('register → list → deregister → list shows completed', async () => {
    const sessionId = randomUUID()

    // Register
    const reg = await req(f.base, 'POST', '/api/register', {
      id: sessionId,
      purpose: 'test session',
      working_dir: '/test',
    })
    expect(reg.status).toBe(200)

    // List — should see 1 active
    const list1 = await req(f.base, 'GET', '/api/list_sessions')
    const sessions1 = (list1.body as { sessions: Array<{ id: string; status: string }> }).sessions
    expect(sessions1.length).toBe(1)
    expect(sessions1[0]!.id).toBe(sessionId)
    expect(sessions1[0]!.status).toBe('active')

    // Deregister
    const dereg = await req(f.base, 'POST', `/api/deregister/${sessionId}`)
    expect((dereg.body as { success: boolean }).success).toBe(true)

    // List — should show completed (include_archived since completed sets archived_at)
    const list2 = await req(f.base, 'GET', '/api/list_sessions?include_archived=true')
    const sessions2 = (list2.body as { sessions: Array<{ status: string }> }).sessions
    expect(sessions2[0]!.status).toBe('completed')
  })
})

// ═══════════════════════════════════════════════════════════════════
// 2. Message flow
// ═══════════════════════════════════════════════════════════════════

describe('Message flow', () => {
  let f: BrokerFixture

  beforeEach(() => {
    f = createTestBroker()
  })
  afterEach(async () => {
    await destroyBroker(f)
  })

  it('A sends message to B → B receives → mark read', async () => {
    const sessionA = randomUUID()
    const sessionB = randomUUID()

    // Register both
    await req(f.base, 'POST', '/api/register', { id: sessionA, purpose: 'a', working_dir: '/' })
    await req(f.base, 'POST', '/api/register', { id: sessionB, purpose: 'b', working_dir: '/' })

    // A sends message to B
    const send = await req(f.base, 'POST', '/api/messages', {
      sender_id: sessionA,
      receiver_id: sessionB,
      content: 'Hello from A',
    })
    expect(send.status).toBe(201)
    const msgId = (send.body as { id: string }).id

    // B receives messages
    const inbox = await req(f.base, 'GET', `/api/messages/${sessionB}`)
    const messages = (inbox.body as { messages: Array<{ id: string; content: string }> }).messages
    expect(messages.length).toBe(1)
    expect(messages[0]!.content).toBe('Hello from A')

    // Mark read
    const markRead = await req(f.base, 'POST', '/api/messages/mark-read', {
      message_ids: [msgId],
    })
    expect((markRead.body as { success: boolean }).success).toBe(true)

    // Verify read — unread_only should return empty
    const unread = await req(f.base, 'GET', `/api/messages/${sessionB}?unread_only=true`)
    const unreadMsgs = (unread.body as { messages: unknown[] }).messages
    expect(unreadMsgs).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════════
// 3. Team lifecycle
// ═══════════════════════════════════════════════════════════════════

describe('Team lifecycle', () => {
  let f: BrokerFixture

  beforeEach(() => {
    f = createTestBroker()
  })
  afterEach(async () => {
    await destroyBroker(f)
  })

  it('create → join 2 members → get info → disband', async () => {
    // Register two sessions for members
    const s1 = randomUUID()
    const s2 = randomUUID()
    await req(f.base, 'POST', '/api/register', { id: s1, purpose: 'dev1', working_dir: '/' })
    await req(f.base, 'POST', '/api/register', { id: s2, purpose: 'dev2', working_dir: '/' })

    // Create team
    const create = await req(f.base, 'POST', '/api/teams', { name: 'alpha' })
    expect(create.status).toBe(201)
    const teamId = (create.body as { id: string }).id

    // Join members
    await req(f.base, 'POST', `/api/teams/${teamId}/members`, {
      session_id: s1,
      name: 'dev-1',
      role: 'dev',
    })
    await req(f.base, 'POST', `/api/teams/${teamId}/members`, {
      session_id: s2,
      name: 'dev-2',
      role: 'qa',
    })

    // Get team info — shows members
    const info = await req(f.base, 'GET', `/api/teams/${teamId}`)
    const teamInfo = info.body as { name: string; members: Array<{ name: string }> }
    expect(teamInfo.name).toBe('alpha')
    expect(teamInfo.members).toHaveLength(2)

    // Disband
    const disband = await req(f.base, 'DELETE', `/api/teams/${teamId}`)
    expect(disband.status).toBe(200)

    // Verify disbanded — list with include_archived
    const listed = await req(f.base, 'GET', '/api/teams?include_archived=true')
    const teams = (listed.body as { teams: Array<{ status: string }> }).teams
    const disbanded = teams.find((t) => t.status === 'disbanded')
    expect(disbanded).toBeDefined()
  })
})

// ═══════════════════════════════════════════════════════════════════
// 4. Observation config
// ═══════════════════════════════════════════════════════════════════

describe('Observation config', () => {
  it('loads default config with expected observer set', () => {
    const config = loadObservationConfig()

    expect(config.activeApp.enabled).toBe(true)
    expect(config.fileChanges.enabled).toBe(true)
    expect(config.gitActivity.enabled).toBe(true)
    expect(config.sessionHooks.enabled).toBe(true)
    expect(config.terminalHistory.enabled).toBe(false)
    expect(config.browserTabs.enabled).toBe(false)
    expect(config.privacy.sanitizeSecrets).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════
// 5. Brain decision
// ═══════════════════════════════════════════════════════════════════

describe('Brain decision', () => {
  it('creates agent → adds task → wake → decision with action/reason/confidence', async () => {
    const agent = createBrainAgent(
      {
        classifier: createTaskClassifier(),
        decisionTree: createDecisionTree(),
        templateEngine: createTemplateEngine(),
        healthMonitor: createHealthMonitor(),
        taskQueue: createTaskQueue(),
      },
      { autonomyLevel: 1 },
    )

    agent.addTask('Implement user authentication')

    const decision = await agent.wake()
    expect(decision.action).toBeDefined()
    expect(decision.reason).toBeDefined()
    expect(typeof decision.confidence).toBe('number')
    expect(decision.confidence).toBeGreaterThanOrEqual(0)
    expect(decision.confidence).toBeLessThanOrEqual(1)
    expect(decision.priority).toBeDefined()
  })

  it('idle brain with no tasks returns idle/observe decision', async () => {
    const agent = createBrainAgent(
      {
        classifier: createTaskClassifier(),
        decisionTree: createDecisionTree(),
        templateEngine: createTemplateEngine(),
        healthMonitor: createHealthMonitor(),
        taskQueue: createTaskQueue(),
      },
      { autonomyLevel: 0 },
    )

    const decision = await agent.wake()
    expect(['idle', 'observe']).toContain(decision.action)
  })
})

// ═══════════════════════════════════════════════════════════════════
// 6. Suggestion workflow
// ═══════════════════════════════════════════════════════════════════

describe('Suggestion workflow', () => {
  it('save pending → list → approve → status changes', () => {
    const dir = tempDir('suggestions')
    const store = createSuggestionStore({ rootDir: dir })
    const executor = createExecutor()
    const workflow = createReviewWorkflow({ store, executor })

    const now = new Date().toISOString()
    const suggestionId = randomUUID()

    store.save({
      id: suggestionId,
      type: 'skill',
      title: 'Auto-format on save',
      description: 'Configure auto-formatting on file save',
      status: 'pending',
      confidence: 0.9,
      evidence: [
        { source: 'observation', detail: 'User formats manually', observedAt: now, weight: 0.7 },
      ],
      tags: ['workflow'],
      createdAt: now,
      updatedAt: now,
    })

    // List pending
    const pending = workflow.listPending()
    expect(pending).toHaveLength(1)
    expect(pending[0]!.id).toBe(suggestionId)

    // Approve
    const result = workflow.approve(suggestionId, 'looks good')
    expect(result.success).toBe(true)

    // Now pending should be empty
    const afterApprove = workflow.listPending()
    expect(afterApprove).toHaveLength(0)

    // Get the approved suggestion
    const approved = store.get(suggestionId)
    expect(approved).not.toBeNull()
    expect(['approved', 'implemented']).toContain(approved!.status)
  })

  it('reject moves suggestion out of pending', () => {
    const dir = tempDir('suggestions-reject')
    const store = createSuggestionStore({ rootDir: dir })
    const executor = createExecutor()
    const workflow = createReviewWorkflow({ store, executor })

    const now = new Date().toISOString()
    const id = randomUUID()

    store.save({
      id,
      type: 'automation',
      title: 'Unwanted automation',
      description: 'Not needed',
      status: 'pending',
      confidence: 0.3,
      evidence: [{ source: 'test', detail: 'test', observedAt: now, weight: 0.1 }],
      tags: [],
      createdAt: now,
      updatedAt: now,
    })

    const result = workflow.reject(id, 'Not useful')
    expect(result.success).toBe(true)
    expect(workflow.listPending()).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════════
// 7. Context health flow
// ═══════════════════════════════════════════════════════════════════

describe('Context health flow', () => {
  it('register session → record turns → warning → rotation recommendation', () => {
    const monitor = createHealthMonitor({
      config: {
        defaultMaxTokens: 200_000,
        warningThreshold: 50,
        criticalThreshold: 75,
        rotationThreshold: 85,
        tokensPerTurn: 2000,
        tokensPerToolCall: 500,
        compactionSavingsPercent: 40,
      },
    })

    const sessionId = 'session-health-test'
    monitor.registerSession(sessionId)

    // Record enough turns to hit warning (50% of 200k = 100k, at 2000/turn = 50 turns)
    for (let i = 0; i < 55; i++) {
      monitor.recordTurn(sessionId)
    }

    const health = monitor.getHealth(sessionId)
    expect(health).not.toBeNull()
    expect(health!.usagePercent).toBeGreaterThan(50)

    const recommendation = monitor.getRotationRecommendation(sessionId)
    expect(recommendation).not.toBeNull()
    expect(['low', 'medium', 'high', 'immediate']).toContain(recommendation!.urgency)
  })

  it('record enough turns to trigger critical', () => {
    const monitor = createHealthMonitor({
      config: {
        defaultMaxTokens: 100_000,
        warningThreshold: 50,
        criticalThreshold: 75,
        rotationThreshold: 85,
        tokensPerTurn: 2000,
        tokensPerToolCall: 500,
        compactionSavingsPercent: 40,
      },
    })

    const sessionId = 'session-critical'
    monitor.registerSession(sessionId)

    // 75% of 100k = 75k, at 2000/turn = 38 turns
    for (let i = 0; i < 40; i++) {
      monitor.recordTurn(sessionId)
    }

    const health = monitor.getHealth(sessionId)
    expect(health!.usagePercent).toBeGreaterThanOrEqual(75)
    expect(health!.status).toBe('critical')
  })
})

// ═══════════════════════════════════════════════════════════════════
// 8. Rotation flow
// ═══════════════════════════════════════════════════════════════════

describe('Rotation flow', () => {
  it('compaction detector + rotation controller → rotation triggered', async () => {
    const healthMonitor = createHealthMonitor({
      config: {
        defaultMaxTokens: 100_000,
        warningThreshold: 50,
        criticalThreshold: 75,
        rotationThreshold: 85,
        tokensPerTurn: 2000,
        tokensPerToolCall: 500,
        compactionSavingsPercent: 40,
      },
    })

    const detector = createCompactionDetector({ healthMonitor })
    const handoffDir = tempDir('handoffs')
    const handoffGenerator = createHandoffGenerator()
    const handoffStore = createHandoffStore({ rootDir: handoffDir })

    let spawnedSessionId: string | null = null
    const controller = createRotationController({
      detector,
      handoffGenerator,
      handoffStore,
      healthMonitor,
      onSpawnSession: async (_handoffId, _purpose) => {
        spawnedSessionId = `new-session-${randomUUID().slice(0, 8)}`
        return spawnedSessionId
      },
    })

    const sessionId = 'session-to-rotate'
    healthMonitor.registerSession(sessionId)

    // Push to rotation threshold: 85% of 100k = 85k, at 2000/turn = 43 turns
    for (let i = 0; i < 45; i++) {
      healthMonitor.recordTurn(sessionId)
    }

    // Verify detector reports it as rotation candidate
    const candidates = detector.getRotationCandidates()
    expect(candidates.length).toBeGreaterThan(0)
    expect(candidates[0]!.sessionId).toBe(sessionId)

    // Rotate via controller
    const result = await controller.rotateSession(sessionId)
    expect(result.success).toBe(true)
    expect(result.sourceSessionId).toBe(sessionId)
    expect(result.handoffId).toBeDefined()
    expect(spawnedSessionId).not.toBeNull()
    expect(result.targetSessionId).toBe(spawnedSessionId)
  })

  it('tick auto-rotates high-urgency candidates', async () => {
    const healthMonitor = createHealthMonitor({
      config: {
        defaultMaxTokens: 100_000,
        warningThreshold: 50,
        criticalThreshold: 75,
        rotationThreshold: 85,
        tokensPerTurn: 2000,
        tokensPerToolCall: 500,
        compactionSavingsPercent: 40,
      },
    })

    const detector = createCompactionDetector({ healthMonitor })
    const handoffDir = tempDir('handoffs-tick')
    const controller = createRotationController({
      detector,
      handoffGenerator: createHandoffGenerator(),
      handoffStore: createHandoffStore({ rootDir: handoffDir }),
      healthMonitor,
      onSpawnSession: async () => `new-${randomUUID().slice(0, 8)}`,
    })

    const sid = 'auto-rotate-session'
    healthMonitor.registerSession(sid)
    for (let i = 0; i < 50; i++) {
      healthMonitor.recordTurn(sid)
    }

    const results = await controller.tick()
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0]!.success).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════
// 9. Cost tracking
// ═══════════════════════════════════════════════════════════════════

describe('Cost tracking', () => {
  it('records usage for 3 sessions → summary totals match', () => {
    const tracker = createCostTracker()
    const now = new Date().toISOString()

    const usages = [
      { sessionId: 's1', inputTokens: 1000, outputTokens: 500 },
      { sessionId: 's2', inputTokens: 2000, outputTokens: 1000 },
      { sessionId: 's3', inputTokens: 3000, outputTokens: 1500 },
    ]

    for (const u of usages) {
      tracker.recordUsage({
        ...u,
        totalTokens: u.inputTokens + u.outputTokens,
        estimatedCostUSD: estimateCost(u.inputTokens, u.outputTokens),
        timestamp: now,
      })
    }

    const summary = tracker.getSummary()
    expect(summary.sessionCount).toBe(3)
    expect(summary.totalInputTokens).toBe(6000)
    expect(summary.totalOutputTokens).toBe(3000)
    expect(summary.totalTokens).toBe(9000)
    expect(summary.perSession).toHaveLength(3)

    // Verify individual session lookup
    const s2Cost = tracker.getSessionCost('s2')
    expect(s2Cost).not.toBeNull()
    expect(s2Cost!.inputTokens).toBe(2000)
    expect(s2Cost!.outputTokens).toBe(1000)
  })

  it('reset clears all data', () => {
    const tracker = createCostTracker()
    tracker.recordUsage({
      sessionId: 'x',
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      estimatedCostUSD: estimateCost(100, 50),
      timestamp: new Date().toISOString(),
    })

    tracker.reset()
    const summary = tracker.getSummary()
    expect(summary.sessionCount).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════════
// 10. Autonomy lifecycle
// ═══════════════════════════════════════════════════════════════════

describe('Autonomy lifecycle', () => {
  it('L0 → promote → L1 → promote → L2 → demote → L1 with correct descriptions', () => {
    const dir = tempDir('autonomy-lifecycle')

    // Default is L0
    const initial = loadAutonomy(dir)
    expect(initial.level).toBe(0)
    expect(getAutonomyDescription(0)).toContain('Observer')

    // Promote to L1
    const l1 = promote(dir)
    expect(l1.level).toBe(1)
    expect(getAutonomyDescription(1)).toContain('Assistant')

    // Promote to L2
    const l2 = promote(dir)
    expect(l2.level).toBe(2)
    expect(getAutonomyDescription(2)).toContain('Collaborator')

    // Demote back to L1
    const back = demote(dir)
    expect(back.level).toBe(1)
    expect(getAutonomyDescription(1)).toContain('Assistant')
  })

  it('full range L0 → L3 → L0', () => {
    const dir = tempDir('autonomy-full-range')

    let state = loadAutonomy(dir)
    expect(state.level).toBe(0)

    // Promote to L3
    promote(dir)
    promote(dir)
    state = promote(dir)
    expect(state.level).toBe(3)
    expect(getAutonomyDescription(3)).toContain('Autonomous')

    // Extra promote stays at L3
    state = promote(dir)
    expect(state.level).toBe(3)

    // Demote to L0
    demote(dir)
    demote(dir)
    state = demote(dir)
    expect(state.level).toBe(0)

    // Extra demote stays at L0
    state = demote(dir)
    expect(state.level).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════════
// 11. Full lifecycle flow (end-to-end gate test)
// ═══════════════════════════════════════════════════════════════════

describe('Full lifecycle gate test', () => {
  let f: BrokerFixture

  beforeEach(() => {
    f = createTestBroker()
  })
  afterEach(async () => {
    await destroyBroker(f)
  })

  it('start → register → team → message → deregister → shutdown', async () => {
    // 1. Health check (broker started)
    const health = await req(f.base, 'GET', '/health')
    expect(health.status).toBe(200)

    // 2. Register sessions
    const s1 = randomUUID()
    const s2 = randomUUID()
    await req(f.base, 'POST', '/api/register', {
      id: s1,
      purpose: 'orchestrator',
      working_dir: '/',
    })
    await req(f.base, 'POST', '/api/register', { id: s2, purpose: 'worker', working_dir: '/' })

    // 3. Create team and join
    const team = await req(f.base, 'POST', '/api/teams', { name: 'lifecycle-team' })
    const teamId = (team.body as { id: string }).id
    await req(f.base, 'POST', `/api/teams/${teamId}/members`, {
      session_id: s1,
      name: 'orch',
      role: 'lead',
    })
    await req(f.base, 'POST', `/api/teams/${teamId}/members`, {
      session_id: s2,
      name: 'worker',
      role: 'dev',
    })

    // 4. Send message
    const msg = await req(f.base, 'POST', '/api/messages', {
      sender_id: s1,
      receiver_id: s2,
      content: 'Start the task',
    })
    expect(msg.status).toBe(201)

    // 5. Deregister sessions
    await req(f.base, 'POST', `/api/deregister/${s1}`)
    await req(f.base, 'POST', `/api/deregister/${s2}`)

    // 6. Disband team
    const disband = await req(f.base, 'DELETE', `/api/teams/${teamId}`)
    expect(disband.status).toBe(200)

    // 7. Shutdown
    const shutdown = await req(f.base, 'POST', '/api/shutdown')
    expect((shutdown.body as { success: boolean }).success).toBe(true)
  })
})
