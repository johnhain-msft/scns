import { describe, it, expect } from 'vitest'
import { createDecisionTree } from '../../../src/brain/decision-tree.js'
import {
  BrainAction,
  DecisionPriority,
  type BrainState,
  type PendingTask,
} from '../../../src/brain/state-types.js'

// ── Test helper ──────────────────────────────────────────────────────

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

// ── Yield to User ────────────────────────────────────────────────────

describe('Yield to User', () => {
  it('yields when user is active and yieldToUser is true', () => {
    const tree = createDecisionTree()
    const state = makeBrainState({ userActive: true, yieldToUser: true })
    const decision = tree.decide(state)
    expect(decision.action).toBe(BrainAction.YieldToUser)
  })

  it('does not yield when user is active but yieldToUser is false', () => {
    const tree = createDecisionTree()
    const state = makeBrainState({ userActive: true, yieldToUser: false })
    const decision = tree.decide(state)
    expect(decision.action).not.toBe(BrainAction.YieldToUser)
  })

  it('does not yield when user is not active', () => {
    const tree = createDecisionTree()
    const state = makeBrainState({ userActive: false, yieldToUser: true })
    const decision = tree.decide(state)
    expect(decision.action).not.toBe(BrainAction.YieldToUser)
  })

  it('has critical priority', () => {
    const tree = createDecisionTree()
    const state = makeBrainState({ userActive: true, yieldToUser: true })
    const decision = tree.decide(state)
    expect(decision.priority).toBe(DecisionPriority.Critical)
  })

  it('shouldYieldToUser helper returns correct value', () => {
    const tree = createDecisionTree()
    expect(tree.shouldYieldToUser(makeBrainState({ userActive: true, yieldToUser: true }))).toBe(
      true,
    )
    expect(tree.shouldYieldToUser(makeBrainState({ userActive: true, yieldToUser: false }))).toBe(
      false,
    )
    expect(tree.shouldYieldToUser(makeBrainState({ userActive: false, yieldToUser: true }))).toBe(
      false,
    )
  })
})

// ── Context Rotation ─────────────────────────────────────────────────

describe('Context Rotation', () => {
  it('rotates when context is at threshold', () => {
    const tree = createDecisionTree()
    const state = makeBrainState({ contextUsagePercent: 85, contextRotationThreshold: 85 })
    const decision = tree.decide(state)
    expect(decision.action).toBe(BrainAction.RotateContext)
  })

  it('rotates when context is above threshold', () => {
    const tree = createDecisionTree()
    const state = makeBrainState({ contextUsagePercent: 90, contextRotationThreshold: 85 })
    const decision = tree.decide(state)
    expect(decision.action).toBe(BrainAction.RotateContext)
  })

  it('does not rotate when context is below threshold', () => {
    const tree = createDecisionTree()
    const state = makeBrainState({ contextUsagePercent: 50 })
    const decision = tree.decide(state)
    expect(decision.action).not.toBe(BrainAction.RotateContext)
  })

  it('respects custom threshold', () => {
    const tree = createDecisionTree()
    const state = makeBrainState({ contextUsagePercent: 70, contextRotationThreshold: 70 })
    const decision = tree.decide(state)
    expect(decision.action).toBe(BrainAction.RotateContext)
  })

  it('has critical priority', () => {
    const tree = createDecisionTree()
    const state = makeBrainState({ contextUsagePercent: 90, contextRotationThreshold: 85 })
    const decision = tree.decide(state)
    expect(decision.priority).toBe(DecisionPriority.Critical)
  })

  it('shouldRotateContext helper returns correct value', () => {
    const tree = createDecisionTree()
    expect(
      tree.shouldRotateContext(
        makeBrainState({ contextUsagePercent: 90, contextRotationThreshold: 85 }),
      ),
    ).toBe(true)
    expect(
      tree.shouldRotateContext(
        makeBrainState({ contextUsagePercent: 50, contextRotationThreshold: 85 }),
      ),
    ).toBe(false)
  })
})

// ── Memory Consolidation ─────────────────────────────────────────────

