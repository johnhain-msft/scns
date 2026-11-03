// ---------------------------------------------------------------------------
// A2A Task Status & State Machine
// ---------------------------------------------------------------------------

import { InvalidStateError } from '../../shared/errors.js'

export const A2ATaskStatus = {
  Submitted: 'submitted',
  Assigned: 'assigned',
  Working: 'working',
  InputRequired: 'input-required',
  Completed: 'completed',
  Failed: 'failed',
  Canceled: 'canceled',
} as const

export type A2ATaskStatus = (typeof A2ATaskStatus)[keyof typeof A2ATaskStatus]

export interface TaskTransition {
  readonly from: A2ATaskStatus
  readonly to: A2ATaskStatus
  readonly timestamp: string
  readonly reason?: string
}

export interface A2ATask {
  readonly id: string
  readonly status: A2ATaskStatus
  readonly assignedTo: string | null
  readonly submittedBy: string
  readonly description: string
  readonly result: unknown | null
  readonly error: string | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly history: readonly TaskTransition[]
}

// ---------------------------------------------------------------------------
// Valid transitions
// ---------------------------------------------------------------------------

export const VALID_TRANSITIONS: Record<A2ATaskStatus, readonly A2ATaskStatus[]> = {
  submitted: ['assigned', 'canceled'],
  assigned: ['working', 'canceled'],
  working: ['completed', 'failed', 'input-required', 'canceled'],
  'input-required': ['working', 'canceled'],
  completed: [],
  failed: ['submitted'],
  canceled: [],
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export interface A2ATaskStateMachine {
  create(input: { id: string; submittedBy: string; description: string }): A2ATask
  transition(
    task: A2ATask,
    to: A2ATaskStatus,
    options?: {
      assignedTo?: string
      result?: unknown
      error?: string
      reason?: string
    },
  ): A2ATask
  isValidTransition(from: A2ATaskStatus, to: A2ATaskStatus): boolean
  getValidTransitions(status: A2ATaskStatus): readonly A2ATaskStatus[]
  isTerminal(status: A2ATaskStatus): boolean
}

export function createA2ATaskStateMachine(): A2ATaskStateMachine {
  return {
    create(input) {
      const now = new Date().toISOString()
      return {
        id: input.id,
        status: A2ATaskStatus.Submitted,
        assignedTo: null,
        submittedBy: input.submittedBy,
        description: input.description,
        result: null,
        error: null,
        createdAt: now,
        updatedAt: now,
        history: [],
      }
    },

    transition(task, to, options) {
      if (!this.isValidTransition(task.status, to)) {
        throw new InvalidStateError(
          `Invalid transition from "${task.status}" to "${to}" for task ${task.id}`,
        )
      }

      const now = new Date().toISOString()
      const transition: TaskTransition = {
        from: task.status,
        to,
        timestamp: now,
        ...(options?.reason ? { reason: options.reason } : {}),
      }

      return {
        ...task,
        status: to,
        updatedAt: now,
        assignedTo: options?.assignedTo ?? task.assignedTo,
        result: options?.result ?? task.result,
        error: options?.error ?? task.error,
        history: [...task.history, transition],
      }
    },

    isValidTransition(from, to) {
      const allowed = VALID_TRANSITIONS[from]
      return allowed.includes(to)
    },

    getValidTransitions(status) {
      return VALID_TRANSITIONS[status]
    },

    isTerminal(status) {
      return VALID_TRANSITIONS[status].length === 0
    },
  }
}
