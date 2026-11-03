// ---------------------------------------------------------------------------
// Auto-scaler — evaluates cluster state and makes scaling decisions
// ---------------------------------------------------------------------------

import { type RateRecommendation, RateRecommendation as RR } from '../../rate-limit/rate-monitor.js'
import type { createRateMonitor } from '../../rate-limit/rate-monitor.js'

// ── Types ────────────────────────────────────────────────────────────

export interface AutoScalerOptions {
  readonly minAgents?: number
  readonly maxAgents?: number
  readonly scaleUpThreshold?: number
  readonly scaleDownIdleMs?: number
  readonly cooldownMs?: number
}

/**
 * Fleet-level scale-up request. No `teamId` is supplied — auto-scaler operates
 * at the cluster level and has no team context, so the `onSpawn` consumer must
 * decide how to handle role-only spawns (typically: return `null` to skip,
 * which the auto-scaler records as a no-op).
 */
export interface ScalerSpawnRequest {
  readonly role: string
}

export interface ScalerDeps {
  readonly rateMonitor: ReturnType<typeof createRateMonitor>
  readonly onSpawn?: (opts: ScalerSpawnRequest) => Promise<string | null>
  readonly onKill?: (sessionId: string) => Promise<void>
  readonly getActiveCount?: () => number
  readonly getQueueDepth?: () => number
}

export interface ScaleDecision {
  readonly action: 'scale-up' | 'scale-down' | 'hold'
  readonly count: number
  readonly reason: string
}

export interface ScaleResult {
  readonly spawned: readonly string[]
  readonly killed: readonly string[]
  readonly errors: readonly string[]
}

export interface ScalerStatus {
  readonly activeAgents: number
  readonly idleAgents: number
  readonly queueDepth: number
  readonly lastScaleAction: string | null
  readonly cooldownRemaining: number
  readonly rateRecommendation: string
}

// ── Defaults ─────────────────────────────────────────────────────────

const DEFAULTS = {
  minAgents: 0,
  maxAgents: 5,
  scaleUpThreshold: 3,
  scaleDownIdleMs: 300_000,
  cooldownMs: 60_000,
} as const

// Rate recommendations that trigger scale-down
const SCALE_DOWN_RECOMMENDATIONS = new Set<RateRecommendation>([
  RR.ScaleDown,
  RR.Pause,
  RR.YieldToUser,
])

// ── Factory ──────────────────────────────────────────────────────────

export function createAutoScaler(deps: ScalerDeps, options?: AutoScalerOptions) {
  const minAgents = options?.minAgents ?? DEFAULTS.minAgents
  const maxAgents = options?.maxAgents ?? DEFAULTS.maxAgents
  const scaleUpThreshold = options?.scaleUpThreshold ?? DEFAULTS.scaleUpThreshold
  const scaleDownIdleMs = options?.scaleDownIdleMs ?? DEFAULTS.scaleDownIdleMs
  const cooldownMs = options?.cooldownMs ?? DEFAULTS.cooldownMs

  // idle sessionId → timestamp when it became idle
  const idleAgents = new Map<string, number>()
  let lastScaleTime: number | null = null
  let lastScaleAction: string | null = null

  function getActive(): number {
    return deps.getActiveCount?.() ?? 0
  }

  function getQueue(): number {
    return deps.getQueueDepth?.() ?? 0
  }

  function isCooldownActive(): boolean {
    if (lastScaleTime === null) return false
    return Date.now() - lastScaleTime < cooldownMs
  }

  function cooldownRemaining(): number {
    if (lastScaleTime === null) return 0
    return Math.max(0, cooldownMs - (Date.now() - lastScaleTime))
  }

  function getIdleBeyondTimeout(): string[] {
    const now = Date.now()
    const result: string[] = []
    for (const [id, since] of idleAgents) {
      if (now - since >= scaleDownIdleMs) {
        result.push(id)
      }
    }
    return result
  }

  function recordCooldown(action: string): void {
    lastScaleTime = Date.now()
    lastScaleAction = action
  }

  return {
    evaluate(): ScaleDecision {
      const rec = deps.rateMonitor.getRecommendation()
      const active = getActive()
      const queueDepth = getQueue()

      // 1. Rate-based scale-down overrides everything
      if (SCALE_DOWN_RECOMMENDATIONS.has(rec) && active > minAgents) {
        return {
          action: 'scale-down',
          count: Math.max(1, active - minAgents),
          reason: `rate monitor recommends ${rec}`,
        }
      }

      // SlowDown → don't spawn more
      if (rec === RR.SlowDown) {
        return { action: 'hold', count: 0, reason: `rate monitor recommends slow-down` }
      }

      // 2. Cooldown check
      if (isCooldownActive()) {
        return { action: 'hold', count: 0, reason: 'cooldown active' }
      }

      // 3. Queue-based scale-up
      if (queueDepth > scaleUpThreshold && active < maxAgents) {
        const count = Math.min(queueDepth - active, maxAgents - active)
        if (count > 0) {
          return {
            action: 'scale-up',
            count,
            reason: `queue depth ${queueDepth} exceeds threshold ${scaleUpThreshold}`,
          }
        }
      }

      // 4. Idle-based scale-down
      const idleBeyond = getIdleBeyondTimeout()
      if (idleBeyond.length > 0 && active > minAgents) {
        const count = Math.min(idleBeyond.length, active - minAgents)
        return {
          action: 'scale-down',
          count,
          reason: `${idleBeyond.length} agents idle beyond timeout`,
        }
      }

      // 5. Default: hold
      return { action: 'hold', count: 0, reason: 'no scaling needed' }
    },

    async execute(decision: ScaleDecision): Promise<ScaleResult> {
      const spawned: string[] = []
      const killed: string[] = []
      const errors: string[] = []

      if (decision.action === 'scale-up') {
        for (let i = 0; i < decision.count; i++) {
          try {
            // A null return means the spawn was deliberately skipped (e.g.,
            // production wiring has no fleet-level spawn handler). Treat it
            // as a no-op rather than an error so we don't pollute the
            // error channel.
            const id = await deps.onSpawn?.({ role: 'worker' })
            if (id) spawned.push(id)
          } catch (err) {
            errors.push(err instanceof Error ? err.message : String(err))
          }
        }
        if (spawned.length > 0) recordCooldown('scale-up')
      }

      if (decision.action === 'scale-down') {
        const targets = getIdleBeyondTimeout().slice(0, decision.count)
        // If no idle-beyond-timeout targets, pick from idle set
        const toKill =
          targets.length > 0 ? targets : [...idleAgents.keys()].slice(0, decision.count)

        for (const id of toKill) {
          try {
            await deps.onKill?.(id)
            killed.push(id)
            idleAgents.delete(id)
          } catch (err) {
            errors.push(err instanceof Error ? err.message : String(err))
          }
        }
        if (killed.length > 0) recordCooldown('scale-down')
      }

      return { spawned, killed, errors }
    },

    async tick(): Promise<ScaleDecision> {
      const decision = this.evaluate()
      if (decision.action !== 'hold') {
        await this.execute(decision)
      }
      return decision
    },

    getStatus(): ScalerStatus {
      return {
        activeAgents: getActive(),
        idleAgents: idleAgents.size,
        queueDepth: getQueue(),
        lastScaleAction,
        cooldownRemaining: cooldownRemaining(),
        rateRecommendation: deps.rateMonitor.getRecommendation(),
      }
    },

    recordIdle(sessionId: string): void {
      idleAgents.set(sessionId, Date.now())
    },

    recordActive(sessionId: string): void {
      idleAgents.delete(sessionId)
    },
  }
}
