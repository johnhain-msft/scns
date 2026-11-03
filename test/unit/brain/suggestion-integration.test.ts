import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createBrainAgent, type BrainAgentDeps } from '../../../src/brain/agent-loop.js'
import { createTaskQueue } from '../../../src/brain/task-queue.js'
import { createDecisionTree } from '../../../src/brain/decision-tree.js'
import { createTaskClassifier } from '../../../src/brain/classifier.js'
import { createTemplateEngine } from '../../../src/brain/templates.js'
import { createHealthMonitor } from '../../../src/context/health-monitor.js'
import { BrainAction } from '../../../src/brain/state-types.js'
import type { DetectedPatterns } from '../../../src/observe/pattern-detector.js'
import type { Suggestion } from '../../../src/suggest/types.js'

// ── Helpers ──────────────────────────────────────────────────────────

function makePatterns(overrides?: Partial<DetectedPatterns>): DetectedPatterns {
  return {
    workSchedule: {
      activeHours: [9, 10, 11, 14, 15, 16],
      peakHour: 10,
      averageSessionMinutes: 90,
      breakGaps: [15, 30],
      activeDays: [1, 2, 3, 4, 5],
    },
    toolFrequency: {
      appCounts: new Map([
        ['VSCode', 50],
        ['Chrome', 30],
      ]),
      topApps: ['VSCode', 'Chrome'],
      categoryBreakdown: new Map([
        ['coding', 50],
        ['browsing', 30],
      ]),
    },
    projectFocus: {
      repoCounts: new Map([['scns', 20]]),
      topRepos: ['scns'],
      fileTypeCounts: new Map([['ts', 40]]),
      recentFocus: 'scns',
    },
    observationCount: 100,
    windowStart: '2025-01-01T00:00:00.000Z',
    windowEnd: '2025-01-07T23:59:59.000Z',
    ...overrides,
  }
}

function makeSuggestion(overrides?: Partial<Suggestion>): Suggestion {
  return {
    id: 'test-suggestion-1',
    type: 'workflow',
    title: 'Test suggestion',
    description: 'A test suggestion',
    status: 'pending',
    confidence: 0.8,
    evidence: [],
    tags: ['test'],
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  }
}

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
    getObservationCount: vi.fn().mockReturnValue(2),
    getActiveSessions: vi.fn().mockReturnValue(0),
    isUserActive: vi.fn().mockReturnValue(false),
    getLastConsolidationAge: vi.fn().mockReturnValue(2),
    ...overrides,
  }
}

