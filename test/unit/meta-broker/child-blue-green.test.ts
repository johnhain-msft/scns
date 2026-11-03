/**
 * Issue #61 (option C) — child-broker blue/green by port swap.
 *
 * The global broker is stuck with a degraded swap: its port is fixed, so the
 * old process must die before the new one can bind. Child brokers are not —
 * the meta registry assigns their ports dynamically, so green can come up on a
 * *different* port, be verified, and take over by a single registry write.
 * Nothing is ever refused, because blue is still serving when the handover
 * happens.
 *
 * These tests pin the ordering that makes that true, and the bound that keeps
 * it safe: repoint only after green is verified, drain only after the repoint,
 * and never let blue and green coexist longer than the overlap budget.
 */

import { describe, it, expect } from 'vitest'
import {
  swapChildBroker,
  DEFAULT_CHILD_SWAP_CONFIG,
  type ChildSwapDeps,
  type ProjectSnapshot,
} from '../../../src/meta-broker/child-blue-green.js'

const BLUE: ProjectSnapshot = {
  projectId: 'proj-a',
  boundPort: 3500,
  childPid: 800,
  instanceId: 'blue-instance',
  takenPorts: new Set([3501]),
}

function makeDeps(over: Partial<ChildSwapDeps> = {}): {
  deps: ChildSwapDeps
  trace: string[]
} {
  const trace: string[] = []
  const deps: ChildSwapDeps = {
    projectId: 'proj-a',
    readProject: () => BLUE,
    allocateGreenPort: async (excluded) => {
      trace.push(`allocate:excluded=${[...excluded].sort((a, b) => a - b).join(',')}`)
      return 3502
    },
    newInstanceId: () => 'green-instance',
    spawnGreen: async (o) => {
      trace.push(`spawnGreen:${o.port}:${o.instanceId}`)
      return 900
    },
    probeChild: async (port, instanceId) => {
      trace.push(`probe:${port}:${instanceId}`)
      return true
    },
    repoint: (s) => {
      trace.push(`repoint:${s.boundPort}:${s.childPid}:${s.instanceId}`)
    },
    drainBlue: async (port) => {
      trace.push(`drain:${port}`)
    },
    readActiveRequests: async () => {
      trace.push('readActive')
      return 0
    },
    stopChild: async (pid) => {
      trace.push(`stop:${pid}`)
    },
    isAlive: () => false,
    sleep: async () => {},
    now: (() => {
      let t = 1_000
      return () => (t += 100)
    })(),
    ...over,
  }
  return { deps, trace }
}

describe('swapChildBroker — the zero-downtime ordering', () => {
  it('starts green, verifies it, repoints, and only then drains and stops blue', async () => {
    const { deps, trace } = makeDeps()
    const result = await swapChildBroker(deps)

    expect(result.outcome).toBe('swapped')
    expect(trace).toEqual([
      'allocate:excluded=3500,3501',
      'spawnGreen:3502:green-instance',
      'probe:3502:green-instance',
      'repoint:3502:900:green-instance',
      'drain:3500',
      'readActive',
      'stop:800',
    ])
  })

  it('never lets the registry point at a broker it has not verified', async () => {
    // The registry IS the routing table: a repoint before verification would
    // send live sessions to a broker that may never come up.
    const { deps, trace } = makeDeps()
    await swapChildBroker(deps)
    expect(trace.indexOf('probe:3502:green-instance')).toBeLessThan(
      trace.indexOf('repoint:3502:900:green-instance'),
    )
  })

  it('keeps blue serving until after the handover — that is the whole point', async () => {
    const { deps, trace } = makeDeps()
    await swapChildBroker(deps)
    expect(trace.indexOf('repoint:3502:900:green-instance')).toBeLessThan(
      trace.indexOf('drain:3500'),
    )
  })

  it('excludes blue\u2019s own port from the green allocation', async () => {
    const { deps, trace } = makeDeps()
    await swapChildBroker(deps)
    expect(trace[0]).toContain('3500')
  })

  it('gives green a fresh instance id so the health probe cannot be satisfied by blue', async () => {
    const { deps } = makeDeps()
    const result = await swapChildBroker(deps)
    expect(result.greenInstanceId).toBe('green-instance')
    expect(result.greenInstanceId).not.toBe(BLUE.instanceId)
  })

  it('reports the measured overlap between green coming up and blue stopping', async () => {
    const { deps } = makeDeps()
    const result = await swapChildBroker(deps)
    expect(result.overlapMs).not.toBeNull()
    expect(result.overlapMs!).toBeGreaterThan(0)
  })
})

