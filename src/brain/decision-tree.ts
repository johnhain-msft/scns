/**
 * Brain Agent decision tree — pure decision engine.
 * Evaluates BrainState and returns the next action to take.
 * No side effects, no I/O, no async.
 */

import {
  BrainAction,
  DecisionPriority,
  type BrainState,
  type Decision,
  type PendingTask,
} from './state-types.js'

// ── Types ────────────────────────────────────────────────────────────

export interface DecisionTreeOptions {
  readonly maxTeamSize?: number
  readonly observationMinimum?: number
}

export interface DecisionTree {
  decide(state: BrainState): Decision
  shouldYieldToUser(state: BrainState): boolean
  shouldRotateContext(state: BrainState): boolean
  hasActiveOtelSessions(state: BrainState): boolean
  shouldConsolidate(state: BrainState): boolean
  shouldObserveMore(state: BrainState): boolean
  shouldSuggest(state: BrainState): boolean
  shouldRunQualityCheck(state: BrainState): boolean
  selectTaskAction(state: BrainState, task: PendingTask): Decision
}

// ── Priority ordering ────────────────────────────────────────────────

const PRIORITY_RANK: Record<string, number> = {
  [DecisionPriority.Critical]: 4,
  [DecisionPriority.High]: 3,
  [DecisionPriority.Normal]: 2,
  [DecisionPriority.Low]: 1,
}

function comparePriority(a: DecisionPriority, b: DecisionPriority): number {
  return (PRIORITY_RANK[b] ?? 0) - (PRIORITY_RANK[a] ?? 0)
}

// ── Complexity check ─────────────────────────────────────────────────

/** L2 (Assistant) can handle solo/sequential tasks with ≤ 5 subtasks */
function isComplexTask(task: PendingTask): boolean {
  if (task.strategy === 'parallel' || task.strategy === 'hybrid') {
    return (task.subtaskCount ?? 1) > 5
  }
  return false
}

// ── Factory ──────────────────────────────────────────────────────────

