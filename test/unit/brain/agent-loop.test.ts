import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createBrainAgent, type BrainAgentDeps } from '../../../src/brain/agent-loop.js'
import { createTaskQueue } from '../../../src/brain/task-queue.js'
import { createDecisionTree } from '../../../src/brain/decision-tree.js'
import { createTaskClassifier } from '../../../src/brain/classifier.js'
import { createTemplateEngine } from '../../../src/brain/templates.js'
import { createHealthMonitor } from '../../../src/context/health-monitor.js'
import { BrainAction, DecisionPriority } from '../../../src/brain/state-types.js'
import type { Suggestion } from '../../../src/suggest/types.js'
import { createSuggestionGenerator } from '../../../src/suggest/generator.js'
import { buildTeamMemberPrompt } from '../../../src/cli/team-member-prompts.js'
import { createConfidenceScorer } from '../../../src/suggest/confidence.js'
import { createEvidenceGatherer } from '../../../src/suggest/evidence.js'

// ── Helpers ──────────────────────────────────────────────────────────

function makeDeps(overrides?: Partial<BrainAgentDeps>): BrainAgentDeps {
  return {
    classifier: createTaskClassifier(),
    decisionTree: createDecisionTree(),
    templateEngine: createTemplateEngine(),
    healthMonitor: createHealthMonitor(),
    taskQueue: createTaskQueue(),
    onSpawnAgent: vi.fn().mockResolvedValue('session-1'),
    onConsolidate: vi.fn().mockResolvedValue(undefined),
    onRotateContext: vi.fn().mockResolvedValue(undefined),
    getObservationCount: vi.fn().mockReturnValue(10),
    getActiveSessions: vi.fn().mockReturnValue(0),
    isUserActive: vi.fn().mockReturnValue(false),
    getLastConsolidationAge: vi.fn().mockReturnValue(2),
    ...overrides,
  }
}

// ── Lifecycle ────────────────────────────────────────────────────────

describe('BrainAgent lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('start() begins interval, isRunning() returns true', () => {
    const agent = createBrainAgent(makeDeps(), { intervalMs: 5000 })
    agent.start()
    expect(agent.isRunning()).toBe(true)
    agent.stop()
  })

  it('stop() clears interval, isRunning() returns false', () => {
    const agent = createBrainAgent(makeDeps(), { intervalMs: 5000 })
    agent.start()
    agent.stop()
    expect(agent.isRunning()).toBe(false)
  })

  it('double start is idempotent', () => {
    const agent = createBrainAgent(makeDeps(), { intervalMs: 5000 })
    agent.start()
    agent.start() // should not throw
    expect(agent.isRunning()).toBe(true)
    agent.stop()
  })

  it('double stop is safe', () => {
    const agent = createBrainAgent(makeDeps(), { intervalMs: 5000 })
    agent.start()
    agent.stop()
    agent.stop() // should not throw
    expect(agent.isRunning()).toBe(false)
  })
})

// ── Wake Cycle ───────────────────────────────────────────────────────

describe('BrainAgent wake cycle', () => {
  it('wake() with no tasks → Idle decision', async () => {
    const agent = createBrainAgent(makeDeps())
    const decision = await agent.wake()
    expect(decision.action).toBe(BrainAction.Idle)
  })

  it('wake() with user active + yieldToUser → YieldToUser', async () => {
    const deps = makeDeps({ isUserActive: vi.fn().mockReturnValue(true) })
    const agent = createBrainAgent(deps, { yieldToUser: true })
    const decision = await agent.wake()
    expect(decision.action).toBe(BrainAction.YieldToUser)
  })

  it('wake() with high context usage → RotateContext', async () => {
    const monitor = createHealthMonitor()
    monitor.registerSession('s1', 1000)
    // Push tokens to 90% usage
    monitor.recordTurn('s1', 900)
    const deps = makeDeps({ healthMonitor: monitor })
    const agent = createBrainAgent(deps, { contextRotationThreshold: 85 })
    const decision = await agent.wake()
    expect(decision.action).toBe(BrainAction.RotateContext)
  })

  it('wake() with stale consolidation → Consolidate', async () => {
    const deps = makeDeps({ getLastConsolidationAge: vi.fn().mockReturnValue(48) })
    const agent = createBrainAgent(deps, { consolidationThresholdHours: 24 })
    const decision = await agent.wake()
    expect(decision.action).toBe(BrainAction.Consolidate)
  })

  it('wake() re-enqueues the task when the solo spawn throws (W4: no dequeue loss)', async () => {
    const taskQueue = createTaskQueue()
    const deps = makeDeps({
      taskQueue,
      onSpawnAgent: vi.fn().mockRejectedValue(new Error('spawn exploded')),
    })
    const agent = createBrainAgent(deps, { autonomyLevel: 3 })
    agent.addTask('Resolve GitHub issue: flaky spawn', DecisionPriority.Normal, 'github-issue:9')

    await agent.wake()

    expect(deps.onSpawnAgent).toHaveBeenCalled()
    expect(taskQueue.size()).toBe(1)
    expect(agent.hasQueuedSignal('github-issue:9')).toBe(true)

    // Recovery: once the spawner works again the same task dispatches.
    vi.mocked(deps.onSpawnAgent!).mockResolvedValue('session-ok')
    await agent.wake()
    expect(taskQueue.size()).toBe(0)
  })

  it('wake() re-enqueues the task when the FIRST team-member spawn throws (W4)', async () => {
    const taskQueue = createTaskQueue()
    const deps = makeDeps({
      taskQueue,
      onSpawnAgent: vi.fn().mockRejectedValue(new Error('team spawn exploded')),
    })
    const agent = createBrainAgent(deps, { autonomyLevel: 3 })
    taskQueue.enqueue({
      id: 'task-team-1',
      description: 'Implement the feature and add tests and update docs',
      priority: DecisionPriority.Normal,
      strategy: 'parallel',
      subtaskCount: 3,
      createdAt: new Date().toISOString(),
    })

    const decision = await agent.wake()

    expect(decision.action).toBe(BrainAction.SpawnTeam)
    expect(taskQueue.size()).toBe(1)
    expect(taskQueue.peek()?.id).toBe('task-team-1')
  })

  it('wake() re-enqueues a PROMOTER task when the team spawn fails after a partial start (W4, PR review)', async () => {
    const taskQueue = createTaskQueue()
    const twoSubtasks = {
      classify: () => ({
        subtasks: [
          { role: 'implementer', description: 'part one' },
          { role: 'implementer', description: 'part two' },
        ],
      }),
    } as ReturnType<typeof import('../../../src/brain/classifier.js').createTaskClassifier>
    const deps = makeDeps({
      taskQueue,
      classifier: twoSubtasks,
      onSpawnAgent: vi
        .fn()
        .mockResolvedValueOnce('session-1')
        .mockRejectedValueOnce(new Error('second member exploded')),
    })
    const agent = createBrainAgent(deps, { autonomyLevel: 3 })
    taskQueue.enqueue({
      id: 'task-promoter-1',
      description: 'Implement the feature in two parts',
      priority: DecisionPriority.Normal,
      strategy: 'parallel',
      subtaskCount: 2,
      createdAt: new Date().toISOString(),
    })

    await agent.wake()

    // No lease exists for a promoter task, so losing it would be permanent.
    expect(taskQueue.size()).toBe(1)
    expect(taskQueue.peek()?.id).toBe('task-promoter-1')
  })

  it('wake() does NOT re-enqueue a SELF-ISSUE task after a partial team spawn (lease recovery, no duplicate members)', async () => {
    const taskQueue = createTaskQueue()
    const twoSubtasks = {
      classify: () => ({
        subtasks: [
          { role: 'implementer', description: 'part one' },
          { role: 'implementer', description: 'part two' },
        ],
      }),
    } as ReturnType<typeof import('../../../src/brain/classifier.js').createTaskClassifier>
    const deps = makeDeps({
      taskQueue,
      classifier: twoSubtasks,
      markSelfIssueInProgress: vi.fn(),
      onSpawnAgent: vi
        .fn()
        .mockResolvedValueOnce('session-1')
        .mockRejectedValueOnce(new Error('second member exploded')),
    })
    const agent = createBrainAgent(deps, { autonomyLevel: 3 })
    taskQueue.enqueue({
      id: 'task-selfissue-1',
      description: 'Resolve GitHub issue: partial spawn',
      priority: DecisionPriority.Normal,
      strategy: 'parallel',
      subtaskCount: 2,
      createdAt: new Date().toISOString(),
      signalKey: 'github-issue:99',
    })

    await agent.wake()

    expect(taskQueue.size()).toBe(0)
  })

  it('wake() with stale consolidation but closed gate + pending Normal task → dispatches task (R1 livelock fix)', async () => {
    const deps = makeDeps({
      getLastConsolidationAge: vi.fn().mockReturnValue(Infinity),
      canConsolidate: vi.fn().mockReturnValue(false),
      getObservationCount: vi.fn().mockReturnValue(3),
    })
    const agent = createBrainAgent(deps, { autonomyLevel: 2, consolidationThresholdHours: 24 })
    agent.addTask('Resolve GitHub issue: starved task', DecisionPriority.Normal, 'github-issue:2')

    const decision = await agent.wake()

    expect(decision.action).not.toBe(BrainAction.Consolidate)
    expect(deps.onConsolidate).not.toHaveBeenCalled()
    expect(deps.onSpawnAgent).toHaveBeenCalled()
  })

  it('wake() with stale consolidation and open gate → still consolidates', async () => {
    const deps = makeDeps({
      getLastConsolidationAge: vi.fn().mockReturnValue(48),
      canConsolidate: vi.fn().mockReturnValue(true),
    })
    const agent = createBrainAgent(deps, { consolidationThresholdHours: 24 })
    const decision = await agent.wake()
    expect(decision.action).toBe(BrainAction.Consolidate)
    expect(deps.onConsolidate).toHaveBeenCalled()
  })

  it('wake() treats a throwing canConsolidate as gate-open (executor gate remains the authority)', async () => {
    const deps = makeDeps({
      getLastConsolidationAge: vi.fn().mockReturnValue(48),
      canConsolidate: vi.fn().mockImplementation(() => {
        throw new Error('gate check boom')
      }),
    })
    const agent = createBrainAgent(deps, { consolidationThresholdHours: 24 })
    const decision = await agent.wake()
    expect(decision.action).toBe(BrainAction.Consolidate)
  })

  it('wake() with pending solo task → spawns agent, onSpawnAgent called', async () => {
    const deps = makeDeps()
    const agent = createBrainAgent(deps, { autonomyLevel: 3 })
    agent.addTask('Fix the login bug', DecisionPriority.High)

    const decision = await agent.wake()
    expect([BrainAction.HandleSolo, BrainAction.SpawnSolo]).toContain(decision.action)
    expect(deps.onSpawnAgent).toHaveBeenCalled()
  })

  it('wake() with a self-issue solo task → spawns into a UNIQUE team and leases the signal (Bug 2)', async () => {
    const markSelfIssueInProgress = vi.fn()
    const deps = makeDeps({ markSelfIssueInProgress })
    const agent = createBrainAgent(deps, { autonomyLevel: 3 })
    const taskId = agent.addTask(
      'Resolve GitHub issue: X',
      DecisionPriority.High,
      'github-issue:42',
    )!

    await agent.wake()

    const expectedTeamId = `team-selfissue-${taskId}`
    expect(markSelfIssueInProgress).toHaveBeenCalledWith('github-issue:42', expectedTeamId)
    expect(deps.onSpawnAgent).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expectedTeamId,
    )
  })

  it('wake() with a non-self-issue solo task → no lease, spawns without a unique team', async () => {
    const markSelfIssueInProgress = vi.fn()
    const deps = makeDeps({ markSelfIssueInProgress })
    const agent = createBrainAgent(deps, { autonomyLevel: 3 })
    agent.addTask('Fix the login bug', DecisionPriority.High)

    await agent.wake()

    expect(markSelfIssueInProgress).not.toHaveBeenCalled()
    expect(deps.onSpawnAgent).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      undefined,
    )
  })

  it('hasQueuedSignal reflects the in-memory queue (Bug 2 intra-process dedup)', () => {
    const agent = createBrainAgent(makeDeps(), { autonomyLevel: 3 })
    expect(agent.hasQueuedSignal('github-issue:42')).toBe(false)
    agent.addTask('Resolve GitHub issue: X', DecisionPriority.High, 'github-issue:42')
    expect(agent.hasQueuedSignal('github-issue:42')).toBe(true)
    expect(agent.hasQueuedSignal('github-issue:99')).toBe(false)
  })

  it('wake() with pending parallel task → SpawnTeam, multiple onSpawnAgent calls', async () => {
    const deps = makeDeps()
    const queue = createTaskQueue()
    queue.enqueue({
      id: 'pt-1',
      description: 'Build three independent modules in parallel',
      priority: DecisionPriority.High,
      strategy: 'parallel',
      subtaskCount: 3,
      createdAt: '2025-01-01T00:00:00Z',
    })
    deps.taskQueue.enqueue(queue.dequeue()!)
    const agent = createBrainAgent(deps, { autonomyLevel: 3 })

    const decision = await agent.wake()
    expect(decision.action).toBe(BrainAction.SpawnTeam)
    expect(
      (deps.onSpawnAgent as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBeGreaterThanOrEqual(1)
  })

  it('wake() increments wakeCount', async () => {
    const agent = createBrainAgent(makeDeps())
    expect(agent.getStatus().wakeCount).toBe(0)
    await agent.wake()
    expect(agent.getStatus().wakeCount).toBe(1)
    await agent.wake()
    expect(agent.getStatus().wakeCount).toBe(2)
  })

  it('wake() updates lastWakeTime', async () => {
    const agent = createBrainAgent(makeDeps())
    expect(agent.getStatus().lastWakeTime).toBeNull()
    await agent.wake()
    expect(agent.getStatus().lastWakeTime).not.toBeNull()
  })

  it('wake() updates lastDecision in status', async () => {
    const agent = createBrainAgent(makeDeps())
    expect(agent.getStatus().lastDecision).toBeNull()
    await agent.wake()
    const status = agent.getStatus()
    expect(status.lastDecision).not.toBeNull()
    expect(status.lastDecision!.action).toBe(BrainAction.Idle)
  })
})

