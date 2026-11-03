/**
 * P7 — Restart policy / suppression for misbehaving child brokers (tests).
 */
import { describe, it, expect } from 'vitest'
import { shouldRestart } from '../../../src/meta-broker/restart-policy.js'

const DEFAULTS = {
  minFailures: 3,
  cooldownMs: 30_000,
  maxRestartsPerWindow: 3,
  windowMs: 600_000,
}

describe('shouldRestart', () => {
  it('does not restart when failures < minFailures', () => {
    const d = shouldRestart({
      ...DEFAULTS,
      consecutiveFailures: 2,
      restartHistoryMs: [],
      lastRestartAtMs: null,
      nowMs: 1000,
    })
    expect(d.restart).toBe(false)
    expect(d.reason).toMatch(/below threshold/i)
  })

  it('restarts when failures ≥ minFailures and no prior restart in cooldown', () => {
    const d = shouldRestart({
      ...DEFAULTS,
      consecutiveFailures: 3,
      restartHistoryMs: [],
      lastRestartAtMs: null,
      nowMs: 1000,
    })
    expect(d.restart).toBe(true)
    expect(d.reason).toMatch(/restart/i)
  })

  it('blocks restart within cooldown of the last restart', () => {
    const d = shouldRestart({
      ...DEFAULTS,
      consecutiveFailures: 10,
      restartHistoryMs: [1_000_000],
      lastRestartAtMs: 1_000_000,
      nowMs: 1_010_000,
    })
    expect(d.restart).toBe(false)
    expect(d.reason).toMatch(/cooldown/i)
  })

  it('allows restart after cooldown elapses', () => {
    const d = shouldRestart({
      ...DEFAULTS,
      consecutiveFailures: 3,
      restartHistoryMs: [1_000_000],
      lastRestartAtMs: 1_000_000,
      nowMs: 1_035_000,
    })
    expect(d.restart).toBe(true)
  })

  it('escalates to suspended when restarts within window ≥ maxRestartsPerWindow', () => {
    const d = shouldRestart({
      ...DEFAULTS,
      consecutiveFailures: 10,
      restartHistoryMs: [200_000, 300_000, 400_000],
      lastRestartAtMs: 400_000,
      nowMs: 500_000,
    })
    expect(d.restart).toBe(false)
    expect(d.suspend).toBe(true)
    expect(d.reason).toMatch(/max.*window|suspended/i)
  })

  it('forgets restarts older than the window (allows recovery)', () => {
    const d = shouldRestart({
      ...DEFAULTS,
      consecutiveFailures: 3,
      restartHistoryMs: [100, 200, 300],
      lastRestartAtMs: 300,
      nowMs: 5_000_000,
    })
    expect(d.restart).toBe(true)
    expect(d.suspend ?? false).toBe(false)
  })

  it('does not suspend on the first failure burst (only ≥ maxRestartsPerWindow)', () => {
    const d = shouldRestart({
      ...DEFAULTS,
      consecutiveFailures: 5,
      restartHistoryMs: [],
      lastRestartAtMs: null,
      nowMs: 1_000_000,
    })
    expect(d.restart).toBe(true)
    expect(d.suspend ?? false).toBe(false)
  })
})