export function createDecisionTree(options?: DecisionTreeOptions): DecisionTree {
  const maxTeamSize = options?.maxTeamSize ?? 5
  const observationMinimum = options?.observationMinimum ?? 3

  function shouldYieldToUser(state: BrainState): boolean {
    return state.userActive && state.yieldToUser
  }

  function shouldRotateContext(state: BrainState): boolean {
    return state.contextUsagePercent >= state.contextRotationThreshold
  }

  function hasActiveOtelSessions(state: BrainState): boolean {
    return (state.otelMetrics?.activeOtelSessions ?? 0) > 0
  }

  function shouldConsolidate(state: BrainState): boolean {
    if (state.lastConsolidationAge < state.consolidationThreshold) return false
    // Staleness alone is not sufficient: the dream executor applies its own
    // run gates and skips when they fail. A closed gate must fall through to
    // the later branches (task processing) instead of re-deciding Consolidate
    // every wake against an executor that cannot run.
    if (state.consolidationGateOpen === false) return false
    const hasHighPriorityTasks = state.pendingTasks.some(
      (t) => t.priority === DecisionPriority.High || t.priority === DecisionPriority.Critical,
    )
    return !hasHighPriorityTasks
  }

  function shouldObserveMore(state: BrainState): boolean {
    return state.recentObservationCount < observationMinimum && state.pendingTasks.length === 0
  }

  /** L1 (Advisor) with enough observations should actively suggest. */
  function shouldSuggest(state: BrainState): boolean {
    return state.autonomyLevel === 1 && state.recentObservationCount >= observationMinimum
  }

  /** L2+ with completed sessions that haven't been quality-checked. */
  function shouldRunQualityCheck(state: BrainState): boolean {
    return state.autonomyLevel >= 2 && state.pendingQualityChecks > 0
  }

  function selectTaskAction(state: BrainState, task: PendingTask): Decision {
    // Autonomy gate: L0/L1 cannot execute tasks
    if (state.autonomyLevel <= 1) {
      return {
        action: BrainAction.Idle,
        reason:
          state.autonomyLevel === 0
            ? 'Observer mode: cannot execute tasks'
            : 'Advisor mode: recommend only, cannot execute',
        confidence: 1.0,
        taskId: task.id,
        priority: DecisionPriority.Low,
      }
    }

    // L2 cannot handle complex tasks
    if (state.autonomyLevel === 2 && isComplexTask(task)) {
      return {
        action: BrainAction.Idle,
        reason: 'Assistant mode: task too complex for L2 autonomy',
        confidence: 0.9,
        taskId: task.id,
        priority: DecisionPriority.Low,
      }
    }

    // No available session slots
    const availableSlots = state.maxConcurrentSessions - state.activeSessions
    if (availableSlots <= 0) {
      return {
        action: BrainAction.Idle,
        reason: 'No available session slots',
        confidence: 1.0,
        taskId: task.id,
        priority: DecisionPriority.Low,
      }
    }

    const confidence = state.autonomyLevel === 3 ? 0.95 : 0.85
    const strategy = task.strategy ?? undefined
    const subtaskCount = task.subtaskCount ?? 1

    // Strategy-based routing
    switch (strategy) {
      case 'parallel': {
        const teamSize = Math.min(subtaskCount, maxTeamSize, availableSlots)
        return {
          action: BrainAction.SpawnTeam,
          reason: `Parallel task: spawning team of ${teamSize}`,
          confidence,
          taskId: task.id,
          teamSize,
          priority: task.priority,
        }
      }

      case 'sequential':
        return {
          action: BrainAction.HandleSolo,
          reason: 'Sequential task: brain handles sequencing',
          confidence,
          taskId: task.id,
          priority: task.priority,
        }

      case 'hybrid': {
        const teamSize = Math.min(subtaskCount, maxTeamSize, availableSlots)
        return {
          action: BrainAction.SpawnTeam,
          reason: 'Hybrid task: team for parallel phase, solo for connectors',
          confidence,
          taskId: task.id,
          teamSize,
          priority: task.priority,
        }
      }

      case 'solo':
        if (subtaskCount <= 1) {
          return {
            action: BrainAction.HandleSolo,
            reason: 'Solo task: handling directly',
            confidence,
            taskId: task.id,
            priority: task.priority,
          }
        }
        return {
          action: BrainAction.SpawnSolo,
          reason: 'Solo strategy with subtasks: spawning single agent',
          confidence,
          taskId: task.id,
          priority: task.priority,
        }

      default:
        // No strategy specified
        if (subtaskCount <= 1) {
          return {
            action: BrainAction.HandleSolo,
            reason: 'Simple task: handling directly',
            confidence,
            taskId: task.id,
            priority: task.priority,
          }
        }
        return {
          action: BrainAction.SpawnSolo,
          reason: 'Task with subtasks: spawning single agent',
          confidence,
          taskId: task.id,
          priority: task.priority,
        }
    }
  }

  function pickHighestPriorityTask(tasks: readonly PendingTask[]): PendingTask {
    const sorted = [...tasks].sort((a, b) => comparePriority(a.priority, b.priority))
    return sorted[0]!
  }

  function decide(state: BrainState): Decision {
    // 1. Yield to user (Critical)
    if (shouldYieldToUser(state)) {
      return {
        action: BrainAction.YieldToUser,
        reason: 'User is active, yielding control',
        confidence: 1.0,
        priority: DecisionPriority.Critical,
      }
    }

    // 2. Context rotation (Critical)
    if (shouldRotateContext(state)) {
      return {
        action: BrainAction.RotateContext,
        reason: `Context usage at ${state.contextUsagePercent}%, rotating`,
        confidence: 1.0,
        priority: DecisionPriority.Critical,
      }
    }

    // 2.5. OTel active sessions — yield to user's interactive Copilot sessions
    if (hasActiveOtelSessions(state) && state.yieldToUser) {
      return {
        action: BrainAction.Observe,
        reason: `Active Copilot sessions detected via OTel (${state.otelMetrics!.activeOtelSessions}), deferring heavy work`,
        confidence: 0.9,
        priority: DecisionPriority.High,
      }
    }

    // 3. Memory consolidation (Low, but checked before tasks with a gate)
    if (shouldConsolidate(state)) {
      return {
        action: BrainAction.Consolidate,
        reason: `${state.lastConsolidationAge}h since last consolidation`,
        confidence: 0.9,
        priority: DecisionPriority.Low,
      }
    }

    // 3.5. Execute approved suggestions (L2+ only)
    if (state.approvedSuggestionCount > 0 && state.autonomyLevel >= 2) {
      return {
        action: BrainAction.ApprovedSuggestions,
        reason: `${state.approvedSuggestionCount} approved suggestion(s) ready for execution`,
        confidence: 0.9,
        priority: DecisionPriority.Normal,
      }
    }

    // 3.6. Quality check completed sessions (L2+ only)
    if (shouldRunQualityCheck(state)) {
      return {
        action: BrainAction.QualityCheck,
        reason: `${state.pendingQualityChecks} completed session(s) need quality check`,
        confidence: 0.85,
        priority: DecisionPriority.Normal,
      }
    }

    // 4. Need more observations (only if no tasks pending)
    if (shouldObserveMore(state)) {
      return {
        action: BrainAction.Observe,
        reason: `Only ${state.recentObservationCount} recent observations, need ${observationMinimum}`,
        confidence: 0.7,
        priority: DecisionPriority.Normal,
      }
    }

    // 4.5. L1 advisory mode — suggest from observations
    if (shouldSuggest(state)) {
      return {
        action: BrainAction.Suggest,
        reason: `Advisory mode: ${state.recentObservationCount} observations collected, generating suggestions`,
        confidence: 0.8,
        priority: DecisionPriority.Normal,
      }
    }

    // 5. Process pending tasks
    if (state.pendingTasks.length > 0) {
      const task = pickHighestPriorityTask(state.pendingTasks)
      return selectTaskAction(state, task)
    }

    // 6. Idle — nothing to do
    return {
      action: BrainAction.Idle,
      reason: 'Nothing to do',
      confidence: 1.0,
      priority: DecisionPriority.Low,
    }
  }

  return {
    decide,
    shouldYieldToUser,
    shouldRotateContext,
    hasActiveOtelSessions,
    shouldConsolidate,
    shouldObserveMore,
    shouldSuggest,
    shouldRunQualityCheck,
    selectTaskAction,
  }
}
