/**
 * Task Scheduler — evaluates scheduled_tasks on an interval and runs due tasks.
 *
 * Uses a simple cron-like evaluation: compares cron_expression fields
 * against the current time. Supports standard 5-field cron (min hour dom month dow)
 * and 6-field cron with seconds.
 *
 * Missed-fire catch-up: each task's missed-window is anchored on its
 * PERSISTED last_run_at (bounded within a process lifetime by the in-memory
 * tick cursor), so fires missed while the process was DOWN — machine off,
 * daily restart, deploy — are caught up on the first tick after start, and
 * fires missed while the process SLEPT are caught up on wake. Capped at
 * MAX_CATCHUP_PER_TICK per tick; one catch-up run per task, not one per
 * missed occurrence. A task that has never run has no baseline to be
 * "missed" from and simply waits for its next natural fire.
 *
 * Uses chained setTimeout (not setInterval) to prevent overlapping ticks.
 *
 * Updates last_run_at, next_run_at, and records in task_run_history.
 */

import type Database from 'better-sqlite3'
import { logger } from '../../shared/logger.js'
import { recordTaskRun, type ScheduledTask } from '../storage/repositories/scheduler-repository.js'

const log = logger.child({ module: 'task-scheduler' })

/**
 * R3 (honest scheduler history): a handler whose own gate declined the run
 * reports it instead of letting the scheduler record `success`. Returning
 * void keeps the legacy success semantics.
 */
export interface TaskHandlerOutcome {
  readonly status?: 'success' | 'skipped' | 'failure'
  /** Recorded in task_run_history.error_message (e.g. the failed gate name). */
  readonly detail?: string
}

export interface TaskHandler {
  (task: ScheduledTask): Promise<TaskHandlerOutcome | void>
}

export interface TaskSchedulerOptions {
  readonly intervalMs?: number
  readonly maxCatchUpPerTick?: number
}

const DEFAULT_INTERVAL_MS = 60_000
const DEFAULT_MAX_CATCHUP = 3

// ── Cron parsing ─────────────────────────────────────────────

/** Check if a cron field matches a value. Supports: wildcard, exact N, step N. */
function fieldMatches(field: string, value: number): boolean {
  if (field === '*') return true

  // */N — every N
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10)
    if (Number.isNaN(step) || step <= 0) return false
    return value % step === 0
  }

  // Comma-separated values
  if (field.includes(',')) {
    return field.split(',').some((v) => parseInt(v.trim(), 10) === value)
  }

  // Range: N-M
  if (field.includes('-')) {
    const [min, max] = field.split('-').map((v) => parseInt(v.trim(), 10))
    if (min === undefined || max === undefined || Number.isNaN(min) || Number.isNaN(max))
      return false
    return value >= min && value <= max
  }

  // Exact match
  const exact = parseInt(field, 10)
  return !Number.isNaN(exact) && exact === value
}

/** Check if a cron expression matches the current time. */
export function cronMatches(expression: string, now: Date): boolean {
  const parts = expression.trim().split(/\s+/)

  if (parts.length === 6) {
    // 6-field: sec min hour dom month dow
    const [sec, min, hour, dom, month, dow] = parts as [
      string,
      string,
      string,
      string,
      string,
      string,
    ]
    return (
      fieldMatches(sec, now.getSeconds()) &&
      fieldMatches(min, now.getMinutes()) &&
      fieldMatches(hour, now.getHours()) &&
      fieldMatches(dom, now.getDate()) &&
      fieldMatches(month, now.getMonth() + 1) &&
      fieldMatches(dow, now.getDay())
    )
  }

  if (parts.length === 5) {
    // 5-field: min hour dom month dow
    const [min, hour, dom, month, dow] = parts as [string, string, string, string, string]
    return (
      fieldMatches(min, now.getMinutes()) &&
      fieldMatches(hour, now.getHours()) &&
      fieldMatches(dom, now.getDate()) &&
      fieldMatches(month, now.getMonth() + 1) &&
      fieldMatches(dow, now.getDay())
    )
  }

  return false
}

/**
 * Check if a cron expression had at least one fire time in the window (from, to].
 * Steps through the window minute-by-minute (or second-by-second for 6-field cron)
 * to check for matches. Caps iteration to prevent infinite loops on very long windows.
 */