describe('Memory Consolidation', () => {
  it('consolidates when stale and no tasks', () => {
    const tree = createDecisionTree()
    const state = makeBrainState({
      lastConsolidationAge: 25,
      consolidationThreshold: 24,
      pendingTasks: [],
    })
    const decision = tree.decide(state)
    expect(decision.action).toBe(BrainAction.Consolidate)
  })

  it('skips consolidation when high-priority tasks are pending', () => {
    const tree = createDecisionTree()
    const state = makeBrainState({
      lastConsolidationAge: 25,
      consolidationThreshold: 24,
      pendingTasks: [makeTask({ priority: DecisionPriority.High })],
    })
    const decision = tree.decide(state)
    expect(decision.action).not.toBe(BrainAction.Consolidate)
  })

  it('does not consolidate when recent', () => {
    const tree = createDecisionTree()
    const state = makeBrainState({ lastConsolidationAge: 5, consolidationThreshold: 24 })
    const decision = tree.decide(state)
    expect(decision.action).not.toBe(BrainAction.Consolidate)
  })

  it('respects custom consolidation threshold', () => {
    const tree = createDecisionTree()
    const state = makeBrainState({
      lastConsolidationAge: 13,
      consolidationThreshold: 12,
      pendingTasks: [],
    })
    const decision = tree.decide(state)
    expect(decision.action).toBe(BrainAction.Consolidate)
  })

  it('shouldConsolidate helper returns correct value', () => {
    const tree = createDecisionTree()
    expect(
      tree.shouldConsolidate(
        makeBrainState({
          lastConsolidationAge: 25,
          consolidationThreshold: 24,
          pendingTasks: [],
        }),
      ),
    ).toBe(true)
    expect(
      tree.shouldConsolidate(
        makeBrainState({
          lastConsolidationAge: 25,
          consolidationThreshold: 24,
          pendingTasks: [makeTask({ priority: DecisionPriority.High })],
        }),
      ),
    ).toBe(false)
  })
})

// ── Consolidation gate (R1 livelock fix) ─────────────────────────────

describe('Consolidation gate', () => {
  it('gate-blocked consolidation falls through to pending tasks', () => {
    // Cell-1 shape: never-run system (stale forever), gate closed (count
    // unsatisfied), one Normal task queued. Pre-fix this decided Consolidate
    // on every wake and the task starved.
    const tree = createDecisionTree()
    const task = makeTask({ priority: DecisionPriority.Normal })
    const state = makeBrainState({
      lastConsolidationAge: Infinity,
      consolidationThreshold: 24,
      consolidationGateOpen: false,
      pendingTasks: [task],
    })
    const decision = tree.decide(state)
    expect(decision.action).not.toBe(BrainAction.Consolidate)
    expect(decision.taskId).toBe(task.id)
  })

  it('gate-open consolidation still fires when stale', () => {
    const tree = createDecisionTree()
    const state = makeBrainState({
      lastConsolidationAge: 25,
      consolidationThreshold: 24,
      consolidationGateOpen: true,
      pendingTasks: [makeTask({ priority: DecisionPriority.Normal })],
    })
    const decision = tree.decide(state)
    expect(decision.action).toBe(BrainAction.Consolidate)
  })

  it('unknown gate state preserves legacy behavior (consolidates when stale)', () => {
    const tree = createDecisionTree()
    const state = makeBrainState({
      lastConsolidationAge: 25,
      consolidationThreshold: 24,
      pendingTasks: [],
    })
    const decision = tree.decide(state)
    expect(decision.action).toBe(BrainAction.Consolidate)
  })

  it('gate-blocked with no tasks does not consolidate', () => {
    const tree = createDecisionTree()
    const state = makeBrainState({
      lastConsolidationAge: Infinity,
      consolidationThreshold: 24,
      consolidationGateOpen: false,
      pendingTasks: [],
    })
    const decision = tree.decide(state)
    expect(decision.action).not.toBe(BrainAction.Consolidate)
  })

  it('shouldConsolidate helper honors the gate', () => {
    const tree = createDecisionTree()
    expect(
      tree.shouldConsolidate(
        makeBrainState({
          lastConsolidationAge: 25,
          consolidationThreshold: 24,
          consolidationGateOpen: false,
          pendingTasks: [],
        }),
      ),
    ).toBe(false)
    expect(
      tree.shouldConsolidate(
        makeBrainState({
          lastConsolidationAge: 25,
          consolidationThreshold: 24,
          consolidationGateOpen: true,
          pendingTasks: [],
        }),
      ),
    ).toBe(true)
  })
})

// ── Approved Suggestions ─────────────────────────────────────────────

