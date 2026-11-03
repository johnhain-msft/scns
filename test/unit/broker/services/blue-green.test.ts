/**
 * Issue #61 (option C) — cross-platform blue/green restart.
 *
 * `scripts/broker-restart.sh` was the only thing that knew the restart
 * sequence, and it is bash + launchctl + python3. On Windows that meant the
 * daily maintenance restart, and the `POST /api/admin/rollback` handler that
 * spawns it, simply did not exist — `onRollback` shelled out to `bash`.
 *
 * These tests pin the two properties that make the sequence safe rather than
 * merely automated:
 *
 *   1. The canary is a GATE. A canary that will not come up must abort the
 *      restart *before* blue is drained — the whole point of validating the
 *      binary on a throwaway port is to not have killed production first.
 *   2. A green that fails verification must roll back, and the caller must be
 *      able to tell "rolled back" (degraded but serving) from "rollback also
 *      failed" (someone has to get up).
 */

import { describe, it, expect, vi } from 'vitest'
import {
  runBlueGreenRestart,
  restartStartedSomething,
  DEFAULT_BLUE_GREEN_CONFIG,
  type BlueGreenDeps,
  type CanaryHandle,
} from '../../../../src/broker/services/blue-green.js'
import {
  createPlatformRestarter,
  type RestartOutcome,
} from '../../../../src/broker/services/platform-restart.js'

const okRestart: RestartOutcome = {
  strategy: 'launchctl',
  stoppedPid: null,
  spawnedPid: null,
  detail: 'launchctl kickstart -k gui/501/com.scns.broker',
}

function makeCanary(): CanaryHandle & { stopped: number } {
  const h = {
    pid: 4242,
    stopped: 0,
    async stop() {
      h.stopped += 1
    },
    readLog: () => 'canary log',
  }
  return h
}

/** Deps whose happy path succeeds, with a call-order trace for sequencing assertions. */
function makeDeps(over: Partial<BlueGreenDeps> = {}): {
  deps: BlueGreenDeps
  trace: string[]
  canary: ReturnType<typeof makeCanary>
} {
  const trace: string[] = []
  const canary = makeCanary()
  const deps: BlueGreenDeps = {
    mainPort: 3456,
    canaryPort: 3457,
    prepare: async () => {
      trace.push('prepare')
      return { ok: true, detail: 'success=true' }
    },
    startCanary: async (port) => {
      trace.push(`startCanary:${port}`)
      return canary
    },
    probeReady: async (port) => {
      trace.push(`probeReady:${port}`)
      return true
    },
    drain: async () => {
      trace.push('drain')
    },
    readActiveRequests: async () => {
      trace.push('readActive')
      return 0
    },
    snapshotAgents: async () => {
      trace.push('snapshot')
      return { ok: true, count: 2 }
    },
    restart: async () => {
      trace.push('restart')
      return okRestart
    },
    rollback: async () => {
      trace.push('rollback')
      return okRestart
    },
    sleep: async () => {},
    now: (() => {
      let t = 1_000
      return () => (t += 100)
    })(),
    ...over,
  }
  return { deps, trace, canary }
}

