// Exponential backoff calculator for retry logic

export interface BackoffOptions {
  readonly baseDelayMs: number
  readonly multiplier: number
  readonly maxDelayMs: number
  readonly jitter: boolean
  readonly jitterRange: number
}

const DEFAULT_OPTIONS: BackoffOptions = {
  baseDelayMs: 1000,
  multiplier: 2,
  maxDelayMs: 60_000,
  jitter: true,
  jitterRange: 0.25,
}

export function createBackoffCalculator(options?: Partial<BackoffOptions>) {
  const opts: BackoffOptions = { ...DEFAULT_OPTIONS, ...options }
  let attemptCount = 0

  function computeDelay(attempt: number): number {
    const raw = opts.baseDelayMs * Math.pow(opts.multiplier, attempt)
    let delay = Math.min(raw, opts.maxDelayMs)

    if (opts.jitter) {
      const jitterFactor = 1 + opts.jitterRange * (2 * Math.random() - 1)
      delay = delay * jitterFactor
    }

    return Math.max(0, Math.min(Math.round(delay), opts.maxDelayMs))
  }

  return {
    calculate(attempt: number): number {
      return computeDelay(attempt)
    },

    recordFailure(): number {
      const delay = computeDelay(attemptCount)
      attemptCount++
      return delay
    },

    recordSuccess(): void {
      attemptCount = 0
    },

    getAttemptCount(): number {
      return attemptCount
    },

    currentDelay(): number {
      return computeDelay(attemptCount)
    },

    shouldGiveUp(maxAttempts?: number): boolean {
      if (maxAttempts === undefined) return false
      return attemptCount >= maxAttempts
    },

    reset(): void {
      attemptCount = 0
    },
  }
}
