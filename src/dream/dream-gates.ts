import type Database from 'better-sqlite3'
import {
  getDreamState,
  acquireDreamLock,
  releaseDreamLock,
  breakStaleDreamLock,
} from './dream-state.js'
import { logger } from '../shared/logger.js'

export interface DreamGateConfig {
  readonly minTimeSinceLastRunMs: number // default 24h = 86_400_000
  readonly minSessionsSinceLastRun: number // default 5
  readonly staleLockMs: number // default 5 * minTimeSinceLastRunMs
}

export interface DreamGateResult {
  readonly canRun: boolean
  readonly failedGate?: 'time' | 'count' | 'lock' | 'uninitialized'
}

export const DEFAULT_DREAM_GATE_CONFIG: DreamGateConfig = {
  minTimeSinceLastRunMs: 86_400_000,
  minSessionsSinceLastRun: 5,
  staleLockMs: 5 * 86_400_000,
}

export function checkDreamGates(
  db: Database.Database,
  config: DreamGateConfig = DEFAULT_DREAM_GATE_CONFIG,
): DreamGateResult {
  const state = getDreamState(db)

  if (!state) {
    return { canRun: false, failedGate: 'uninitialized' }
  }

  // Gate 1 (cheapest): Lock gate
  if (state.lock_holder !== null) {
    const broken = breakStaleDreamLock(db, config.staleLockMs)
    if (!broken) {
      return { canRun: false, failedGate: 'lock' }
    }
    logger.info('Broke stale dream consolidation lock')
  }

  // Gate 2: Time gate
  if (state.last_run_at !== null) {
    const timePassed = db
      .prepare(
        `SELECT CASE
         WHEN (julianday('now') - julianday(@lastRunAt)) * 86400000 >= @minMs THEN 1
         ELSE 0
       END AS passed`,
      )
      .get({ lastRunAt: state.last_run_at, minMs: config.minTimeSinceLastRunMs }) as {
      passed: number
    }

    if (timePassed.passed !== 1) {
      return { canRun: false, failedGate: 'time' }
    }
  }

  // Gate 3: Count gate
  if (state.sessions_since_last_run < config.minSessionsSinceLastRun) {
    return { canRun: false, failedGate: 'count' }
  }

  return { canRun: true }
}

/**
 * @public
 * Convenience wrapper: checks gates, acquires lock, runs `fn`, releases lock.
 * Part of the public API for consumers that need dream-gated execution
 * without managing lock lifecycle manually.
 */
export function withDreamGate<T>(
  db: Database.Database,
  config: DreamGateConfig,
  fn: () => T,
): T | null {
  const gateResult = checkDreamGates(db, config)

  if (!gateResult.canRun) {
    return null
  }

  const lockHolder = `dream-${process.pid}`
  const locked = acquireDreamLock(db, lockHolder)

  if (!locked) {
    return null
  }

  try {
    const result = fn()
    // Note: caller is responsible for recording real metrics via recordDreamRun
    return result
  } finally {
    releaseDreamLock(db, lockHolder)
  }
}