describe('runBlueGreenRestart — happy path', () => {
  it('runs prepare → canary → drain → snapshot → restart → verify and exits 0', async () => {
    const { deps, trace } = makeDeps()
    const result = await runBlueGreenRestart(deps)

    expect(result.outcome).toBe('success')
    expect(result.exitCode).toBe(0)
    expect(trace).toEqual([
      'prepare',
      'startCanary:3457',
      'probeReady:3457',
      'drain',
      'readActive',
      'snapshot',
      'restart',
      'probeReady:3456',
    ])
    expect(result.phases.map((p) => p.phase)).toEqual([
      'prepare',
      'canary-start',
      'canary-health',
      'drain',
      'snapshot',
      'restart',
      'verify',
    ])
    expect(result.phases.every((p) => p.ok)).toBe(true)
  })

  it('stops the canary once it has served its purpose, before blue is touched', async () => {
    const { deps, trace, canary } = makeDeps()
    await runBlueGreenRestart(deps)
    expect(canary.stopped).toBe(1)
    // The canary is validation only: it must not still be holding its port
    // while the real restart happens.
    expect(trace.indexOf('drain')).toBeGreaterThan(trace.indexOf('probeReady:3457'))
  })

  it('reports the degraded-gap window between the restart and a healthy green', async () => {
    const { deps } = makeDeps()
    const result = await runBlueGreenRestart(deps)
    // now() advances 100ms per call; the gap is measured, not assumed.
    expect(result.gapMs).not.toBeNull()
    expect(result.gapMs!).toBeGreaterThan(0)
  })

  /**
   * Caught by a live run: the canary and verify waits happen BEFORE their phase
   * is recorded, so a naive `record` timed only the closure and printed the one
   * genuinely slow step in the whole sequence as `0ms`. A report that hides the
   * cost of waiting is worse than no report.
   */
  it('attributes the wait itself to the phase that waited', async () => {
    let calls = 0
    const { deps } = makeDeps({
      // Green is not ready until the third probe — a real wait, not instant.
      probeReady: async (port) => (port === 3456 ? ++calls >= 3 : true),
    })
    const result = await runBlueGreenRestart({ ...deps, config: { pollMs: 5 } })
    expect(result.outcome).toBe('success')
    const verify = result.phases.find((p) => p.phase === 'verify')!
    expect(verify.durationMs).toBeGreaterThan(0)
  })

  it('attributes a canary wait to canary-health rather than reporting 0ms', async () => {
    let calls = 0
    const { deps } = makeDeps({
      probeReady: async (port) => (port === 3457 ? ++calls >= 3 : true),
    })
    const result = await runBlueGreenRestart({ ...deps, config: { pollMs: 5 } })
    const health = result.phases.find((p) => p.phase === 'canary-health')!
    expect(health.ok).toBe(true)
    expect(health.durationMs).toBeGreaterThan(0)
  })
})

describe('runBlueGreenRestart — the canary is a gate', () => {
  it('aborts before draining blue when the canary never becomes healthy', async () => {
    const { deps, trace, canary } = makeDeps({
      probeReady: async (port) => port !== 3457,
    })
    const result = await runBlueGreenRestart({ ...deps, config: { healthTimeoutMs: 30 } })

    expect(result.outcome).toBe('canary-failed')
    expect(result.exitCode).toBe(1)
    // The entire point: production was never touched.
    expect(trace).not.toContain('drain')
    expect(trace).not.toContain('restart')
    expect(trace).not.toContain('rollback')
    expect(canary.stopped).toBe(1)
  })

  it('aborts when the canary process cannot even be spawned', async () => {
    const { deps, trace } = makeDeps({ startCanary: async () => null })
    const result = await runBlueGreenRestart(deps)

    expect(result.outcome).toBe('canary-failed')
    expect(result.exitCode).toBe(1)
    expect(trace).not.toContain('drain')
    expect(result.phases.find((p) => p.phase === 'canary-start')?.ok).toBe(false)
  })

  it('carries the canary log into the failure detail so the abort is diagnosable', async () => {
    const { deps } = makeDeps({ probeReady: async (port) => port !== 3457 })
    const result = await runBlueGreenRestart({ ...deps, config: { healthTimeoutMs: 30 } })
    expect(result.phases.find((p) => p.phase === 'canary-health')?.detail).toContain('canary log')
  })

  it('can be told to skip the canary, and then never spawns one', async () => {
    const { deps, trace } = makeDeps()
    const result = await runBlueGreenRestart({ ...deps, skipCanary: true })
    expect(result.outcome).toBe('success')
    expect(trace).not.toContain('startCanary:3457')
    expect(trace[0]).toBe('prepare')
  })
})

