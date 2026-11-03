/**
 * Issue #61 — real deps for the external watchdog's restart action.
 *
 * `src/cli.ts` used to build the restart closure inline, which is why it was
 * hardcoded to `launchctl kickstart -k`: there was nowhere to test an
 * alternative. These tests cover the dep construction — the part that decides
 * WHAT gets run — while `platform-restart.test.ts` covers the ordering rules.
 */

import { describe, it, expect, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildStopCommand,
  resolveWatchdogRestartConfig,
  createWatchdogRestart,
  claimSingleton,
  ensureBrokerUp,
} from '../../../src/cli/watchdog-runtime.js'
import {
  watchdogPidfilePath,
  writeBrokerPidfile,
} from '../../../src/broker/services/broker-pidfile.js'
import { SUPERVISED_ENV } from '../../../src/broker/services/supervision.js'

const WIN = {
  platform: 'win32' as NodeJS.Platform,
  port: 3456,
  scnsHome: 'C:\\Users\\jh',
  execPath: 'C:\\node\\node.exe',
  brokerEntry: 'C:\\scns\\dist\\cli.js',
}

describe('buildStopCommand', () => {
  it('uses taskkill /T on Windows so the broker takes its children with it', () => {
    expect(buildStopCommand('win32', 1234)).toEqual({
      command: 'taskkill',
      args: ['/PID', '1234', '/T', '/F'],
    })
  })

  it('uses kill -9 elsewhere', () => {
    expect(buildStopCommand('linux', 1234)).toEqual({ command: 'kill', args: ['-9', '1234'] })
  })
})

describe('resolveWatchdogRestartConfig', () => {
  it('selects launchctl on darwin and carries the label', () => {
    const c = resolveWatchdogRestartConfig({
      platform: 'darwin',
      port: 3456,
      scnsHome: '/Users/jh',
      brokerLabel: 'com.scns.broker',
      uid: 501,
    })
    expect(c.strategy).toBe('launchctl')
    expect(c.launchd).toEqual({ uid: 501, label: 'com.scns.broker' })
    expect(c.spawnSpec).toBeUndefined()
  })

  it('selects systemctl on linux', () => {
    const c = resolveWatchdogRestartConfig({
      platform: 'linux',
      port: 3456,
      scnsHome: '/home/jh',
      service: 'scns',
    })
    expect(c.strategy).toBe('systemctl')
    expect(c.systemd).toEqual({ service: 'scns' })
  })

  it('builds a relaunch spawn spec on win32, announcing itself as the supervisor', () => {
    const c = resolveWatchdogRestartConfig(WIN)
    expect(c.strategy).toBe('relaunch')
    expect(c.spawnSpec?.command).toBe(WIN.execPath)
    expect(c.spawnSpec?.args).toEqual([WIN.brokerEntry, 'start', '--port', '3456'])
    expect(c.spawnSpec?.env[SUPERVISED_ENV]).toBe('1')
  })

  it('threads an autonomy level into the spawn spec when given', () => {
    const c = resolveWatchdogRestartConfig({ ...WIN, autonomyLevel: 2 })
    expect(c.spawnSpec?.args).toContain('--autonomy')
    expect(c.spawnSpec?.args).toContain('2')
  })

  it('points the pidfile at the same port the broker records under', () => {
    const c = resolveWatchdogRestartConfig(WIN)
    expect(c.pidfilePath).toContain('broker-3456.pid')
  })

  it('refuses a relaunch config with no broker entry — loudly, at wiring time', () => {
    expect(() => resolveWatchdogRestartConfig({ ...WIN, brokerEntry: undefined })).toThrow(
      /broker entry/i,
    )
  })
})

