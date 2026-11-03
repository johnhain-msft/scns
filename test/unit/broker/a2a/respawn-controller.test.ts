import { describe, it, expect, vi } from 'vitest'
import {
  createRespawnController,
  type RespawnDeps,
  type RespawnControllerOptions,
  type DeadAgent,
} from '../../../../src/broker/a2a/respawn-controller.js'
import { createRateMonitor, RateRecommendation } from '../../../../src/rate-limit/rate-monitor.js'
import { createHealthMonitor } from '../../../../src/context/health-monitor.js'

// ── Helpers ──────────────────────────────────────────────────────────

function makeDeps(overrides: Partial<RespawnDeps> = {}): RespawnDeps {
  return {
    healthMonitor: createHealthMonitor(),
    rateMonitor: createRateMonitor(),
    onSpawn: vi.fn(
      async (_opts: { role: string; teamId?: string; context?: string }) =>
        `new-${Math.random().toString(36).slice(2, 8)}`,
    ),
    onKill: vi.fn(async () => {}),
    ...overrides,
  }
}

function makeOpts(overrides: Partial<RespawnControllerOptions> = {}): RespawnControllerOptions {
  return {
    maxRespawns: 3,
    respawnCooldownMs: 30_000,
    healthCheckTimeoutMs: 10_000,
    ...overrides,
  }
}

function makeDead(overrides: Partial<DeadAgent> = {}): DeadAgent {
  return {
    sessionId: 'dead-agent-1',
    role: 'coder',
    lastHeartbeat: new Date().toISOString(),
    ...overrides,
  }
}

// ── shouldRespawn ────────────────────────────────────────────────────

