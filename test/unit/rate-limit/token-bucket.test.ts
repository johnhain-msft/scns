import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createTokenBucket, type TokenBucketOptions } from '../../../src/rate-limit/token-bucket.js'

describe('createTokenBucket', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const defaultOpts: TokenBucketOptions = {
    capacity: 10,
    refillRate: 1, // 1 token/sec
  }

  // ── Basic consume ────────────────────────────────────────────────

  it('full bucket allows consume', () => {
    const bucket = createTokenBucket(defaultOpts)
    expect(bucket.tryConsume()).toBe(true)
  })

  it('empty bucket denies consume', () => {
    const bucket = createTokenBucket({ capacity: 1, refillRate: 0.1 })
    bucket.tryConsume(1)
    expect(bucket.tryConsume(1)).toBe(false)
  })

  it('consume 1 token by default', () => {
    const bucket = createTokenBucket(defaultOpts)
    const before = bucket.available()
    bucket.tryConsume()
    expect(bucket.available()).toBe(before - 1)
  })

  it('consume multiple tokens at once', () => {
    const bucket = createTokenBucket(defaultOpts)
    expect(bucket.tryConsume(5)).toBe(true)
    expect(bucket.available()).toBe(5)
  })

  it('cannot consume more than capacity', () => {
    const bucket = createTokenBucket(defaultOpts)
    expect(bucket.tryConsume(11)).toBe(false)
    expect(bucket.available()).toBe(10)
  })

  // ── Refill ───────────────────────────────────────────────────────

  it('tokens refill over time', () => {
    const bucket = createTokenBucket(defaultOpts)
    bucket.tryConsume(10)
    expect(bucket.available()).toBe(0)

    vi.advanceTimersByTime(5000) // 5 seconds → 5 tokens
    expect(bucket.available()).toBe(5)
  })

  it('refill does not exceed capacity', () => {
    const bucket = createTokenBucket(defaultOpts)
    bucket.tryConsume(1)
    vi.advanceTimersByTime(60_000) // way more than needed
    expect(bucket.available()).toBe(10)
  })

  it('partial refill between consumes', () => {
    const bucket = createTokenBucket({ capacity: 10, refillRate: 2 }) // 2/sec
    bucket.tryConsume(10)
    vi.advanceTimersByTime(2000) // 2s → 4 tokens
    expect(bucket.available()).toBe(4)
    bucket.tryConsume(3)
    vi.advanceTimersByTime(1000) // 1s → 2 more
    expect(bucket.available()).toBe(3)
  })

  // ── Burst ────────────────────────────────────────────────────────

  it('burst: consume all at once then denied', () => {
    const bucket = createTokenBucket({ capacity: 5, refillRate: 1 })
    expect(bucket.tryConsume(5)).toBe(true)
    expect(bucket.tryConsume(1)).toBe(false)
  })

  // ── Custom options ───────────────────────────────────────────────

  it('custom capacity and refill rate', () => {
    const bucket = createTokenBucket({ capacity: 100, refillRate: 10 })
    expect(bucket.available()).toBe(100)
    bucket.tryConsume(100)
    vi.advanceTimersByTime(5000)
    expect(bucket.available()).toBe(50)
  })

  it('initial tokens customizable', () => {
    const bucket = createTokenBucket({ capacity: 10, refillRate: 1, initialTokens: 3 })
    expect(bucket.available()).toBe(3)
  })

  // ── timeUntilAvailable ───────────────────────────────────────────

  it('timeUntilAvailable returns 0 when tokens available', () => {
    const bucket = createTokenBucket(defaultOpts)
    expect(bucket.timeUntilAvailable(5)).toBe(0)
  })

  it('timeUntilAvailable returns correct ms', () => {
    const bucket = createTokenBucket({ capacity: 10, refillRate: 2 })
    bucket.tryConsume(10)
    // Need 4 tokens at 2/sec = 2s = 2000ms
    expect(bucket.timeUntilAvailable(4)).toBe(2000)
  })

  it('timeUntilAvailable for 1 token default', () => {
    const bucket = createTokenBucket({ capacity: 10, refillRate: 1 })
    bucket.tryConsume(10)
    expect(bucket.timeUntilAvailable()).toBe(1000)
  })

  // ── isEmpty ──────────────────────────────────────────────────────

  it('isEmpty true when 0 tokens', () => {
    const bucket = createTokenBucket({ capacity: 1, refillRate: 0.1 })
    bucket.tryConsume(1)
    expect(bucket.isEmpty()).toBe(true)
  })

  it('isEmpty false when tokens remain', () => {
    const bucket = createTokenBucket(defaultOpts)
    expect(bucket.isEmpty()).toBe(false)
  })

  // ── reset ────────────────────────────────────────────────────────

  it('reset fills to capacity', () => {
    const bucket = createTokenBucket(defaultOpts)
    bucket.tryConsume(10)
    expect(bucket.available()).toBe(0)
    bucket.reset()
    expect(bucket.available()).toBe(10)
  })

  // ── getStats ─────────────────────────────────────────────────────

  it('getStats returns correct utilization', () => {
    const bucket = createTokenBucket(defaultOpts)
    bucket.tryConsume(3)
    const stats = bucket.getStats()
    expect(stats.capacity).toBe(10)
    expect(stats.available).toBe(7)
    expect(stats.refillRate).toBe(1)
    expect(stats.utilizationPercent).toBeCloseTo(30, 0)
    expect(stats.lastConsumedAt).not.toBeNull()
  })

  it('getStats shows null lastConsumedAt when never consumed', () => {
    const bucket = createTokenBucket(defaultOpts)
    expect(bucket.getStats().lastConsumedAt).toBeNull()
  })
})
