// Token bucket rate limiter for controlling request rates

export interface TokenBucketOptions {
  readonly capacity: number
  readonly refillRate: number
  readonly initialTokens?: number
}

export interface BucketStats {
  readonly capacity: number
  readonly available: number
  readonly refillRate: number
  readonly utilizationPercent: number
  readonly lastConsumedAt: string | null
}

export function createTokenBucket(options: TokenBucketOptions) {
  const { capacity, refillRate } = options
  const initialTokens = options.initialTokens ?? capacity

  let tokens = initialTokens
  let lastRefillTime = Date.now()
  let lastConsumedAt: string | null = null

  function refill(): void {
    const now = Date.now()
    const elapsed = (now - lastRefillTime) / 1000
    tokens = Math.min(capacity, tokens + elapsed * refillRate)
    lastRefillTime = now
  }

  return {
    tryConsume(n = 1): boolean {
      refill()
      if (tokens >= n) {
        tokens -= n
        lastConsumedAt = new Date().toISOString()
        return true
      }
      return false
    },

    available(): number {
      refill()
      return Math.floor(tokens * 1000) / 1000 // avoid float noise
    },

    timeUntilAvailable(n = 1): number {
      refill()
      if (tokens >= n) return 0
      const deficit = n - tokens
      return Math.ceil((deficit / refillRate) * 1000)
    },

    isEmpty(): boolean {
      refill()
      return tokens < 1
    },

    reset(): void {
      tokens = capacity
      lastRefillTime = Date.now()
      lastConsumedAt = null
    },

    getStats(): BucketStats {
      refill()
      const used = capacity - tokens
      return {
        capacity,
        available: Math.floor(tokens * 1000) / 1000,
        refillRate,
        utilizationPercent: (used / capacity) * 100,
        lastConsumedAt,
      }
    },

    /** Raw token count (no rounding) for internal calcs */
    _rawAvailable(): number {
      refill()
      return tokens
    },
  }
}
