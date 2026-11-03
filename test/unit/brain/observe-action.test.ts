import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createBrainAgent, type BrainAgentDeps } from '../../../src/brain/agent-loop.js'
import { createTaskQueue } from '../../../src/brain/task-queue.js'
import { createDecisionTree } from '../../../src/brain/decision-tree.js'
import { createTaskClassifier } from '../../../src/brain/classifier.js'
import { createTemplateEngine } from '../../../src/brain/templates.js'
import { createHealthMonitor } from '../../../src/context/health-monitor.js'
import { BrainAction } from '../../../src/brain/state-types.js'

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
    getActiveSessions: vi.fn().mockReturnValue(0),
    isUserActive: vi.fn().mockReturnValue(false),
    getLastConsolidationAge: vi.fn().mockReturnValue(2),
    ...overrides,
  }
}

/** Force decision tree to pick Observe by setting low observation count */
function makeObserveDeps(overrides?: Partial<BrainAgentDeps>): BrainAgentDeps {
  return makeDeps({
    getObservationCount: vi.fn().mockReturnValue(2),
    ...overrides,
  })
}

// ── Observe action ───────────────────────────────────────────────────

describe('Observe action', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('with no observationManager → logs "no observations"', async () => {
    const deps = makeObserveDeps()
    const agent = createBrainAgent(deps)

    const decision = await agent.wake()
    expect(decision.action).toBe(BrainAction.Observe)
    // No observationManager means obsCount defaults to 0 → "no observations" path
  })

  it('with observationManager reporting 0 → skips learning', async () => {
    const mockManager = { getStatus: vi.fn().mockReturnValue({ observationCount: 0 }) }
    const onLearn = vi.fn().mockResolvedValue({
      sessionsProcessed: 0,
      digestsStored: 0,
      errors: [],
    })
    const deps = makeObserveDeps({
      observationManager: mockManager,
      onLearn,
    })
    const agent = createBrainAgent(deps)

    const decision = await agent.wake()
    expect(decision.action).toBe(BrainAction.Observe)
    expect(onLearn).not.toHaveBeenCalled()
  })

  it('with observations + onLearn callback → calls onLearn', async () => {
    const mockManager = { getStatus: vi.fn().mockReturnValue({ observationCount: 5 }) }
    const onLearn = vi.fn().mockResolvedValue({
      sessionsProcessed: 3,
      digestsStored: 3,
      errors: [],
    })
    const deps = makeObserveDeps({
      observationManager: mockManager,
      onLearn,
    })
    const agent = createBrainAgent(deps)

    const decision = await agent.wake()
    expect(decision.action).toBe(BrainAction.Observe)
    expect(onLearn).toHaveBeenCalledOnce()
  })

  it('with observations but onLearn fails → logs error, does not crash', async () => {
    const mockManager = { getStatus: vi.fn().mockReturnValue({ observationCount: 10 }) }
    const onLearn = vi.fn().mockRejectedValue(new Error('DB connection lost'))
    const deps = makeObserveDeps({
      observationManager: mockManager,
      onLearn,
    })
    const agent = createBrainAgent(deps)

    // Should not throw
    const decision = await agent.wake()
    expect(decision.action).toBe(BrainAction.Observe)
    expect(onLearn).toHaveBeenCalledOnce()
  })

  it('with observations but no onLearn → does not crash', async () => {
    const mockManager = { getStatus: vi.fn().mockReturnValue({ observationCount: 5 }) }
    const deps = makeObserveDeps({
      observationManager: mockManager,
      // no onLearn
    })
    const agent = createBrainAgent(deps)

    const decision = await agent.wake()
    expect(decision.action).toBe(BrainAction.Observe)
    // Should reach the "no learning callback" branch without error
  })
})

// ── getObservationCount fallback ─────────────────────────────────────

describe('getObservationCount fallback chain', () => {
  it('explicit getObservationCount overrides observationManager', async () => {
    const mockManager = { getStatus: vi.fn().mockReturnValue({ observationCount: 100 }) }
    const getObservationCount = vi.fn().mockReturnValue(2)
    const deps = makeDeps({
      observationManager: mockManager,
      getObservationCount,
    })
    const agent = createBrainAgent(deps)

    const decision = await agent.wake()
    // getObservationCount returns 2, which triggers Observe (below minimum of 5)
    expect(decision.action).toBe(BrainAction.Observe)
    expect(getObservationCount).toHaveBeenCalled()
  })

  it('observationManager used when no explicit getObservationCount', async () => {
    const mockManager = { getStatus: vi.fn().mockReturnValue({ observationCount: 2 }) }
    const deps = makeDeps({
      observationManager: mockManager,
      getObservationCount: undefined,
    })
    const agent = createBrainAgent(deps)

    const decision = await agent.wake()
    // observationManager returns 2, below minimum → Observe
    expect(decision.action).toBe(BrainAction.Observe)
    expect(mockManager.getStatus).toHaveBeenCalled()
  })

  it('default (0) used when neither callback nor manager provided', async () => {
    const deps = makeDeps({
      getObservationCount: undefined,
    })
    const agent = createBrainAgent(deps)

    const decision = await agent.wake()
    // Default is 0, below minimum → Observe
    expect(decision.action).toBe(BrainAction.Observe)
  })
})

// ── L0 safety ────────────────────────────────────────────────────────

describe('L0 Observer mode safety', () => {
  it('brain never executes tasks at L0 — only proposes/observes', async () => {
    const deps = makeDeps({
      getObservationCount: vi.fn().mockReturnValue(10),
    })
    const agent = createBrainAgent(deps, { autonomyLevel: 0 })
    agent.addTask('Write authentication module')

    const decision = await agent.wake()
    // At L0 with tasks pending, should not spawn/handle — should Idle with reason
    expect(decision.action).toBe(BrainAction.Idle)
    expect(decision.reason).toContain('Observer mode')
    expect(deps.onSpawnAgent).not.toHaveBeenCalled()
  })
})