describe('runBlueGreenRestart — non-blocking phases', () => {
  it('continues when prepare fails: phase 7 is the authoritative gate, not phase 1', async () => {
    const { deps } = makeDeps({
      prepare: async () => ({ ok: false, detail: 'dream,housekeeping' }),
    })
    const result = await runBlueGreenRestart(deps)
    expect(result.outcome).toBe('success')
    expect(result.phases.find((p) => p.phase === 'prepare')).toMatchObject({
      ok: false,
      detail: 'dream,housekeeping',
    })
  })

  it('proceeds after a drain timeout rather than leaving the broker half-drained', async () => {
    const { deps, trace } = makeDeps({ readActiveRequests: async () => 3 })
    const result = await runBlueGreenRestart({
      ...deps,
      config: { drainTimeoutMs: 30, pollMs: 10 },
    })
    expect(result.outcome).toBe('success')
    expect(result.phases.find((p) => p.phase === 'drain')?.ok).toBe(false)
    expect(result.phases.find((p) => p.phase === 'drain')?.detail).toContain('3 active')
    expect(trace).toContain('restart')
  })

  it('treats an unreadable active-request count as drained rather than blocking forever', async () => {
    const { deps } = makeDeps({ readActiveRequests: async () => null })
    const result = await runBlueGreenRestart({
      ...deps,
      config: { drainTimeoutMs: 30, pollMs: 10 },
    })
    expect(result.outcome).toBe('success')
  })

  it('continues when the agent snapshot fails — agents are lost, the restart is not', async () => {
    const { deps } = makeDeps({ snapshotAgents: async () => ({ ok: false, count: 0 }) })
    const result = await runBlueGreenRestart(deps)
    expect(result.outcome).toBe('success')
    expect(result.phases.find((p) => p.phase === 'snapshot')?.ok).toBe(false)
  })
})

describe('runBlueGreenRestart — verify and rollback', () => {
  it('rolls back and exits 3 when green fails verification but blue comes back', async () => {
    let restarted = false
    const { deps, trace } = makeDeps({
      restart: async () => {
        restarted = true
        return okRestart
      },
      probeReady: async (port) => (port === 3456 && restarted ? false : true),
    })
    const result = await runBlueGreenRestart({
      ...deps,
      config: { healthTimeoutMs: 30, pollMs: 10 },
      rollback: async () => {
        restarted = false
        trace.push('rollback')
        return okRestart
      },
    })

    expect(result.outcome).toBe('rolled-back')
    expect(result.exitCode).toBe(3)
    expect(trace).toContain('rollback')
    expect(result.phases.find((p) => p.phase === 'verify')?.ok).toBe(false)
    expect(result.phases.find((p) => p.phase === 'rollback')?.ok).toBe(true)
  })

  it('exits 2 when green fails verification AND the rollback does not restore blue', async () => {
    const { deps } = makeDeps({ probeReady: async (port) => port !== 3456 })
    const result = await runBlueGreenRestart({
      ...deps,
      config: { healthTimeoutMs: 30, pollMs: 10 },
    })
    expect(result.outcome).toBe('failed')
    expect(result.exitCode).toBe(2)
    expect(result.phases.find((p) => p.phase === 'rollback')?.ok).toBe(false)
  })

  it('exits 2 when the rollback action itself throws', async () => {
    const { deps } = makeDeps({
      probeReady: async (port) => port !== 3456,
      rollback: async () => {
        throw new Error('bootstrap: Input/output error')
      },
    })
    const result = await runBlueGreenRestart({
      ...deps,
      config: { healthTimeoutMs: 30, pollMs: 10 },
    })
    expect(result.outcome).toBe('failed')
    expect(result.exitCode).toBe(2)
    expect(result.phases.find((p) => p.phase === 'rollback')?.detail).toContain(
      'Input/output error',
    )
  })

  it('rolls back when the restart action throws instead of pretending it restarted', async () => {
    const { deps, trace } = makeDeps({
      restart: async () => {
        throw new Error('taskkill: access denied')
      },
      probeReady: async (port) => port !== 3456,
    })
    const result = await runBlueGreenRestart({
      ...deps,
      config: { healthTimeoutMs: 30, pollMs: 10 },
    })
    expect(result.phases.find((p) => p.phase === 'restart')?.ok).toBe(false)
    expect(trace).toContain('rollback')
  })
})