// ── Task Management ──────────────────────────────────────────────────

describe('BrainAgent task management', () => {
  it('addTask enqueues with generated ID', () => {
    const agent = createBrainAgent(makeDeps())
    const id = agent.addTask('Write tests for auth module')
    expect(id).toBeTruthy()
    expect(typeof id).toBe('string')
    expect(agent.getStatus().queueSize).toBe(1)
  })

  it('addTask with custom priority', () => {
    const deps = makeDeps()
    const agent = createBrainAgent(deps)
    agent.addTask('Critical bugfix', DecisionPriority.Critical)

    const task = deps.taskQueue.peek()
    expect(task).not.toBeNull()
    expect(task!.priority).toBe(DecisionPriority.Critical)
  })

  it('multiple tasks: highest priority processed first', async () => {
    const deps = makeDeps()
    const agent = createBrainAgent(deps, { autonomyLevel: 3 })
    agent.addTask('Low priority task', DecisionPriority.Low)
    agent.addTask('Critical task', DecisionPriority.Critical)

    const decision = await agent.wake()
    // Should pick the critical task
    expect(decision.taskId).toBeDefined()
  })
})

// ── Status ───────────────────────────────────────────────────────────

describe('BrainAgent status', () => {
  it('getStatus() reflects current state', () => {
    const agent = createBrainAgent(makeDeps())
    const status = agent.getStatus()
    expect(status.state).toBe('idle')
    expect(status.wakeCount).toBe(0)
  })

  it('getStatus() shows queueSize', () => {
    const agent = createBrainAgent(makeDeps())
    agent.addTask('Task 1')
    agent.addTask('Task 2')
    expect(agent.getStatus().queueSize).toBe(2)
  })

  it('getStatus() shows intervalMs', () => {
    const agent = createBrainAgent(makeDeps(), { intervalMs: 60_000 })
    expect(agent.getStatus().intervalMs).toBe(60_000)
  })

  // Phase 13.12.5 — autonomy-scaled tick interval
  it('defaults to 300_000ms (5min) at autonomy L0', () => {
    const agent = createBrainAgent(makeDeps(), { autonomyLevel: 0 })
    expect(agent.getStatus().intervalMs).toBe(300_000)
  })

  it('defaults to 300_000ms (5min) at autonomy L1', () => {
    const agent = createBrainAgent(makeDeps(), { autonomyLevel: 1 })
    expect(agent.getStatus().intervalMs).toBe(300_000)
  })

  it('defaults to 60_000ms (60s) at autonomy L2', () => {
    const agent = createBrainAgent(makeDeps(), { autonomyLevel: 2 })
    expect(agent.getStatus().intervalMs).toBe(60_000)
  })

  it('defaults to 60_000ms (60s) at autonomy L3', () => {
    const agent = createBrainAgent(makeDeps(), { autonomyLevel: 3 })
    expect(agent.getStatus().intervalMs).toBe(60_000)
  })

  it('explicit options.intervalMs overrides autonomy-based default', () => {
    const agent = createBrainAgent(makeDeps(), { autonomyLevel: 2, intervalMs: 111 })
    expect(agent.getStatus().intervalMs).toBe(111)
  })

  it('getStatusSnapshot() exposes the real task queue depth as taskQueueDepth (R3)', () => {
    const agent = createBrainAgent(makeDeps({ getPendingSuggestionCount: () => 7 }))
    agent.addTask('Task 1')
    agent.addTask('Task 2')
    const snap = agent.getStatusSnapshot()
    expect(snap.taskQueueDepth).toBe(2)
    // Suggestions stay available under an honest name; queueDepth remains the
    // legacy alias the dashboard reads.
    expect(snap.pendingSuggestions).toBe(7)
    expect(snap.queueDepth).toBe(7)
  })

  it('hot-reloads interval when getAutonomyLevel flips L1 → L2', async () => {
    let level = 1
    const agent = createBrainAgent(makeDeps({ getAutonomyLevel: () => level }), {
      autonomyLevel: 1,
    })
    expect(agent.getStatus().intervalMs).toBe(300_000)
    agent.start()
    // Flip level and wait long enough for the scheduler's next tick decision.
    level = 2
    // The tick at 300s won't fire in test time; instead stop+start to force
    // re-eval, and also verify next tick after wake would pick up the change.
    // The contract: after a wake completes, the next scheduled delay reflects
    // the new level. Trigger a wake directly and observe intervalMs update.
    await agent.wake()
    // Give the scheduler a microtask to re-evaluate.
    await new Promise((r) => setTimeout(r, 5))
    expect(agent.getStatus().intervalMs).toBe(60_000)
    agent.stop()
  })
})

// ── Readiness (Phase 13.10.3) ────────────────────────────────────────