describe('RespawnController — shouldRespawn', () => {
  it('returns true on first death (attempt 0 < max)', () => {
    const ctrl = createRespawnController(makeDeps(), makeOpts())
    expect(ctrl.shouldRespawn('dead-agent-1')).toBe(true)
  })

  it('returns false after maxRespawns reached', async () => {
    const ctrl = createRespawnController(
      makeDeps(),
      makeOpts({ maxRespawns: 2, respawnCooldownMs: 0 }),
    )
    const dead = makeDead()
    await ctrl.respawn(dead)
    await ctrl.respawn(dead)
    expect(ctrl.shouldRespawn('dead-agent-1')).toBe(false)
  })

  it('returns false within cooldown period', async () => {
    vi.useFakeTimers()
    try {
      const ctrl = createRespawnController(makeDeps(), makeOpts({ respawnCooldownMs: 30_000 }))
      const dead = makeDead()
      await ctrl.respawn(dead)
      // Immediately after respawn → within cooldown
      expect(ctrl.shouldRespawn('dead-agent-1')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns true after cooldown has elapsed', async () => {
    vi.useFakeTimers()
    try {
      const ctrl = createRespawnController(makeDeps(), makeOpts({ respawnCooldownMs: 1000 }))
      const dead = makeDead()
      await ctrl.respawn(dead)
      vi.advanceTimersByTime(1500)
      expect(ctrl.shouldRespawn('dead-agent-1')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── respawn ──────────────────────────────────────────────────────────

describe('RespawnController — respawn', () => {
  it('returns new session ID on success', async () => {
    const onSpawn = vi.fn(async () => 'new-session-42')
    const ctrl = createRespawnController(makeDeps({ onSpawn }), makeOpts())
    const result = await ctrl.respawn(makeDead())
    expect(result.success).toBe(true)
    expect(result.newId).toBe('new-session-42')
    expect(result.originalId).toBe('dead-agent-1')
    expect(result.attempt).toBe(1)
  })

  it('returns failure when spawn throws', async () => {
    const onSpawn = vi.fn(async () => {
      throw new Error('no resources')
    })
    const ctrl = createRespawnController(makeDeps({ onSpawn }), makeOpts())
    const result = await ctrl.respawn(makeDead())
    expect(result.success).toBe(false)
    expect(result.newId).toBeNull()
    expect(result.error).toContain('no resources')
  })

  it('defers respawn when rate limited (ScaleDown)', async () => {
    const rm = createRateMonitor()
    vi.spyOn(rm, 'getRecommendation').mockReturnValue(RateRecommendation.ScaleDown)
    const onSpawn = vi.fn(async () => 'should-not-be-called')
    const ctrl = createRespawnController(makeDeps({ rateMonitor: rm, onSpawn }), makeOpts())
    const result = await ctrl.respawn(makeDead())
    expect(result.success).toBe(false)
    expect(result.error).toContain('rate')
    expect(onSpawn).not.toHaveBeenCalled()
  })

  it('defers respawn when rate limited (Pause)', async () => {
    const rm = createRateMonitor()
    vi.spyOn(rm, 'getRecommendation').mockReturnValue(RateRecommendation.Pause)
    const onSpawn = vi.fn(async () => 'should-not-be-called')
    const ctrl = createRespawnController(makeDeps({ rateMonitor: rm, onSpawn }), makeOpts())
    const result = await ctrl.respawn(makeDead())
    expect(result.success).toBe(false)
    expect(onSpawn).not.toHaveBeenCalled()
  })

  it('passes context to spawn function', async () => {
    const onSpawn = vi.fn(async () => 'new-session')
    const ctrl = createRespawnController(makeDeps({ onSpawn }), makeOpts())
    const dead = makeDead({ lastContext: 'was refactoring auth module' })
    await ctrl.respawn(dead)
    expect(onSpawn).toHaveBeenCalledWith({
      role: 'coder',
      teamId: undefined,
      context: 'was refactoring auth module',
    })
  })

  it('passes teamId through to spawn function', async () => {
    const onSpawn = vi.fn(async () => 'new-session')
    const ctrl = createRespawnController(makeDeps({ onSpawn }), makeOpts())
    const dead = makeDead({ teamId: 'team-42', lastContext: 'building login flow' })
    await ctrl.respawn(dead)
    expect(onSpawn).toHaveBeenCalledWith({
      role: 'coder',
      teamId: 'team-42',
      context: 'building login flow',
    })
  })

  it('records failure (not success) when onSpawn returns null', async () => {
    const onSpawn = vi.fn(async () => null)
    const ctrl = createRespawnController(makeDeps({ onSpawn }), makeOpts())
    const dead = makeDead({ teamId: 'team-purged-mid-respawn' })
    const result = await ctrl.respawn(dead)
    expect(onSpawn).toHaveBeenCalled()
    expect(result.success).toBe(false)
    expect(result.newId).toBeNull()
    expect(result.error).toContain('spawn skipped')
    const stats = ctrl.getStats()
    expect(stats.failedRespawns).toBeGreaterThan(0)
    expect(stats.successfulRespawns).toBe(0)
  })

  it('increments attempt counter', async () => {
    const ctrl = createRespawnController(makeDeps(), makeOpts({ respawnCooldownMs: 0 }))
    const dead = makeDead()
    const r1 = await ctrl.respawn(dead)
    const r2 = await ctrl.respawn(dead)
    expect(r1.attempt).toBe(1)
    expect(r2.attempt).toBe(2)
  })

  it('returns failure when shouldRespawn is false', async () => {
    const ctrl = createRespawnController(
      makeDeps(),
      makeOpts({ maxRespawns: 1, respawnCooldownMs: 0 }),
    )
    const dead = makeDead()
    await ctrl.respawn(dead) // attempt 1
    const result = await ctrl.respawn(dead) // attempt 2 → exceeds max
    expect(result.success).toBe(false)
    expect(result.error).toContain('max respawns')
  })
})

// ── processBatch ─────────────────────────────────────────────────────

describe('RespawnController — processBatch', () => {
  it('processes multiple dead agents', async () => {
    const ctrl = createRespawnController(makeDeps(), makeOpts())
    const dead = [
      makeDead({ sessionId: 'd-1', role: 'coder' }),
      makeDead({ sessionId: 'd-2', role: 'reviewer' }),
      makeDead({ sessionId: 'd-3', role: 'tester' }),
    ]
    const results = await ctrl.processBatch(dead)
    expect(results).toHaveLength(3)
    expect(results.filter((r) => r.success)).toHaveLength(3)
  })

  it('returns mixed results when some fail', async () => {
    let callCount = 0
    const onSpawn = vi.fn(async () => {
      callCount++
      if (callCount === 2) throw new Error('spawn error')
      return `agent-${callCount}`
    })
    const ctrl = createRespawnController(makeDeps({ onSpawn }), makeOpts())
    const dead = [
      makeDead({ sessionId: 'd-1' }),
      makeDead({ sessionId: 'd-2' }),
      makeDead({ sessionId: 'd-3' }),
    ]
    const results = await ctrl.processBatch(dead)
    const successes = results.filter((r) => r.success)
    const failures = results.filter((r) => !r.success)
    expect(successes.length).toBe(2)
    expect(failures.length).toBe(1)
  })

  it('skips agents at max respawns', async () => {
    const ctrl = createRespawnController(
      makeDeps(),
      makeOpts({ maxRespawns: 1, respawnCooldownMs: 0 }),
    )
    const dead = makeDead({ sessionId: 'maxed-out' })
    await ctrl.respawn(dead) // use up the single respawn
    const results = await ctrl.processBatch([dead, makeDead({ sessionId: 'fresh' })])
    expect(results).toHaveLength(2)
    expect(results.find((r) => r.originalId === 'maxed-out')?.success).toBe(false)
    expect(results.find((r) => r.originalId === 'fresh')?.success).toBe(true)
  })
})

// ── History & Stats ──────────────────────────────────────────────────

describe('RespawnController — history & stats', () => {
  it('getHistory returns all respawn attempts for a session', async () => {
    const ctrl = createRespawnController(
      makeDeps(),
      makeOpts({ maxRespawns: 5, respawnCooldownMs: 0 }),
    )
    const dead = makeDead()
    await ctrl.respawn(dead)
    await ctrl.respawn(dead)
    const history = ctrl.getHistory('dead-agent-1')
    expect(history).toHaveLength(2)
    expect(history[0]!.attempt).toBe(1)
    expect(history[1]!.attempt).toBe(2)
  })

  it('getStats returns accurate totals', async () => {
    const ctrl = createRespawnController(
      makeDeps(),
      makeOpts({ maxRespawns: 1, respawnCooldownMs: 0 }),
    )
    await ctrl.respawn(makeDead({ sessionId: 'a' }))
    await ctrl.respawn(makeDead({ sessionId: 'b' }))
    // Third attempt on 'a' should fail (max reached)
    await ctrl.respawn(makeDead({ sessionId: 'a' }))
    const stats = ctrl.getStats()
    expect(stats.totalRespawns).toBe(3)
    expect(stats.successfulRespawns).toBe(2)
    expect(stats.failedRespawns).toBe(1)
    expect(stats.agentsAtMaxRespawns).toBe(2) // a and b both used their 1 respawn
  })

  it('resetCounters clears respawn count for a session', async () => {
    const ctrl = createRespawnController(
      makeDeps(),
      makeOpts({ maxRespawns: 1, respawnCooldownMs: 0 }),
    )
    const dead = makeDead()
    await ctrl.respawn(dead)
    expect(ctrl.shouldRespawn('dead-agent-1')).toBe(false)
    ctrl.resetCounters('dead-agent-1')
    expect(ctrl.shouldRespawn('dead-agent-1')).toBe(true)
  })

  it('getHistory returns empty array for unknown session', () => {
    const ctrl = createRespawnController(makeDeps(), makeOpts())
    expect(ctrl.getHistory('unknown')).toEqual([])
  })
})