describe('restartStartedSomething', () => {
  it('treats a service-manager restart as started — it owns the process, not us', () => {
    expect(restartStartedSomething(okRestart)).toBe(true)
    expect(
      restartStartedSomething({ ...okRestart, strategy: 'systemctl', detail: 'systemctl' }),
    ).toBe(true)
  })

  it('treats a relaunch that spawned nothing as NOT started', () => {
    expect(
      restartStartedSomething({
        strategy: 'relaunch',
        stoppedPid: 900,
        spawnedPid: null,
        detail: 'pid 900 still alive after 10000ms',
      }),
    ).toBe(false)
  })

  it('treats a relaunch that produced a pid as started', () => {
    expect(
      restartStartedSomething({
        strategy: 'relaunch',
        stoppedPid: 900,
        spawnedPid: 901,
        detail: 'spawned',
      }),
    ).toBe(true)
  })
})

describe('the Windows path, wired to the real platform restarter', () => {
  /**
   * The failure mode this guards is specific: on a platform with no service
   * manager the restarter is a userland supervisor, and a supervisor that
   * spawns a second broker onto a port the first one still holds turns a hang
   * into a crash loop. The restarter already refuses; this pins that blue/green
   * carries the refusal through to a rollback instead of reporting success.
   */
  it('refuses to spawn while the old broker is still bound, and rolls back', async () => {
    const spawnBroker = vi.fn(() => 999)
    const restart = createPlatformRestarter({
      platform: 'win32',
      runCommand: () => {},
      spawnBroker,
      readLivePid: () => 900,
      stopPid: () => {},
      isAlive: () => true, // never dies — a wedged, still-listening broker
      sleep: async () => {},
      now: (() => {
        let t = 0
        return () => (t += 1_000)
      })(),
      spawnSpec: { command: 'node', args: ['dist/cli.js', 'start'], env: {} },
      stopGraceMs: 3_000,
    })

    const { deps, trace } = makeDeps({
      restart,
      probeReady: async (port) => port !== 3456,
    })
    const result = await runBlueGreenRestart({
      ...deps,
      config: { healthTimeoutMs: 30, pollMs: 10 },
    })

    expect(spawnBroker).not.toHaveBeenCalled()
    expect(result.phases.find((p) => p.phase === 'restart')?.ok).toBe(false)
    expect(result.phases.find((p) => p.phase === 'restart')?.detail).toContain('refusing to spawn')
    expect(trace).toContain('rollback')
    expect(result.outcome).toBe('failed')
  })

  it('accepts the short gap: it drains and snapshots before stopping the old broker', async () => {
    const order: string[] = []
    const restart = createPlatformRestarter({
      platform: 'win32',
      runCommand: () => {},
      spawnBroker: () => {
        order.push('spawn')
        return 999
      },
      readLivePid: () => 900,
      stopPid: () => order.push('stop'),
      isAlive: () => false,
      sleep: async () => {},
      spawnSpec: { command: 'node', args: ['dist/cli.js', 'start'], env: {} },
    })

    const { deps, trace } = makeDeps({
      restart: async () => {
        trace.push('restart')
        order.push('restart')
        return restart()
      },
    })
    const result = await runBlueGreenRestart(deps)

    expect(result.outcome).toBe('success')
    expect(order).toEqual(['restart', 'stop', 'spawn'])
    // The gap only opens after the work is safe: drain + snapshot precede it.
    expect(trace.indexOf('snapshot')).toBeLessThan(trace.indexOf('restart'))
    expect(result.gapMs).not.toBeNull()
  })
})

describe('DEFAULT_BLUE_GREEN_CONFIG', () => {
  it('keeps the timings the shell script used, so behaviour does not change with the port', () => {
    expect(DEFAULT_BLUE_GREEN_CONFIG).toEqual({
      healthTimeoutMs: 30_000,
      drainTimeoutMs: 30_000,
      pollMs: 1_000,
    })
  })
})