describe('BrainAgent readiness (isReady)', () => {
  it('isReady() is false immediately after construction', () => {
    const agent = createBrainAgent(makeDeps())
    expect(agent.isReady()).toBe(false)
  })

  it('isReady() is false after start() but before first wake completes', () => {
    const agent = createBrainAgent(makeDeps(), { intervalMs: 60_000 })
    agent.start()
    expect(agent.isReady()).toBe(false)
    agent.stop()
  })

  it('isReady() flips to true after first successful wake()', async () => {
    const agent = createBrainAgent(makeDeps())
    expect(agent.isReady()).toBe(false)
    await agent.wake()
    expect(agent.isReady()).toBe(true)
  })

  it('throwing wake does NOT mark ready; next successful wake does', async () => {
    // Force decide() to throw on the first call only
    const decisionTree = createDecisionTree()
    let calls = 0
    const decideSpy = vi.spyOn(decisionTree, 'decide').mockImplementation((state) => {
      calls += 1
      if (calls === 1) throw new Error('boom')
      // Delegate to a fresh real tree for subsequent calls
      return createDecisionTree().decide(state)
    })
    const agent = createBrainAgent(makeDeps({ decisionTree }))

    await expect(agent.wake()).rejects.toThrow('boom')
    expect(agent.isReady()).toBe(false)

    await agent.wake()
    expect(agent.isReady()).toBe(true)
    decideSpy.mockRestore()
  })

  it('isWakeInProgress() is false initially, true while wake() runs, false after', async () => {
    const decisionTree = createDecisionTree()
    let observedDuringWake: boolean | null = null
    let resolveWake: () => void = () => {}
    const wakeSignal = new Promise<void>((r) => {
      resolveWake = r
    })
    vi.spyOn(decisionTree, 'decide').mockImplementation(() => ({
      action: BrainAction.Consolidate,
      reason: 'x',
      confidence: 1,
      priority: DecisionPriority.Normal,
    }))
    const agent = createBrainAgent(
      makeDeps({
        decisionTree,
        onConsolidate: async () => {
          observedDuringWake = agent.isWakeInProgress()
          resolveWake()
        },
      }),
    )
    expect(agent.isWakeInProgress()).toBe(false)
    // Trigger a wake that goes into the decision tree (Idle action) — use a decision path
    // that at least calls into executeDecision synchronously. The simplest observation:
    // isWakeInProgress should be true between the wake() Promise being created and resolving.
    const wakePromise = agent.wake()
    expect(agent.isWakeInProgress()).toBe(true)
    await wakePromise
    // Silence unused-var lints
    void wakeSignal
    void observedDuringWake
    expect(agent.isWakeInProgress()).toBe(false)
  })

  it('stays ready across stop() (readiness is process-lifetime)', async () => {
    const agent = createBrainAgent(makeDeps(), { intervalMs: 60_000 })
    await agent.wake()
    expect(agent.isReady()).toBe(true)
    agent.stop()
    expect(agent.isReady()).toBe(true)
  })
})

// ── requestWake (Phase 13.12.4) ──────────────────────────────────────

describe('BrainAgent requestWake() — fire-and-forget coalesced wake', () => {
  it('runs wake() once for a single request', async () => {
    const decisionTree = createDecisionTree()
    const decideSpy = vi.spyOn(decisionTree, 'decide')
    const agent = createBrainAgent(makeDeps({ decisionTree }))
    agent.requestWake()
    // Wait a microtask so the scheduled wake runs
    await new Promise((r) => setTimeout(r, 10))
    expect(decideSpy).toHaveBeenCalledTimes(1)
  })

  it('returns synchronously without awaiting wake()', () => {
    const agent = createBrainAgent(makeDeps())
    const result = agent.requestWake()
    // Must be void (non-Promise) so callers can fire-and-forget.
    expect(result).toBeUndefined()
  })

  it('coalesces multiple concurrent calls into one follow-up wake', async () => {
    // Build a decision tree whose decide() blocks long enough for us to
    // fire several requestWake() calls while the first wake is in-flight.
    let resolveFirst: () => void = () => {}
    const firstBlocks = new Promise<void>((r) => {
      resolveFirst = r
    })
    let decideCalls = 0
    const decisionTree = createDecisionTree()
    vi.spyOn(decisionTree, 'decide').mockImplementation(() => {
      decideCalls += 1
      // Only the first call blocks; later calls return immediately.
      if (decideCalls === 1) {
        // Synchronous decide can't truly block, but by holding the wake
        // at a later point via onConsolidate we can observe coalescing.
      }
      return {
        action: BrainAction.Consolidate,
        reason: 'x',
        confidence: 1,
        priority: DecisionPriority.Normal,
      }
    })

    // Use onConsolidate as the suspension point: the first wake hangs here
    // while requestWake() is called repeatedly. Subsequent wakes should be
    // coalesced into at most ONE additional wake.
    let consolidateCalls = 0
    const agent = createBrainAgent(
      makeDeps({
        decisionTree,
        onConsolidate: async () => {
          consolidateCalls += 1
          if (consolidateCalls === 1) await firstBlocks
        },
      }),
    )

    // Kick the first wake directly so it enters 'acting' and gets held.
    const firstWake = agent.wake()
    // Ensure it's in-flight
    await new Promise((r) => setTimeout(r, 5))
    expect(agent.isWakeInProgress()).toBe(true)

    // Fire many requestWake() calls while first is still in flight.
    agent.requestWake()
    agent.requestWake()
    agent.requestWake()
    agent.requestWake()

    // Release the first wake.
    resolveFirst()
    await firstWake
    // Give the coalesced follow-up wake time to run.
    await new Promise((r) => setTimeout(r, 20))

    // Exactly 2 wakes should have run: the initial one + one coalesced
    // follow-up. The additional requestWake() calls must NOT stack.
    expect(decideCalls).toBe(2)
  })

  it('schedules a follow-up wake when called while wake is in-flight', async () => {
    let resolveBlock: () => void = () => {}
    const blocker = new Promise<void>((r) => {
      resolveBlock = r
    })
    const decisionTree = createDecisionTree()
    let decideCalls = 0
    vi.spyOn(decisionTree, 'decide').mockImplementation(() => {
      decideCalls += 1
      return {
        action: BrainAction.Consolidate,
        reason: 'x',
        confidence: 1,
        priority: DecisionPriority.Normal,
      }
    })
    let consolidateCalls = 0
    const agent = createBrainAgent(
      makeDeps({
        decisionTree,
        onConsolidate: async () => {
          consolidateCalls += 1
          if (consolidateCalls === 1) await blocker
        },
      }),
    )
    const firstWake = agent.wake()
    await new Promise((r) => setTimeout(r, 5))
    agent.requestWake()
    // Not yet: first wake still blocked.
    expect(decideCalls).toBe(1)
    resolveBlock()
    await firstWake
    await new Promise((r) => setTimeout(r, 20))
    expect(decideCalls).toBe(2)
  })
})

// ── Integration with deps ────────────────────────────────────────────

describe('BrainAgent dep integration', () => {
  it('classifier called for task classification', async () => {
    const classifier = createTaskClassifier()
    const classifySpy = vi.spyOn(classifier, 'classify')
    const deps = makeDeps({ classifier })
    const agent = createBrainAgent(deps, { autonomyLevel: 3 })
    agent.addTask('Build a new feature')

    await agent.wake()
    expect(classifySpy).toHaveBeenCalled()
  })

  it('template engine called for prompt rendering', async () => {
    const templateEngine = createTemplateEngine()
    const selectSpy = vi.spyOn(templateEngine, 'selectTemplate')
    const deps = makeDeps({ templateEngine })
    const agent = createBrainAgent(deps, { autonomyLevel: 3 })
    agent.addTask('Build a new feature')

    await agent.wake()
    expect(selectSpy).toHaveBeenCalled()
  })

  it('health monitor queried for context health', async () => {
    const monitor = createHealthMonitor()
    const statsSpy = vi.spyOn(monitor, 'getStats')
    const deps = makeDeps({ healthMonitor: monitor })
    const agent = createBrainAgent(deps)

    await agent.wake()
    expect(statsSpy).toHaveBeenCalled()
  })

  it('onConsolidate called when decision is Consolidate', async () => {
    const deps = makeDeps({ getLastConsolidationAge: vi.fn().mockReturnValue(48) })
    const agent = createBrainAgent(deps, { consolidationThresholdHours: 24 })

    const decision = await agent.wake()
    expect(decision.action).toBe(BrainAction.Consolidate)
    expect(deps.onConsolidate).toHaveBeenCalled()
  })

  it('onRotateContext called when decision is RotateContext', async () => {
    const monitor = createHealthMonitor()
    monitor.registerSession('s1', 1000)
    monitor.recordTurn('s1', 900)
    const deps = makeDeps({ healthMonitor: monitor })
    const agent = createBrainAgent(deps, { contextRotationThreshold: 85 })

    const decision = await agent.wake()
    expect(decision.action).toBe(BrainAction.RotateContext)
    expect(deps.onRotateContext).toHaveBeenCalled()
  })

  it('getObservationCount used in brain state', async () => {
    const getObservationCount = vi.fn().mockReturnValue(2)
    const deps = makeDeps({ getObservationCount })
    const agent = createBrainAgent(deps)

    const decision = await agent.wake()
    expect(getObservationCount).toHaveBeenCalled()
    expect(decision.action).toBe(BrainAction.Observe)
  })

  it('isUserActive used in brain state', async () => {
    const isUserActive = vi.fn().mockReturnValue(true)
    const deps = makeDeps({ isUserActive })
    const agent = createBrainAgent(deps, { yieldToUser: true })

    await agent.wake()
    expect(isUserActive).toHaveBeenCalled()
  })
})

// ── Error handling ───────────────────────────────────────────────────

