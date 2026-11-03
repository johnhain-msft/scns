/**
 * Priority task queue for the Brain Agent.
 * Ordered by priority (Critical > High > Normal > Low), FIFO within same priority.
 */

import { DecisionPriority, type PendingTask } from './state-types.js'

// ── Types ────────────────────────────────────────────────────────────

export interface TaskQueueOptions {
  readonly maxSize?: number
}

// ── Priority ranking ─────────────────────────────────────────────────

const PRIORITY_RANK: Record<string, number> = {
  [DecisionPriority.Critical]: 4,
  [DecisionPriority.High]: 3,
  [DecisionPriority.Normal]: 2,
  [DecisionPriority.Low]: 1,
}

function compareTasks(a: PendingTask, b: PendingTask): number {
  const rankDiff = (PRIORITY_RANK[b.priority] ?? 0) - (PRIORITY_RANK[a.priority] ?? 0)
  if (rankDiff !== 0) return rankDiff
  return a.createdAt.localeCompare(b.createdAt)
}

// ── Factory ──────────────────────────────────────────────────────────

export function createTaskQueue(options?: TaskQueueOptions) {
  const maxSize = options?.maxSize ?? 100
  const tasks: PendingTask[] = []

  function sortedIndex(task: PendingTask): number {
    let lo = 0
    let hi = tasks.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (compareTasks(tasks[mid]!, task) <= 0) {
        lo = mid + 1
      } else {
        hi = mid
      }
    }
    return lo
  }

  return {
    enqueue(task: PendingTask): boolean {
      if (tasks.length >= maxSize) return false
      const idx = sortedIndex(task)
      tasks.splice(idx, 0, task)
      return true
    },

    dequeue(): PendingTask | null {
      if (tasks.length === 0) return null
      return tasks.shift()!
    },

    peek(): PendingTask | null {
      return tasks[0] ?? null
    },

    remove(taskId: string): boolean {
      const idx = tasks.findIndex((t) => t.id === taskId)
      if (idx === -1) return false
      tasks.splice(idx, 1)
      return true
    },

    getAll(): readonly PendingTask[] {
      return [...tasks]
    },

    size(): number {
      return tasks.length
    },

    isEmpty(): boolean {
      return tasks.length === 0
    },

    clear(): void {
      tasks.length = 0
    },
  }
}