describe('Approved Suggestions', () => {
  it('decides ApprovedSuggestions when approved count > 0 and L2+', () => {
    const tree = createDecisionTree()
    const state = makeBrainState({
      autonomyLevel: 2,
      approvedSuggestionCount: 3,
    })
    const decision = tree.decide(state)
    expect(decision.action).toBe(BrainAction.ApprovedSuggestions)
    expect(decision.reason).toContain('3 approved')
  })

  it('does not execute suggestions at L1 (Advisor)', () => {
    const tree = createDecisionTree()
    const state = makeBrainState({
      autonomyLevel: 1,
      approvedSuggestionCount: 5,
    })
    const decision = tree.decide(state)
    expect(decision.action).not.toBe(BrainAction.ApprovedSuggestions)
  })

  it('does not execute when no approved suggestions', () => {
    const tree = createDecisionTree()
    const state = makeBrainState({
      autonomyLevel: 3,
      approvedSuggestionCount: 0,
    })
    const decision = tree.decide(state)
    expect(decision.action).not.toBe(BrainAction.ApprovedSuggestions)
  })

  it('consolidation takes priority over approved suggestions', () => {
    const tree = createDecisionTree()
    const state = makeBrainState({
      autonomyLevel: 3,
      approvedSuggestionCount: 2,
      lastConsolidationAge: 48,
      consolidationThreshold: 24,
    })
    const decision = tree.decide(state)
    expect(decision.action).toBe(BrainAction.Consolidate)
  })
})

describe('Observation Gathering', () => {
  it('observes when few observations and no tasks', () => {
    const tree = createDecisionTree()
    const state = makeBrainState({ recentObservationCount: 2, pendingTasks: [] })
    const decision = tree.decide(state)
    expect(decision.action).toBe(BrainAction.Observe)
  })

  it('does not observe when many observations', () => {
    const tree = createDecisionTree()
    const state = makeBrainState({ recentObservationCount: 20, pendingTasks: [] })
    const decision = tree.decide(state)
    expect(decision.action).not.toBe(BrainAction.Observe)
  })

  it('tasks take priority over observing', () => {
    const tree = createDecisionTree()
    const state = makeBrainState({
      recentObservationCount: 2,
      pendingTasks: [makeTask({ priority: DecisionPriority.Normal })],
    })
    const decision = tree.decide(state)
    expect(decision.action).not.toBe(BrainAction.Observe)
  })

  it('respects custom observation minimum', () => {
    const tree = createDecisionTree({ observationMinimum: 10 })
    const state = makeBrainState({ recentObservationCount: 7, pendingTasks: [] })
    const decision = tree.decide(state)
    expect(decision.action).toBe(BrainAction.Observe)
  })

  it('shouldObserveMore helper returns correct value', () => {
    const tree = createDecisionTree()
    expect(
      tree.shouldObserveMore(makeBrainState({ recentObservationCount: 2, pendingTasks: [] })),
    ).toBe(true)
    expect(
      tree.shouldObserveMore(makeBrainState({ recentObservationCount: 20, pendingTasks: [] })),
    ).toBe(false)
    expect(
      tree.shouldObserveMore(
        makeBrainState({
          recentObservationCount: 2,
          pendingTasks: [makeTask()],
        }),
      ),
    ).toBe(false)
  })
})

// ── Task Processing ──────────────────────────────────────────────────

