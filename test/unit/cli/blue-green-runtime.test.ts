/**
 * Issue #61 (option C) — real deps for the cross-platform blue/green restart.
 *
 * The decision core in `broker/services/blue-green.ts` is effect-free; this is
 * the layer that talks HTTP, spawns the canary, and picks the platform-native
 * swap. Tests here pin the two things that are easy to get quietly wrong: the
 * canary's isolation, and which mechanism each platform ends up using.
 */

import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveCanaryPort,
  buildCanarySpawnSpec,
  authHeaders,
  createBlueGreenHttp,
  createBlueGreenDeps,
  formatBlueGreenReport,
} from '../../../src/cli/blue-green-runtime.js'
import type { BlueGreenResult } from '../../../src/broker/services/blue-green.js'

describe('resolveCanaryPort', () => {
  it('defaults to main + 1, as broker-restart.sh did', () => {
    expect(resolveCanaryPort(3456)).toBe(3457)
  })

  it('honours an explicit canary port', () => {
    expect(resolveCanaryPort(3456, 34999)).toBe(34999)
  })

  it('refuses a canary port equal to the broker it is validating for', () => {
    expect(() => resolveCanaryPort(3456, 3456)).toThrow(/same port/i)
  })
})

describe('buildCanarySpawnSpec', () => {
  const spec = buildCanarySpawnSpec({
    execPath: 'C:\\node\\node.exe',
    brokerEntry: 'C:\\scns\\dist\\cli.js',
    port: 3457,
    dataDir: 'C:\\tmp\\canary',
    dbPath: 'C:\\tmp\\canary-db\\canary.db',
  })

  it('starts a real broker on the canary port at autonomy 0', () => {
    expect(spec.command).toBe('C:\\node\\node.exe')
    expect(spec.args).toEqual([
      'C:\\scns\\dist\\cli.js',
      'start',
      '--port',
      '3457',
      '--autonomy',
      '0',
    ])
  })

  /**
   * The shell script set `SCNS_DATA_DIR`, which nothing in `src/` reads — so
   * its canary ran against the LIVE `~/.scns` vault and experience corpus with
   * only its SQLite file redirected. `SCNS_HOME` is the variable that actually
   * relocates the tree (`shared/scns-home.ts`), and both are required:
   * `SCNS_HOME` alone does not scope the broker DB.
   */
  it('isolates the canary with BOTH SCNS_HOME and BROKER_DB_PATH', () => {
    expect(spec.env['SCNS_HOME']).toBe('C:\\tmp\\canary')
    expect(spec.env['BROKER_DB_PATH']).toBe('C:\\tmp\\canary-db\\canary.db')
  })

  it('keeps the canary from taking a port it finds occupied', () => {
    // A validation broker must never kill whatever holds its port — that is how
    // a canary ends up murdering the production broker it is validating for.
    expect(spec.env['BROKER_LISTEN_KILL_STALE']).toBe('false')
  })

  it('keeps the canary out of the machine-wide observers', () => {
    expect(spec.env['OBSERVE_ACTIVE_APP_ENABLED']).toBe('false')
    expect(spec.env['OBSERVE_SESSION_STORE_ENABLED']).toBe('false')
  })
})

describe('authHeaders', () => {
  it('omits Authorization when there is no token', () => {
    expect(authHeaders(undefined)).toEqual({ 'Content-Type': 'application/json' })
    expect(authHeaders('   ')).toEqual({ 'Content-Type': 'application/json' })
  })

  it('sends a bearer token when one is configured', () => {
    expect(authHeaders('abc')['Authorization']).toBe('Bearer abc')
  })
})

describe('createBlueGreenHttp', () => {
  const okResponse = (body: unknown, status = 200): Response =>
    ({ ok: status < 400, status, json: async () => body }) as unknown as Response

  it('reads prepare success and names the failing sub-steps', async () => {
    const http = createBlueGreenHttp({
      port: 3456,
      fetchImpl: async () =>
        okResponse({
          success: false,
          steps: { dream: { success: false }, housekeeping: { success: true } },
        }),
    })
    expect(await http.prepare()).toEqual({ ok: false, detail: 'dream' })
  })

  it('treats a transport failure during prepare as non-fatal', async () => {
    const http = createBlueGreenHttp({
      port: 3456,
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED')
      },
    })
    expect(await http.prepare()).toEqual({ ok: false, detail: 'ECONNREFUSED' })
  })

  it('reads the active request count for the drain wait', async () => {
    const http = createBlueGreenHttp({
      port: 3456,
      fetchImpl: async () => okResponse({ activeRequestCount: 4 }),
    })
    expect(await http.readActiveRequests()).toBe(4)
  })

  it('returns null — not 0 — when the active count cannot be read', async () => {
    // 0 would mean "drained"; null means "unknown". Conflating them is how a
    // restart proceeds while requests are still in flight.
    const http = createBlueGreenHttp({
      port: 3456,
      fetchImpl: async () => {
        throw new Error('socket hang up')
      },
    })
    expect(await http.readActiveRequests()).toBeNull()
  })

  it('probes readiness on any port, and counts a non-2xx as not ready', async () => {
    const seen: string[] = []
    const http = createBlueGreenHttp({
      port: 3456,
      fetchImpl: async (url) => {
        seen.push(String(url))
        return okResponse({}, String(url).includes('3457') ? 503 : 200)
      },
    })
    expect(await http.probeReady(3456)).toBe(true)
    expect(await http.probeReady(3457)).toBe(false)
    expect(seen).toEqual([
      'http://127.0.0.1:3456/health/ready',
      'http://127.0.0.1:3457/health/ready',
    ])
  })

  it('reports the snapshot count, and a failure as count 0', async () => {
    const good = createBlueGreenHttp({
      port: 3456,
      fetchImpl: async () => okResponse({ success: true, count: 3 }),
    })
    expect(await good.snapshotAgents()).toEqual({ ok: true, count: 3 })

    const bad = createBlueGreenHttp({
      port: 3456,
      fetchImpl: async () => okResponse({ error: 'no spawner' }, 503),
    })
    expect(await bad.snapshotAgents()).toEqual({ ok: false, count: 0 })
  })
})

