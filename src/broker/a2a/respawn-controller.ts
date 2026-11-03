// ---------------------------------------------------------------------------
// Respawn controller — manages dead-agent recovery with backoff & limits
// ---------------------------------------------------------------------------

import { RateRecommendation as RR, type RateRecommendation } from '../../rate-limit/rate-monitor.js'
import type { createRateMonitor } from '../../rate-limit/rate-monitor.js'
import type { createHealthMonitor } from '../../context/health-monitor.js'

// ── Types ────────────────────────────────────────────────────────────

export interface RespawnControllerOptions {
  readonly maxRespawns?: number
  readonly respawnCooldownMs?: number
  readonly healthCheckTimeoutMs?: number
}

/**
 * Spawn request passed to `onSpawn`. `teamId` is the team the respawned
 * agent must rejoin — required for the spawn to succeed end-to-end. If the
 * caller cannot supply a valid team (e.g., fleet-level auto-scaler with no
 * team context, or team purged between zombie detection and respawn), the
 * `onSpawn` implementation should return `null` and the controller will
 * record the respawn as a failure rather than success.
 */
export interface SpawnRequest {
  readonly role: string
  readonly teamId?: string
  readonly context?: string
}

export interface RespawnDeps {
  readonly healthMonitor?: ReturnType<typeof createHealthMonitor>
  readonly rateMonitor?: ReturnType<typeof createRateMonitor>
  readonly onSpawn?: (opts: SpawnRequest) => Promise<string | null>
  readonly onKill?: (sessionId: string) => Promise<void>
}

export interface DeadAgent {
  readonly sessionId: string
  readonly role: string
  readonly lastHeartbeat: string
  readonly teamId?: string
  readonly lastContext?: string
}

export interface RespawnResult {
  readonly originalId: string
  readonly newId: string | null
  readonly success: boolean
  readonly attempt: number
  readonly error?: string
}

export interface RespawnStats {
  readonly totalRespawns: number
  readonly successfulRespawns: number
  readonly failedRespawns: number
  readonly agentsAtMaxRespawns: number
}

// ── Defaults ─────────────────────────────────────────────────────────

const DEFAULTS = {
  maxRespawns: 3,
  respawnCooldownMs: 30_000,
  healthCheckTimeoutMs: 10_000,
} as const

// Rate recommendations that defer respawns
const DEFER_RECOMMENDATIONS = new Set<RateRecommendation>([RR.ScaleDown, RR.Pause])

// ── Per-agent tracking ───────────────────────────────────────────────

interface AgentTracker {
  count: number
  lastRespawnTime: number | null
  history: RespawnResult[]
}

// ── Factory ──────────────────────────────────────────────────────────

export function createRespawnController(deps: RespawnDeps, options?: RespawnControllerOptions) {
  const maxRespawns = options?.maxRespawns ?? DEFAULTS.maxRespawns
  const respawnCooldownMs = options?.respawnCooldownMs ?? DEFAULTS.respawnCooldownMs
  // healthCheckTimeoutMs reserved for future health-check integration
  void (options?.healthCheckTimeoutMs ?? DEFAULTS.healthCheckTimeoutMs)

  const trackers = new Map<string, AgentTracker>()

  let totalRespawns = 0
  let successfulRespawns = 0
  let failedRespawns = 0

  function getTracker(sessionId: string): AgentTracker {
    let t = trackers.get(sessionId)
    if (!t) {
      t = { count: 0, lastRespawnTime: null, history: [] }
      trackers.set(sessionId, t)
    }
    return t
  }

  function isCooldownActive(tracker: AgentTracker): boolean {
    if (tracker.lastRespawnTime === null) return false
    return Date.now() - tracker.lastRespawnTime < respawnCooldownMs
  }

  function isRateLimited(): boolean {
    if (!deps.rateMonitor) return false
    const rec = deps.rateMonitor.getRecommendation()
    return DEFER_RECOMMENDATIONS.has(rec)
  }

  return {
    shouldRespawn(sessionId: string): boolean {
      const tracker = getTracker(sessionId)
      if (tracker.count >= maxRespawns) return false
      if (isCooldownActive(tracker)) return false
      return true
    },

    async respawn(dead: DeadAgent): Promise<RespawnResult> {
      const tracker = getTracker(dead.sessionId)
      totalRespawns++

      // Check max respawns
      if (tracker.count >= maxRespawns) {
        const result: RespawnResult = {
          originalId: dead.sessionId,
          newId: null,
          success: false,
          attempt: tracker.count + 1,
          error: `max respawns (${maxRespawns}) reached for ${dead.sessionId}`,
        }
        tracker.history.push(result)
        failedRespawns++
        return result
      }

      // Check rate limiting
      if (isRateLimited()) {
        const result: RespawnResult = {
          originalId: dead.sessionId,
          newId: null,
          success: false,
          attempt: tracker.count + 1,
          error: 'respawn deferred due to rate limiting',
        }
        tracker.history.push(result)
        failedRespawns++
        return result
      }

      // Attempt spawn
      tracker.count++
      const attempt = tracker.count

      try {
        const newId =
          (await deps.onSpawn?.({
            role: dead.role,
            teamId: dead.teamId,
            context: dead.lastContext,
          })) ?? null
        tracker.lastRespawnTime = Date.now()

        // A null return is an explicit "spawn skipped" signal (e.g., the
        // caller could not resolve a valid team for the agent). Treat it as
        // failure so we don't inflate successful-respawn stats and we don't
        // record a phantom session as the replacement.
        if (newId === null) {
          const result: RespawnResult = {
            originalId: dead.sessionId,
            newId: null,
            success: false,
            attempt,
            error: 'spawn skipped: missing or inactive team',
          }
          tracker.history.push(result)
          failedRespawns++
          return result
        }

        const result: RespawnResult = {
          originalId: dead.sessionId,
          newId,
          success: true,
          attempt,
        }
        tracker.history.push(result)
        successfulRespawns++
        return result
      } catch (err) {
        tracker.lastRespawnTime = Date.now()
        const result: RespawnResult = {
          originalId: dead.sessionId,
          newId: null,
          success: false,
          attempt,
          error: err instanceof Error ? err.message : String(err),
        }
        tracker.history.push(result)
        failedRespawns++
        return result
      }
    },

    async processBatch(deadAgents: readonly DeadAgent[]): Promise<readonly RespawnResult[]> {
      const results: RespawnResult[] = []
      for (const dead of deadAgents) {
        const result = await this.respawn(dead)
        results.push(result)
      }
      return results
    },

    getHistory(sessionId: string): readonly RespawnResult[] {
      return trackers.get(sessionId)?.history ?? []
    },

    getStats(): RespawnStats {
      let agentsAtMaxRespawns = 0
      for (const tracker of trackers.values()) {
        if (tracker.count >= maxRespawns) agentsAtMaxRespawns++
      }
      return {
        totalRespawns,
        successfulRespawns,
        failedRespawns,
        agentsAtMaxRespawns,
      }
    },

    resetCounters(sessionId: string): void {
      const tracker = trackers.get(sessionId)
      if (tracker) {
        tracker.count = 0
        tracker.lastRespawnTime = null
      }
    },
  }
}
