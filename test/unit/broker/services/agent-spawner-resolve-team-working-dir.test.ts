/**
 * Task 43 — agent-spawner integration with the team-worktree-manager via
 * the new `resolveTeamWorkingDir` callback option.
 *
 * Properties under test:
 *   1. The callback is invoked exactly once per `spawn()`, with the
 *      `team_id` from the spawn input, BEFORE the spawner reads
 *      `teams.working_dir`. This is the wiring contract that lets the
 *      manager pin `teams.working_dir` as a side effect just-in-time.
 *   2. The pin written by the callback is picked up by the existing
 *      Task 34 `findTeamWorkingDir` path — the agent's `workingDir`
 *      resolves to the pinned worktree path.
 *   3. When the callback throws, the spawn STILL succeeds (the spawner
 *      falls back to the pre-task-43 working_dir resolution). A bug in
 *      the worktree-manager must never wedge the broker.
 *   4. When the callback is omitted, behaviour is identical to
 *      pre-task-43 (regression guard for the opt-in contract).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { resolve } from 'node:path'
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

function makeMockDeps(): SpawnerDeps {
  const mockChild = {
    pid: 12345,
    killed: false,
    unref: vi.fn(),
    on: vi.fn(),
    kill: vi.fn(),
  }
  return {
    detectPlatform: () => 'darwin' as Platform,
    findCli: () => ({ command: 'copilot' }) as CliInfo,
    isTmuxAvailable: () => false,
    spawnProcess: vi.fn().mockReturnValue(mockChild) as unknown as SpawnerDeps['spawnProcess'],
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
  }
}

describe('agent-spawner: resolveTeamWorkingDir hook (Task 43)', () => {
  let testDb: TestDb
  let eventLog: SpawnerEventLog
  let deps: SpawnerDeps

  beforeEach(() => {
    testDb = createBrokerTestDb()
    testDb.db.prepare('INSERT INTO teams (id, name) VALUES (?, ?)').run('team-43', 't43')
    eventLog = makeMockEventLog()
    deps = makeMockDeps()
  })

  afterEach(() => {
    testDb.close()
  })

  it('invokes the resolver exactly once per spawn, with the requested team_id', async () => {
    const resolver = vi.fn<[string], string | null>(() => null)
    const spawner = createAgentSpawner(testDb.db, eventLog, {
      brokerUrl: 'http://localhost:9999',
      workingDir: '/broker/cwd',
      deps,
      maxConcurrentAgents: Infinity,
      resolveTeamWorkingDir: resolver,
    })

    await spawner.spawn({ team_id: 'team-43', name: 'a1', role: 'dev', prompt: 'x' })
    expect(resolver).toHaveBeenCalledTimes(1)
    expect(resolver).toHaveBeenCalledWith('team-43')

    await spawner.spawn({ team_id: 'team-43', name: 'a2', role: 'dev', prompt: 'x' })
    expect(resolver).toHaveBeenCalledTimes(2)
    expect(resolver.mock.calls[1]?.[0]).toBe('team-43')

    await spawner.shutdownAll()
  })

  it('picks up the pin the resolver writes as a side effect (workingDir = pinned worktree)', async () => {
    // Simulates the real worktree-manager: when called, the resolver
    // persists the pin in `teams.working_dir`. The spawner re-reads it
    // a few lines later, so the spawned agent's recorded workingDir
    // must resolve to the pinned path.
    const pinned = '/tmp/team-43-worktree'
    const resolver = vi.fn<[string], string | null>((teamId) => {
      testDb.db
        .prepare('UPDATE teams SET working_dir = ? WHERE id = ? AND working_dir IS NULL')
        .run(pinned, teamId)
      return pinned
    })

    const spawner = createAgentSpawner(testDb.db, eventLog, {
      brokerUrl: 'http://localhost:9999',
      workingDir: '/broker/cwd',
      deps,
      maxConcurrentAgents: Infinity,
      resolveTeamWorkingDir: resolver,
    })

    const result = await spawner.spawn({
      team_id: 'team-43',
      name: 'a1',
      role: 'dev',
      prompt: 'x',
      // Even though the caller asked for /caller/dir, the team's pin
      // (set by the resolver) must win — Task 34's neuron-mode precedence.
      working_dir: '/caller/dir',
    })

    const startedPayload = (eventLog.agentLaunchStarted as ReturnType<typeof vi.fn>)
      .mock.calls[0]?.[1] as Record<string, unknown>
    // resolve(): the spawner canonicalizes working_dir (path.resolve), which
    // maps a '/tmp/...' fixture to '<drive>:\tmp\...' on win32.
    expect(startedPayload.working_dir).toBe(resolve(pinned))
    expect(result.sessionId).toBeTruthy()
    await spawner.shutdownAll()
  })

  it('falls back to default working_dir resolution when the resolver throws', async () => {
    const resolver = vi.fn<[string], string | null>(() => {
      throw new Error('simulated worktree-manager FS failure')
    })

    const spawner = createAgentSpawner(testDb.db, eventLog, {
      brokerUrl: 'http://localhost:9999',
      workingDir: '/broker/cwd',
      deps,
      maxConcurrentAgents: Infinity,
      resolveTeamWorkingDir: resolver,
    })

    // Spawn must NOT throw — provisioning failure is non-fatal.
    const result = await spawner.spawn({
      team_id: 'team-43',
      name: 'a-fallback',
      role: 'dev',
      prompt: 'x',
      working_dir: '/caller/dir',
    })

    expect(resolver).toHaveBeenCalledTimes(1)
    expect(result.sessionId).toBeTruthy()
    const startedPayload = (eventLog.agentLaunchStarted as ReturnType<typeof vi.fn>)
      .mock.calls[0]?.[1] as Record<string, unknown>
    // No pin was written → spawner falls back to caller's working_dir.
    expect(startedPayload.working_dir).toBe(resolve('/caller/dir'))
    await spawner.shutdownAll()
  })

  it('does NOT call any resolver when the option is omitted (regression guard for opt-in contract)', async () => {
    const spawner = createAgentSpawner(testDb.db, eventLog, {
      brokerUrl: 'http://localhost:9999',
      workingDir: '/broker/cwd',
      deps,
      maxConcurrentAgents: Infinity,
      // resolveTeamWorkingDir intentionally omitted.
    })

    // Should behave exactly like pre-Task-43 — uses caller working_dir.
    const result = await spawner.spawn({
      team_id: 'team-43',
      name: 'a-noop',
      role: 'dev',
      prompt: 'x',
      working_dir: '/caller/dir',
    })

    expect(result.sessionId).toBeTruthy()
    const startedPayload = (eventLog.agentLaunchStarted as ReturnType<typeof vi.fn>)
      .mock.calls[0]?.[1] as Record<string, unknown>
    expect(startedPayload.working_dir).toBe(resolve('/caller/dir'))
    await spawner.shutdownAll()
  })
})
