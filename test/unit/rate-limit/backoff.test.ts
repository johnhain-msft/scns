import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createBackoffCalculator, type BackoffOptions } from '../../../src/rate-limit/backoff.js'

describe('createBackoffCalculator', () => {
  beforeEach(() => {
    vi.spyOn(Math, 'random')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const noJitterOpts: Partial<BackoffOptions> = {
    baseDelayMs: 1000,
    multiplier: 2,
    maxDelayMs: 60_000,
    jitter: false,
  }

  // ── calculate ────────────────────────────────────────────────────

  it('first attempt returns baseDelay', () => {
    const calc = createBackoffCalculator(noJitterOpts)
    expect(calc.calculate(0)).toBe(1000)
  })

  it('second attempt returns baseDelay * multiplier', () => {
    const calc = createBackoffCalculator(noJitterOpts)
    expect(calc.calculate(1)).toBe(2000)
  })

  it('third attempt returns baseDelay * multiplier^2', () => {
    const calc = createBackoffCalculator(noJitterOpts)
    expect(calc.calculate(2)).toBe(4000)
  })

  it('delay capped at maxDelay', () => {
    const calc = createBackoffCalculator(noJitterOpts)
    expect(calc.calculate(20)).toBe(60_000)
  })

  it('very high attempt still capped at maxDelay', () => {
    const calc = createBackoffCalculator(noJitterOpts)
    expect(calc.calculate(100)).toBe(60_000)
  })

  it('zero baseDelay always returns 0', () => {
    const calc = createBackoffCalculator({ ...noJitterOpts, baseDelayMs: 0 })
    expect(calc.calculate(0)).toBe(0)
    expect(calc.calculate(5)).toBe(0)
    expect(calc.calculate(100)).toBe(0)
  })

  // ── Jitter ───────────────────────────────────────────────────────

  it('jitter adds randomness within range', () => {
    // Math.random returns 0.75 → jitter factor = 1 + 0.25*(2*0.75-1) = 1 + 0.25*0.5 = 1.125
    vi.mocked(Math.random).mockReturnValue(0.75)
    const calc = createBackoffCalculator({
      baseDelayMs: 1000,
      multiplier: 2,
      maxDelayMs: 60_000,
      jitter: true,
      jitterRange: 0.25,
    })
    const delay = calc.calculate(0)
    expect(delay).toBe(1125) // 1000 * 1.125
  })

  it('jitter disabled produces deterministic results', () => {
    const calc = createBackoffCalculator(noJitterOpts)
    const d1 = calc.calculate(3)
    const d2 = calc.calculate(3)
    expect(d1).toBe(d2)
  })

  // ── recordFailure / recordSuccess ────────────────────────────────

  it('recordFailure increments and returns delay', () => {
    const calc = createBackoffCalculator(noJitterOpts)
    expect(calc.getAttemptCount()).toBe(0)
    const delay1 = calc.recordFailure()
    expect(delay1).toBe(1000) // attempt 0
    expect(calc.getAttemptCount()).toBe(1)
    const delay2 = calc.recordFailure()
    expect(delay2).toBe(2000) // attempt 1
    expect(calc.getAttemptCount()).toBe(2)
  })

  it('recordSuccess resets to 0', () => {
    const calc = createBackoffCalculator(noJitterOpts)
    calc.recordFailure()
    calc.recordFailure()
    expect(calc.getAttemptCount()).toBe(2)
    calc.recordSuccess()
    expect(calc.getAttemptCount()).toBe(0)
  })

  // ── getAttemptCount ──────────────────────────────────────────────

  it('getAttemptCount tracks correctly', () => {
    const calc = createBackoffCalculator(noJitterOpts)
    expect(calc.getAttemptCount()).toBe(0)
    calc.recordFailure()
    calc.recordFailure()
    calc.recordFailure()
    expect(calc.getAttemptCount()).toBe(3)
  })

  // ── currentDelay ─────────────────────────────────────────────────

  it('currentDelay returns delay without incrementing', () => {
    const calc = createBackoffCalculator(noJitterOpts)
    calc.recordFailure() // attempt 0 → count=1
    const delay = calc.currentDelay()
    expect(delay).toBe(2000) // delay for attempt 1 (next)
    expect(calc.getAttemptCount()).toBe(1) // not incremented
  })

  // ── shouldGiveUp ─────────────────────────────────────────────────

  it('shouldGiveUp false under max, true at/above', () => {
    const calc = createBackoffCalculator(noJitterOpts)
    calc.recordFailure()
    calc.recordFailure()
    expect(calc.shouldGiveUp(3)).toBe(false)
    calc.recordFailure()
    expect(calc.shouldGiveUp(3)).toBe(true)
    calc.recordFailure()
    expect(calc.shouldGiveUp(3)).toBe(true)
  })

  it('shouldGiveUp without maxAttempts never gives up', () => {
    const calc = createBackoffCalculator(noJitterOpts)
    for (let i = 0; i < 50; i++) calc.recordFailure()
    expect(calc.shouldGiveUp()).toBe(false)
  })

  // ── reset ────────────────────────────────────────────────────────

  it('reset clears state', () => {
    const calc = createBackoffCalculator(noJitterOpts)
    calc.recordFailure()
    calc.recordFailure()
    calc.reset()
    expect(calc.getAttemptCount()).toBe(0)
    expect(calc.currentDelay()).toBe(1000) // attempt 0 delay
  })

  // ── defaults ─────────────────────────────────────────────────────

  it('default options work', () => {
    const calc = createBackoffCalculator()
    // Should not throw and have sensible defaults
    const delay = calc.calculate(0)
    expect(delay).toBeGreaterThan(0)
    expect(calc.getAttemptCount()).toBe(0)
  })
})