describe('swapChildBroker — green fails', () => {
  it('leaves blue registered and running when green never becomes healthy', async () => {
    const { deps, trace } = makeDeps({ probeChild: async () => false })
    const result = await swapChildBroker({
      ...deps,
      config: { healthTimeoutMs: 30, pollMs: 10 },
    })

    expect(result.outcome).toBe('green-failed')
    expect(trace.some((t) => t.startsWith('repoint'))).toBe(false)
    expect(trace).not.toContain('drain:3500')
    expect(trace).not.toContain('stop:800')
  })

  it('stops the failed green, so a rejected swap leaves no orphan holding a port', async () => {
    const { deps, trace } = makeDeps({ probeChild: async () => false })
    await swapChildBroker({ ...deps, config: { healthTimeoutMs: 30, pollMs: 10 } })
    expect(trace).toContain('stop:900')
  })

  it('fails the swap when green cannot be spawned at all', async () => {
    const { deps, trace } = makeDeps({ spawnGreen: async () => null })
    const result = await swapChildBroker(deps)
    expect(result.outcome).toBe('green-failed')
    expect(result.phases.find((p) => p.phase === 'spawn-green')?.ok).toBe(false)
    expect(trace.some((t) => t.startsWith('repoint'))).toBe(false)
  })

  it('fails the swap — without touching blue — when the port allocator is exhausted', async () => {
    const { deps, trace } = makeDeps({
      allocateGreenPort: async () => {
        throw new Error('allocatePort: port pool exhausted')
      },
    })
    const result = await swapChildBroker(deps)
    expect(result.outcome).toBe('green-failed')
    expect(result.phases.find((p) => p.phase === 'allocate')?.detail).toContain('exhausted')
    expect(trace.some((t) => t.startsWith('spawnGreen'))).toBe(false)
  })
})

describe('swapChildBroker — degenerate states', () => {
  it('reports not-registered and spawns nothing for an unknown project', async () => {
    const { deps, trace } = makeDeps({ readProject: () => null })
    const result = await swapChildBroker(deps)
    expect(result.outcome).toBe('not-registered')
    expect(trace).toEqual([])
  })

  it('just starts and registers green when no child is currently running', async () => {
    const { deps, trace } = makeDeps({
      readProject: () => ({
        projectId: 'proj-a',
        boundPort: null,
        childPid: null,
        instanceId: null,
        takenPorts: new Set([3501]),
      }),
    })
    const result = await swapChildBroker(deps)
    expect(result.outcome).toBe('no-blue')
    expect(trace.some((t) => t.startsWith('repoint'))).toBe(true)
    expect(trace).not.toContain('drain:3500')
    expect(result.overlapMs).toBeNull()
  })

  it('treats a registered port with no pid as no-blue rather than killing pid 0', async () => {
    const { deps, trace } = makeDeps({
      readProject: () => ({ ...BLUE, childPid: null }),
    })
    const result = await swapChildBroker(deps)
    expect(result.outcome).toBe('no-blue')
    expect(trace.every((t) => !t.startsWith('stop:'))).toBe(true)
  })
})

