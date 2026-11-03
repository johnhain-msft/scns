/**
 * Issue #61 — platform-aware broker restart.
 *
 * `scns watchdog run` hardcoded `launchctl kickstart -k` as its restart dep, so
 * on Windows the one component whose decision core was already portable could
 * observe a dead broker and do nothing about it. These tests pin the three
 * strategies, and — more importantly — the ordering and refusal rules of the
 * Windows relaunch path, where getting it wrong means either a second broker
 * fighting for the port or a kill with no respawn.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  selectRestartStrategy,
  buildLaunchctlRestart,
  buildLaunchctlBootout,
  buildLaunchctlBootstrap,
  buildSystemctlRestart,
  buildBrokerSpawn,
  createPlatformRestarter,
  createPlatformRollback,
  type PlatformRestarterDeps,
} from '../../../../src/broker/services/platform-restart.js'
import { SUPERVISED_ENV } from '../../../../src/broker/services/supervision.js'

describe('selectRestartStrategy', () => {
  it('maps each platform to its native mechanism', () => {
    expect(selectRestartStrategy('darwin')).toBe('launchctl')
    expect(selectRestartStrategy('linux')).toBe('systemctl')
    expect(selectRestartStrategy('win32')).toBe('relaunch')
  })

  it('falls back to relaunch on an unknown platform rather than throwing', () => {
    expect(selectRestartStrategy('aix' as NodeJS.Platform)).toBe('relaunch')
  })
})

describe('command builders', () => {
  it('builds the exact launchctl invocation the pre-#61 watchdog used', () => {
    expect(buildLaunchctlRestart({ uid: 501, label: 'com.scns.broker' })).toEqual({
      command: 'launchctl',
      args: ['kickstart', '-k', 'gui/501/com.scns.broker'],
    })
  })

  it('builds a systemd user-unit restart', () => {
    expect(buildSystemctlRestart({ service: 'scns' })).toEqual({
      command: 'systemctl',
      args: ['--user', 'restart', 'scns'],
    })
  })

  it('builds a broker spawn that announces the supervisor to its child', () => {
    const spec = buildBrokerSpawn({
      execPath: 'C:\\node\\node.exe',
      scriptPath: 'C:\\scns\\dist\\cli.js',
      port: 3456,
      autonomyLevel: 2,
    })
    expect(spec.command).toBe('C:\\node\\node.exe')
    expect(spec.args).toEqual([
      'C:\\scns\\dist\\cli.js',
      'start',
      '--port',
      '3456',
      '--autonomy',
      '2',
    ])
    // Without this the relaunched broker refuses to arm self-heal (supervision.ts).
    expect(spec.env[SUPERVISED_ENV]).toBe('1')
  })

  it('omits --autonomy when the caller does not pin one', () => {
    const spec = buildBrokerSpawn({
      execPath: 'node',
      scriptPath: 'cli.js',
      port: 3456,
    })
    expect(spec.args).toEqual(['cli.js', 'start', '--port', '3456'])
  })
})

// ── relaunch harness ────────────────────────────────────────────────

function relaunchHarness(
  overrides: Partial<PlatformRestarterDeps> & { livePids?: Array<number | null> } = {},
) {
  const runCommand = vi.fn()
  const spawnBroker = vi.fn(() => 9001)
  const stopPid = vi.fn()
  const sleep = vi.fn(async () => {})
  let aliveAfterStop = false
  const livePids = overrides.livePids ?? [4242]
  let call = 0
  const deps: PlatformRestarterDeps = {
    platform: 'win32',
    runCommand,
    spawnBroker,
    readLivePid: () => livePids[Math.min(call++, livePids.length - 1)] ?? null,
    stopPid,
    isAlive: () => aliveAfterStop,
    sleep,
    spawnSpec: buildBrokerSpawn({ execPath: 'node', scriptPath: 'cli.js', port: 3456 }),
    ...overrides,
  }
  return {
    deps,
    runCommand,
    spawnBroker,
    stopPid,
    sleep,
    setAliveAfterStop: (v: boolean) => {
      aliveAfterStop = v
    },
  }
}

describe('createPlatformRestarter — darwin', () => {
  it('runs launchctl kickstart and never spawns anything itself', async () => {
    const runCommand = vi.fn()
    const spawnBroker = vi.fn()
    const restart = createPlatformRestarter({
      platform: 'darwin',
      runCommand,
      spawnBroker,
      readLivePid: () => null,
      stopPid: vi.fn(),
      isAlive: () => false,
      sleep: async () => {},
      launchd: { uid: 501, label: 'com.scns.broker' },
    })
    const out = await restart()
    expect(out.strategy).toBe('launchctl')
    expect(runCommand).toHaveBeenCalledWith(
      { command: 'launchctl', args: ['kickstart', '-k', 'gui/501/com.scns.broker'] },
      expect.anything(),
    )
    expect(spawnBroker).not.toHaveBeenCalled()
  })
})

describe('createPlatformRestarter — linux', () => {
  it('runs systemctl --user restart', async () => {
    const runCommand = vi.fn()
    const restart = createPlatformRestarter({
      platform: 'linux',
      runCommand,
      spawnBroker: vi.fn(),
      readLivePid: () => null,
      stopPid: vi.fn(),
      isAlive: () => false,
      sleep: async () => {},
      systemd: { service: 'scns' },
    })
    const out = await restart()
    expect(out.strategy).toBe('systemctl')
    expect(runCommand).toHaveBeenCalledWith(
      { command: 'systemctl', args: ['--user', 'restart', 'scns'] },
      expect.anything(),
    )
  })
})

describe('createPlatformRestarter — win32 relaunch', () => {
  it('spawns immediately when no broker process is alive (the dead-stack case)', async () => {
    const h = relaunchHarness({ livePids: [null] })
    const out = await createPlatformRestarter(h.deps)()
    expect(h.stopPid).not.toHaveBeenCalled()
    expect(h.spawnBroker).toHaveBeenCalledTimes(1)
    expect(out.strategy).toBe('relaunch')
    expect(out.stoppedPid).toBeNull()
    expect(out.spawnedPid).toBe(9001)
  })

  it('stops the hung broker BEFORE spawning a replacement', async () => {
    const order: string[] = []
    const h = relaunchHarness()
    h.deps.stopPid = vi.fn(() => {
      order.push('stop')
    })
    h.deps.spawnBroker = vi.fn(() => {
      order.push('spawn')
      return 9001
    })
    const out = await createPlatformRestarter(h.deps)()
    expect(order).toEqual(['stop', 'spawn'])
    expect(h.deps.stopPid).toHaveBeenCalledWith(4242)
    expect(out.stoppedPid).toBe(4242)
  })

  it('REFUSES to spawn when the old process survives the stop grace', async () => {
    const h = relaunchHarness()
    h.setAliveAfterStop(true)
    // Fake clock: `sleep` advances time, so the grace elapses without the test
    // burning wall-clock (and without going flaky when the CI box is loaded).
    let clock = 0
    const out = await createPlatformRestarter({
      ...h.deps,
      stopGraceMs: 300,
      pollMs: 100,
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms
      },
    })()
    expect(h.stopPid).toHaveBeenCalled()
    expect(h.spawnBroker).not.toHaveBeenCalled()
    expect(out.spawnedPid).toBeNull()
    expect(out.detail).toMatch(/still alive|did not exit/i)
  })

  it('waits for the stopped process to actually exit before spawning', async () => {
    const h = relaunchHarness()
    let calls = 0
    let clock = 0
    const out = await createPlatformRestarter({
      ...h.deps,
      isAlive: () => {
        calls += 1
        return calls < 3 // dies on the 3rd poll
      },
      stopGraceMs: 5_000,
      pollMs: 10,
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms
      },
    })()
    expect(h.spawnBroker).toHaveBeenCalledTimes(1)
    expect(out.spawnedPid).toBe(9001)
  })

  it('reports a failed spawn instead of pretending it worked', async () => {
    const h = relaunchHarness({ livePids: [null] })
    const out = await createPlatformRestarter({
      ...h.deps,
      spawnBroker: vi.fn(() => null),
    })()
    expect(out.spawnedPid).toBeNull()
    expect(out.detail).toMatch(/spawn/i)
  })

  it('throws at WIRING time when relaunch has no spawn spec — not at 3am', () => {
    const h = relaunchHarness()
    const { spawnSpec: _omitted, ...withoutSpec } = h.deps
    expect(() => createPlatformRestarter(withoutSpec as PlatformRestarterDeps)).toThrow(/spawn/i)
  })

  it('throws at wiring time when launchctl has no label/uid', () => {
    expect(() =>
      createPlatformRestarter({
        platform: 'darwin',
        runCommand: vi.fn(),
        spawnBroker: vi.fn(),
        readLivePid: () => null,
        stopPid: vi.fn(),
        isAlive: () => false,
        sleep: async () => {},
      }),
    ).toThrow(/launchd/i)
  })

  it('an explicit strategy override beats the platform (lets a Mac test the win32 path)', async () => {
    const h = relaunchHarness()
    const out = await createPlatformRestarter({
      ...h.deps,
      platform: 'darwin',
      strategy: 'relaunch',
    })()
    expect(out.strategy).toBe('relaunch')
    expect(h.spawnBroker).toHaveBeenCalled()
  })

  it('surfaces a stop failure without aborting the restart attempt', async () => {
    const h = relaunchHarness()
    const out = await createPlatformRestarter({
      ...h.deps,
      stopPid: vi.fn(() => {
        throw new Error('Access is denied.')
      }),
    })()
    // The process was not ours to kill, but it is also not alive per isAlive(),
    // so a spawn is still the right move — and the error must be visible.
    expect(out.detail).toContain('Access is denied.')
    expect(h.spawnBroker).toHaveBeenCalled()
  })
})

// ── rollback (#61 option C) ─────────────────────────────────────────
//
// `scripts/broker-restart.sh rollback` re-bootstraps the blue plist, which is
// deliberately NOT the same command as a restart: `kickstart -k` fails when the
// job is not loaded, and "not loaded" is exactly the state a failed restart
// tends to leave behind. The rollback path has to be able to load it.

describe('createPlatformRollback — darwin', () => {
  it('boots the job out and back in, mirroring broker-restart.sh rollback', async () => {
    const runCommand = vi.fn()
    const rollback = createPlatformRollback({
      platform: 'darwin',
      runCommand,
      spawnBroker: vi.fn(),
      readLivePid: () => null,
      stopPid: vi.fn(),
      isAlive: () => false,
      sleep: async () => {},
      launchd: {
        uid: 501,
        label: 'com.scns.broker',
        plistPath: '/Users/j/L/com.scns.broker.plist',
      },
    })
    const out = await rollback()
    expect(out.strategy).toBe('launchctl')
    expect(runCommand.mock.calls.map((c) => (c[0] as { args: string[] }).args)).toEqual([
      ['bootout', 'gui/501', '/Users/j/L/com.scns.broker.plist'],
      ['bootstrap', 'gui/501', '/Users/j/L/com.scns.broker.plist'],
    ])
  })

  it('ignores a bootout failure — the job simply was not loaded', async () => {
    const runCommand = vi.fn((spec: { args: readonly string[] }) => {
      if (spec.args[0] === 'bootout') throw new Error('No such process')
    })
    const rollback = createPlatformRollback({
      platform: 'darwin',
      runCommand,
      spawnBroker: vi.fn(),
      readLivePid: () => null,
      stopPid: vi.fn(),
      isAlive: () => false,
      sleep: async () => {},
      launchd: { uid: 501, label: 'com.scns.broker', plistPath: '/p.plist' },
    })
    const out = await rollback()
    expect(out.detail).toContain('bootstrap')
    expect(runCommand).toHaveBeenCalledTimes(2)
  })

  it('retries bootstrap once before giving up, as the shell script does', async () => {
    let bootstraps = 0
    const runCommand = vi.fn((spec: { args: readonly string[] }) => {
      if (spec.args[0] === 'bootstrap') {
        bootstraps += 1
        if (bootstraps === 1) throw new Error('Input/output error')
      }
    })
    const rollback = createPlatformRollback({
      platform: 'darwin',
      runCommand,
      spawnBroker: vi.fn(),
      readLivePid: () => null,
      stopPid: vi.fn(),
      isAlive: () => false,
      sleep: async () => {},
      launchd: { uid: 501, label: 'com.scns.broker', plistPath: '/p.plist' },
    })
    const out = await rollback()
    expect(bootstraps).toBe(2)
    expect(out.detail).toContain('retry')
  })

  it('throws when the second bootstrap also fails, so the caller reports exit 2', async () => {
    const rollback = createPlatformRollback({
      platform: 'darwin',
      runCommand: () => {
        throw new Error('Input/output error')
      },
      spawnBroker: vi.fn(),
      readLivePid: () => null,
      stopPid: vi.fn(),
      isAlive: () => false,
      sleep: async () => {},
      launchd: { uid: 501, label: 'com.scns.broker', plistPath: '/p.plist' },
    })
    await expect(rollback()).rejects.toThrow(/Input\/output error/)
  })

  it('refuses to be built without a plist path — kickstart cannot load an unloaded job', () => {
    expect(() =>
      createPlatformRollback({
        platform: 'darwin',
        runCommand: vi.fn(),
        spawnBroker: vi.fn(),
        readLivePid: () => null,
        stopPid: vi.fn(),
        isAlive: () => false,
        sleep: async () => {},
        launchd: { uid: 501, label: 'com.scns.broker' },
      }),
    ).toThrow(/plistPath/i)
  })
})

describe('createPlatformRollback — linux and relaunch', () => {
  it('restarts the systemd user unit', async () => {
    const runCommand = vi.fn()
    const out = await createPlatformRollback({
      platform: 'linux',
      runCommand,
      spawnBroker: vi.fn(),
      readLivePid: () => null,
      stopPid: vi.fn(),
      isAlive: () => false,
      sleep: async () => {},
      systemd: { service: 'scns' },
    })()
    expect(out.strategy).toBe('systemctl')
    expect(runCommand).toHaveBeenCalledWith(
      { command: 'systemctl', args: ['--user', 'restart', 'scns'] },
      expect.anything(),
    )
  })

  it('is the same stop-then-spawn as a restart where there is no service manager', async () => {
    const h = relaunchHarness()
    const out = await createPlatformRollback(h.deps)()
    expect(out.strategy).toBe('relaunch')
    expect(h.stopPid).toHaveBeenCalledWith(4242)
    expect(h.spawnBroker).toHaveBeenCalled()
    expect(out.spawnedPid).toBe(9001)
  })

  it('still refuses to spawn a second broker onto a port the old one holds', async () => {
    const h = relaunchHarness()
    h.setAliveAfterStop(true)
    const out = await createPlatformRollback({ ...h.deps, stopGraceMs: 30, pollMs: 10 })()
    expect(h.spawnBroker).not.toHaveBeenCalled()
    expect(out.detail).toContain('refusing to spawn')
  })
})

describe('buildLaunchctl bootout/bootstrap', () => {
  it('addresses the domain, not the job label — bootstrap takes a path', () => {
    expect(buildLaunchctlBootout({ uid: 501, plistPath: '/p.plist' })).toEqual({
      command: 'launchctl',
      args: ['bootout', 'gui/501', '/p.plist'],
    })
    expect(buildLaunchctlBootstrap({ uid: 501, plistPath: '/p.plist' })).toEqual({
      command: 'launchctl',
      args: ['bootstrap', 'gui/501', '/p.plist'],
    })
  })
})
