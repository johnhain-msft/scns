/**
 * Restart Manager — orchestrates broker pre-restart preparation and drain mode.
 *
 * Used by admin routes to coordinate daily blue/green restarts:
 * 1. prepareForRestart() — runs dream consolidation + housekeeping (no VACUUM)
 * 2. enterDrainMode() — signals middleware to reject new work (503)
 * 3. getHealth() — reports status including drain state and dep availability
 */

import { logger } from '../shared/logger.js'
import type { HousekeepingConfig, HousekeepingResult } from '../dream/housekeeping.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RestartManagerDeps {
  readonly dreamDaemon?: {
    triggerRun(force: boolean): Promise<unknown>
  }
  readonly runHousekeeping?: (config: Partial<HousekeepingConfig>) => HousekeepingResult
  /** Returns the current in-flight request count (excluding health/admin). */
  readonly getActiveRequestCount?: () => number
  /** Invoked when POST /api/admin/rollback is called. May be async. */
  readonly onRollback?: (reason?: string) => Promise<void> | void
}

export interface PrepareResult {
  readonly success: boolean
  readonly dreamResult: unknown | null
  readonly housekeepingResult: HousekeepingResult | null
  readonly durationMs: number
  readonly error?: string
}

export interface HealthStatus {
  readonly status: 'ok' | 'draining'
  readonly draining: boolean
  readonly uptimeSeconds: number
  readonly startedAt: string
  readonly hasDreamDaemon: boolean
  readonly hasHousekeeping: boolean
  readonly activeRequestCount: number
}

export interface RollbackResult {
  readonly success: boolean
  readonly triggered: boolean
  readonly error?: string
}

export interface RestartManager {
  prepareForRestart(): Promise<PrepareResult>
  enterDrainMode(): void
  isDraining(): boolean
  getHealth(): HealthStatus
  requestRollback(reason?: string): Promise<RollbackResult>
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const log = logger.child({ module: 'restart-manager' })

export function createRestartManager(deps: RestartManagerDeps): RestartManager {
  let draining = false
  const startedAt = new Date()

  return {
    async prepareForRestart(): Promise<PrepareResult> {
      const start = Date.now()
      let dreamResult: unknown | null = null
      let housekeepingResult: HousekeepingResult | null = null
      let error: string | undefined

      // Phase 1: Dream consolidation
      if (deps.dreamDaemon) {
        try {
          log.info('Prepare-restart: triggering dream consolidation')
          dreamResult = await deps.dreamDaemon.triggerRun(true)
          log.info({ dreamResult }, 'Prepare-restart: dream consolidation complete')
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          log.error({ err: msg }, 'Prepare-restart: dream consolidation failed')
          error = msg
        }
      } else {
        log.info('Prepare-restart: no dream daemon available, skipping')
      }

      // Phase 2: Housekeeping (lightweight — no VACUUM on live broker)
      if (deps.runHousekeeping) {
        try {
          log.info('Prepare-restart: running housekeeping (no VACUUM)')
          housekeepingResult = deps.runHousekeeping({ vacuum: false })
          log.info({ housekeepingResult }, 'Prepare-restart: housekeeping complete')
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          log.warn({ err: msg }, 'Prepare-restart: housekeeping failed')
          // Don't fail the whole prepare for housekeeping failure
        }
      }

      const durationMs = Date.now() - start

      return {
        success: !error,
        dreamResult,
        housekeepingResult,
        durationMs,
        ...(error ? { error } : {}),
      }
    },

    enterDrainMode(): void {
      if (!draining) {
        draining = true
        log.info('Entering drain mode — new requests will receive 503')
      }
    },

    isDraining(): boolean {
      return draining
    },

    getHealth(): HealthStatus {
      const uptimeSeconds = Math.floor((Date.now() - startedAt.getTime()) / 1000)
      const activeRequestCount = deps.getActiveRequestCount ? deps.getActiveRequestCount() : 0

      return {
        status: draining ? 'draining' : 'ok',
        draining,
        uptimeSeconds,
        startedAt: startedAt.toISOString(),
        hasDreamDaemon: !!deps.dreamDaemon,
        hasHousekeeping: !!deps.runHousekeeping,
        activeRequestCount,
      }
    },

    async requestRollback(reason?: string): Promise<RollbackResult> {
      log.warn({ reason }, 'Admin: rollback requested')
      if (!deps.onRollback) {
        return {
          success: false,
          triggered: false,
          error: 'No rollback handler configured',
        }
      }
      try {
        await deps.onRollback(reason)
        return { success: true, triggered: true }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log.error({ err: msg }, 'Rollback handler failed')
        return { success: false, triggered: true, error: msg }
      }
    },
  }
}