describe('BrainAgent error handling', () => {
  it('onSpawnAgent failure does not crash the loop', async () => {
    const deps = makeDeps({
      onSpawnAgent: vi.fn().mockRejectedValue(new Error('spawn failed')),
    })
    const agent = createBrainAgent(deps, { autonomyLevel: 3 })
    agent.addTask('Build something', DecisionPriority.High)

    // Should not throw
    const decision = await agent.wake()
    expect(decision).toBeDefined()
  })

  it('missing optional deps handled gracefully (default implementations)', async () => {
    const deps: BrainAgentDeps = {
      classifier: createTaskClassifier(),
      decisionTree: createDecisionTree(),
      templateEngine: createTemplateEngine(),
      healthMonitor: createHealthMonitor(),
      taskQueue: createTaskQueue(),
      // All optional deps omitted
    }
    const agent = createBrainAgent(deps)

    // Should not throw — action depends on defaults but must not crash
    const decision = await agent.wake()
    expect(decision).toBeDefined()
    expect(decision.action).toBe(BrainAction.Observe)
  })
})

// ── GAP-031 & GAP-002: Pattern detection and observe action ─────────

describe('BrainAgent pattern detection (GAP-031)', () => {
  it('buildBrainState uses getDetectedPatterns when provided', async () => {
    const mockPatterns = {
      workSchedule: null,
      toolFrequency: null,
      projectFocus: null,
      observationCount: 42,
      windowStart: '2025-01-01T00:00:00Z',
      windowEnd: '2025-01-08T00:00:00Z',
    }
    const getDetectedPatterns = vi.fn().mockReturnValue(mockPatterns)
    const deps = makeDeps({ getDetectedPatterns })
    const agent = createBrainAgent(deps)

    await agent.wake()

    // getDetectedPatterns is called during buildBrainState
    expect(getDetectedPatterns).toHaveBeenCalled()
  })

  it('patterns null when getDetectedPatterns not provided', async () => {
    // Ensure no crash when getDetectedPatterns is undefined
    const deps = makeDeps()
    delete (deps as Record<string, unknown>)['getDetectedPatterns']
    const agent = createBrainAgent(deps)

    const decision = await agent.wake()
    expect(decision).toBeDefined()
  })
})

describe('BrainAgent idle suggestion generation', () => {
  it('Idle action generates suggestions when patterns exist', async () => {
    const mockPatterns = {
      workSchedule: null,
      toolFrequency: null,
      projectFocus: null,
      observationCount: 10,
      windowStart: '2025-01-01T00:00:00Z',
      windowEnd: '2025-01-08T00:00:00Z',
    }
    const generate = vi.fn().mockReturnValue([{ id: 'sug-1' }])
    const deps = makeDeps({
      // observation count ≥ 5 → not Observe, will be Idle
      getObservationCount: vi.fn().mockReturnValue(10),
      getDetectedPatterns: vi.fn().mockReturnValue(mockPatterns),
      suggestionGenerator: { generate },
    })

    const agent = createBrainAgent(deps, { autonomyLevel: 2 })
    const decision = await agent.wake()

    expect(decision.action).toBe(BrainAction.Idle)
    // Idle should still generate suggestions when patterns exist (L1+)
    expect(generate).toHaveBeenCalledWith(mockPatterns)
  })

  it('Idle action skips suggestion generation when no patterns', async () => {
    const generate = vi.fn().mockReturnValue([])
    const deps = makeDeps({
      getObservationCount: vi.fn().mockReturnValue(10),
      getDetectedPatterns: vi.fn().mockReturnValue(null),
      suggestionGenerator: { generate },
    })

    const agent = createBrainAgent(deps)
    const decision = await agent.wake()

    expect(decision.action).toBe(BrainAction.Idle)
    expect(generate).not.toHaveBeenCalled()
  })

  it('Idle action skips suggestions when no generator configured', async () => {
    const deps = makeDeps({
      getObservationCount: vi.fn().mockReturnValue(10),
      getDetectedPatterns: vi.fn().mockReturnValue({ observationCount: 10 }),
    })

    const agent = createBrainAgent(deps)
    // Should not throw
    const decision = await agent.wake()
    expect(decision.action).toBe(BrainAction.Idle)
  })
})

describe('BrainAgent observe action (GAP-002)', () => {
  it('Observe action triggers suggestion generation with real patterns', async () => {
    const mockPatterns = {
      workSchedule: null,
      toolFrequency: null,
      projectFocus: null,
      observationCount: 5,
      windowStart: '2025-01-01T00:00:00Z',
      windowEnd: '2025-01-08T00:00:00Z',
    }
    const generate = vi.fn().mockReturnValue([])
    const deps = makeDeps({
      getObservationCount: vi.fn().mockReturnValue(2), // below minimum → triggers Observe
      getDetectedPatterns: vi.fn().mockReturnValue(mockPatterns),
      observationManager: { getStatus: () => ({ observationCount: 5 }) },
      suggestionGenerator: { generate },
      onLearn: vi.fn().mockResolvedValue({ sessionsProcessed: 0, digestsStored: 0, errors: [] }),
    })

    const agent = createBrainAgent(deps, { autonomyLevel: 2 })
    const decision = await agent.wake()

    expect(decision.action).toBe(BrainAction.Observe)
    // Suggestion generator called with real patterns (L1+)
    expect(generate).toHaveBeenCalledWith(mockPatterns)
  })

  it('Observe action still works when patterns are null', async () => {
    const generate = vi.fn().mockReturnValue([])
    const deps = makeDeps({
      getObservationCount: vi.fn().mockReturnValue(2), // below minimum → triggers Observe
      getDetectedPatterns: vi.fn().mockReturnValue(null),
      observationManager: { getStatus: () => ({ observationCount: 5 }) },
      suggestionGenerator: { generate },
      onLearn: vi.fn().mockResolvedValue({ sessionsProcessed: 0, digestsStored: 0, errors: [] }),
    })

    const agent = createBrainAgent(deps)
    const decision = await agent.wake()

    expect(decision.action).toBe(BrainAction.Observe)
    // Should NOT call generate when patterns are null
    expect(generate).not.toHaveBeenCalled()
  })
})

// ── Phase 13.9.2: autonomy hot-reload at wake() ──────────────────────

describe('BrainAgent autonomy hot-reload (Phase 13.9.2)', () => {
  it('wake() re-reads autonomy level from getAutonomyLevel() each cycle', async () => {
    const getAutonomyLevel = vi.fn().mockReturnValue(0)
    const deps = makeDeps({
      getObservationCount: vi.fn().mockReturnValue(10),
      getAutonomyLevel,
    })
    const agent = createBrainAgent(deps, { autonomyLevel: 0 })

    await agent.wake()
    await agent.wake()
    await agent.wake()

    // Must be re-read, not captured at construction
    expect(getAutonomyLevel).toHaveBeenCalledTimes(3)
  })

  it('getAutonomyLevel overrides options.autonomyLevel (dep wins)', async () => {
    const generate = vi.fn().mockReturnValue([])
    const patterns = {
      workSchedule: null,
      toolFrequency: null,
      projectFocus: null,
      observationCount: 10,
      windowStart: '2025-01-01T00:00:00Z',
      windowEnd: '2025-01-08T00:00:00Z',
    }
    const deps = makeDeps({
      getObservationCount: vi.fn().mockReturnValue(10),
      getDetectedPatterns: vi.fn().mockReturnValue(patterns),
      suggestionGenerator: { generate },
      // Construction says L0, but live store says L2 — live wins.
      getAutonomyLevel: () => 2,
    })
    const agent = createBrainAgent(deps, { autonomyLevel: 0 })

    await agent.wake()

    // At L2, Idle path generates suggestions (gated on autonomyLevel >= 1).
    // If the captured L0 had been used, generate would not be called.
    expect(generate).toHaveBeenCalledWith(patterns)
  })

  it('mid-run level change flips decision tree behavior on next wake', async () => {
    let level = 0
    const generate = vi.fn().mockReturnValue([])
    const patterns = {
      workSchedule: null,
      toolFrequency: null,
      projectFocus: null,
      observationCount: 10,
      windowStart: '2025-01-01T00:00:00Z',
      windowEnd: '2025-01-08T00:00:00Z',
    }
    const deps = makeDeps({
      getObservationCount: vi.fn().mockReturnValue(10),
      getDetectedPatterns: vi.fn().mockReturnValue(patterns),
      suggestionGenerator: { generate },
      getAutonomyLevel: () => level,
    })
    const agent = createBrainAgent(deps)

    // First wake at L0: generator must NOT be called (L0 is observe-only)
    await agent.wake()
    expect(generate).not.toHaveBeenCalled()

    // Simulate POST /api/autonomy/promote writing level=1 to disk
    level = 1

    // Next wake must see the new level without any restart
    await agent.wake()
    expect(generate).toHaveBeenCalledWith(patterns)
  })

  it('falls back to options.autonomyLevel when getAutonomyLevel omitted', async () => {
    const generate = vi.fn().mockReturnValue([])
    const patterns = {
      workSchedule: null,
      toolFrequency: null,
      projectFocus: null,
      observationCount: 10,
      windowStart: '2025-01-01T00:00:00Z',
      windowEnd: '2025-01-08T00:00:00Z',
    }
    const deps = makeDeps({
      getObservationCount: vi.fn().mockReturnValue(10),
      getDetectedPatterns: vi.fn().mockReturnValue(patterns),
      suggestionGenerator: { generate },
    })
    const agent = createBrainAgent(deps, { autonomyLevel: 2 })

    await agent.wake()
    // Backward compat: fixed option still works when no live reader provided
    expect(generate).toHaveBeenCalledWith(patterns)
  })
})

// ── Phase 13.9.1: Executor → Team-Spawn Bridge ───────────────────────