// Force BrainAction.Observe by providing low observation count
function makeObserveDeps(overrides?: Partial<BrainAgentDeps>): BrainAgentDeps {
  return makeDeps({
    getObservationCount: vi.fn().mockReturnValue(2),
    observationManager: { getStatus: () => ({ observationCount: 5 }) },
    ...overrides,
  })
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Brain suggestion integration', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('calls generateSuggestions after observe when generator and patterns are available', async () => {
    const patterns = makePatterns()
    const suggestions = [makeSuggestion(), makeSuggestion({ id: 'test-2', title: 'Second' })]
    const generate = vi.fn().mockReturnValue(suggestions)

    const deps = makeObserveDeps({
      suggestionGenerator: { generate },
      getDetectedPatterns: vi.fn().mockReturnValue(patterns),
    })

    const agent = createBrainAgent(deps, { autonomyLevel: 2 })
    const decision = await agent.wake()

    expect(decision.action).toBe(BrainAction.Observe)
    expect(generate).toHaveBeenCalledWith(patterns)
  })

  it('skips suggestion generation when no generator is provided', async () => {
    const deps = makeObserveDeps({
      getDetectedPatterns: vi.fn().mockReturnValue(makePatterns()),
    })

    const agent = createBrainAgent(deps, { autonomyLevel: 2 })
    const decision = await agent.wake()

    expect(decision.action).toBe(BrainAction.Observe)
    // getDetectedPatterns is called by buildBrainState, but no error thrown
    // without a generator — suggestion generation is simply skipped
    expect(deps.getDetectedPatterns).toHaveBeenCalled()
  })

  it('skips suggestion generation when patterns are null', async () => {
    const generate = vi.fn()

    const deps = makeObserveDeps({
      suggestionGenerator: { generate },
      getDetectedPatterns: vi.fn().mockReturnValue(null),
    })

    const agent = createBrainAgent(deps, { autonomyLevel: 2 })
    const decision = await agent.wake()

    expect(decision.action).toBe(BrainAction.Observe)
    expect(deps.getDetectedPatterns).toHaveBeenCalled()
    expect(generate).not.toHaveBeenCalled()
  })

  it('skips suggestion generation when getDetectedPatterns is not provided', async () => {
    const generate = vi.fn()

    const deps = makeObserveDeps({
      suggestionGenerator: { generate },
      // No getDetectedPatterns
    })

    const agent = createBrainAgent(deps, { autonomyLevel: 2 })
    const decision = await agent.wake()

    expect(decision.action).toBe(BrainAction.Observe)
    expect(generate).not.toHaveBeenCalled()
  })

  it('catches and logs suggestion generation errors without crashing', async () => {
    const generate = vi.fn().mockImplementation(() => {
      throw new Error('generator exploded')
    })

    const deps = makeObserveDeps({
      suggestionGenerator: { generate },
      getDetectedPatterns: vi.fn().mockReturnValue(makePatterns()),
    })

    const agent = createBrainAgent(deps, { autonomyLevel: 2 })

    // Should not throw
    const decision = await agent.wake()

    expect(decision.action).toBe(BrainAction.Observe)
    expect(generate).toHaveBeenCalled()
    // Agent still returns a valid decision (error was caught)
    expect(decision).toBeDefined()
  })

  it('generates suggestions even when onLearn is not configured', async () => {
    const generate = vi.fn().mockReturnValue([makeSuggestion()])

    const deps = makeObserveDeps({
      suggestionGenerator: { generate },
      getDetectedPatterns: vi.fn().mockReturnValue(makePatterns()),
      // onLearn is NOT provided
    })

    const agent = createBrainAgent(deps, { autonomyLevel: 2 })
    const decision = await agent.wake()

    expect(decision.action).toBe(BrainAction.Observe)
    expect(generate).toHaveBeenCalled()
  })

  it('generates suggestions after learning completes', async () => {
    const generate = vi.fn().mockReturnValue([makeSuggestion()])
    const onLearn = vi.fn().mockResolvedValue({
      sessionsProcessed: 1,
      digestsStored: 1,
      errors: [],
    })

    const deps = makeObserveDeps({
      suggestionGenerator: { generate },
      getDetectedPatterns: vi.fn().mockReturnValue(makePatterns()),
      onLearn,
    })

    const agent = createBrainAgent(deps, { autonomyLevel: 2 })
    const decision = await agent.wake()

    expect(decision.action).toBe(BrainAction.Observe)
    expect(onLearn).toHaveBeenCalled()
    expect(generate).toHaveBeenCalled()
  })

  it('still generates suggestions when learning pipeline fails', async () => {
    const generate = vi.fn().mockReturnValue([makeSuggestion()])
    const onLearn = vi.fn().mockRejectedValue(new Error('learn failed'))

    const deps = makeObserveDeps({
      suggestionGenerator: { generate },
      getDetectedPatterns: vi.fn().mockReturnValue(makePatterns()),
      onLearn,
    })

    const agent = createBrainAgent(deps, { autonomyLevel: 2 })
    const decision = await agent.wake()

    expect(decision.action).toBe(BrainAction.Observe)
    expect(generate).toHaveBeenCalled()
  })

  it('returns empty suggestions array gracefully', async () => {
    const generate = vi.fn().mockReturnValue([])

    const deps = makeObserveDeps({
      suggestionGenerator: { generate },
      getDetectedPatterns: vi.fn().mockReturnValue(makePatterns()),
    })

    const agent = createBrainAgent(deps, { autonomyLevel: 2 })
    const decision = await agent.wake()

    expect(decision.action).toBe(BrainAction.Observe)
    expect(generate).toHaveBeenCalled()
  })

  it('auto-approves a pending high-confidence suggestion but does NOT enqueue it as a task (ApprovedSuggestions Path A is authoritative — prevents double-spawn)', async () => {
    const pending = makeSuggestion({
      id: 'auto-approve-1',
      status: 'pending',
      confidence: 0.95,
      estimatedComplexity: 'solo',
      actionable: true,
    })
    const updateStatus = vi.fn()
    const taskQueue = createTaskQueue()
    const enqueueSpy = vi.spyOn(taskQueue, 'enqueue')

    const deps = makeDeps({
      taskQueue,
      getObservationCount: vi.fn().mockReturnValue(50),
      suggestionStore: {
        list: (filter: { status: string }) =>
          filter.status === 'pending' ? [pending] : [],
        updateStatus,
      },
    })

    const agent = createBrainAgent(deps, { autonomyLevel: 2 })
    await agent.wake()

    // Auto-approved (pending → approved) so ApprovedSuggestions can execute it.
    expect(updateStatus).toHaveBeenCalledWith('auto-approve-1', 'approved')
    // But NOT also enqueued as a task — that would spawn it a second time
    // via the task-queue path on a later tick.
    expect(enqueueSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ sourceSuggestionId: 'auto-approve-1' }),
    )
  })

  it('still enqueues a human-approved suggestion as a task (not auto-approved this tick)', async () => {
    const approved = makeSuggestion({
      id: 'human-approved-1',
      status: 'approved',
      confidence: 0.6,
      estimatedComplexity: 'solo',
      actionable: true,
    })
    const updateStatus = vi.fn()
    const taskQueue = createTaskQueue()
    const enqueueSpy = vi.spyOn(taskQueue, 'enqueue')

    const deps = makeDeps({
      taskQueue,
      getObservationCount: vi.fn().mockReturnValue(50),
      suggestionStore: {
        list: (filter: { status: string }) =>
          filter.status === 'approved' ? [approved] : [],
        updateStatus,
      },
    })

    const agent = createBrainAgent(deps, { autonomyLevel: 2 })
    await agent.wake()

    // Human-approved items are not in autoApprovedIds, so they keep the
    // existing task-queue promotion behavior.
    expect(enqueueSpy).toHaveBeenCalledWith(
      expect.objectContaining({ sourceSuggestionId: 'human-approved-1' }),
    )
  })
})
