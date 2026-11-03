/**
 * Gap 3 — external health-watchdog decision logic.
 *
 * The in-process health-watchdog runs on the broker's event loop, so a
 * BLOCKED loop can't run its own `setInterval` to self-heal. This module
 * is the pure decision core for a SEPARATE process that HTTP-polls
 * `/api/health` and restarts the broker after N consecutive UNRESPONSIVE
 * probes (event-loop hang), gated by a startup grace period and a
 * cooldown. "Unresponsive" (timeout / connection refused) is distinct
 * from "responsive but unhealthy" (any HTTP status, incl. 503) — the
 * latter is the in-process self-heal's job, not the external watchdog's.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  classifyProbe,
  decideWatchdogAction,
  createExternalWatchdog,
  DEFAULT_MAX_CONSECUTIVE_TIMEOUTS,
  type WatchdogConfig,
} from '../../../../src/broker/services/external-watchdog.js'

const CFG: WatchdogConfig = {
  maxConsecutiveTimeouts: 3,
  cooldownMs: 300_000,
  startupGraceMs: 60_000,
}

describe('classifyProbe', () => {
  it('treats any HTTP status (even 5xx) as responsive — event loop is alive', () => {
    expect(classifyProbe({ ok: true, status: 200 })).toBe('responsive')
    expect(classifyProbe({ ok: false, status: 503 })).toBe('responsive')
    expect(classifyProbe({ ok: false, status: 500 })).toBe('responsive')
  })

  it('treats timeout / connection error (no status) as unresponsive', () => {
    expect(classifyProbe({ ok: false, timedOut: true })).toBe('unresponsive')
    expect(classifyProbe({ ok: false, error: 'ECONNREFUSED' })).toBe('unresponsive')
    expect(classifyProbe({ ok: false })).toBe('unresponsive')
  })
})

describe('decideWatchdogAction', () => {
  const base = {
    consecutiveTimeouts: 3,
    now: 1_000_000,
    startedAt: 0,
    lastRestartAt: null as number | null,
    killSwitch: false,
  }

  it('restarts at/above the consecutive-timeout threshold (past grace, no cooldown)', () => {
    expect(decideWatchdogAction(base, CFG).action).toBe('restart')
  })

  it('does not restart below the threshold', () => {
    expect(decideWatchdogAction({ ...base, consecutiveTimeouts: 2 }, CFG)).toEqual({
      action: 'none',
      reason: 'below-threshold',
    })
  })

  it('does not restart during the startup grace period', () => {
    expect(
      decideWatchdogAction({ ...base, now: 30_000, startedAt: 0 }, CFG),
    ).toEqual({ action: 'none', reason: 'startup-grace' })
  })

  it('does not restart within the cooldown of the last restart', () => {
    expect(
      decideWatchdogAction({ ...base, lastRestartAt: base.now - 60_000 }, CFG),
    ).toEqual({ action: 'none', reason: 'cooldown' })
  })

  it('restarts again once the cooldown has elapsed', () => {
    expect(
      decideWatchdogAction({ ...base, lastRestartAt: base.now - 400_000 }, CFG).action,
    ).toBe('restart')
  })

  it('never restarts when the kill-switch is set', () => {
    expect(decideWatchdogAction({ ...base, killSwitch: true }, CFG)).toEqual({
      action: 'none',
      reason: 'kill-switch',
    })
  })

  it('exposes a sane default threshold', () => {
    expect(DEFAULT_MAX_CONSECUTIVE_TIMEOUTS).toBeGreaterThanOrEqual(2)
  })
})

describe('createExternalWatchdog (tick loop)', () => {
  function harness(probeOutcomes: Array<{ status?: number; timedOut?: boolean }>) {
    let i = 0
    let nowMs = 1_000_000 // already well past startup grace (startedAt = 0)
    let lastRestartAt: number | null = null
    const restart = vi.fn()
    const wd = createExternalWatchdog({
      probe: async () => {
        const o = probeOutcomes[Math.min(i, probeOutcomes.length - 1)]!
        i += 1
        return { ok: o.status === 200, status: o.status, timedOut: o.timedOut }
      },
      restart,
      loadLastRestartAt: () => lastRestartAt,
      saveLastRestartAt: (t) => {
        lastRestartAt = t
      },
      isKillSwitched: () => false,
      now: () => nowMs,
      startedAt: 0,
      config: { maxConsecutiveTimeouts: 3, cooldownMs: 300_000, startupGraceMs: 60_000 },
    })
    return { wd, restart, advance: (ms: number) => (nowMs += ms), get lastRestartAt() { return lastRestartAt } }
  }

  it('restarts after N consecutive unresponsive probes, once', async () => {
    const h = harness([{ timedOut: true }])
    await h.wd.tick()
    await h.wd.tick()
    expect(h.restart).not.toHaveBeenCalled()
    const d = await h.wd.tick() // 3rd consecutive timeout
    expect(d.action).toBe('restart')
    expect(h.restart).toHaveBeenCalledTimes(1)
  })

  it('a responsive probe resets the consecutive-timeout counter', async () => {
    const h = harness([{ timedOut: true }, { timedOut: true }, { status: 200 }, { timedOut: true }])
    await h.wd.tick() // timeout 1
    await h.wd.tick() // timeout 2
    await h.wd.tick() // responsive → reset
    await h.wd.tick() // timeout 1 again
    expect(h.restart).not.toHaveBeenCalled()
  })

  it('does not restart again while within cooldown', async () => {
    const h = harness([{ timedOut: true }])
    await h.wd.tick()
    await h.wd.tick()
    await h.wd.tick() // restart #1
    expect(h.restart).toHaveBeenCalledTimes(1)
    h.advance(10_000) // still within 300s cooldown
    await h.wd.tick()
    await h.wd.tick()
    await h.wd.tick()
    expect(h.restart).toHaveBeenCalledTimes(1) // suppressed by cooldown
  })
})