describe('createWatchdogRestart', () => {
  it('stops the recorded pid with taskkill, then spawns a fresh broker', async () => {
    const runCommand = vi.fn()
    const spawnBroker = vi.fn(() => 7777)
    const restart = createWatchdogRestart(WIN, {
      runCommand,
      spawnBroker,
      readLivePid: () => 4242,
      isAlive: () => false,
      sleep: async () => {},
      isPortInUse: async () => false,
    })
    const out = await restart()
    expect(runCommand).toHaveBeenCalledWith(
      { command: 'taskkill', args: ['/PID', '4242', '/T', '/F'] },
      expect.anything(),
    )
    expect(spawnBroker).toHaveBeenCalledTimes(1)
    expect(out.spawnedPid).toBe(7777)
  })

  it('goes straight to spawn when the broker is simply gone', async () => {
    const runCommand = vi.fn()
    const restart = createWatchdogRestart(WIN, {
      runCommand,
      spawnBroker: () => 7777,
      readLivePid: () => null,
      isAlive: () => false,
      sleep: async () => {},
      isPortInUse: async () => false,
    })
    await restart()
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('refuses to spawn over an occupied port when its pidfile is missing', async () => {
    const runCommand = vi.fn()
    const spawnBroker = vi.fn(() => 7777)
    const restart = createWatchdogRestart(WIN, {
      runCommand,
      spawnBroker,
      readLivePid: () => null,
      isAlive: () => false,
      isPortInUse: async () => true,
    })
    const result = await restart()
    expect(runCommand).not.toHaveBeenCalled()
    expect(spawnBroker).not.toHaveBeenCalled()
    expect(result.spawnedPid).toBeNull()
    expect(result.detail).toMatch(/port.*occupied/i)
  })

  it('refuses to spawn if the recorded process exited but its port remains occupied', async () => {
    const runCommand = vi.fn()
    const spawnBroker = vi.fn(() => 7777)
    const restart = createWatchdogRestart(WIN, {
      runCommand,
      spawnBroker,
      readLivePid: () => 4242,
      isAlive: () => false,
      isPortInUse: async () => true,
    })
    const result = await restart()
    expect(runCommand).toHaveBeenCalledTimes(1)
    expect(spawnBroker).not.toHaveBeenCalled()
    expect(result.spawnedPid).toBeNull()
  })
})

describe('claimSingleton', () => {
  it('grants the claim when nobody holds the pidfile, and releases it', () => {
    const home = mkdtempSync(join(tmpdir(), 'scns-wd-'))
    try {
      const path = watchdogPidfilePath(home, 3456)
      const claim = claimSingleton(path)
      expect(claim.acquired).toBe(true)
      expect(existsSync(path)).toBe(true)
      claim.release()
      expect(existsSync(path)).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('REFUSES a second watchdog while a live one holds the file', () => {
    const home = mkdtempSync(join(tmpdir(), 'scns-wd-'))
    try {
      const path = watchdogPidfilePath(home, 3456)
      // A live holder: our own pid, claimed under a different identity.
      const first = claimSingleton(path, process.pid)
      expect(first.acquired).toBe(true)
      const second = claimSingleton(path, process.pid + 1)
      expect(second.acquired).toBe(false)
      expect(second.heldBy).toBe(process.pid)
      first.release()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('takes over a STALE pidfile — a killed watchdog must not lock out its successor', () => {
    const home = mkdtempSync(join(tmpdir(), 'scns-wd-'))
    try {
      const path = watchdogPidfilePath(home, 3456)
      writeBrokerPidfile(path, {
        pid: 999_999,
        port: 0,
        startedAt: Date.now(),
        execPath: 'node',
      })
      expect(claimSingleton(path).acquired).toBe(true)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('ensureBrokerUp', () => {
  it('does nothing when the broker already answers', async () => {
    const restart = vi.fn()
    const r = await ensureBrokerUp(WIN, {
      probe: async () => ({ status: 200 }),
      restart: restart as never,
    })
    expect(r.started).toBe(false)
    expect(r.reason).toBe('broker-responsive')
    expect(restart).not.toHaveBeenCalled()
  })

  it('starts the broker immediately when none is running — no 60s grace for a ghost', async () => {
    const restart = vi.fn(async () => ({
      strategy: 'relaunch' as const,
      stoppedPid: null,
      spawnedPid: 1,
      detail: '',
    }))
    const r = await ensureBrokerUp(WIN, {
      probe: async () => ({}),
      restart,
      readLivePid: () => null,
    })
    expect(r.started).toBe(true)
    expect(restart).toHaveBeenCalledTimes(1)
  })

  it('does not report a start when the relaunch was refused without spawning', async () => {
    const spawnBroker = vi.fn(() => 7777)
    const restart = createWatchdogRestart(WIN, {
      readLivePid: () => null,
      isPortInUse: async () => true,
      spawnBroker,
    })
    await expect(
      ensureBrokerUp(WIN, {
        probe: async () => ({}),
        readLivePid: () => null,
        restart,
      }),
    ).rejects.toThrow(/refusing to spawn/i)
    expect(spawnBroker).not.toHaveBeenCalled()
  })

  it('defers to the startup grace when a broker pid exists but is not answering yet', async () => {
    const restart = vi.fn()
    const r = await ensureBrokerUp(WIN, {
      probe: async () => ({}),
      restart: restart as never,
      readLivePid: () => 4242,
    })
    expect(r.started).toBe(false)
    expect(r.reason).toContain('4242')
    expect(restart).not.toHaveBeenCalled()
  })
})
