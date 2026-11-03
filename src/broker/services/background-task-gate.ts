import type Database from 'better-sqlite3'
import type { GateCheckResult, TaskGateConfig } from '../types.js'
import {
  getBackgroundTask,
  upsertBackgroundTask,
  acquireLock,
  releaseLock,
  recordRun,
  isTimePassed,
  breakStaleLock,
} from '../storage/repositories/background-task-repository.js'
import { logger } from '../../shared/logger.js'

const DEFAULT_STALE_LOCK_MULTIPLIER = 5

const KNOWN_TASKS: ReadonlyArray<{ readonly name: string; readonly intervalMs: number }> = [
  { name: 'team-gc', intervalMs: 300_000 },
  { name: 'session-gc', intervalMs: 300_000 },
  { name: 'message-compaction', intervalMs: 600_000 },
  { name: 'embedding-reindex', intervalMs: 900_000 },
]

export function checkGates(db: Database.Database, config: TaskGateConfig): GateCheckResult {
  const task = getBackgroundTask(db, config.taskName)

  if (!task) {
    return { canRun: false, failedGate: 'disabled' }
  }

  if (!task.enabled) {
    return { canRun: false, failedGate: 'disabled' }
  }

  // Gate 1 (cheapest): Lock gate
  if (task.lock_holder !== null) {
    const staleLockMs = config.staleLockMs ?? config.intervalMs * DEFAULT_STALE_LOCK_MULTIPLIER
    const broken = breakStaleLock(db, config.taskName, staleLockMs)
    if (!broken) {
      return { canRun: false, failedGate: 'lock' }
    }
    logger.info({ taskName: config.taskName }, 'Broke stale lock on background task')
  }

  // Gate 2 (cheap): Time gate
  if (!isTimePassed(db, config.taskName)) {
    return { canRun: false, failedGate: 'time' }
  }

  // Gate 3 (may require query): Count gate
  if (config.countCheck && !config.countCheck()) {
    return { canRun: false, failedGate: 'count' }
  }

  return { canRun: true }
}

export function withTaskGate<T>(
  db: Database.Database,
  config: TaskGateConfig,
  fn: () => T,
): T | null {
  const gateResult = checkGates(db, config)

  if (!gateResult.canRun) {
    return null
  }

  const lockHolder = config.lockHolder ?? `poller-${process.pid}`
  const locked = acquireLock(db, config.taskName, lockHolder)

  if (!locked) {
    return null
  }

  try {
    const result = fn()
    recordRun(db, config.taskName)
    return result
  } finally {
    releaseLock(db, config.taskName, lockHolder)
  }
}

export function initializeTaskGates(db: Database.Database): void {
  for (const task of KNOWN_TASKS) {
    upsertBackgroundTask(db, task.name, task.intervalMs)
  }
  logger.debug({ tasks: KNOWN_TASKS.map((t) => t.name) }, 'Initialized background task gates')
}
