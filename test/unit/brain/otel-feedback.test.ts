import { describe, it, expect, vi } from 'vitest'
import { createBrainAgent, type BrainAgentDeps } from '../../../src/brain/agent-loop.js'
import { createTaskQueue } from '../../../src/brain/task-queue.js'
import { createDecisionTree } from '../../../src/brain/decision-tree.js'
import { createTaskClassifier } from '../../../src/brain/classifier.js'
import { createTemplateEngine } from '../../../src/brain/templates.js'
import { createHealthMonitor } from '../../../src/context/health-monitor.js'
import {
  BrainAction,
  DecisionPriority,
  type BrainState,
  type OtelMetricsSummary,
  type PendingTask,
} from '../../../src/brain/state-types.js'

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

function makeBrainState(overrides?: Partial<BrainState>): BrainState {
  return {
    autonomyLevel: 3,
    userActive: false,
    yieldToUser: true,
    pendingTasks: [],
    activeSessions: 0,
    maxConcurrentSessions: 5,
    contextUsagePercent: 30,
    contextRotationThreshold: 85,
    recentObservationCount: 10,
    lastConsolidationAge: 2,
    consolidationThreshold: 24,
    approvedSuggestionCount: 0,
    pendingQualityChecks: 0,
    patterns: null,
    ...overrides,
  }
}

function makeTask(overrides?: Partial<PendingTask>): PendingTask {
  return {
    id: 'task-1',
    description: 'Test task',
    priority: DecisionPriority.Normal,
    createdAt: '2025-01-01T00:00:00Z',
    ...overrides,
  }
}

const SAMPLE_OTEL_METRICS: OtelMetricsSummary = {
  totalSpansIngested: 150,
  lastIngestTime: '2025-01-15T10:30:00Z',
  activeOtelSessions: 2,
  patternsExtracted: 5,
}

// ── Brain state includes OTel metrics ────────────────────────────────

describe('OTel feedback — brain state', () => {
  it('includes OTel metrics in state when callback provided', async () => {
    const decisionTree = createDecisionTree()
    const decideSpy = vi.spyOn(decisionTree, 'decide')

    const deps = makeDeps({
      decisionTree,
      getOtelMetrics: () => SAMPLE_OTEL_METRICS,
    })
    const agent = createBrainAgent(deps)
    await agent.wake()

    expect(decideSpy).toHaveBeenCalledOnce()
    const stateArg = decideSpy.mock.calls[0]![0]
    expect(stateArg.otelMetrics).toEqual(SAMPLE_OTEL_METRICS)
  })

  it('state has no OTel metrics when callback absent', async () => {
    const decisionTree = createDecisionTree()
    const decideSpy = vi.spyOn(decisionTree, 'decide')

    const deps = makeDeps({ decisionTree })
    // Ensure no getOtelMetrics is set
    delete (deps as Record<string, unknown>).getOtelMetrics
    const agent = createBrainAgent(deps)
    await agent.wake()

    expect(decideSpy).toHaveBeenCalledOnce()
    const stateArg = decideSpy.mock.calls[0]![0]
    expect(stateArg.otelMetrics).toBeUndefined()
  })

  it('metrics callback errors are caught gracefully', async () => {
    const decisionTree = createDecisionTree()
    const decideSpy = vi.spyOn(decisionTree, 'decide')

    const deps = makeDeps({
      decisionTree,
      getOtelMetrics: () => {
        throw new Error('DB connection failed')
      },
    })
    const agent = createBrainAgent(deps)

    // Should not throw
    const decision = await agent.wake()
    expect(decision).toBeDefined()

    // State should have undefined otelMetrics due to error
    const stateArg = decideSpy.mock.calls[0]![0]
    expect(stateArg.otelMetrics).toBeUndefined()
  })

  it('metrics with zero active sessions still included', async () => {
    const decisionTree = createDecisionTree()
    const decideSpy = vi.spyOn(decisionTree, 'decide')

    const zeroMetrics: OtelMetricsSummary = {
      totalSpansIngested: 50,
      activeOtelSessions: 0,
      patternsExtracted: 3,
    }

    const deps = makeDeps({
      decisionTree,
      getOtelMetrics: () => zeroMetrics,
    })
    const agent = createBrainAgent(deps)
    await agent.wake()

    const stateArg = decideSpy.mock.calls[0]![0]
    expect(stateArg.otelMetrics).toEqual(zeroMetrics)
  })
})

// ── Decision tree OTel awareness ─────────────────────────────────────

