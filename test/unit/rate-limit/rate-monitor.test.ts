import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createRateMonitor,
  RateRecommendation,
  type RateMonitorOptions,
} from '../../../src/rate-limit/rate-monitor.js'

describe('createRateMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const defaultOpts: RateMonitorOptions = {
    globalBucket: { capacity: 100, refillRate: 10 },
    perSessionBucket: { capacity: 10, refillRate: 2 },
  }

  // ── canProceed ───────────────────────────────────────────────────

  it('canProceed allowed when buckets have tokens', () => {
    const monitor = createRateMonitor(defaultOpts)
    const result = monitor.canProceed('session-1')
    expect(result.allowed).toBe(true)
  })

  it('canProceed denied when global bucket empty', () => {
    const monitor = createRateMonitor({
      globalBucket: { capacity: 1, refillRate: 0.01 },
      perSessionBucket: { capacity: 10, refillRate: 2 },
    })
    monitor.recordRequest('session-1') // consumes the 1 global token
    const result = monitor.canProceed('session-1')
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('global')
  })

  it('canProceed denied when session bucket empty', () => {
    const monitor = createRateMonitor({
      globalBucket: { capacity: 100, refillRate: 10 },
      perSessionBucket: { capacity: 1, refillRate: 0.01 },
    })
    monitor.recordRequest('session-1') // consumes the 1 session token
    const result = monitor.canProceed('session-1')
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('session')
  })

  // ── recordRequest ────────────────────────────────────────────────

  it('recordRequest consumes from both buckets', () => {
    const monitor = createRateMonitor(defaultOpts)
    const result = monitor.recordRequest('session-1')
    expect(result.allowed).toBe(true)
    const stats = monitor.getStats()
    expect(stats.totalRequests).toBe(1)
    expect(stats.globalTokens).toBe(99)
  })

  it('recordRequest denied returns retryAfterMs', () => {
    const monitor = createRateMonitor({
      globalBucket: { capacity: 1, refillRate: 1 },
      perSessionBucket: { capacity: 10, refillRate: 2 },
    })
    monitor.recordRequest('session-1')
    const result = monitor.recordRequest('session-1')
    expect(result.allowed).toBe(false)
    expect(result.retryAfterMs).toBeGreaterThan(0)
  })

  // ── recordExternalLimit ──────────────────────────────────────────

  it('recordExternalLimit triggers backoff', () => {
    const monitor = createRateMonitor(defaultOpts)
    monitor.recordExternalLimit('session-1')
    const delay = monitor.getBackoffDelay('session-1')
    expect(delay).toBeGreaterThan(0)
  })

  // ── getBackoffDelay ──────────────────────────────────────────────

  it('getBackoffDelay returns current backoff', () => {
    const monitor = createRateMonitor(defaultOpts)
    // No external limits yet → delay from backoff calculator at attempt 0
    const delay = monitor.getBackoffDelay('session-1')
    expect(delay).toBeGreaterThanOrEqual(0)
  })

  // ── Multiple sessions ────────────────────────────────────────────

  it('multiple sessions tracked independently', () => {
    const monitor = createRateMonitor({
      globalBucket: { capacity: 100, refillRate: 10 },
      perSessionBucket: { capacity: 2, refillRate: 0.01 },
    })
    monitor.recordRequest('session-a')
    monitor.recordRequest('session-a')
    // session-a exhausted its per-session bucket
    const resultA = monitor.canProceed('session-a')
    expect(resultA.allowed).toBe(false)

    // session-b still has tokens
    const resultB = monitor.canProceed('session-b')
    expect(resultB.allowed).toBe(true)
  })

  // ── getRecommendation ────────────────────────────────────────────

  it('getRecommendation Normal when plenty of tokens', () => {
    const monitor = createRateMonitor(defaultOpts)
    expect(monitor.getRecommendation()).toBe(RateRecommendation.Normal)
  })

  it('getRecommendation SlowDown at 20-50%', () => {
    const monitor = createRateMonitor({
      globalBucket: { capacity: 100, refillRate: 0.01 },
      perSessionBucket: { capacity: 10, refillRate: 2 },
    })
    // Consume 60 tokens → 40% remaining → SlowDown
    for (let i = 0; i < 60; i++) {
      monitor.recordRequest(`s-${i}`)
    }
    expect(monitor.getRecommendation()).toBe(RateRecommendation.SlowDown)
  })

  it('getRecommendation Pause below 20%', () => {
    const monitor = createRateMonitor({
      globalBucket: { capacity: 100, refillRate: 0.01 },
      perSessionBucket: { capacity: 10, refillRate: 2 },
      yieldThreshold: 5, // lower than 15% so Pause triggers, not YieldToUser
    })
    // Consume 85 tokens → 15% remaining → Pause
    for (let i = 0; i < 85; i++) {
      monitor.recordRequest(`s-${i}`)
    }
    expect(monitor.getRecommendation()).toBe(RateRecommendation.Pause)
  })

  it('getRecommendation YieldToUser at threshold', () => {
    const monitor = createRateMonitor({
      globalBucket: { capacity: 100, refillRate: 0.01 },
      perSessionBucket: { capacity: 10, refillRate: 2 },
      yieldThreshold: 20,
    })
    // Consume 85 tokens → 15% < 20% → YieldToUser
    for (let i = 0; i < 85; i++) {
      monitor.recordRequest(`s-${i}`)
    }
    expect(monitor.getRecommendation()).toBe(RateRecommendation.YieldToUser)
  })

  it('getRecommendation ScaleDown at queue depth', () => {
    createRateMonitor({
      ...defaultOpts,
      queueDepthThreshold: 3,
    })
    // Record enough denied requests to trigger queue depth
    const smallMonitor = createRateMonitor({
      globalBucket: { capacity: 5, refillRate: 0.01 },
      perSessionBucket: { capacity: 10, refillRate: 2 },
      queueDepthThreshold: 3,
    })
    // Exhaust global tokens then keep requesting
    for (let i = 0; i < 5; i++) {
      smallMonitor.recordRequest(`s-${i}`)
    }
    // These will be denied and queue up
    smallMonitor.recordRequest('s-extra-1')
    smallMonitor.recordRequest('s-extra-2')
    smallMonitor.recordRequest('s-extra-3')
    expect(smallMonitor.getRecommendation()).toBe(RateRecommendation.ScaleDown)
  })

  // ── shouldYieldToUser ────────────────────────────────────────────

  it('shouldYieldToUser reflects token state', () => {
    const monitor = createRateMonitor({
      globalBucket: { capacity: 100, refillRate: 0.01 },
      perSessionBucket: { capacity: 10, refillRate: 2 },
      yieldThreshold: 20,
    })
    expect(monitor.shouldYieldToUser()).toBe(false)
    // Consume 85 → 15% remaining < 20%
    for (let i = 0; i < 85; i++) {
      monitor.recordRequest(`s-${i}`)
    }
    expect(monitor.shouldYieldToUser()).toBe(true)
  })

  // ── getStats ─────────────────────────────────────────────────────

  it('getStats returns correct counts', () => {
    const monitor = createRateMonitor(defaultOpts)
    monitor.recordRequest('session-1')
    monitor.recordRequest('session-2')
    monitor.recordRequest('session-1')
    const stats = monitor.getStats()
    expect(stats.sessionCount).toBe(2)
    expect(stats.totalRequests).toBe(3)
    expect(stats.globalCapacity).toBe(100)
    expect(stats.globalTokens).toBe(97)
  })

  it('total denied tracked', () => {
    const monitor = createRateMonitor({
      globalBucket: { capacity: 2, refillRate: 0.01 },
      perSessionBucket: { capacity: 10, refillRate: 2 },
    })
    monitor.recordRequest('s-1')
    monitor.recordRequest('s-2')
    monitor.recordRequest('s-3') // denied
    monitor.recordRequest('s-4') // denied
    const stats = monitor.getStats()
    expect(stats.totalDenied).toBe(2)
  })

  // ── reset ────────────────────────────────────────────────────────

  it('reset clears all sessions and stats', () => {
    const monitor = createRateMonitor(defaultOpts)
    monitor.recordRequest('session-1')
    monitor.recordRequest('session-2')
    monitor.reset()
    const stats = monitor.getStats()
    expect(stats.sessionCount).toBe(0)
    expect(stats.totalRequests).toBe(0)
    expect(stats.totalDenied).toBe(0)
    expect(stats.globalTokens).toBe(100)
  })

  // ── New session auto-creates ─────────────────────────────────────

  it('new session auto-creates bucket', () => {
    const monitor = createRateMonitor(defaultOpts)
    // Simply calling canProceed with a new session should work
    const result = monitor.canProceed('brand-new-session')
    expect(result.allowed).toBe(true)
  })

  // ── Default options ──────────────────────────────────────────────

  it('works with no options', () => {
    const monitor = createRateMonitor()
    const result = monitor.canProceed('session-1')
    expect(result.allowed).toBe(true)
  })
})