export function cronHadFireTimeInWindow(expression: string, from: Date, to: Date): boolean {
  const parts = expression.trim().split(/\s+/)
  const hasSeconds = parts.length === 6

  // Step size: 1 second for 6-field, 60 seconds for 5-field
  const stepMs = hasSeconds ? 1_000 : 60_000

  // Cap at 50,000 iterations to avoid infinite loops
  const maxIterations = 50_000
  let iterations = 0

  // Start scanning from the first step after `from`
  let cursor = new Date(from.getTime() + stepMs)
  // Align to boundary: zero out sub-step components
  if (!hasSeconds) {
    cursor.setSeconds(0, 0)
  } else {
    cursor.setMilliseconds(0)
  }

  while (cursor.getTime() <= to.getTime() && iterations < maxIterations) {
    if (cronMatches(expression, cursor)) {
      return true
    }
    cursor = new Date(cursor.getTime() + stepMs)
    iterations++
  }

  return false
}

// ── Scheduler ────────────────────────────────────────────────

export function createTaskScheduler(
  db: Database.Database,
  handlers: ReadonlyMap<string, TaskHandler>,
  options?: TaskSchedulerOptions,
) {
  const intervalMs = options?.intervalMs ?? DEFAULT_INTERVAL_MS
  const maxCatchUpPerTick = options?.maxCatchUpPerTick ?? DEFAULT_MAX_CATCHUP
  let timer: ReturnType<typeof setTimeout> | null = null
  let running = false
  let lastTickTime = 0
  let tickInProgress = false

  // Mutable handler map — allows late registration
  const mutableHandlers = new Map(handlers)

  function getDueTasks(): ScheduledTask[] {
    const rows = db
      .prepare(
        `SELECT * FROM scheduled_tasks
         WHERE enabled = 1
           AND category = 'cron'
           AND cron_expression IS NOT NULL`,
      )
      .all() as Array<{
      id: string
      name: string
      description: string | null
      category: 'cron' | 'on-demand'
      cron_expression: string | null
      enabled: number
      last_run_at: string | null
      next_run_at: string | null
      run_count: number
      last_status: 'success' | 'failure' | 'skipped' | null
      config_json: string
      created_at: string
      updated_at: string
    }>

    const now = new Date()
    return rows
      .filter((row) => row.cron_expression && cronMatches(row.cron_expression, now))
      .map((row) => ({
        ...row,
        enabled: row.enabled === 1,
      }))
  }

  function getMissedTasks(): ScheduledTask[] {
    const rows = db
      .prepare(
        `SELECT * FROM scheduled_tasks
         WHERE enabled = 1
           AND category = 'cron'
           AND cron_expression IS NOT NULL`,
      )
      .all() as Array<{
      id: string
      name: string
      description: string | null
      category: 'cron' | 'on-demand'
      cron_expression: string | null
      enabled: number
      last_run_at: string | null
      next_run_at: string | null
      run_count: number
      last_status: 'success' | 'failure' | 'skipped' | null
      config_json: string
      created_at: string
      updated_at: string
    }>

    const to = new Date()

    return (
      rows
        .filter((row) => {
          if (!row.cron_expression) return false
          if (!mutableHandlers.has(row.id)) return false
          // Anchor the missed-window on the task's PERSISTED last run, not
          // only the in-memory tick cursor: lastTickTime restarts at 0 with
          // every process start, which made any fire missed while the process
          // was DOWN invisible — the weekly review silently lost its week
          // whenever the Mac was off at Monday 09:00. A task that never ran
          // has no baseline to be "missed" from (and exempting it avoids a
          // first-boot thundering herd on fresh installs); it waits for its
          // next natural fire instead.
          if (!row.last_run_at) return false
          const lastRun = new Date(
            row.last_run_at + (row.last_run_at.endsWith('Z') ? '' : 'Z'),
          ).getTime()
          // Within one process lifetime the tick cursor still bounds the
          // window: a task whose fire predates this wake's gap was already
          // considered by earlier ticks, so only the gap itself counts. The
          // max() also skips tasks that already ran during a previous partial
          // catch-up (their lastRun sits past the cursor, closing the window).
          const from = new Date(Math.max(lastRun, lastTickTime))
          if (from.getTime() >= to.getTime()) return false
          return cronHadFireTimeInWindow(row.cron_expression, from, to)
        })
        .map((row) => ({
          ...row,
          enabled: row.enabled === 1,
        }))
        // Sort by last_run_at ascending (oldest first, nulls first)
        .sort((a, b) => {
          if (!a.last_run_at && !b.last_run_at) return 0
          if (!a.last_run_at) return -1
          if (!b.last_run_at) return 1
          return a.last_run_at.localeCompare(b.last_run_at)
        })
    )
  }

  async function runTask(task: ScheduledTask, catchUp = false): Promise<void> {
    const handler = mutableHandlers.get(task.id)
    if (!handler) {
      log.debug({ taskId: task.id }, 'No handler registered for task — skipping')
      return
    }

    const startedAt = new Date().toISOString()
    const start = performance.now()

    try {
      const outcome = await handler(task)
      const durationMs = performance.now() - start
      const status = outcome?.status ?? 'success'

      recordTaskRun(
        db,
        task.id,
        status,
        startedAt,
        new Date().toISOString(),
        Math.round(durationMs),
        outcome?.detail,
      )

      log.info(
        {
          taskId: task.id,
          durationMs: Math.round(durationMs),
          status,
          ...(outcome?.detail ? { detail: outcome.detail } : {}),
          catchUp,
        },
        'Task completed',
      )
    } catch (err) {
      const durationMs = performance.now() - start
      const errorMessage = err instanceof Error ? err.message : String(err)

      recordTaskRun(
        db,
        task.id,
        'failure',
        startedAt,
        new Date().toISOString(),
        Math.round(durationMs),
        errorMessage,
      )

      log.error({ taskId: task.id, err: errorMessage, catchUp }, 'Task failed')
    }
  }

  async function tick(): Promise<void> {
    if (tickInProgress) {
      log.debug('Tick skipped — previous tick still in progress')
      return
    }
    tickInProgress = true

    try {
      const now = Date.now()
      const caughtUpIds = new Set<string>()
      let allCaughtUp = true

      // Catch-up runs on a detected sleep gap AND on process cold start
      // (lastTickTime === 0). The gap-only spelling skipped cold starts
      // entirely, so a cron fire missed while the process was down (machine
      // off, daily restart, deploy) was never caught up; getMissedTasks
      // anchors each task's window on its persisted last_run_at, which is
      // what survives the restart.
      const coldStart = lastTickTime === 0
      const sleepGap = lastTickTime > 0 && now - lastTickTime > 2 * intervalMs
      if (coldStart || sleepGap) {
        if (sleepGap) {
          const gapMs = now - lastTickTime
          log.info({ gapMs, intervalMs }, 'Sleep gap detected — running catch-up')
        } else {
          log.info({ intervalMs }, 'Cold start — checking for cron fires missed while down')
        }

        const missedTasks = getMissedTasks()
        const catchUpBatch = missedTasks.slice(0, maxCatchUpPerTick)
        allCaughtUp = missedTasks.length <= maxCatchUpPerTick

        for (const task of catchUpBatch) {
          await runTask(task, true)
          caughtUpIds.add(task.id)
        }

        if (!allCaughtUp) {
          log.warn(
            { total: missedTasks.length, ran: catchUpBatch.length },
            'More missed tasks than catch-up cap — remaining will run on subsequent ticks',
          )
        }
      }

      // Normal tick: run currently-due tasks (skip already caught-up ones)
      const dueTasks = getDueTasks()
      for (const task of dueTasks) {
        if (!caughtUpIds.has(task.id)) {
          await runTask(task)
        }
      }

      // Only advance lastTickTime if all catch-up work is done;
      // otherwise keep the old value so next tick re-detects the gap
      if (allCaughtUp) {
        lastTickTime = now
      }
    } catch (err) {
      log.error({ err }, 'Scheduler tick failed')
    } finally {
      tickInProgress = false
    }
  }

  function scheduleNext(): void {
    if (!running) return
    timer = setTimeout(() => {
      tick()
        .catch((err) => log.error({ err }, 'Scheduler tick error'))
        .finally(() => {
          if (running) scheduleNext()
        })
    }, intervalMs)
  }

  return {
    start(): void {
      if (running) return
      running = true
      lastTickTime = Date.now()
      log.info({ intervalMs }, 'Task scheduler starting')
      // Immediate first tick, then chain
      tick()
        .catch((err) => log.error({ err }, 'Scheduler initial tick error'))
        .finally(() => {
          if (running) scheduleNext()
        })
    },

    stop(): void {
      if (!running) return
      running = false
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      log.info('Task scheduler stopped')
    },

    /** Run a single tick (for testing). */
    tick,

    /**
     * WI-6 — execute ONE task's real handler immediately (the dashboard's
     * "run now"). Before this existed the run-now route only RECORDED a
     * success row without executing anything.
     */
    async runNow(taskId: string): Promise<'ran' | 'no-task' | 'no-handler'> {
      const row = db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(taskId) as
        | (Omit<ScheduledTask, 'enabled'> & { enabled: number })
        | undefined
      if (!row) return 'no-task'
      if (!mutableHandlers.has(taskId)) return 'no-handler'
      await runTask({ ...row, enabled: row.enabled === 1 })
      return 'ran'
    },

    /** Register a handler for a task ID (allows late registration). */
    registerHandler(taskId: string, handler: TaskHandler): void {
      mutableHandlers.set(taskId, handler)
    },

    isRunning(): boolean {
      return running
    },

    /** Set lastTickTime (for testing sleep catch-up). */
    setLastTickTime(time: number): void {
      lastTickTime = time
    },
  }
}