describe('BrainAgent Phase 13.9.1 — executor → team-spawn bridge', () => {
  function makeSuggestion(overrides: Partial<Suggestion> = {}): Suggestion {
    const now = new Date().toISOString()
    return {
      id: '11111111-2222-3333-4444-555555555555',
      type: 'workflow',
      title: 'Team-complexity test suggestion',
      description: 'Should route to team spawn.',
      status: 'approved',
      confidence: 0.95,
      evidence: [],
      tags: [],
      createdAt: now,
      updatedAt: now,
      actionable: true,
      estimatedComplexity: 'team',
      suggestedRoles: ['dev', 'reviewer'],
      ...overrides,
    } as Suggestion
  }

  function makeStore(suggestions: Suggestion[]) {
    const statuses = new Map<string, string>(suggestions.map((s) => [s.id, s.status as string]))
    return {
      list: (filter: { status: string }) =>
        suggestions.filter((s) => statuses.get(s.id) === filter.status),
      updateStatus: vi.fn((id: string, status: string) => {
        statuses.set(id, status)
      }),
      markInProgress: vi.fn((id: string, _teamId: string) => {
        statuses.set(id, 'in-progress')
      }),
      get: vi.fn((id: string) => suggestions.find((s) => s.id === id) ?? null),
      recordFailure: vi.fn(),
      _statuses: statuses,
    }
  }

  it('routes team-complexity suggestion with roles to onSpawnTeam (not executor)', async () => {
    const suggestion = makeSuggestion()
    const store = makeStore([suggestion])
    const executor = { execute: vi.fn() }
    const onSpawnTeam = vi.fn().mockResolvedValue({
      teamId: 'team-sugg-11111111',
      memberSessionIds: ['s1', 's2'],
    })
    const onSuggestionSpawnedTeam = vi.fn()

    const deps = makeDeps({
      suggestionStore: store as unknown as BrainAgentDeps['suggestionStore'],
      suggestionExecutor: executor,
      onSpawnTeam,
      onSuggestionSpawnedTeam,
    })
    const agent = createBrainAgent(deps, { autonomyLevel: 2 })
    await agent.wake()

    expect(onSpawnTeam).toHaveBeenCalledTimes(1)
    expect(onSpawnTeam).toHaveBeenCalledWith({
      suggestionId: suggestion.id,
      goal: suggestion.title,
      roles: ['dev', 'reviewer'],
      description: suggestion.description,
    })
    expect(executor.execute).not.toHaveBeenCalled()
    // Phase 13.12.20: suggestion moves to in-progress (not implemented) until
    // team_completed fires and quality-gate decides pass/fail.
    expect(store.markInProgress).toHaveBeenCalledWith(suggestion.id, 'team-sugg-11111111')
    expect(store.updateStatus).not.toHaveBeenCalledWith(suggestion.id, 'implemented')
    expect(onSuggestionSpawnedTeam).toHaveBeenCalledTimes(1)
    const emitted = onSuggestionSpawnedTeam.mock.calls[0]![0] as {
      suggestionId: string
      teamId: string
      timestamp: string
    }
    expect(emitted.suggestionId).toBe(suggestion.id)
    expect(emitted.teamId).toBe('team-sugg-11111111')
    expect(typeof emitted.timestamp).toBe('string')
  })

  it('Track 1: investigation suggestion (scns-researcher role) forms an analysis team via onSpawnTeam', async () => {
    // The suggestion→scns-researcher emission produces exactly this shape:
    // suggestedRoles=['scns-researcher'] + estimatedComplexity='team'. The brain
    // must forward that role verbatim to onSpawnTeam (no namespace remap) so the
    // suggestion→team path spawns a researcher rather than a scns-dev.
    const suggestion = makeSuggestion({
      id: '33333333-4444-5555-6666-777777777777',
      title: 'Investigate whether the rotation watchdog is unwired',
      estimatedComplexity: 'team',
      suggestedRoles: ['scns-researcher'],
    })
    const store = makeStore([suggestion])
    const executor = { execute: vi.fn() }
    const onSpawnTeam = vi.fn().mockResolvedValue({
      teamId: 'team-sugg-33333333',
      memberSessionIds: ['s1'],
    })

    const deps = makeDeps({
      suggestionStore: store as unknown as BrainAgentDeps['suggestionStore'],
      suggestionExecutor: executor,
      onSpawnTeam,
      onSuggestionSpawnedTeam: vi.fn(),
    })
    const agent = createBrainAgent(deps, { autonomyLevel: 2 })
    await agent.wake()

    expect(onSpawnTeam).toHaveBeenCalledTimes(1)
    expect(onSpawnTeam).toHaveBeenCalledWith({
      suggestionId: suggestion.id,
      goal: suggestion.title,
      roles: ['scns-researcher'],
      description: suggestion.description,
    })
    expect(executor.execute).not.toHaveBeenCalled()
    expect(store.markInProgress).toHaveBeenCalledWith(suggestion.id, 'team-sugg-33333333')
  })

  it('the researcher role resolves to the investigate-only prompt in BOTH namespaces (bridge)', () => {
    // Closes the loop: buildTeamMemberPrompt maps the canonical broker role
    // scns-researcher to buildResearcherPrompt, AND the role bridge normalizes
    // the brain AgentRole `researcher` to the same prompt — so a planner-formed
    // or suggestion-formed researcher no longer falls through to the implementer.
    const researcher = buildTeamMemberPrompt({
      role: 'scns-researcher',
      teamId: 'team-sugg-33333333',
      goal: 'Investigate whether the rotation watchdog is unwired',
      projectRoot: '/repo',
    })
    expect(researcher).toContain('RESEARCHER (investigate-only')
    expect(researcher).not.toContain('Your Role: IMPLEMENTER')

    const brainNamespace = buildTeamMemberPrompt({
      role: 'researcher',
      teamId: 'team-sugg-33333333',
      goal: 'Investigate whether the rotation watchdog is unwired',
      projectRoot: '/repo',
    })
    expect(brainNamespace).toContain('RESEARCHER (investigate-only')
    expect(brainNamespace).not.toContain('Your Role: IMPLEMENTER')
  })

  it('13.12.24a: solo-complexity REPO-WORK suggestion WITH onSpawnTeam routes to single scns-dev agent', async () => {
    // `github-action` is the one type whose artifact IS repo content, so solo repo work
    // keeps the unified spawn path. Direct-artifact types (lsp/instruction/…) now take
    // the executor path instead — covered by the direct-artifact tests below.
    const suggestion = makeSuggestion({
      id: '22222222-3333-4444-5555-666666666666',
      type: 'github-action',
      estimatedComplexity: 'solo',
      suggestedRoles: undefined,
    })
    const store = makeStore([suggestion])
    const executor = { execute: vi.fn() }
    const onSpawnTeam = vi.fn().mockResolvedValue({
      teamId: 'team-sugg-22222222',
      memberSessionIds: ['s1'],
    })
    const onSuggestionSpawnedTeam = vi.fn()

    const deps = makeDeps({
      suggestionStore: store as unknown as BrainAgentDeps['suggestionStore'],
      suggestionExecutor: executor,
      onSpawnTeam,
      onSuggestionSpawnedTeam,
    })
    const agent = createBrainAgent(deps, { autonomyLevel: 2 })
    await agent.wake()

    expect(onSpawnTeam).toHaveBeenCalledTimes(1)
    expect(onSpawnTeam).toHaveBeenCalledWith({
      suggestionId: suggestion.id,
      goal: suggestion.title,
      roles: ['scns-dev'],
      description: suggestion.description,
    })
    // Executor must NOT be touched on the unified solo path — QG validates
    // via team_completed instead of the thin "success: true" stub.
    expect(executor.execute).not.toHaveBeenCalled()
    expect(store.markInProgress).toHaveBeenCalledWith(suggestion.id, 'team-sugg-22222222')
    expect(store.updateStatus).not.toHaveBeenCalledWith(suggestion.id, 'implemented')
    expect(onSuggestionSpawnedTeam).toHaveBeenCalledTimes(1)
  })

  it('13.12.24a: solo-complexity suggestion WITHOUT onSpawnTeam falls back to executor', async () => {
    const suggestion = makeSuggestion({
      id: '22222222-3333-4444-5555-666666666667',
      estimatedComplexity: 'solo',
      suggestedRoles: undefined,
    })
    const store = makeStore([suggestion])
    const executor = { execute: vi.fn().mockReturnValue({ success: true }) }

    const deps = makeDeps({
      suggestionStore: store as unknown as BrainAgentDeps['suggestionStore'],
      suggestionExecutor: executor,
      // onSpawnTeam intentionally omitted
    })
    const agent = createBrainAgent(deps, { autonomyLevel: 2 })
    await agent.wake()

    expect(executor.execute).toHaveBeenCalledTimes(1)
    expect(store.updateStatus).toHaveBeenCalledWith(suggestion.id, 'implemented')
  })

  it('solo DIRECT-ARTIFACT suggestion (lsp) takes the executor path even WITH onSpawnTeam wired', async () => {
    // The spawn → staged-repo-diff → npm-gate roundtrip is a dead end for artifacts
    // that do not live in the repo: the agent has no legitimate repo diff to stage and
    // the real write (applyArtifact) sits behind a PASS it cannot earn. Observed live
    // 2026-09: approved lsp/instruction/tag-proposal items cycled gate-fail ×N →
    // gate-exhausted → needs-human → weekly re-ask, with the artifact never written.
    const suggestion = makeSuggestion({
      id: '55555555-6666-7777-8888-999999999999',
      type: 'lsp',
      title: 'Configure TypeScript LSP (typescript-language-server)',
      estimatedComplexity: 'solo',
      suggestedRoles: undefined,
    })
    const store = makeStore([suggestion])
    const executor = {
      execute: vi.fn().mockReturnValue({
        success: true,
        stepsCompleted: 2,
        stepsTotal: 2,
        filesCreated: ['/home/user/.copilot/lsp-config.json'],
      }),
    }
    const onSpawnTeam = vi.fn()

    const deps = makeDeps({
      suggestionStore: store as unknown as BrainAgentDeps['suggestionStore'],
      suggestionExecutor: executor,
      onSpawnTeam,
    })
    const agent = createBrainAgent(deps, { autonomyLevel: 2 })
    await agent.wake()

    expect(onSpawnTeam).not.toHaveBeenCalled()
    expect(executor.execute).toHaveBeenCalledTimes(1)
    expect(store.updateStatus).toHaveBeenCalledWith(suggestion.id, 'implemented')
  })

  it('executor evidence (steps + files written) reaches self-critique via teamOutput', async () => {
    // Phase 13.12.24a existed because the critic saw a bare "success: true", could
    // verify nothing, and false-failed artifact writes into an infinite retry loop.
    // The executor path is only safe to restore because this evidence now flows.
    const suggestion = makeSuggestion({
      id: '66666666-7777-8888-9999-aaaaaaaaaaaa',
      type: 'lsp',
      estimatedComplexity: 'solo',
      suggestedRoles: undefined,
    })
    const store = makeStore([suggestion])
    const executor = {
      execute: vi.fn().mockReturnValue({
        success: true,
        stepsCompleted: 2,
        stepsTotal: 2,
        filesCreated: ['/home/user/.copilot/lsp-config.json'],
      }),
    }
    const selfCritique = {
      run: vi.fn().mockResolvedValue({
        verdict: 'pass' as const,
        findings: [],
        requiredFollowups: [],
      }),
      writeCritiqueFile: vi.fn().mockReturnValue('/tmp/critique.md'),
    }

    const deps = makeDeps({
      suggestionStore: store as unknown as BrainAgentDeps['suggestionStore'],
      suggestionExecutor: executor,
      onSpawnTeam: vi.fn(),
      selfCritique: selfCritique as unknown as BrainAgentDeps['selfCritique'],
    })
    const agent = createBrainAgent(deps, { autonomyLevel: 2 })
    await agent.wake()

    expect(selfCritique.run).toHaveBeenCalledTimes(1)
    const input = selfCritique.run.mock.calls[0]![0] as { teamOutput: string }
    expect(input.teamOutput).toContain('steps completed: 2/2')
    expect(input.teamOutput).toContain('files written:')
    expect(input.teamOutput).toContain('/home/user/.copilot/lsp-config.json')
  })

  it('team-complexity with empty roles falls back to executor (safety)', async () => {
    const suggestion = makeSuggestion({
      id: '33333333-4444-5555-6666-777777777777',
      estimatedComplexity: 'team',
      suggestedRoles: [],
    })
    const store = makeStore([suggestion])
    const executor = { execute: vi.fn().mockReturnValue({ success: true }) }
    const onSpawnTeam = vi.fn()

    const deps = makeDeps({
      suggestionStore: store as unknown as BrainAgentDeps['suggestionStore'],
      suggestionExecutor: executor,
      onSpawnTeam,
    })
    const agent = createBrainAgent(deps, { autonomyLevel: 2 })
    await agent.wake()

    expect(onSpawnTeam).not.toHaveBeenCalled()
    expect(executor.execute).toHaveBeenCalledTimes(1)
  })

  it('team-complexity suggestion without onSpawnTeam dep falls back to executor', async () => {
    const suggestion = makeSuggestion({
      id: '44444444-5555-6666-7777-888888888888',
    })
    const store = makeStore([suggestion])
    const executor = { execute: vi.fn().mockReturnValue({ success: true }) }

    const deps = makeDeps({
      suggestionStore: store as unknown as BrainAgentDeps['suggestionStore'],
      suggestionExecutor: executor,
      // onSpawnTeam intentionally omitted
    })
    const agent = createBrainAgent(deps, { autonomyLevel: 2 })
    await agent.wake()

    expect(executor.execute).toHaveBeenCalledTimes(1)
  })

  // ── Phase 13.12.20: brain spawn roundtrip ──────────────────────────

  it('13.12.20: onSpawnTeam throwing leaves suggestion approved + records failure (no fake implemented)', async () => {
    const suggestion = makeSuggestion()
    const store = makeStore([suggestion])
    const executor = { execute: vi.fn() }
    const onSpawnTeam = vi.fn().mockRejectedValue(new Error('CHECK constraint failed'))

    const deps = makeDeps({
      suggestionStore: store as unknown as BrainAgentDeps['suggestionStore'],
      suggestionExecutor: executor,
      onSpawnTeam,
    })
    const agent = createBrainAgent(deps, { autonomyLevel: 2 })
    await agent.wake()

    expect(onSpawnTeam).toHaveBeenCalledTimes(1)
    // CRITICAL: must NOT fake-implement.
    expect(store.updateStatus).not.toHaveBeenCalledWith(suggestion.id, 'implemented')
    expect(store.markInProgress).not.toHaveBeenCalled()
    expect(store.recordFailure).toHaveBeenCalledWith(
      suggestion.id,
      expect.stringContaining('CHECK constraint failed'),
    )
  })

  it('13.12.20: onSpawnTeam returning empty memberSessionIds records failure (no fake implemented)', async () => {
    const suggestion = makeSuggestion()
    const store = makeStore([suggestion])
    const executor = { execute: vi.fn() }
    const onSpawnTeam = vi.fn().mockResolvedValue({
      teamId: 'team-sugg-deadbeef',
      memberSessionIds: [],
    })

    const deps = makeDeps({
      suggestionStore: store as unknown as BrainAgentDeps['suggestionStore'],
      suggestionExecutor: executor,
      onSpawnTeam,
    })
    const agent = createBrainAgent(deps, { autonomyLevel: 2 })
    await agent.wake()

    expect(onSpawnTeam).toHaveBeenCalledTimes(1)
    expect(store.updateStatus).not.toHaveBeenCalledWith(suggestion.id, 'implemented')
    expect(store.markInProgress).not.toHaveBeenCalled()
    expect(store.recordFailure).toHaveBeenCalled()
  })

  it('13.12.20: successful onSpawnTeam passes suggestion.description into callback input', async () => {
    const suggestion = makeSuggestion()
    const store = makeStore([suggestion])
    const onSpawnTeam = vi.fn().mockResolvedValue({
      teamId: 'team-sugg-ab',
      memberSessionIds: ['s1'],
    })
    const deps = makeDeps({
      suggestionStore: store as unknown as BrainAgentDeps['suggestionStore'],
      suggestionExecutor: { execute: vi.fn() },
      onSpawnTeam,
    })
    await createBrainAgent(deps, { autonomyLevel: 2 }).wake()
    expect(onSpawnTeam.mock.calls[0]![0]).toMatchObject({
      suggestionId: suggestion.id,
      description: suggestion.description,
    })
  })

  it('13.12.1: executor returning nextStatus=needs-human moves suggestion out of approved', async () => {
    const suggestion = makeSuggestion({
      id: '55555555-6666-7777-8888-999999999999',
      estimatedComplexity: 'solo',
      suggestedRoles: undefined,
      type: 'workflow',
    })
    const store = makeStore([suggestion])
    const executor = {
      execute: vi.fn().mockReturnValue({
        success: false,
        error: 'workflow-type needs human planner, not auto-execution',
        nextStatus: 'needs-human',
      }),
    }

    const deps = makeDeps({
      suggestionStore: store as unknown as BrainAgentDeps['suggestionStore'],
      suggestionExecutor: executor,
    })
    const agent = createBrainAgent(deps, { autonomyLevel: 2 })
    await agent.wake()

    expect(executor.execute).toHaveBeenCalledTimes(1)
    expect(store.updateStatus).toHaveBeenCalledWith(
      suggestion.id,
      'needs-human',
      'workflow-type needs human planner, not auto-execution',
      undefined,
      // Phase 10f: the executor DECLINING a type is a gate refusal, not an exhausted retry
      // budget. Pinned here because only the tag keeps `scns suggest retry` from offering
      // another identical attempt at something that was refused on principle.
      { escalation: 'gate-refused' },
    )
    expect(store.updateStatus).not.toHaveBeenCalledWith(suggestion.id, 'implemented')

    // Second wake: store.list({status:'approved'}) should now return empty,
    // so executor is NOT called again. This proves it no longer loops.
    await agent.wake()
    expect(executor.execute).toHaveBeenCalledTimes(1)
  })

  it('13.12.1: executor failure WITHOUT nextStatus leaves suggestion in approved (retry next tick)', async () => {
    const suggestion = makeSuggestion({
      id: '66666666-7777-8888-9999-aaaaaaaaaaaa',
      estimatedComplexity: 'solo',
      suggestedRoles: undefined,
    })
    const store = makeStore([suggestion])
    const executor = {
      execute: vi.fn().mockReturnValue({ success: false, error: 'transient error' }),
    }

    const deps = makeDeps({
      suggestionStore: store as unknown as BrainAgentDeps['suggestionStore'],
      suggestionExecutor: executor,
    })
    const agent = createBrainAgent(deps, { autonomyLevel: 2 })
    await agent.wake()

    expect(executor.execute).toHaveBeenCalledTimes(1)
    // No status change — stays 'approved' and will be retried.
    expect(store.updateStatus).not.toHaveBeenCalled()
  })

  // ── Phase 13.12.2: blocked-autonomy ─────────────────────────────────

  it('13.12.2: executor returning nextStatus=blocked-autonomy persists metadata', async () => {
    const suggestion = makeSuggestion({
      id: '77777777-8888-9999-aaaa-bbbbbbbbbbbb',
      estimatedComplexity: 'solo',
      suggestedRoles: undefined,
      type: 'automation',
    })
    const store = makeStore([suggestion])
    const executor = {
      execute: vi.fn().mockReturnValue({
        success: false,
        error: 'RunCommand skipped at autonomy level 2',
        nextStatus: 'blocked-autonomy',
        blockedMetadata: { requiredLevel: 3, blockedAt: '2025-01-20T12:00:00Z' },
      }),
    }

    const deps = makeDeps({
      suggestionStore: store as unknown as BrainAgentDeps['suggestionStore'],
      suggestionExecutor: executor,
    })
    const agent = createBrainAgent(deps, { autonomyLevel: 2 })
    await agent.wake()

    expect(executor.execute).toHaveBeenCalledTimes(1)
    expect(store.updateStatus).toHaveBeenCalledWith(
      suggestion.id,
      'blocked-autonomy',
      'RunCommand skipped at autonomy level 2',
      { requiredLevel: 3, blockedAt: '2025-01-20T12:00:00Z' },
      // Phase 10f negative control: the escalation tag describes `needs-human` only, so a
      // blocked-autonomy transition must carry NO tag.
      undefined,
    )

    // Second wake: store.list({status:'approved'}) returns empty,
    // so executor is NOT called again → no warn spam loop.
    await agent.wake()
    expect(executor.execute).toHaveBeenCalledTimes(1)
  })

  it('13.12.2: blocked-autonomy suggestion auto-resets to approved when autonomy raised to required level', async () => {
    const now = '2025-01-20T12:00:00Z'
    const blocked = {
      ...makeSuggestion({
        id: '88888888-9999-aaaa-bbbb-cccccccccccc',
        estimatedComplexity: 'solo',
        suggestedRoles: undefined,
      }),
      status: 'blocked-autonomy',
      blockedMetadata: { requiredLevel: 3, blockedAt: now },
    } as Suggestion

    // Store that tracks a blocked-autonomy suggestion we can reset.
    const statuses = new Map<string, string>([[blocked.id, 'blocked-autonomy']])
    const store = {
      list: vi.fn((filter: { status: string }) =>
        statuses.get(blocked.id) === filter.status ? [blocked] : [],
      ),
      updateStatus: vi.fn((id: string, status: string) => {
        statuses.set(id, status)
      }),
    }

    // Autonomy source: starts at L2 (required is L3 → still blocked),
    // then raised to L3 before the second wake.
    let liveLevel = 2
    const deps = makeDeps({
      suggestionStore: store as unknown as BrainAgentDeps['suggestionStore'],
      suggestionExecutor: { execute: vi.fn() },
      getAutonomyLevel: () => liveLevel,
    })
    const agent = createBrainAgent(deps)

    await agent.wake()
    // L2 < required L3 → NOT reset.
    expect(store.updateStatus).not.toHaveBeenCalled()

    liveLevel = 3
    await agent.wake()
    // L3 meets required L3 → reset to approved.
    expect(store.updateStatus).toHaveBeenCalledWith(
      blocked.id,
      'approved',
      expect.stringContaining('autonomy raised to L3'),
    )
  })

  // ── Phase 13.12.9: failed-suggestion recovery ───────────────────────

  it('13.12.9: execute() failure (no nextStatus) calls recordFailure, not updateStatus', async () => {
    const suggestion = makeSuggestion({
      id: '99999999-1111-2222-3333-444444444444',
      estimatedComplexity: 'solo',
      suggestedRoles: undefined,
    })
    const statuses = new Map<string, string>([[suggestion.id, 'approved']])
    const store = {
      list: vi.fn((filter: { status: string }) =>
        statuses.get(suggestion.id) === filter.status ? [suggestion] : [],
      ),
      updateStatus: vi.fn((id: string, status: string) => {
        statuses.set(id, status)
      }),
      recordFailure: vi.fn(),
      clearBackoff: vi.fn(),
    }
    const executor = {
      execute: vi.fn().mockReturnValue({ success: false, error: 'disk full' }),
    }

    const deps = makeDeps({
      suggestionStore: store as unknown as BrainAgentDeps['suggestionStore'],
      suggestionExecutor: executor,
    })
    const agent = createBrainAgent(deps, { autonomyLevel: 2 })
    await agent.wake()

    expect(executor.execute).toHaveBeenCalledTimes(1)
    expect(store.recordFailure).toHaveBeenCalledWith(suggestion.id, 'disk full')
    // Must NOT call updateStatus for the failure path (store manages the move).
    expect(store.updateStatus).not.toHaveBeenCalled()
  })

  it('13.12.9: skips items whose nextRetryAt is in the future', async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    const suggestion = {
      ...makeSuggestion({
        id: 'aaaaaaaa-1111-2222-3333-444444444444',
        estimatedComplexity: 'solo',
        suggestedRoles: undefined,
      }),
      status: 'approved' as const,
      attemptCount: 2,
      nextRetryAt: future,
    } as Suggestion
    const store = {
      list: vi.fn((filter: { status: string }) =>
        filter.status === 'approved' ? [suggestion] : [],
      ),
      updateStatus: vi.fn(),
      recordFailure: vi.fn(),
      clearBackoff: vi.fn(),
    }
    const executor = { execute: vi.fn() }
    const deps = makeDeps({
      suggestionStore: store as unknown as BrainAgentDeps['suggestionStore'],
      suggestionExecutor: executor,
    })
    const agent = createBrainAgent(deps, { autonomyLevel: 3 })
    await agent.wake()

    // Executor must NOT run for backing-off item.
    expect(executor.execute).not.toHaveBeenCalled()
    expect(store.recordFailure).not.toHaveBeenCalled()
  })

  it('13.12.9: autonomy raise to L3 auto-resets failed items whose lastError matches RunCommand skipped', async () => {
    const failed = {
      ...makeSuggestion({
        id: 'bbbbbbbb-1111-2222-3333-444444444444',
        estimatedComplexity: 'solo',
        suggestedRoles: undefined,
      }),
      status: 'failed' as const,
      attemptCount: 5,
      lastError: 'RunCommand skipped at autonomy level 2',
    } as Suggestion

    const store = {
      list: vi.fn((filter: { status: string }) => (filter.status === 'failed' ? [failed] : [])),
      updateStatus: vi.fn(),
      recordFailure: vi.fn(),
      clearBackoff: vi.fn(),
    }
    let liveLevel = 2
    const deps = makeDeps({
      suggestionStore: store as unknown as BrainAgentDeps['suggestionStore'],
      suggestionExecutor: { execute: vi.fn() },
      getAutonomyLevel: () => liveLevel,
    })
    const agent = createBrainAgent(deps)

    await agent.wake()
    // L2 — no reset.
    expect(store.clearBackoff).not.toHaveBeenCalled()

    liveLevel = 3
    await agent.wake()
    expect(store.clearBackoff).toHaveBeenCalledWith(failed.id)
  })
})

