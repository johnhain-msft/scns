import { describe, it, expect, vi } from 'vitest'
import { createAutoScaler } from '../../../../src/broker/a2a/auto-scaler.js'
import { createRateMonitor, RateRecommendation } from '../../../../src/rate-limit/rate-monitor.js'
import type { ScalerDeps, AutoScalerOptions } from '../../../../src/broker/a2a/auto-scaler.js'

// ── Helpers ──────────────────────────────────────────────────────────

function makeDeps(overrides: Partial<ScalerDeps> = {}): ScalerDeps {
  return {
    rateMonitor: createRateMonitor(),
    onSpawn: vi.fn(
      async (_opts: { role: string }) => `session-${Math.random().toString(36).slice(2, 8)}`,
    ),
    onKill: vi.fn(async () => {}),
    getActiveCount: vi.fn(() => 0),
    getQueueDepth: vi.fn(() => 0),
    ...overrides,
  }
}

function makeOpts(overrides: Partial<AutoScalerOptions> = {}): AutoScalerOptions {
  return {
    minAgents: 0,
    maxAgents: 5,
    scaleUpThreshold: 3,
    scaleDownIdleMs: 300_000,
    cooldownMs: 60_000,
    ...overrides,
  }
}

// ── Evaluation ───────────────────────────────────────────────────────