describe('OTel feedback — decision tree', () => {
  it('defers to Observe when active OTel sessions detected and yieldToUser is true', () => {
    const tree = createDecisionTree()
    const state = makeBrainState({
      otelMetrics: { ...SAMPLE_OTEL_METRICS, activeOtelSessions: 1 },
      yieldToUser: true,
    })
    const decision = tree.decide(state)
    expect(decision.action).toBe(BrainAction.Observe)
    expect(decision.reason).toContain('OTel')
  })

  it('does not defer when active OTel sessions but yieldToUser is false', () => {
    const tree = createDecisionTree()
    const state = makeBrainState({
      otelMetrics: { ...SAMPLE_OTEL_METRICS, activeOtelSessions: 2 },
      yieldToUser: false,
    })
    const decision = tree.decide(state)
    // Should fall through to normal decision flow (idle in this case)
    expect(decision.action).not.toBe(BrainAction.Observe)
  })

  it('blocks consolidation when active OTel sessions', () => {
    const tree = createDecisionTree()
    const state = makeBrainState({
      lastConsolidationAge: 48,
      consolidationThreshold: 24,
      otelMetrics: { ...SAMPLE_OTEL_METRICS, activeOtelSessions: 1 },
      yieldToUser: true,
    })
    const decision = tree.decide(state)
    // Should observe instead of consolidate
    expect(decision.action).toBe(BrainAction.Observe)
    expect(decision.action).not.toBe(BrainAction.Consolidate)
  })

  it('blocks task processing when active OTel sessions', () => {
    const tree = createDecisionTree()
    const task = makeTask({ strategy: 'solo', subtaskCount: 1 })
    const state = makeBrainState({
      autonomyLevel: 3,
      pendingTasks: [task],
      otelMetrics: { ...SAMPLE_OTEL_METRICS, activeOtelSessions: 1 },
      yieldToUser: true,
    })
    const decision = tree.decide(state)
    // Should observe, not process the task
    expect(decision.action).toBe(BrainAction.Observe)
    expect(decision.action).not.toBe(BrainAction.HandleSolo)
  })

  it('allows normal decisions when zero active OTel sessions', () => {
    const tree = createDecisionTree()
    const state = makeBrainState({
      otelMetrics: { ...SAMPLE_OTEL_METRICS, activeOtelSessions: 0 },
      lastConsolidationAge: 48,
      consolidationThreshold: 24,
    })
    const decision = tree.decide(state)
    // Should consolidate normally
    expect(decision.action).toBe(BrainAction.Consolidate)
  })

  it('allows normal decisions when no OTel metrics present', () => {
    const tree = createDecisionTree()
    const state = makeBrainState({
      lastConsolidationAge: 48,
      consolidationThreshold: 24,
    })
    const decision = tree.decide(state)
    expect(decision.action).toBe(BrainAction.Consolidate)
  })

  it('context rotation still takes priority over OTel sessions', () => {
    const tree = createDecisionTree()
    const state = makeBrainState({
      contextUsagePercent: 90,
      contextRotationThreshold: 85,
      otelMetrics: { ...SAMPLE_OTEL_METRICS, activeOtelSessions: 3 },
      yieldToUser: true,
    })
    const decision = tree.decide(state)
    // Context rotation is critical — it must still happen
    expect(decision.action).toBe(BrainAction.RotateContext)
  })

  it('user-active yield still takes priority over OTel gate', () => {
    const tree = createDecisionTree()
    const state = makeBrainState({
      userActive: true,
      yieldToUser: true,
      otelMetrics: { ...SAMPLE_OTEL_METRICS, activeOtelSessions: 1 },
    })
    const decision = tree.decide(state)
    expect(decision.action).toBe(BrainAction.YieldToUser)
  })

  it('hasActiveOtelSessions helper returns correct value', () => {
    const tree = createDecisionTree()
    expect(
      tree.hasActiveOtelSessions(
        makeBrainState({
          otelMetrics: { ...SAMPLE_OTEL_METRICS, activeOtelSessions: 2 },
        }),
      ),
    ).toBe(true)
    expect(
      tree.hasActiveOtelSessions(
        makeBrainState({
          otelMetrics: { ...SAMPLE_OTEL_METRICS, activeOtelSessions: 0 },
        }),
      ),
    ).toBe(false)
    expect(tree.hasActiveOtelSessions(makeBrainState({ otelMetrics: undefined }))).toBe(false)
  })
})