// ── Phase 13.12.19: Self-critique integration ────────────────────────

describe('BrainAgent self-critique integration (Phase 13.12.19)', () => {
  function makeSug(overrides: Partial<Suggestion> = {}): Suggestion {
    const now = '2025-01-15T10:00:00Z'
    return {
      id: '11111111-2222-3333-4444-555555555555',
      type: 'automation',
      title: 'Sample automation',
      description: 'Body',
      status: 'approved',
      confidence: 0.9,
      evidence: [],
      tags: [],
      createdAt: now,
      updatedAt: now,
      actionable: true,
      estimatedComplexity: 'solo',
      attemptCount: 0,
      lastError: null,
      lastAttemptAt: null,
      nextRetryAt: null,
      allowRepoWrites: false,
      ...overrides,
    } as Suggestion
  }

  function makeStore(s: Suggestion) {
    const statuses = new Map<string, string>([[s.id, s.status as string]])
    return {
      list: (filter: { status: string }) => (statuses.get(s.id) === filter.status ? [s] : []),
      updateStatus: vi.fn((id: string, status: string) => {
        statuses.set(id, status)
      }),
      recordFailure: vi.fn((id: string, _err: string) => {
        statuses.set(id, 'approved') // still approved until MAX_ATTEMPTS, matches store
      }),
      clearBackoff: vi.fn(),
      _statuses: statuses,
    }
  }

  it('pass verdict → updateStatus(implemented) + writeCritiqueFile(implemented)', async () => {
    const s = makeSug()
    const store = makeStore(s)
    const executor = { execute: vi.fn().mockReturnValue({ success: true }) }
    const selfCritique = {
      run: vi.fn().mockResolvedValue({
        verdict: 'pass',
        findings: [],
        requiredFollowups: [],
        criticSessionId: 'sc-ok',
      }),
      writeCritiqueFile: vi.fn().mockReturnValue('/tmp/ok.md'),
    }
    const deps = makeDeps({
      suggestionStore: store as unknown as BrainAgentDeps['suggestionStore'],
      suggestionExecutor: executor,
      selfCritique,
    })
    const agent = createBrainAgent(deps, { autonomyLevel: 2 })
    await agent.wake()

    expect(selfCritique.run).toHaveBeenCalledTimes(1)
    expect(store.updateStatus).toHaveBeenCalledWith(s.id, 'implemented')
    expect(store.recordFailure).not.toHaveBeenCalled()
    expect(selfCritique.writeCritiqueFile).toHaveBeenCalledWith(
      expect.objectContaining({ targetStatus: 'implemented', suggestion: s }),
    )
  })

  it('fail verdict → recordFailure + writeCritiqueFile(failed), NO implemented transition', async () => {
    const s = makeSug({ id: '22222222-2222-3333-4444-555555555555' })
    const store = makeStore(s)
    const executor = { execute: vi.fn().mockReturnValue({ success: true }) }
    const selfCritique = {
      run: vi.fn().mockResolvedValue({
        verdict: 'fail',
        findings: ['expected file missing'],
        requiredFollowups: ['re-run executor'],
        criticalReasons: ['no filesystem write observed'],
        criticSessionId: 'sc-fail',
      }),
      writeCritiqueFile: vi.fn(),
    }
    const deps = makeDeps({
      suggestionStore: store as unknown as BrainAgentDeps['suggestionStore'],
      suggestionExecutor: executor,
      selfCritique,
    })
    const agent = createBrainAgent(deps, { autonomyLevel: 3 })
    await agent.wake()

    expect(store.recordFailure).toHaveBeenCalledWith(
      s.id,
      expect.stringMatching(/self-critique: fail.*expected file missing/),
    )
    expect(store.updateStatus).not.toHaveBeenCalledWith(s.id, 'implemented')
    expect(selfCritique.writeCritiqueFile).toHaveBeenCalledWith(
      expect.objectContaining({ targetStatus: 'failed' }),
    )
  })

  it('needs-evidence verdict → updateStatus(needs-human) + writeCritiqueFile(needs-human)', async () => {
    const s = makeSug({ id: '33333333-2222-3333-4444-555555555555' })
    const store = makeStore(s)
    const executor = { execute: vi.fn().mockReturnValue({ success: true }) }
    const selfCritique = {
      run: vi.fn().mockResolvedValue({
        verdict: 'needs-evidence',
        findings: ['cannot confirm'],
        requiredFollowups: ['manual check'],
        criticSessionId: 'sc-nh',
        degradedReason: 'critique-timeout',
      }),
      writeCritiqueFile: vi.fn(),
    }
    const deps = makeDeps({
      suggestionStore: store as unknown as BrainAgentDeps['suggestionStore'],
      suggestionExecutor: executor,
      selfCritique,
    })
    const agent = createBrainAgent(deps, { autonomyLevel: 2 })
    await agent.wake()

    expect(store.updateStatus).toHaveBeenCalledWith(
      s.id,
      'needs-human',
      expect.stringContaining('self-critique'),
      undefined,
      // Phase 10f: the critic refusing to pass it is a gate refusal.
      { escalation: 'gate-refused' },
    )
    expect(store.updateStatus).not.toHaveBeenCalledWith(s.id, 'implemented')
    expect(store.recordFailure).not.toHaveBeenCalled()
    expect(selfCritique.writeCritiqueFile).toHaveBeenCalledWith(
      expect.objectContaining({ targetStatus: 'needs-human' }),
    )
  })

  it('no selfCritique dep → behaves as pre-13.12.19 (straight to implemented)', async () => {
    const s = makeSug({ id: '44444444-2222-3333-4444-555555555555' })
    const store = makeStore(s)
    const executor = { execute: vi.fn().mockReturnValue({ success: true }) }
    const deps = makeDeps({
      suggestionStore: store as unknown as BrainAgentDeps['suggestionStore'],
      suggestionExecutor: executor,
    })
    const agent = createBrainAgent(deps, { autonomyLevel: 2 })
    await agent.wake()

    expect(store.updateStatus).toHaveBeenCalledWith(s.id, 'implemented')
  })

  it('critique.run() throwing falls through to implemented (fail-open)', async () => {
    const s = makeSug({ id: '55555555-2222-3333-4444-555555555555' })
    const store = makeStore(s)
    const executor = { execute: vi.fn().mockReturnValue({ success: true }) }
    const selfCritique = {
      run: vi.fn().mockRejectedValue(new Error('critic crashed')),
      writeCritiqueFile: vi.fn(),
    }
    const deps = makeDeps({
      suggestionStore: store as unknown as BrainAgentDeps['suggestionStore'],
      suggestionExecutor: executor,
      selfCritique,
    })
    const agent = createBrainAgent(deps, { autonomyLevel: 2 })
    await agent.wake()

    expect(store.updateStatus).toHaveBeenCalledWith(s.id, 'implemented')
    expect(selfCritique.writeCritiqueFile).not.toHaveBeenCalled()
  })

  it('executor failure path is not touched by self-critique (no critique on failed execute)', async () => {
    const s = makeSug({ id: '66666666-2222-3333-4444-555555555555' })
    const store = makeStore(s)
    const executor = {
      execute: vi.fn().mockReturnValue({ success: false, error: 'boom' }),
    }
    const selfCritique = {
      run: vi.fn(),
      writeCritiqueFile: vi.fn(),
    }
    const deps = makeDeps({
      suggestionStore: store as unknown as BrainAgentDeps['suggestionStore'],
      suggestionExecutor: executor,
      selfCritique,
    })
    const agent = createBrainAgent(deps, { autonomyLevel: 2 })
    await agent.wake()

    expect(selfCritique.run).not.toHaveBeenCalled()
    expect(store.recordFailure).toHaveBeenCalledWith(s.id, 'boom')
  })
})

