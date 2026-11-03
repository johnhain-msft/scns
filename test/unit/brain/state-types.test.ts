import { describe, it, expect } from 'vitest'
import {
  BrainAction,
  DecisionPriority,
  type BrainState,
  type Decision,
  type PendingTask,
} from '../../../src/brain/state-types.js'

describe('BrainAction', () => {
  it('has correct string values', () => {
    expect(BrainAction.Idle).toBe('idle')
    expect(BrainAction.Observe).toBe('observe')
    expect(BrainAction.SpawnSolo).toBe('spawn-solo')
    expect(BrainAction.SpawnTeam).toBe('spawn-team')
    expect(BrainAction.HandleSolo).toBe('handle-solo')
    expect(BrainAction.Consolidate).toBe('consolidate')
    expect(BrainAction.RotateContext).toBe('rotate-context')
    expect(BrainAction.YieldToUser).toBe('yield-to-user')
  })

  it('contains exactly 12 actions', () => {
    const values = Object.values(BrainAction)
    expect(values).toHaveLength(12)
  })

  it('includes SelfCritique (Phase 13.12.19)', () => {
    expect(BrainAction.SelfCritique).toBe('self-critique')
  })
})

describe('DecisionPriority', () => {
  it('has correct string values', () => {
    expect(DecisionPriority.Critical).toBe('critical')
    expect(DecisionPriority.High).toBe('high')
    expect(DecisionPriority.Normal).toBe('normal')
    expect(DecisionPriority.Low).toBe('low')
  })

  it('contains exactly 4 priorities', () => {
    const values = Object.values(DecisionPriority)
    expect(values).toHaveLength(4)
  })
})

describe('BrainState interface', () => {
  it('accepts a valid brain state', () => {
    const state: BrainState = {
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
    }
    expect(state.autonomyLevel).toBe(3)
    expect(state.pendingTasks).toEqual([])
    expect(state.patterns).toBeNull()
  })

  it('accepts brain state with patterns', () => {
    const state: BrainState = {
      autonomyLevel: 2,
      userActive: true,
      yieldToUser: false,
      pendingTasks: [],
      activeSessions: 1,
      maxConcurrentSessions: 3,
      contextUsagePercent: 50,
      contextRotationThreshold: 85,
      recentObservationCount: 20,
      lastConsolidationAge: 5,
      consolidationThreshold: 24,
      approvedSuggestionCount: 0,
      pendingQualityChecks: 0,
      patterns: {
        workSchedule: { peakHour: 14, activeHours: [9, 10, 11, 14, 15, 16] },
        isCurrentlyPeakHours: true,
      },
    }
    expect(state.patterns?.workSchedule?.peakHour).toBe(14)
    expect(state.patterns?.isCurrentlyPeakHours).toBe(true)
  })
})

describe('PendingTask interface', () => {
  it('accepts a valid pending task', () => {
    const task: PendingTask = {
      id: 'task-1',
      description: 'Refactor auth module',
      priority: DecisionPriority.High,
      strategy: 'parallel',
      subtaskCount: 3,
      createdAt: '2025-01-01T00:00:00Z',
    }
    expect(task.id).toBe('task-1')
    expect(task.strategy).toBe('parallel')
  })

  it('accepts a minimal pending task without optional fields', () => {
    const task: PendingTask = {
      id: 'task-2',
      description: 'Simple fix',
      priority: DecisionPriority.Normal,
      createdAt: '2025-01-01T00:00:00Z',
    }
    expect(task.strategy).toBeUndefined()
    expect(task.subtaskCount).toBeUndefined()
  })
})

describe('Decision interface', () => {
  it('accepts a valid decision', () => {
    const decision: Decision = {
      action: BrainAction.HandleSolo,
      reason: 'Simple task at autonomy level 3',
      confidence: 0.95,
      taskId: 'task-1',
      priority: DecisionPriority.High,
    }
    expect(decision.action).toBe('handle-solo')
    expect(decision.confidence).toBe(0.95)
  })

  it('accepts a decision with teamSize', () => {
    const decision: Decision = {
      action: BrainAction.SpawnTeam,
      reason: 'Parallel task needs 3 agents',
      confidence: 0.9,
      taskId: 'task-2',
      teamSize: 3,
      priority: DecisionPriority.High,
    }
    expect(decision.teamSize).toBe(3)
  })
})