describe('Task Processing', () => {
  it('simple solo task at L3 → HandleSolo', () => {
    const tree = createDecisionTree()
    const task = makeTask({ strategy: 'solo', subtaskCount: 1 })
    const state = makeBrainState({ autonomyLevel: 3, pendingTasks: [task] })
    const decision = tree.decide(state)
    expect(decision.action).toBe(BrainAction.HandleSolo)
    expect(decision.taskId).toBe(task.id)
  })

  it('solo task at L2 → HandleSolo (L2 can handle simple)', () => {
    const tree = createDecisionTree()
    const task = makeTask({ strategy: 'solo', subtaskCount: 1 })
    const state = makeBrainState({ autonomyLevel: 2, pendingTasks: [task] })
    const decision = tree.decide(state)
    expect(decision.action).toBe(BrainAction.HandleSolo)
  })

  it('task at L1 → Suggest (advisor: cannot execute, suggests instead)', () => {
    const tree = createDecisionTree()
    const task = makeTask({ strategy: 'solo' })
    const state = makeBrainState({ autonomyLevel: 1, pendingTasks: [task] })
    const decision = tree.decide(state)
    expect(decision.action).toBe(BrainAction.Suggest)
  })

  it('task at L0 → Idle (observer only)', () => {
    const tree = createDecisionTree()
    const task = makeTask({ strategy: 'solo' })
    const state = makeBrainState({ autonomyLevel: 0, pendingTasks: [task] })
    const decision = tree.decide(state)
    expect(decision.action).toBe(BrainAction.Idle)
  })

  it('parallel task → SpawnTeam with correct teamSize', () => {
    const tree = createDecisionTree()
    const task = makeTask({ strategy: 'parallel', subtaskCount: 3 })
    const state = makeBrainState({ autonomyLevel: 3, pendingTasks: [task] })
    const decision = tree.decide(state)
    expect(decision.action).toBe(BrainAction.SpawnTeam)
    expect(decision.teamSize).toBe(3)
  })

  it('sequential task → HandleSolo', () => {
    const tree = createDecisionTree()
    const task = makeTask({ strategy: 'sequential', subtaskCount: 4 })
    const state = makeBrainState({ autonomyLevel: 3, pendingTasks: [task] })
    const decision = tree.decide(state)
    expect(decision.action).toBe(BrainAction.HandleSolo)
  })

  it('hybrid task → SpawnTeam', () => {
    const tree = createDecisionTree()
    const task = makeTask({ strategy: 'hybrid', subtaskCount: 4 })
    const state = makeBrainState({ autonomyLevel: 3, pendingTasks: [task] })
    const decision = tree.decide(state)
    expect(decision.action).toBe(BrainAction.SpawnTeam)
  })

  it('team size capped at maxTeamSize', () => {
    const tree = createDecisionTree({ maxTeamSize: 3 })
    const task = makeTask({ strategy: 'parallel', subtaskCount: 10 })
    const state = makeBrainState({ autonomyLevel: 3, pendingTasks: [task] })
    const decision = tree.decide(state)
    expect(decision.teamSize).toBe(3)
  })

  it('team size capped at available session slots', () => {
    const tree = createDecisionTree()
    const task = makeTask({ strategy: 'parallel', subtaskCount: 10 })
    const state = makeBrainState({
      autonomyLevel: 3,
      pendingTasks: [task],
      activeSessions: 3,
      maxConcurrentSessions: 5,
    })
    const decision = tree.decide(state)
    expect(decision.teamSize).toBe(2) // 5 - 3 = 2 available
  })

  it('no available sessions → Idle', () => {
    const tree = createDecisionTree()
    const task = makeTask({ strategy: 'solo' })
    const state = makeBrainState({
      autonomyLevel: 3,
      pendingTasks: [task],
      activeSessions: 5,
      maxConcurrentSessions: 5,
    })
    const decision = tree.decide(state)
    expect(decision.action).toBe(BrainAction.Idle)
  })

  it('picks highest priority task when multiple pending', () => {
    const tree = createDecisionTree()
    const lowTask = makeTask({ id: 'low', priority: DecisionPriority.Low, strategy: 'solo' })
    const highTask = makeTask({ id: 'high', priority: DecisionPriority.High, strategy: 'solo' })
    const state = makeBrainState({
      autonomyLevel: 3,
      pendingTasks: [lowTask, highTask],
    })
    const decision = tree.decide(state)
    expect(decision.taskId).toBe('high')
  })

  it('task without strategy defaults to HandleSolo for single subtask', () => {
    const tree = createDecisionTree()
    const task = makeTask({ subtaskCount: 1 })
    const state = makeBrainState({ autonomyLevel: 3, pendingTasks: [task] })
    const decision = tree.decide(state)
    expect(decision.action).toBe(BrainAction.HandleSolo)
  })

  it('task without strategy spawns solo for multiple subtasks', () => {
    const tree = createDecisionTree()
    const task = makeTask({ subtaskCount: 3 })
    const state = makeBrainState({ autonomyLevel: 3, pendingTasks: [task] })
    const decision = tree.decide(state)
    expect(decision.action).toBe(BrainAction.SpawnSolo)
  })

  it('moderate task at L2 → allowed', () => {
    const tree = createDecisionTree()
    // A moderate task: has a few subtasks, sequential strategy
    const task = makeTask({ strategy: 'sequential', subtaskCount: 3 })
    const state = makeBrainState({ autonomyLevel: 2, pendingTasks: [task] })
    const decision = tree.decide(state)
    expect(decision.action).toBe(BrainAction.HandleSolo)
  })

  it('complex task at L2 → NOT allowed (Idle)', () => {
    const tree = createDecisionTree()
    // A complex task: parallel strategy with many subtasks
    const task = makeTask({ strategy: 'parallel', subtaskCount: 6 })
    const state = makeBrainState({ autonomyLevel: 2, pendingTasks: [task] })
    const decision = tree.decide(state)
    expect(decision.action).toBe(BrainAction.Idle)
  })

  it('complex task at L3 → allowed', () => {
    const tree = createDecisionTree()
    const task = makeTask({ strategy: 'parallel', subtaskCount: 6 })
    const state = makeBrainState({ autonomyLevel: 3, pendingTasks: [task] })
    const decision = tree.decide(state)
    expect(decision.action).toBe(BrainAction.SpawnTeam)
  })

  it('selectTaskAction returns correct decision for solo task', () => {
    const tree = createDecisionTree()
    const task = makeTask({ strategy: 'solo', subtaskCount: 1 })
    const state = makeBrainState({ autonomyLevel: 3 })
    const decision = tree.selectTaskAction(state, task)
    expect(decision.action).toBe(BrainAction.HandleSolo)
  })
})