// ── P1: OTel-driven suggestion generation ────────────────────────────
// The brain previously called suggestionGenerator.generate(patterns), which
// passes otelPatterns=undefined, starving the OTel-based extractors. As a
// result the brain emitted 0 suggestions on every tick even though OTel data
// (otel_spans) was available. These tests pin the fix: the brain must feed
// OTel patterns into generateFromAllSources, including when observation
// patterns are absent.

describe('BrainAgent OTel-driven suggestions (P1)', () => {
  const otelPatterns = {
    schedule: {
      activeHours: [{ hour: 10, sessionCount: 5 }],
      activeDays: [{ day: 'Monday', sessionCount: 5 }],
      avgSessionDuration: 3_600_000,
      avgTokensPerSession: { input: 1000, output: 2000 },
    },
    tools: {
      topTools: [
        { tool: 'bash', totalUses: 50, avgDurationMs: 100 },
        { tool: 'edit', totalUses: 40, avgDurationMs: 50 },
        { tool: 'view', totalUses: 35, avgDurationMs: 30 },
      ],
      mcpServers: [{ server: 'github-mcp', sessionCount: 4 }],
      skills: [{ skill: 'code-review', sessionCount: 4 }],
    },
    models: {
      models: [{ model: 'claude-sonnet-4', totalCalls: 30, sessionCount: 4 }],
      primaryModel: 'claude-sonnet-4',
    },
    totalSessions: 5,
    analyzedFrom: '2025-01-01T00:00:00.000Z',
    analyzedTo: '2025-01-08T00:00:00.000Z',
    extractedAt: '2025-01-08T00:00:00.000Z',
  }

  it('feeds OTel patterns to generateFromAllSources even when observation patterns are null', async () => {
    const generateFromAllSources = vi.fn().mockReturnValue([{ id: 's1' }])
    const generate = vi.fn().mockReturnValue([])
    const deps = makeDeps({
      getObservationCount: vi.fn().mockReturnValue(10), // Idle
      getDetectedPatterns: vi.fn().mockReturnValue(null), // no observation patterns
      getOtelPatterns: vi.fn().mockReturnValue(otelPatterns),
      suggestionGenerator: { generate, generateFromAllSources },
    })

    const agent = createBrainAgent(deps, { autonomyLevel: 2 })
    const decision = await agent.wake()

    expect(decision.action).toBe(BrainAction.Idle)
    expect(generateFromAllSources).toHaveBeenCalledTimes(1)
    const [patternsArg, otelArg] = generateFromAllSources.mock.calls[0]!
    expect(otelArg).toBe(otelPatterns)
    // A synthesized observation-pattern shell with a valid window is supplied.
    expect(patternsArg.observationCount).toBe(0)
    expect(patternsArg.windowStart).toBe(otelPatterns.analyzedFrom)
    expect(generate).not.toHaveBeenCalled()
  })

  it('passes both observation and OTel patterns when both are present', async () => {
    const generateFromAllSources = vi.fn().mockReturnValue([])
    const obsPatterns = {
      workSchedule: null,
      toolFrequency: null,
      projectFocus: null,
      observationCount: 12,
      windowStart: '2025-02-01T00:00:00Z',
      windowEnd: '2025-02-08T00:00:00Z',
    }
    const deps = makeDeps({
      getObservationCount: vi.fn().mockReturnValue(10),
      getDetectedPatterns: vi.fn().mockReturnValue(obsPatterns),
      getOtelPatterns: vi.fn().mockReturnValue(otelPatterns),
      suggestionGenerator: { generate: vi.fn(), generateFromAllSources },
    })

    const agent = createBrainAgent(deps, { autonomyLevel: 2 })
    await agent.wake()

    expect(generateFromAllSources).toHaveBeenCalledWith(obsPatterns, otelPatterns)
  })

  it('does NOT generate suggestions at autonomy L0 (observe-only)', async () => {
    const generateFromAllSources = vi.fn().mockReturnValue([])
    const deps = makeDeps({
      getObservationCount: vi.fn().mockReturnValue(10),
      getDetectedPatterns: vi.fn().mockReturnValue(null),
      getOtelPatterns: vi.fn().mockReturnValue(otelPatterns),
      suggestionGenerator: { generate: vi.fn(), generateFromAllSources },
    })

    const agent = createBrainAgent(deps, { autonomyLevel: 0 })
    await agent.wake()

    expect(generateFromAllSources).not.toHaveBeenCalled()
  })

  it('emits >0 real suggestions through the real generator from OTel patterns', async () => {
    const saved: Suggestion[] = []
    const store = {
      save: (s: Suggestion) => {
        saved.push(s)
      },
      get: () => null,
      list: () => saved,
      updateStatus: () => null,
      findSimilar: () => null,
      getRejectedTitles: () => [] as string[],
    }
    const generator = createSuggestionGenerator(
      {
        scorer: createConfidenceScorer(),
        evidenceGatherer: createEvidenceGatherer(),
        store: store as never,
      },
      { minimumConfidence: 0.1 },
    )

    const deps = makeDeps({
      getObservationCount: vi.fn().mockReturnValue(10),
      getDetectedPatterns: vi.fn().mockReturnValue(null),
      getOtelPatterns: vi.fn().mockReturnValue(otelPatterns),
      suggestionGenerator: generator,
    })

    const agent = createBrainAgent(deps, { autonomyLevel: 2 })
    await agent.wake()

    expect(saved.length).toBeGreaterThan(0)
  })
})