describe('swapChildBroker — the overlap budget', () => {
  /**
   * Blue and green share one SQLite file. Poller-gated background work is
   * protected by the `background_tasks` advisory lock, but the cron scheduler
   * claims nothing across processes and fires an immediate tick on start — so
   * two live brokers can run the same due task twice. The budget exists to keep
   * the coexistence window far shorter than the 60s scheduler interval; it is
   * a bound, not a preference, and a slow drain must not be allowed to widen it.
   */
  it('stops blue on schedule even when it will not finish draining', async () => {
    const { deps, trace } = makeDeps({ readActiveRequests: async () => 5 })
    const result = await swapChildBroker({
      ...deps,
      config: { maxOverlapMs: 300, pollMs: 10 },
    })
    expect(result.outcome).toBe('swapped')
    expect(result.phases.find((p) => p.phase === 'drain-blue')?.ok).toBe(false)
    expect(result.phases.find((p) => p.phase === 'drain-blue')?.detail).toContain('5 active')
    expect(trace).toContain('stop:800')
  })

  it('keeps the default budget well under the scheduler interval', () => {
    // 60_000 is DEFAULT_INTERVAL_MS in broker/services/task-scheduler.ts.
    expect(DEFAULT_CHILD_SWAP_CONFIG.maxOverlapMs).toBeLessThan(60_000 / 2)
  })

  it('reports — but does not undo — a blue that refuses to die', async () => {
    // Green is already serving and the registry already points at it. Rolling
    // back here would take down a healthy broker to fix a leaked one.
    const { deps } = makeDeps({ isAlive: () => true })
    const result = await swapChildBroker({
      ...deps,
      config: { stopGraceMs: 30, pollMs: 10 },
    })
    expect(result.outcome).toBe('swapped')
    expect(result.blueStopped).toBe(false)
    expect(result.phases.find((p) => p.phase === 'stop-blue')?.ok).toBe(false)
    expect(result.phases.find((p) => p.phase === 'stop-blue')?.detail).toContain('800')
  })

  it('escalates to forceStopChild when blue survives SIGTERM plus the full grace', async () => {
    // A blue that shrugs off SIGTERM is split-brain: it shares green's SQLite
    // DB (cron tasks run twice) and keeps serving sessions pinned to its URL.
    let killed = false
    const { deps, trace } = makeDeps({
      isAlive: () => !killed,
      forceStopChild: async (pid) => {
        trace.push(`forceStop:${pid}`)
        killed = true
      },
    })
    const result = await swapChildBroker({
      ...deps,
      config: { stopGraceMs: 30, pollMs: 10 },
    })
    expect(result.outcome).toBe('swapped')
    expect(trace).toContain('forceStop:800')
    expect(result.blueStopped).toBe(true)
    expect(result.phases.find((p) => p.phase === 'stop-blue')?.ok).toBe(true)
  })

  it('escalates on a failed green too — it is in neither the live map nor the registry', async () => {
    // A failed green was never claimed anywhere: if this cleanup leaks it, the
    // half-booted broker holds the project's data.db and a pool port forever,
    // invisible to stop() and to operators — and the retry loop spawns another
    // one every cooldown.
    let killed = false
    const { deps, trace } = makeDeps({
      probeChild: async () => false,
      isAlive: () => !killed,
      forceStopChild: async (pid) => {
        trace.push(`forceStop:${pid}`)
        killed = true
      },
    })
    const result = await swapChildBroker({
      ...deps,
      config: { healthTimeoutMs: 30, stopGraceMs: 30, pollMs: 10 },
    })
    expect(result.outcome).toBe('green-failed')
    expect(trace).toContain('stop:900')
    expect(trace).toContain('forceStop:900')
    // Blue untouched throughout.
    expect(trace).not.toContain('stop:800')
    expect(trace).not.toContain('forceStop:800')
  })

  it('survives a drain request that the dying blue refuses to answer', async () => {
    const { deps, trace } = makeDeps({
      drainBlue: async () => {
        throw new Error('ECONNREFUSED')
      },
    })
    const result = await swapChildBroker(deps)
    expect(result.outcome).toBe('swapped')
    expect(trace).toContain('stop:800')
  })
})