// ── Suggest (L1 advisory mode) ───────────────────────────────────────

describe('Suggest (L1 advisory mode)', () => {
  it('at L1 with enough observations and no tasks → Suggest', () => {
    const tree = createDecisionTree()
    const state = makeBrainState({
      autonomyLevel: 1,
      recentObservationCount: 10,
      pendingTasks: [],
    })
    const decision = tree.decide(state)
    expect(decision.action).toBe(BrainAction.Suggest)
  })

  it('at L0 with enough observations → Idle (L0 is observe-only)', () => {
    const tree = createDecisionTree()
    const state = makeBrainState({
      autonomyLevel: 0,
      recentObservationCount: 10,
      pendingTasks: [],
    })
    const decision = tree.decide(state)
    expect(decision.action).toBe(BrainAction.Idle)
  })

  it('at L2 with enough observations → NOT Suggest (L2+ handles tasks)', () => {
    const tree = createDecisionTree()
    const state = makeBrainState({
      autonomyLevel: 2,
      recentObservationCount: 10,
      pendingTasks: [],
    })
    const decision = tree.decide(state)
    expect(decision.action).not.toBe(BrainAction.Suggest)
  })

  it('at L1 with insufficient observations → Observe (not Suggest)', () => {
    const tree = createDecisionTree()
    const state = makeBrainState({
      autonomyLevel: 1,
      recentObservationCount: 2,
      pendingTasks: [],
    })
    const decision = tree.decide(state)
    expect(decision.action).toBe(BrainAction.Observe)
  })

  it('Suggest has Normal priority', () => {
    const tree = createDecisionTree()
    const state = makeBrainState({
      autonomyLevel: 1,
      recentObservationCount: 10,
      pendingTasks: [],
    })
    const decision = tree.decide(state)
    expect(decision.priority).toBe(DecisionPriority.Normal)
  })

  it('consolidation takes priority over Suggest', () => {
    const tree = createDecisionTree()
    const state = makeBrainState({
      autonomyLevel: 1,
      recentObservationCount: 10,
      lastConsolidationAge: 48,
      consolidationThreshold: 24,
      pendingTasks: [],
    })
    const decision = tree.decide(state)
    expect(decision.action).toBe(BrainAction.Consolidate)
  })

  it('at L1 with tasks still routes to Suggest (L1 cannot execute tasks)', () => {
    const tree = createDecisionTree()
    const state = makeBrainState({
      autonomyLevel: 1,
      recentObservationCount: 10,
      pendingTasks: [makeTask({ priority: DecisionPriority.Normal })],
    })
    const decision = tree.decide(state)
    expect(decision.action).toBe(BrainAction.Suggest)
  })

  it('respects lowered default observation minimum (3)', () => {
    const tree = createDecisionTree()
    // Default minimum is now 3, not 5
    const state = makeBrainState({
      autonomyLevel: 1,
      recentObservationCount: 3,
      pendingTasks: [],
    })
    const decision = tree.decide(state)
    expect(decision.action).toBe(BrainAction.Suggest)
  })

  it('shouldSuggest helper returns correct value', () => {
    const tree = createDecisionTree()
    expect(
      tree.shouldSuggest(makeBrainState({ autonomyLevel: 1, recentObservationCount: 10 })),
    ).toBe(true)
    expect(
      tree.shouldSuggest(makeBrainState({ autonomyLevel: 1, recentObservationCount: 2 })),
    ).toBe(false)
    expect(
      tree.shouldSuggest(makeBrainState({ autonomyLevel: 2, recentObservationCount: 10 })),
    ).toBe(false)
    expect(
      tree.shouldSuggest(makeBrainState({ autonomyLevel: 0, recentObservationCount: 10 })),
    ).toBe(false)
  })
})

