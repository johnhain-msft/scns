/**
 * Layer-2 fix — agent-spawner PATH injection.
 *
 * When the resolved working_dir contains a `node_modules/.bin`
 * directory (because team-worktree-manager bridged node_modules
 * into the per-team worktree), the spawner MUST prepend that
 * directory to the spawned agent's PATH so bare `vitest run …`,
 * `tsc --noEmit`, `eslint`, `prettier` invocations in the dev/qa
 * task prompts resolve. Without this the ACP agent exits silently
 * on the first turn — every npm-script in the prompt returns
 * "command not found" instantly.
 *
 * Properties under test:
 *   (P1) When existsSync(<cwd>/node_modules/.bin) returns true,
 *        the env passed to spawnProcess has
 *        PATH = `<cwd>/node_modules/.bin${delimiter}<inherited>`.
 *   (P2) When existsSync(<cwd>/node_modules/.bin) returns false,
 *        the env passed to spawnProcess has PATH untouched (no
 *        leading bin dir).
 *   (P3) The probe is invoked exactly once per spawn, with the
 *        path joined from the team's resolved working_dir.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import path from 'node:path'
import type { TestDb } from '../../../helpers/db-harness.js'
import { createBrokerTestDb } from '../../../helpers/broker-db-harness.js'
import {
  createAgentSpawner,
} from '../../../../src/broker/services/agent-spawner.js'
import type {
  SpawnerDeps,
  SpawnerEventLog,
} from '../../../../src/broker/services/agent-spawner.js'
import type { CliInfo, Platform } from '../../../../src/broker/services/platform.js'

function makeMockEventLog(): SpawnerEventLog {
  return {
    sessionRegistered: vi.fn(),
    sessionDeregistered: vi.fn(),
    teamMemberJoined: vi.fn(),
    agentLaunchStarted: vi.fn(),
    agentPromptDelivered: vi.fn(),
    agentFirstOutputReceived: vi.fn(),
    agentLaunchFailed: vi.fn(),
  }
}

interface SpawnArgsCapture {
  cmd: string
  args: ReadonlyArray<string>
  opts: { env?: NodeJS.ProcessEnv; cwd?: string } | undefined
}

function makeMockDeps(
  existsImpl: (p: string) => boolean,
  capture: { calls: SpawnArgsCapture[] },
): SpawnerDeps {
  const mockChild = {
    pid: 12345,
    killed: false,
    unref: vi.fn(),
    on: vi.fn(),
    kill: vi.fn(),
  }
  const spawnProcess = vi.fn((cmd: string, args: ReadonlyArray<string>, opts: unknown) => {
    capture.calls.push({
      cmd,
      args,
      opts: opts as { env?: NodeJS.ProcessEnv; cwd?: string },
    })
    return mockChild as unknown as ReturnType<typeof import('node:child_process').spawn>
  }) as unknown as SpawnerDeps['spawnProcess']
  return {
    detectPlatform: () => 'darwin' as Platform,
    findCli: () => ({ command: 'copilot' }) as CliInfo,
    isTmuxAvailable: () => false,
    spawnProcess,
    spawnSync: vi.fn().mockReturnValue({
      status: 0,
      stdout: Buffer.from(''),
      stderr: Buffer.from(''),
      pid: 0,
      output: [],
      signal: null,
    }) as unknown as SpawnerDeps['spawnSync'],
    execSync: vi.fn() as unknown as SpawnerDeps['execSync'],
    mkdirSync: vi.fn() as unknown as SpawnerDeps['mkdirSync'],
    createWriteStream: vi.fn().mockReturnValue({
      write: vi.fn(),
      end: vi.fn(),
    }) as unknown as SpawnerDeps['createWriteStream'],
    writeFileSync: vi.fn() as unknown as SpawnerDeps['writeFileSync'],
    openSync: vi.fn().mockReturnValue(99) as unknown as SpawnerDeps['openSync'],
    closeSync: vi.fn() as unknown as SpawnerDeps['closeSync'],
    existsSync: existsImpl,
  }
}

describe('agent-spawner: PATH injection from working_dir node_modules/.bin (Layer-2)', () => {
  let testDb: TestDb
  let eventLog: SpawnerEventLog

  beforeEach(() => {
    testDb = createBrokerTestDb()
    testDb.db.prepare('INSERT INTO teams (id, name) VALUES (?, ?)').run('team-l2', 't-l2')
    eventLog = makeMockEventLog()
  })

  afterEach(() => {
    testDb.close()
    vi.restoreAllMocks()
  })

  it('(P1) existsSync(<cwd>/node_modules/.bin) → PATH starts with that dir', async () => {
    // Pre-resolved: the spawner canonicalizes via path.resolve before probing.
    const cwd = path.resolve('/sandbox/wt')
    const expectedBin = path.join(cwd, 'node_modules', '.bin')
    const existsCalls: string[] = []
    const existsImpl = (p: string): boolean => {
      existsCalls.push(p)
      return p === expectedBin
    }
    const capture: { calls: SpawnArgsCapture[] } = { calls: [] }
    const deps = makeMockDeps(existsImpl, capture)

    const spawner = createAgentSpawner(testDb.db, eventLog, {
      brokerUrl: 'http://localhost:9999',
      workingDir: '/broker/cwd',
      deps,
      maxConcurrentAgents: Infinity,
      // Resolver pins the team to /sandbox/wt before findTeamWorkingDir reads it.
      resolveTeamWorkingDir: () => {
        testDb.db
          .prepare('UPDATE teams SET working_dir = ? WHERE id = ?')
          .run(cwd, 'team-l2')
        return cwd
      },
    })

    await spawner.spawn({
      team_id: 'team-l2',
      name: 'dev1',
      role: 'dev',
      prompt: 'go',
    })

    expect(capture.calls).toHaveLength(1)
    const env = capture.calls[0]!.opts!.env!
    expect(env['PATH']).toBeDefined()
    expect(env['PATH']!.startsWith(`${expectedBin}${path.delimiter}`)).toBe(true)
    // Original PATH still present after our prepend.
    if (process.env['PATH']) {
      expect(env['PATH']!.includes(process.env['PATH'])).toBe(true)
    }
    expect(existsCalls).toContain(expectedBin)

    await spawner.shutdownAll()
  })

  it('(P2) existsSync false → PATH is the inherited PATH (no prepend)', async () => {
    const cwd = path.resolve('/sandbox/no-bin')
    const existsImpl = (_p: string): boolean => false
    const capture: { calls: SpawnArgsCapture[] } = { calls: [] }
    const deps = makeMockDeps(existsImpl, capture)

    const spawner = createAgentSpawner(testDb.db, eventLog, {
      brokerUrl: 'http://localhost:9999',
      workingDir: '/broker/cwd',
      deps,
      maxConcurrentAgents: Infinity,
      resolveTeamWorkingDir: () => {
        testDb.db
          .prepare('UPDATE teams SET working_dir = ? WHERE id = ?')
          .run(cwd, 'team-l2')
        return cwd
      },
    })

    await spawner.spawn({
      team_id: 'team-l2',
      name: 'dev2',
      role: 'dev',
      prompt: 'go',
    })

    expect(capture.calls).toHaveLength(1)
    const env = capture.calls[0]!.opts!.env!
    // PATH must equal the inherited PATH untouched — no `/node_modules/.bin:`
    // prepend. We can't assert exact equality because env is built from
    // process.env, but we CAN assert no node_modules/.bin prefix.
    expect(env['PATH']).toBeDefined()
    expect(env['PATH']!.startsWith(`${cwd}/node_modules/.bin${path.delimiter}`)).toBe(false)

    await spawner.shutdownAll()
  })

  it('(P3) probe invoked exactly once per spawn with the resolved working_dir', async () => {
    const cwd = path.resolve('/sandbox/probe-once')
    const calls: string[] = []
    const existsImpl = (p: string): boolean => {
      calls.push(p)
      return false
    }
    const capture: { calls: SpawnArgsCapture[] } = { calls: [] }
    const deps = makeMockDeps(existsImpl, capture)

    const spawner = createAgentSpawner(testDb.db, eventLog, {
      brokerUrl: 'http://localhost:9999',
      workingDir: '/broker/cwd',
      deps,
      maxConcurrentAgents: Infinity,
      resolveTeamWorkingDir: () => {
        testDb.db
          .prepare('UPDATE teams SET working_dir = ? WHERE id = ?')
          .run(cwd, 'team-l2')
        return cwd
      },
    })

    await spawner.spawn({
      team_id: 'team-l2',
      name: 'dev3',
      role: 'dev',
      prompt: 'go',
    })

    const expectedBin = path.join(cwd, 'node_modules', '.bin')
    // Exactly one bin-dir probe per spawn — the one for PATH injection.
    const binProbes = calls.filter((c) => c === expectedBin)
    expect(binProbes).toHaveLength(1)

    await spawner.shutdownAll()
  })
})
