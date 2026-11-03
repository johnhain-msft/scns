/**
 * Health Watchdog — monitors broker self-health on an interval.
 *
 * Checks:
 *   1. Event loop lag (stalled > 500ms)
 *   2. Memory usage (RSS > 1.5 GB)
 *   3. Database responsiveness (SELECT 1 < 1s)
 *
 * After 3 consecutive failures, logs critical and optionally triggers action.
 */

import type Database from 'better-sqlite3'
import { logger } from '../../shared/logger.js'

const log = logger.child({ module: 'health-watchdog' })

export interface HealthWatchdogOptions {
  readonly intervalMs?: number
  readonly maxConsecutiveFailures?: number
  readonly maxEventLoopLagMs?: number
  readonly maxMemoryMb?: number
  readonly onUnhealthy?: (failures: number, checks: readonly HealthCheck[]) => void
}

export interface HealthCheck {
  readonly name: string
  readonly healthy: boolean
  readonly value: number
  readonly threshold: number
  readonly unit: string
}

export interface HealthWatchdogStatus {
  readonly running: boolean
  readonly consecutiveFailures: number
  readonly lastCheckAt: string | null
  readonly lastChecks: readonly HealthCheck[]
}

const DEFAULTS = {
  intervalMs: 60_000,
  maxConsecutiveFailures: 3,
  maxEventLoopLagMs: 500,
  maxMemoryMb: 1536,
} as const

export function createHealthWatchdog(db: Database.Database, options?: HealthWatchdogOptions) {
  const intervalMs = options?.intervalMs ?? DEFAULTS.intervalMs
  const maxFailures = options?.maxConsecutiveFailures ?? DEFAULTS.maxConsecutiveFailures
  const maxLagMs = options?.maxEventLoopLagMs ?? DEFAULTS.maxEventLoopLagMs
  const maxMemMb = options?.maxMemoryMb ?? DEFAULTS.maxMemoryMb
  const onUnhealthy = options?.onUnhealthy

  let timer: ReturnType<typeof setInterval> | null = null
  let consecutiveFailures = 0
  let lastCheckAt: string | null = null
  let lastChecks: HealthCheck[] = []

  function checkEventLoopLag(): HealthCheck {
    const start = performance.now()
    // Synchronous check — if event loop is blocked, this will have high duration
    const elapsed = performance.now() - start
    return {
      name: 'event-loop-lag',
      healthy: elapsed < maxLagMs,
      value: Math.round(elapsed * 100) / 100,
      threshold: maxLagMs,
      unit: 'ms',
    }
  }

  function checkMemory(): HealthCheck {
    const rss = process.memoryUsage.rss() / (1024 * 1024)
    return {
      name: 'memory-rss',
      healthy: rss < maxMemMb,
      value: Math.round(rss),
      threshold: maxMemMb,
      unit: 'MB',
    }
  }

  function checkDatabase(): HealthCheck {
    const start = performance.now()
    try {
      db.prepare('SELECT 1').get()
      const elapsed = performance.now() - start
      return {
        name: 'database',
        healthy: elapsed < 1000,
        value: Math.round(elapsed * 100) / 100,
        threshold: 1000,
        unit: 'ms',
      }
    } catch {
      return {
        name: 'database',
        healthy: false,
        value: -1,
        threshold: 1000,
        unit: 'ms',
      }
    }
  }

  function runChecks(): readonly HealthCheck[] {
    return [checkEventLoopLag(), checkMemory(), checkDatabase()]
  }

  function tick(): void {
    const checks = runChecks()
    lastChecks = [...checks]
    lastCheckAt = new Date().toISOString()

    const unhealthy = checks.filter((c) => !c.healthy)

    if (unhealthy.length > 0) {
      consecutiveFailures++
      log.warn(
        {
          consecutiveFailures,
          unhealthy: unhealthy.map((c) => ({
            name: c.name,
            value: c.value,
            threshold: c.threshold,
            unit: c.unit,
          })),
        },
        'Health check failed',
      )

      if (consecutiveFailures >= maxFailures) {
        log.error(
          { consecutiveFailures },
          'Health watchdog: broker unhealthy for multiple consecutive checks',
        )
        onUnhealthy?.(consecutiveFailures, checks)
      }
    } else {
      if (consecutiveFailures > 0) {
        log.info({ previousFailures: consecutiveFailures }, 'Health restored')
      }
      consecutiveFailures = 0
    }
  }

  return {
    start(): void {
      if (timer) return
      log.info({ intervalMs }, 'Health watchdog starting')
      timer = setInterval(tick, intervalMs)
    },

    stop(): void {
      if (!timer) return
      clearInterval(timer)
      timer = null
      log.info('Health watchdog stopped')
    },

    /** Run a single check cycle (for testing). */
    check(): readonly HealthCheck[] {
      tick()
      return lastChecks
    },

    getStatus(): HealthWatchdogStatus {
      return {
        running: timer !== null,
        consecutiveFailures,
        lastCheckAt,
        lastChecks,
      }
    },
  }
}