// ── Idle ─────────────────────────────────────────────────────────────

describe('Idle', () => {
  it('returns Idle when nothing to do', () => {
    const tree = createDecisionTree()
    const state = makeBrainState({
      pendingTasks: [],
      recentObservationCount: 10,
      lastConsolidationAge: 2,
    })
    const decision = tree.decide(state)
    expect(decision.action).toBe(BrainAction.Idle)
  })

  it('Idle has confidence 1.0', () => {
    const tree = createDecisionTree()
    const state = makeBrainState()
    const decision = tree.decide(state)
    expect(decision.confidence).toBe(1.0)
  })
})

// ── Priority integration ─────────────────────────────────────────────

describe('Priority integration', () => {
  it('user active overrides pending tasks', () => {
    const tree = createDecisionTree()
    const state = makeBrainState({
      userActive: true,
      yieldToUser: true,
      pendingTasks: [makeTask({ priority: DecisionPriority.High })],
    })
    const decision = tree.decide(state)
    expect(decision.action).toBe(BrainAction.YieldToUser)
  })

  it('context rotation overrides task processing', () => {
    const tree = createDecisionTree()
    const state = makeBrainState({
      contextUsagePercent: 90,
      contextRotationThreshold: 85,
      pendingTasks: [makeTask({ priority: DecisionPriority.High })],
    })
    const decision = tree.decide(state)
    expect(decision.action).toBe(BrainAction.RotateContext)
  })

  it('tasks override consolidation when high priority', () => {
    const tree = createDecisionTree()
    const state = makeBrainState({
      lastConsolidationAge: 25,
      consolidationThreshold: 24,
      pendingTasks: [makeTask({ priority: DecisionPriority.High })],
    })
    const decision = tree.decide(state)
    // Should handle the task, not consolidate
    expect(decision.action).not.toBe(BrainAction.Consolidate)
    expect(decision.taskId).toBe('task-1')
  })

  it('full traversal: user inactive, low context, no stale, some observations, task', () => {
    const tree = createDecisionTree()
    const task = makeTask({ strategy: 'solo', subtaskCount: 1, priority: DecisionPriority.Normal })
    const state = makeBrainState({
      userActive: false,
      contextUsagePercent: 30,
      lastConsolidationAge: 2,
      recentObservationCount: 10,
      pendingTasks: [task],
      autonomyLevel: 3,
    })
    const decision = tree.decide(state)
    expect(decision.action).toBe(BrainAction.HandleSolo)
  })
})

// ── Decision confidence ──────────────────────────────────────────────

describe('Decision confidence', () => {
  it('clear yield action has confidence 1.0', () => {
    const tree = createDecisionTree()
    const state = makeBrainState({ userActive: true, yieldToUser: true })
    const decision = tree.decide(state)
    expect(decision.confidence).toBe(1.0)
  })

  it('clear context rotation has confidence 1.0', () => {
    const tree = createDecisionTree()
    const state = makeBrainState({ contextUsagePercent: 90, contextRotationThreshold: 85 })
    const decision = tree.decide(state)
    expect(decision.confidence).toBe(1.0)
  })

  it('task action at L3 has high confidence', () => {
    const tree = createDecisionTree()
    const task = makeTask({ strategy: 'solo', subtaskCount: 1 })
    const state = makeBrainState({ autonomyLevel: 3, pendingTasks: [task] })
    const decision = tree.decide(state)
    expect(decision.confidence).toBeGreaterThanOrEqual(0.8)
  })

  it('task action at L2 has lower confidence than L3', () => {
    const tree = createDecisionTree()
    const task = makeTask({ strategy: 'solo', subtaskCount: 1 })
    const stateL2 = makeBrainState({ autonomyLevel: 2, pendingTasks: [task] })
    const stateL3 = makeBrainState({ autonomyLevel: 3, pendingTasks: [task] })
    const decisionL2 = tree.decide(stateL2)
    const decisionL3 = tree.decide(stateL3)
    expect(decisionL2.confidence).toBeLessThan(decisionL3.confidence)
  })
})
