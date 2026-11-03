// Rate monitoring and control — coordinates token buckets and backoff per session

import { createTokenBucket, type TokenBucketOptions } from './token-bucket.js'
import { createBackoffCalculator } from './backoff.js'

// ── Types ────────────────────────────────────────────────────────────

export interface RateMonitorOptions {
  readonly globalBucket?: TokenBucketOptions
  readonly perSessionBucket?: TokenBucketOptions
  readonly queueDepthThreshold?: number
  readonly yieldThreshold?: number
}

export interface RateCheckResult {
  readonly allowed: boolean
  readonly reason?: string
  readonly retryAfterMs?: number
}

export const RateRecommendation = {
  Normal: 'normal',
  SlowDown: 'slow-down',
  Pause: 'pause',
  ScaleDown: 'scale-down',
  YieldToUser: 'yield-to-user',
} as const
export type RateRecommendation = (typeof RateRecommendation)[keyof typeof RateRecommendation]

export interface RateMonitorStats {
  readonly globalTokens: number
  readonly globalCapacity: number
  readonly sessionCount: number
  readonly totalRequests: number
  readonly totalDenied: number
  readonly currentRecommendation: RateRecommendation
}

// ── Defaults ─────────────────────────────────────────────────────────

const DEFAULT_GLOBAL: TokenBucketOptions = { capacity: 100, refillRate: 10 }
const DEFAULT_SESSION: TokenBucketOptions = { capacity: 10, refillRate: 2 }
const DEFAULT_QUEUE_DEPTH = 10
const DEFAULT_YIELD_THRESHOLD = 20

// ── Session state ────────────────────────────────────────────────────

interface SessionState {
  bucket: ReturnType<typeof createTokenBucket>
  backoff: ReturnType<typeof createBackoffCalculator>
}

// ── Factory ──────────────────────────────────────────────────────────

export function createRateMonitor(options?: RateMonitorOptions) {
  const globalOpts = options?.globalBucket ?? DEFAULT_GLOBAL
  const sessionOpts = options?.perSessionBucket ?? DEFAULT_SESSION
  const queueDepthThreshold = options?.queueDepthThreshold ?? DEFAULT_QUEUE_DEPTH
  const yieldThreshold = options?.yieldThreshold ?? DEFAULT_YIELD_THRESHOLD

  let globalBucket = createTokenBucket(globalOpts)
  const sessions = new Map<string, SessionState>()
  let totalRequests = 0
  let totalDenied = 0
  let queueDepth = 0

  function getOrCreateSession(sessionId: string): SessionState {
    let session = sessions.get(sessionId)
    if (!session) {
      session = {
        bucket: createTokenBucket(sessionOpts),
        backoff: createBackoffCalculator({ jitter: false }),
      }
      sessions.set(sessionId, session)
    }
    return session
  }

  function globalPercent(): number {
    return (globalBucket._rawAvailable() / globalOpts.capacity) * 100
  }

  function buildDenied(reason: string, retryAfterMs: number): RateCheckResult {
    return { allowed: false, reason, retryAfterMs }
  }

  return {
    canProceed(sessionId: string): RateCheckResult {
      const session = getOrCreateSession(sessionId)

      if (globalBucket.isEmpty()) {
        return buildDenied('global rate limit exceeded', globalBucket.timeUntilAvailable())
      }
      if (session.bucket.isEmpty()) {
        return buildDenied('session rate limit exceeded', session.bucket.timeUntilAvailable())
      }
      return { allowed: true }
    },

    recordRequest(sessionId: string): RateCheckResult {
      const check = this.canProceed(sessionId)
      totalRequests++

      if (!check.allowed) {
        totalDenied++
        queueDepth++
        return check
      }

      const session = getOrCreateSession(sessionId)
      globalBucket.tryConsume()
      session.bucket.tryConsume()
      session.backoff.recordSuccess()
      // Decrement queue depth on successful request (clamped to 0)
      if (queueDepth > 0) queueDepth--
      return { allowed: true }
    },

    getRecommendation(): RateRecommendation {
      const pct = globalPercent()

      if (queueDepth >= queueDepthThreshold) return RateRecommendation.ScaleDown
      if (pct < yieldThreshold) return RateRecommendation.YieldToUser
      if (pct < 20) return RateRecommendation.Pause
      if (pct <= 50) return RateRecommendation.SlowDown
      return RateRecommendation.Normal
    },

    recordExternalLimit(sessionId: string): void {
      const session = getOrCreateSession(sessionId)
      session.backoff.recordFailure()
    },

    shouldYieldToUser(): boolean {
      return globalPercent() < yieldThreshold
    },

    getBackoffDelay(sessionId: string): number {
      const session = getOrCreateSession(sessionId)
      return session.backoff.currentDelay()
    },

    getStats(): RateMonitorStats {
      return {
        globalTokens: globalBucket.available(),
        globalCapacity: globalOpts.capacity,
        sessionCount: sessions.size,
        totalRequests,
        totalDenied,
        currentRecommendation: this.getRecommendation(),
      }
    },

    reset(): void {
      globalBucket = createTokenBucket(globalOpts)
      sessions.clear()
      totalRequests = 0
      totalDenied = 0
      queueDepth = 0
    },
  }
}