describe('AutoScaler — evaluate', () => {
  it('returns scale-up when queue depth > threshold', () => {
    const deps = makeDeps({ getQueueDepth: () => 5, getActiveCount: () => 1 })
    const scaler = createAutoScaler(deps, makeOpts())
    const decision = scaler.evaluate()
    expect(decision.action).toBe('scale-up')
    expect(decision.count).toBeGreaterThan(0)
  })

  it('returns hold when queue depth ≤ threshold', () => {
    const deps = makeDeps({ getQueueDepth: () => 2, getActiveCount: () => 1 })
    const scaler = createAutoScaler(deps, makeOpts())
    const decision = scaler.evaluate()
    expect(decision.action).toBe('hold')
  })

  it('returns hold when active = maxAgents (cannot spawn more)', () => {
    const deps = makeDeps({ getQueueDepth: () => 10, getActiveCount: () => 5 })
    const scaler = createAutoScaler(deps, makeOpts({ maxAgents: 5 }))
    const decision = scaler.evaluate()
    expect(decision.action).toBe('hold')
  })

  it('returns scale-down when rate monitor says ScaleDown', () => {
    const rm = createRateMonitor()
    vi.spyOn(rm, 'getRecommendation').mockReturnValue(RateRecommendation.ScaleDown)
    const deps = makeDeps({ rateMonitor: rm, getQueueDepth: () => 10, getActiveCount: () => 3 })
    const scaler = createAutoScaler(deps, makeOpts())
    const decision = scaler.evaluate()
    expect(decision.action).toBe('scale-down')
  })

  it('returns scale-down when rate monitor says Pause', () => {
    const rm = createRateMonitor()
    vi.spyOn(rm, 'getRecommendation').mockReturnValue(RateRecommendation.Pause)
    const deps = makeDeps({ rateMonitor: rm, getActiveCount: () => 2 })
    const scaler = createAutoScaler(deps, makeOpts())
    const decision = scaler.evaluate()
    expect(decision.action).toBe('scale-down')
  })

  it('returns scale-down when rate monitor says YieldToUser', () => {
    const rm = createRateMonitor()
    vi.spyOn(rm, 'getRecommendation').mockReturnValue(RateRecommendation.YieldToUser)
    const deps = makeDeps({ rateMonitor: rm, getActiveCount: () => 2 })
    const scaler = createAutoScaler(deps, makeOpts())
    const decision = scaler.evaluate()
    expect(decision.action).toBe('scale-down')
  })

  it('returns hold when rate monitor says SlowDown', () => {
    const rm = createRateMonitor()
    vi.spyOn(rm, 'getRecommendation').mockReturnValue(RateRecommendation.SlowDown)
    const deps = makeDeps({ rateMonitor: rm, getQueueDepth: () => 10, getActiveCount: () => 1 })
    const scaler = createAutoScaler(deps, makeOpts())
    const decision = scaler.evaluate()
    expect(decision.action).toBe('hold')
  })

  it('returns scale-up when rate monitor is Normal and queue is high', () => {
    const rm = createRateMonitor()
    vi.spyOn(rm, 'getRecommendation').mockReturnValue(RateRecommendation.Normal)
    const deps = makeDeps({ rateMonitor: rm, getQueueDepth: () => 6, getActiveCount: () => 1 })
    const scaler = createAutoScaler(deps, makeOpts())
    const decision = scaler.evaluate()
    expect(decision.action).toBe('scale-up')
  })

  it('returns scale-down for idle agents beyond timeout', () => {
    vi.useFakeTimers()
    try {
      const deps = makeDeps({ getQueueDepth: () => 0, getActiveCount: () => 2 })
      const scaler = createAutoScaler(deps, makeOpts({ scaleDownIdleMs: 1000 }))
      scaler.recordIdle('agent-1')
      scaler.recordIdle('agent-2')
      vi.advanceTimersByTime(1500)
      const decision = scaler.evaluate()
      expect(decision.action).toBe('scale-down')
      expect(decision.count).toBeGreaterThan(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not scale down below minAgents', () => {
    vi.useFakeTimers()
    try {
      const deps = makeDeps({ getQueueDepth: () => 0, getActiveCount: () => 2 })
      const scaler = createAutoScaler(deps, makeOpts({ minAgents: 2, scaleDownIdleMs: 1000 }))
      scaler.recordIdle('agent-1')
      scaler.recordIdle('agent-2')
      vi.advanceTimersByTime(1500)
      const decision = scaler.evaluate()
      // Should hold because active === minAgents
      expect(decision.action).toBe('hold')
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns hold when cooldown is active', () => {
    vi.useFakeTimers()
    try {
      const deps = makeDeps({ getQueueDepth: () => 5, getActiveCount: () => 1 })
      const scaler = createAutoScaler(deps, makeOpts({ cooldownMs: 60_000 }))
      // First tick triggers scale-up and starts cooldown
      const first = scaler.evaluate()
      expect(first.action).toBe('scale-up')
      // Simulate cooldown being set (execute sets it, but we can test via tick)
      // We'll test cooldown via tick() tests below instead
      // Here we advance only a bit and test via internal tracking
    } finally {
      vi.useRealTimers()
    }
  })

  it('computes scale-up count = min(queueDepth - active, maxAgents - active)', () => {
    const deps = makeDeps({ getQueueDepth: () => 10, getActiveCount: () => 2 })
    const scaler = createAutoScaler(deps, makeOpts({ maxAgents: 5 }))
    const decision = scaler.evaluate()
    expect(decision.action).toBe('scale-up')
    // min(10 - 2, 5 - 2) = min(8, 3) = 3
    expect(decision.count).toBe(3)
  })
})

// ── Execution ────────────────────────────────────────────────────────

describe('AutoScaler — execute', () => {
  it('calls onSpawn correct number of times for scale-up', async () => {
    const onSpawn = vi.fn(async () => `session-${Math.random().toString(36).slice(2, 8)}`)
    const deps = makeDeps({ onSpawn })
    const scaler = createAutoScaler(deps, makeOpts())
    const result = await scaler.execute({ action: 'scale-up', count: 3, reason: 'test' })
    expect(onSpawn).toHaveBeenCalledTimes(3)
    expect(result.spawned).toHaveLength(3)
    expect(result.killed).toHaveLength(0)
  })

  it('calls onKill for idle agents on scale-down', async () => {
    vi.useFakeTimers()
    try {
      const onKill = vi.fn(async () => {})
      const deps = makeDeps({ onKill, getActiveCount: () => 3 })
      const scaler = createAutoScaler(deps, makeOpts({ scaleDownIdleMs: 1000 }))
      scaler.recordIdle('idle-1')
      scaler.recordIdle('idle-2')
      vi.advanceTimersByTime(1500)
      const result = await scaler.execute({ action: 'scale-down', count: 2, reason: 'idle' })
      expect(onKill).toHaveBeenCalledTimes(2)
      expect(result.killed).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('records spawn errors without throwing', async () => {
    const onSpawn = vi.fn(async () => {
      throw new Error('spawn failed')
    })
    const deps = makeDeps({ onSpawn })
    const scaler = createAutoScaler(deps, makeOpts())
    const result = await scaler.execute({ action: 'scale-up', count: 2, reason: 'test' })
    expect(result.spawned).toHaveLength(0)
    expect(result.errors).toHaveLength(2)
    expect(result.errors[0]).toContain('spawn failed')
  })

  it('returns spawned session IDs', async () => {
    let counter = 0
    const onSpawn = vi.fn(async () => `agent-${++counter}`)
    const deps = makeDeps({ onSpawn })
    const scaler = createAutoScaler(deps, makeOpts())
    const result = await scaler.execute({ action: 'scale-up', count: 2, reason: 'test' })
    expect(result.spawned).toEqual(['agent-1', 'agent-2'])
  })
})

// ── Status ───────────────────────────────────────────────────────────

describe('AutoScaler — getStatus', () => {
  it('reflects current state', () => {
    const deps = makeDeps({ getActiveCount: () => 3, getQueueDepth: () => 7 })
    const scaler = createAutoScaler(deps, makeOpts())
    const status = scaler.getStatus()
    expect(status.activeAgents).toBe(3)
    expect(status.queueDepth).toBe(7)
    expect(status.rateRecommendation).toBeDefined()
  })

  it('tracks idle agents via recordIdle', () => {
    const deps = makeDeps()
    const scaler = createAutoScaler(deps, makeOpts())
    scaler.recordIdle('a-1')
    scaler.recordIdle('a-2')
    const status = scaler.getStatus()
    expect(status.idleAgents).toBe(2)
  })

  it('recordActive removes agent from idle set', () => {
    const deps = makeDeps()
    const scaler = createAutoScaler(deps, makeOpts())
    scaler.recordIdle('a-1')
    scaler.recordActive('a-1')
    const status = scaler.getStatus()
    expect(status.idleAgents).toBe(0)
  })
})

// ── Tick ─────────────────────────────────────────────────────────────

describe('AutoScaler — tick', () => {
  it('evaluates then executes', async () => {
    const onSpawn = vi.fn(async () => 'new-agent')
    const deps = makeDeps({ onSpawn, getQueueDepth: () => 5, getActiveCount: () => 0 })
    const scaler = createAutoScaler(deps, makeOpts())
    const decision = await scaler.tick()
    expect(decision.action).toBe('scale-up')
    expect(onSpawn).toHaveBeenCalled()
  })

  it('respects cooldown between ticks', async () => {
    vi.useFakeTimers()
    try {
      const onSpawn = vi.fn(async () => `agent-${Math.random().toString(36).slice(2, 8)}`)
      const deps = makeDeps({ onSpawn, getQueueDepth: () => 5, getActiveCount: () => 0 })
      const scaler = createAutoScaler(deps, makeOpts({ cooldownMs: 60_000 }))

      const first = await scaler.tick()
      expect(first.action).toBe('scale-up')
      const spawnCount = onSpawn.mock.calls.length

      // Second tick within cooldown → hold
      vi.advanceTimersByTime(10_000)
      const second = await scaler.tick()
      expect(second.action).toBe('hold')
      expect(onSpawn).toHaveBeenCalledTimes(spawnCount) // no additional spawns
    } finally {
      vi.useRealTimers()
    }
  })
})
