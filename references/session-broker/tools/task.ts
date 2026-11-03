import type Database from 'better-sqlite3'
import type { EventLog } from '../services/event-log.js'
import { findTeamById } from '../storage/repositories/team-repository.js'
import {
  createTask,
  findTaskWithDeps,
  findTasksByTeam,
  updateTask,
  addDependency,
} from '../storage/repositories/task-repository.js'
import { type ToolResult, textResult, errorResult } from './helpers.js'

interface CreateTaskInput {
  readonly team_id: string
  readonly subject: string
  readonly description?: string | null
  readonly active_form?: string | null
}

export function handleCreateTask(
  db: Database.Database,
  eventLog: EventLog,
  input: CreateTaskInput,
): ToolResult {
  const team = findTeamById(db, input.team_id)
  if (!team) {
    return errorResult(`Team '${input.team_id}' not found`)
  }

  try {
    const task = createTask(db, {
      team_id: input.team_id,
      subject: input.subject,
      description: input.description ?? null,
      active_form: input.active_form ?? null,
    })
    eventLog.taskCreated(null, {
      task_id: task.id,
      team_id: input.team_id,
      subject: input.subject,
    })
    return textResult(task)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResult(`Failed to create task: ${message}`)
  }
}

interface GetTaskInput {
  readonly task_id: number
}

export function handleGetTask(
  db: Database.Database,
  input: GetTaskInput,
): ToolResult {
  const task = findTaskWithDeps(db, input.task_id)
  if (!task) {
    return errorResult(`Task ${input.task_id} not found`)
  }
  return textResult(task)
}

interface ListTasksInput {
  readonly team_id: string
  readonly status?: string
}

export function handleListTasks(
  db: Database.Database,
  input: ListTasksInput,
): ToolResult {
  const tasks = findTasksByTeam(db, input.team_id, input.status)
  return textResult(tasks)
}

interface UpdateTaskInput {
  readonly task_id: number
  readonly status?: string
  readonly owner?: string | null
  readonly subject?: string
  readonly description?: string | null
  readonly active_form?: string | null
  readonly add_blocks?: ReadonlyArray<number>
  readonly add_blocked_by?: ReadonlyArray<number>
}

export function handleUpdateTask(
  db: Database.Database,
  eventLog: EventLog,
  input: UpdateTaskInput,
): ToolResult {
  const existing = findTaskWithDeps(db, input.task_id)
  if (!existing) {
    return errorResult(`Task ${input.task_id} not found`)
  }

  const task = updateTask(db, input.task_id, {
    status: input.status,
    owner: input.owner,
    subject: input.subject,
    description: input.description,
    active_form: input.active_form,
  })

  if (!task) {
    return errorResult(`Failed to update task ${input.task_id}`)
  }

  // Handle add_blocks: these tasks depend on the current task
  if (input.add_blocks) {
    for (const blockedTaskId of input.add_blocks) {
      addDependency(db, blockedTaskId, input.task_id)
    }
  }

  // Handle add_blocked_by: the current task depends on these tasks
  if (input.add_blocked_by) {
    for (const blockingTaskId of input.add_blocked_by) {
      addDependency(db, input.task_id, blockingTaskId)
    }
  }

  const eventType = input.status === 'completed' ? 'taskCompleted' : 'taskUpdated'
  const eventFn = eventType === 'taskCompleted'
    ? eventLog.taskCompleted
    : eventLog.taskUpdated

  eventFn(null, {
    task_id: input.task_id,
    changes: {
      ...(input.status !== undefined && { status: input.status }),
      ...(input.owner !== undefined && { owner: input.owner }),
      ...(input.subject !== undefined && { subject: input.subject }),
      ...(input.add_blocks && { added_blocks: input.add_blocks }),
      ...(input.add_blocked_by && { added_blocked_by: input.add_blocked_by }),
    },
  })

  // Return the task with updated deps
  const updated = findTaskWithDeps(db, input.task_id)
  return textResult(updated)
}