describe('createBlueGreenDeps — platform wiring', () => {
  const base = {
    port: 3456,
    scnsHome: 'C:\\Users\\j',
    brokerEntry: 'C:\\scns\\dist\\cli.js',
    execPath: 'C:\\node\\node.exe',
  }

  it('uses launchctl kickstart to restart and bootout/bootstrap to roll back on darwin', async () => {
    const runCommand = vi.fn()
    const deps = createBlueGreenDeps(
      {
        ...base,
        platform: 'darwin',
        uid: 501,
        brokerLabel: 'com.scns.broker',
        plistPath: '/Users/j/Library/LaunchAgents/com.scns.broker.plist',
      },
      { runCommand, spawnCanary: async () => null },
    )
    await deps.restart()
    await deps.rollback()
    expect(runCommand.mock.calls.map((c) => (c[0] as { args: string[] }).args)).toEqual([
      ['kickstart', '-k', 'gui/501/com.scns.broker'],
      ['bootout', 'gui/501', '/Users/j/Library/LaunchAgents/com.scns.broker.plist'],
      ['bootstrap', 'gui/501', '/Users/j/Library/LaunchAgents/com.scns.broker.plist'],
    ])
  })

  it('uses the userland stop-then-spawn for both on Windows', async () => {
    const spawnBroker = vi.fn(() => 777)
    const deps = createBlueGreenDeps(
      { ...base, platform: 'win32' },
      {
        spawnBroker,
        readLivePid: () => null,
        spawnCanary: async () => null,
      },
    )
    const restarted = await deps.restart()
    const rolledBack = await deps.rollback()
    expect(restarted.strategy).toBe('relaunch')
    expect(restarted.spawnedPid).toBe(777)
    expect(rolledBack.strategy).toBe('relaunch')
    expect(spawnBroker).toHaveBeenCalledTimes(2)
  })

  it('refuses to build on Windows with no broker entry to relaunch', () => {
    expect(() =>
      createBlueGreenDeps(
        { platform: 'win32', port: 3456, scnsHome: 'C:\\Users\\j' },
        { spawnCanary: async () => null },
      ),
    ).toThrow(/broker-entry/i)
  })

  it('refuses to build on darwin with no plist path — rollback could not load the job', () => {
    expect(() =>
      createBlueGreenDeps(
        { ...base, platform: 'darwin', uid: 501 },
        { runCommand: vi.fn(), spawnCanary: async () => null },
      ),
    ).toThrow(/plistPath/i)
  })
})

describe('the real canary spawner', () => {
  it('cleans up its isolated directories when stopped', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scns-bg-test-'))
    try {
      const created: string[] = []
      const deps = createBlueGreenDeps(
        {
          platform: 'win32',
          port: 3456,
          scnsHome: root,
          brokerEntry: join(root, 'cli.js'),
          execPath: process.execPath,
        },
        {
          spawnBroker: () => 1,
          readLivePid: () => null,
          // Real canary machinery, fake process: the temp dirs are real so the
          // cleanup assertion is real.
          spawnProcess: (spec) => {
            created.push(spec.env['SCNS_HOME']!)
            return { pid: 5, kill: () => true }
          },
        },
      )
      const handle = await deps.startCanary(3457)
      expect(handle).not.toBeNull()
      expect(created).toHaveLength(1)
      await handle!.stop()
      // Both isolated trees are gone — a canary must not accumulate state.
      const { existsSync } = await import('node:fs')
      expect(existsSync(created[0]!)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('returns null when the process cannot be spawned, so the canary gate fails closed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'scns-bg-test-'))
    try {
      const deps = createBlueGreenDeps(
        {
          platform: 'win32',
          port: 3456,
          scnsHome: root,
          brokerEntry: join(root, 'cli.js'),
          execPath: process.execPath,
        },
        {
          spawnBroker: () => 1,
          readLivePid: () => null,
          spawnProcess: () => {
            throw new Error('ENOENT')
          },
        },
      )
      expect(await deps.startCanary(3457)).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('formatBlueGreenReport', () => {
  const result: BlueGreenResult = {
    outcome: 'rolled-back',
    exitCode: 3,
    phases: [
      { phase: 'prepare', ok: true, detail: 'success=true', durationMs: 12 },
      { phase: 'verify', ok: false, detail: 'not ready', durationMs: 30_000 },
      { phase: 'rollback', ok: true, detail: 'blue restored and serving', durationMs: 900 },
    ],
    restart: null,
    gapMs: 31_000,
  }

  it('renders every phase with its verdict and the measured gap', () => {
    const text = formatBlueGreenReport(result)
    expect(text).toContain('prepare')
    expect(text).toContain('FAILED')
    expect(text).toContain('blue restored and serving')
    expect(text).toContain('31000ms')
    expect(text).toContain('rolled-back')
  })
})
