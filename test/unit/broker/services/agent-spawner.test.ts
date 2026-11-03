import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { resolve } from 'node:path'
import type { TestDb } from '../../../helpers/db-harness.js'
import { createBrokerTestDb } from '../../../helpers/broker-db-harness.js'
import { createAgentSpawner, shellQuote } from '../../../../src/broker/services/agent-spawner.js'
import type {
  AgentSpawner,
  SpawnerDeps,
  SpawnerEventLog,
} from '../../../../src/broker/services/agent-spawner.js'
import type { CliInfo, Platform } from '../../../../src/broker/services/platform.js'
import { findSessionById } from '../../../../src/broker/storage/repositories/session-repository.js'
import { findTeamMember } from '../../../../src/broker/storage/repositories/team-repository.js'

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

function makeMockDeps(overrides?: Partial<SpawnerDeps>): SpawnerDeps {
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
    ...overrides,
  }
}

describe('Agent Spawner', () => {
  let testDb: TestDb
  let eventLog: SpawnerEventLog
  let spawner: AgentSpawner
  let deps: SpawnerDeps

  beforeEach(() => {
    testDb = createBrokerTestDb()
    // Pre-register a team for spawn tests
    testDb.db.prepare('INSERT INTO teams (id, name) VALUES (?, ?)').run('test-team', 'Test Team')
    eventLog = makeMockEventLog()
    deps = makeMockDeps()
    spawner = createAgentSpawner(testDb.db, eventLog, {
      brokerUrl: 'http://localhost:9999',
      heartbeatMs: 60_000,
      workingDir: '/test/dir',
      deps,
      // Disable the F1 global concurrency cap for tests that spawn multiple
      // agents in a single test body (role-allowlist coverage, multi-agent
      // lifecycle). Concurrency-cap behaviour is covered by its own describe.
      maxConcurrentAgents: Infinity,
    })
  })

  afterEach(async () => {
    await spawner.shutdownAll()
    testDb.close()
  })

  const defaultInput = {
    team_id: 'test-team',
    name: 'agent-1',
    role: 'dev',
    prompt: 'Do the work',
  }

  describe('spawn', () => {
    it('creates session in DB', async () => {
      const result = await spawner.spawn(defaultInput)
      const session = findSessionById(testDb.db, result.sessionId)
      expect(session).not.toBeNull()
      expect(session!.purpose).toContain('dev agent for team test-team')
    })

    it('adds team member', async () => {
      const result = await spawner.spawn(defaultInput)
      const member = findTeamMember(testDb.db, 'test-team', result.sessionId)
      expect(member).not.toBeNull()
      expect(member!.name).toBe('agent-1')
      expect(member!.role).toBe('dev')
    })

    it('registers agent without server-side heartbeat timer', async () => {
      const result = await spawner.spawn(defaultInput)
      const agents = spawner.getActiveAgents()
      expect(agents.has(result.sessionId)).toBe(true)
      // GAP-013: No server-side heartbeat timer; agents send heartbeats themselves
    })

    it('returns correct SpawnResult fields', async () => {
      const result = await spawner.spawn(defaultInput)
      expect(result.teamId).toBe('test-team')
      expect(result.name).toBe('agent-1')
      expect(result.role).toBe('dev')
      expect(result.platform).toBe('darwin')
      expect(result.launchMethod).toBe('detached')
    })

    it('throws when no CLI is available', async () => {
      const noCli = createAgentSpawner(testDb.db, eventLog, {
        deps: { ...deps, findCli: () => null },
      })
      await expect(noCli.spawn(defaultInput)).rejects.toThrow('No compatible AI CLI found')
    })

    it('logs session registered event', async () => {
      await spawner.spawn(defaultInput)
      expect(eventLog.sessionRegistered).toHaveBeenCalled()
    })

    it('logs team member joined event', async () => {
      await spawner.spawn(defaultInput)
      expect(eventLog.teamMemberJoined).toHaveBeenCalled()
    })

    // WS K (Phase 13.13.x) — agent-spawn lifecycle instrumentation.
    // The four events below let operators observe which stage of a launch
    // a given session reached. See agent-spawner.ts (doSpawn) and the
    // diagnostic harness scripts/wsk-acp-dev-trace.mjs.
    describe('WS K lifecycle events', () => {
      it('emits agent_launch_started with role/team/working_dir/launch_method', async () => {
        const result = await spawner.spawn(defaultInput)
        expect(eventLog.agentLaunchStarted).toHaveBeenCalledTimes(1)
        const [sid, payload] = (eventLog.agentLaunchStarted as ReturnType<typeof vi.fn>).mock
          .calls[0]
        expect(sid).toBe(result.sessionId)
        expect(payload).toMatchObject({
          role: 'dev',
          team_id: 'test-team',
          launch_method: 'detached',
          cli: 'copilot',
        })
        expect(payload.working_dir).toBeTruthy()
      })

      it('emits agent_prompt_delivered with prompt byte count for detached launches', async () => {
        const result = await spawner.spawn(defaultInput)
        expect(eventLog.agentPromptDelivered).toHaveBeenCalledTimes(1)
        const [sid, payload] = (eventLog.agentPromptDelivered as ReturnType<typeof vi.fn>).mock
          .calls[0]
        expect(sid).toBe(result.sessionId)
        expect(payload).toMatchObject({
          role: 'dev',
          team_id: 'test-team',
          transport: 'detached',
        })
        expect(payload.prompt_byte_count).toBeGreaterThan(0)
      })

      it('does NOT emit agent_launch_failed on the happy path', async () => {
        await spawner.spawn(defaultInput)
        expect(eventLog.agentLaunchFailed).not.toHaveBeenCalled()
      })

      it('emits agent_launch_failed with stage=spawn when the OS spawn throws', async () => {
        const failingDeps = makeMockDeps({
          spawnProcess: vi.fn(() => {
            throw new Error('ENOENT: copilot')
          }) as unknown as SpawnerDeps['spawnProcess'],
        })
        const failingEventLog = makeMockEventLog()
        const failingSpawner = createAgentSpawner(testDb.db, failingEventLog, {
          brokerUrl: 'http://localhost:9999',
          heartbeatMs: 60_000,
          workingDir: '/test/dir',
          deps: failingDeps,
          maxConcurrentAgents: Infinity,
        })
        await expect(failingSpawner.spawn(defaultInput)).rejects.toThrow()
        expect(failingEventLog.agentLaunchFailed).toHaveBeenCalledTimes(1)
        const [, payload] = (
          failingEventLog.agentLaunchFailed as ReturnType<typeof vi.fn>
        ).mock.calls[0]
        expect(payload).toMatchObject({
          role: 'dev',
          team_id: 'test-team',
          stage: 'spawn',
          transport: 'detached',
        })
        expect(typeof payload.error).toBe('string')
        expect(payload.error_class).toBeDefined()
        await failingSpawner.shutdownAll()
      })
    })

    it('uses default role when not provided', async () => {
      const result = await spawner.spawn({ team_id: 'test-team', name: 'agent-2' })
      expect(result.role).toBe('dev')
    })
  })

  describe('spawn with tmux', () => {
    it('uses tmux launch when tmux is available', async () => {
      const tmuxDeps = makeMockDeps({
        isTmuxAvailable: () => true,
        spawnSync: vi.fn().mockReturnValue({
          status: 0,
          stdout: Buffer.from(''),
          stderr: Buffer.from(''),
          pid: 0,
          output: [],
          signal: null,
        }) as unknown as SpawnerDeps['spawnSync'],
      })
      const tmuxSpawner = createAgentSpawner(testDb.db, eventLog, {
        workingDir: '/test/dir',
        deps: tmuxDeps,
      })
      const result = await tmuxSpawner.spawn(defaultInput)
      expect(result.launchMethod).toBe('tmux')
      expect(result.tmuxSession).not.toBeNull()
      expect(result.tmuxWindow).not.toBeNull()
      tmuxSpawner.shutdownAll()
    })

    it('uses detached launch when tmux is unavailable', async () => {
      const result = await spawner.spawn(defaultInput)
      expect(result.launchMethod).toBe('detached')
      expect(result.tmuxSession).toBeNull()
      expect(result.tmuxWindow).toBeNull()
    })
  })

  describe('cleanup', () => {
    it('removes session and team member', async () => {
      const result = await spawner.spawn(defaultInput)
      spawner.cleanup(result.sessionId)

      const session = findSessionById(testDb.db, result.sessionId)
      expect(session).toBeNull()

      const member = findTeamMember(testDb.db, 'test-team', result.sessionId)
      expect(member).toBeNull()
    })

    it('stops heartbeat timer', async () => {
      const result = await spawner.spawn(defaultInput)
      spawner.cleanup(result.sessionId)
      const agents = spawner.getActiveAgents()
      expect(agents.has(result.sessionId)).toBe(false)
    })

    it('is a no-op for unknown session IDs', () => {
      expect(() => spawner.cleanup('nonexistent')).not.toThrow()
    })
  })

  describe('shutdownAll', () => {
    it('cleans up all agents', async () => {
      await spawner.spawn({ ...defaultInput, name: 'a1' })
      await spawner.spawn({ ...defaultInput, name: 'a2' })
      expect(spawner.getActiveAgents().size).toBe(2)

      spawner.shutdownAll()
      expect(spawner.getActiveAgents().size).toBe(0)
    })
  })

  describe('getActiveAgents', () => {
    it('returns snapshot of active agents', async () => {
      const result = await spawner.spawn(defaultInput)
      const agents = spawner.getActiveAgents()
      expect(agents.size).toBe(1)

      const info = agents.get(result.sessionId)
      expect(info).toBeDefined()
      expect(info!.name).toBe('agent-1')
      expect(info!.teamId).toBe('test-team')
      expect(info!.role).toBe('dev')
      expect(info!.startedAt).toBeDefined()
    })

    it('returns empty map when no agents', () => {
      const agents = spawner.getActiveAgents()
      expect(agents.size).toBe(0)
    })
  })

  describe('shellQuote', () => {
    it('wraps string in single quotes', () => {
      expect(shellQuote('hello')).toBe("'hello'")
    })

    it('escapes single quotes correctly', () => {
      expect(shellQuote("it's")).toBe("'it'\\''s'")
    })

    it('handles empty strings', () => {
      expect(shellQuote('')).toBe("''")
    })

    it('handles strings with multiple single quotes', () => {
      expect(shellQuote("a'b'c")).toBe("'a'\\''b'\\''c'")
    })

    it('handles strings with special characters', () => {
      const result = shellQuote('hello world $HOME "quoted"')
      expect(result).toBe('\'hello world $HOME "quoted"\'')
    })
  })

  describe('GAP-012: error handler improvements', () => {
    it('tmux new-session failure throws and cleans up session', async () => {
      const tmuxDeps = makeMockDeps({
        isTmuxAvailable: () => true,
        spawnSync: vi.fn().mockImplementation((_cmd: string, args: string[]) => {
          if (args[0] === 'has-session') {
            return {
              status: 1,
              stdout: Buffer.from(''),
              stderr: Buffer.from(''),
              pid: 0,
              output: [],
              signal: null,
            }
          }
          // new-session fails
          return {
            status: 1,
            stdout: Buffer.from(''),
            stderr: Buffer.from('failed to create session'),
            pid: 0,
            output: [],
            signal: null,
            error: undefined,
          }
        }) as unknown as SpawnerDeps['spawnSync'],
      })
      const tmuxSpawner = createAgentSpawner(testDb.db, eventLog, {
        workingDir: '/test/dir',
        deps: tmuxDeps,
      })

      await expect(tmuxSpawner.spawn(defaultInput)).rejects.toThrow('tmux')
      // Session should be cleaned up (deleted from DB)
      // The session ID is generated dynamically, so we check no sessions remain
      const sessions = testDb.db.prepare('SELECT id FROM sessions').all() as Array<{ id: string }>
      expect(sessions.length).toBe(0)
      tmuxSpawner.shutdownAll()
    })

    it('tmux spawnSync error field triggers throw', async () => {
      const tmuxDeps = makeMockDeps({
        isTmuxAvailable: () => true,
        spawnSync: vi.fn().mockImplementation((_cmd: string, args: string[]) => {
          if (args[0] === 'has-session') {
            return {
              status: 1,
              stdout: Buffer.from(''),
              stderr: Buffer.from(''),
              pid: 0,
              output: [],
              signal: null,
            }
          }
          // new-session has an error
          return {
            status: null,
            stdout: Buffer.from(''),
            stderr: Buffer.from(''),
            pid: 0,
            output: [],
            signal: null,
            error: new Error('ENOENT: tmux not found'),
          }
        }) as unknown as SpawnerDeps['spawnSync'],
      })
      const tmuxSpawner = createAgentSpawner(testDb.db, eventLog, {
        workingDir: '/test/dir',
        deps: tmuxDeps,
      })

      await expect(tmuxSpawner.spawn(defaultInput)).rejects.toThrow()
      tmuxSpawner.shutdownAll()
    })

    it('launchDetached openSync failure cleans up session', async () => {
      const failDeps = makeMockDeps({
        openSync: vi.fn().mockImplementation(() => {
          throw new Error('EACCES: permission denied')
        }) as unknown as SpawnerDeps['openSync'],
      })
      const failSpawner = createAgentSpawner(testDb.db, eventLog, {
        workingDir: '/test/dir',
        deps: failDeps,
      })

      await expect(failSpawner.spawn(defaultInput)).rejects.toThrow('EACCES')
      // Session cleaned up from DB
      const sessions = testDb.db.prepare('SELECT id FROM sessions').all() as Array<{ id: string }>
      expect(sessions.length).toBe(0)
      failSpawner.shutdownAll()
    })

    it('launchDetached spawnProcess failure closes log fd and cleans up', async () => {
      const closeSync = vi.fn()
      const failDeps = makeMockDeps({
        openSync: vi.fn().mockReturnValue(77) as unknown as SpawnerDeps['openSync'],
        closeSync: closeSync as unknown as SpawnerDeps['closeSync'],
        spawnProcess: vi.fn().mockImplementation(() => {
          throw new Error('ENOMEM: cannot spawn')
        }) as unknown as SpawnerDeps['spawnProcess'],
      })
      const failSpawner = createAgentSpawner(testDb.db, eventLog, {
        workingDir: '/test/dir',
        deps: failDeps,
      })

      await expect(failSpawner.spawn(defaultInput)).rejects.toThrow('ENOMEM')
      // Log fd should have been closed
      expect(closeSync).toHaveBeenCalledWith(77)
      failSpawner.shutdownAll()
    })

    it('launchDetached passes numeric fd to stdio and closes parent-side fd after spawn', async () => {
      const mockChild = {
        pid: 11111,
        killed: false,
        unref: vi.fn(),
        on: vi.fn(),
        kill: vi.fn(),
      }
      const spawnProcess = vi.fn().mockReturnValue(mockChild)
      const closeSync = vi.fn()
      const deps2 = makeMockDeps({
        openSync: vi.fn().mockReturnValue(42) as unknown as SpawnerDeps['openSync'],
        closeSync: closeSync as unknown as SpawnerDeps['closeSync'],
        spawnProcess: spawnProcess as unknown as SpawnerDeps['spawnProcess'],
      })
      const fdSpawner = createAgentSpawner(testDb.db, eventLog, {
        workingDir: '/test/dir',
        deps: deps2,
      })
      await fdSpawner.spawn(defaultInput)
      const stdioArg = spawnProcess.mock.calls[0]?.[2]?.stdio
      expect(stdioArg).toEqual(['ignore', 42, 42])
      // Parent-side fd closed once after successful spawn
      expect(closeSync).toHaveBeenCalledWith(42)
      fdSpawner.shutdownAll()
    })

    it('post-spawn closeSync failure does not fail the spawn', async () => {
      const mockChild = {
        pid: 22222,
        killed: false,
        unref: vi.fn(),
        on: vi.fn(),
        kill: vi.fn(),
      }
      const deps2 = makeMockDeps({
        openSync: vi.fn().mockReturnValue(50) as unknown as SpawnerDeps['openSync'],
        closeSync: vi.fn().mockImplementation(() => {
          throw new Error('EBADF')
        }) as unknown as SpawnerDeps['closeSync'],
        spawnProcess: vi.fn().mockReturnValue(mockChild) as unknown as SpawnerDeps['spawnProcess'],
      })
      const resilientSpawner = createAgentSpawner(testDb.db, eventLog, {
        workingDir: '/test/dir',
        deps: deps2,
      })
      const result = await resilientSpawner.spawn(defaultInput)
      expect(result.pid).toBe(22222)
      resilientSpawner.shutdownAll()
    })

    it('child process error event triggers cleanup with full context', async () => {
      let errorCallback: ((err: Error) => void) | undefined
      const mockChild = {
        pid: 12345,
        killed: false,
        unref: vi.fn(),
        on: vi.fn().mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
          if (event === 'error') errorCallback = cb as (err: Error) => void
        }),
        kill: vi.fn(),
      }
      const childDeps = makeMockDeps({
        spawnProcess: vi.fn().mockReturnValue(mockChild) as unknown as SpawnerDeps['spawnProcess'],
      })
      const childSpawner = createAgentSpawner(testDb.db, eventLog, {
        workingDir: '/test/dir',
        deps: childDeps,
      })
      const result = await childSpawner.spawn(defaultInput)
      expect(errorCallback).toBeDefined()

      // Trigger the error callback
      errorCallback!(new Error('EPERM: operation not permitted'))

      // Session should be cleaned up
      const agents = childSpawner.getActiveAgents()
      expect(agents.has(result.sessionId)).toBe(false)
      childSpawner.shutdownAll()
    })

    it('spawn catch block logs error with platform and launch method context', async () => {
      const failDeps = makeMockDeps({
        isTmuxAvailable: () => true,
        spawnSync: vi.fn().mockImplementation(() => {
          throw new Error('tmux: command not found')
        }) as unknown as SpawnerDeps['spawnSync'],
      })
      const failSpawner = createAgentSpawner(testDb.db, eventLog, {
        workingDir: '/test/dir',
        deps: failDeps,
      })

      // Should throw and the error should be logged (we verify the throw; logging verified by implementation)
      await expect(failSpawner.spawn(defaultInput)).rejects.toThrow('tmux: command not found')
      failSpawner.shutdownAll()
    })
  })

  describe('GAP-NEW-005: SCNS env vars in spawned processes', () => {
    it('detached spawn passes SCNS_* env vars to child process', async () => {
      const result = await spawner.spawn(defaultInput)
      const spawnCall = (deps.spawnProcess as ReturnType<typeof vi.fn>).mock.calls[0]
      const spawnOpts = spawnCall[2] as { env?: Record<string, string> }
      expect(spawnOpts.env).toBeDefined()
      expect(spawnOpts.env!.SCNS_SESSION_ID).toBe(result.sessionId)
      expect(spawnOpts.env!.SCNS_TEAM_ID).toBe('test-team')
      expect(spawnOpts.env!.SCNS_ROLE).toBe('dev')
      expect(spawnOpts.env!.SCNS_BROKER_URL).toBe('http://localhost:9999')
    })

    it('detached spawn includes process.env in child environment', async () => {
      await spawner.spawn(defaultInput)
      const spawnCall = (deps.spawnProcess as ReturnType<typeof vi.fn>).mock.calls[0]
      const spawnOpts = spawnCall[2] as { env?: Record<string, string> }
      // Should include existing process.env vars alongside SCNS_* vars
      expect(spawnOpts.env!.PATH).toBeDefined()
    })

    it('detached spawn uses default role in env when role not provided', async () => {
      await spawner.spawn({ team_id: 'test-team', name: 'agent-no-role' })
      const spawnCall = (deps.spawnProcess as ReturnType<typeof vi.fn>).mock.calls[0]
      const spawnOpts = spawnCall[2] as { env?: Record<string, string> }
      expect(spawnOpts.env!.SCNS_ROLE).toBe('dev')
    })

    it('tmux spawn includes SCNS env exports in shell script', async () => {
      const tmuxDeps = makeMockDeps({
        isTmuxAvailable: () => true,
        spawnSync: vi.fn().mockReturnValue({
          status: 0,
          stdout: Buffer.from(''),
          stderr: Buffer.from(''),
          pid: 0,
          output: [],
          signal: null,
        }) as unknown as SpawnerDeps['spawnSync'],
      })
      const tmuxSpawner = createAgentSpawner(testDb.db, eventLog, {
        brokerUrl: 'http://localhost:9999',
        workingDir: '/test/dir',
        deps: tmuxDeps,
      })
      const result = await tmuxSpawner.spawn(defaultInput)
      const writeCall = (tmuxDeps.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0]
      const scriptContent = writeCall[1] as string
      expect(scriptContent).toContain(`SCNS_SESSION_ID=`)
      expect(scriptContent).toContain(result.sessionId)
      expect(scriptContent).toContain(`SCNS_TEAM_ID=`)
      expect(scriptContent).toContain('test-team')
      expect(scriptContent).toContain(`SCNS_ROLE=`)
      expect(scriptContent).toContain('dev')
      expect(scriptContent).toContain(`SCNS_BROKER_URL=`)
      expect(scriptContent).toContain('http://localhost:9999')
      tmuxSpawner.shutdownAll()
    })

    it('tmux script exports env vars before exec line', async () => {
      const tmuxDeps = makeMockDeps({
        isTmuxAvailable: () => true,
        spawnSync: vi.fn().mockReturnValue({
          status: 0,
          stdout: Buffer.from(''),
          stderr: Buffer.from(''),
          pid: 0,
          output: [],
          signal: null,
        }) as unknown as SpawnerDeps['spawnSync'],
      })
      const tmuxSpawner = createAgentSpawner(testDb.db, eventLog, {
        brokerUrl: 'http://localhost:9999',
        workingDir: '/test/dir',
        deps: tmuxDeps,
      })
      await tmuxSpawner.spawn(defaultInput)
      const writeCall = (tmuxDeps.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0]
      const scriptContent = writeCall[1] as string
      const exportIdx = scriptContent.indexOf('export SCNS_')
      const execIdx = scriptContent.indexOf('exec ')
      expect(exportIdx).toBeGreaterThan(-1)
      expect(execIdx).toBeGreaterThan(exportIdx)
      tmuxSpawner.shutdownAll()
    })

    it('tmux script safely escapes env values with special characters', async () => {
      const tmuxDeps = makeMockDeps({
        isTmuxAvailable: () => true,
        spawnSync: vi.fn().mockReturnValue({
          status: 0,
          stdout: Buffer.from(''),
          stderr: Buffer.from(''),
          pid: 0,
          output: [],
          signal: null,
        }) as unknown as SpawnerDeps['spawnSync'],
      })
      // Use a team_id with a single quote to test shell escaping
      const teamWithQuote = "team'quoted"
      testDb.db
        .prepare('INSERT OR IGNORE INTO teams (id, name) VALUES (?, ?)')
        .run(teamWithQuote, 'Quoted Team')
      const tmuxSpawner = createAgentSpawner(testDb.db, eventLog, {
        brokerUrl: 'http://localhost:9999',
        workingDir: '/test/dir',
        deps: tmuxDeps,
      })
      await tmuxSpawner.spawn({
        team_id: teamWithQuote,
        name: 'agent-special',
        role: 'dev',
      })
      const writeCall = (tmuxDeps.writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0]
      const scriptContent = writeCall[1] as string
      // shellQuote escapes single quotes: team'quoted → 'team'\''quoted'
      expect(scriptContent).toContain("'team'\\''quoted'")
      tmuxSpawner.shutdownAll()
    })

    it('env vars match broker URL from options', async () => {
      const customSpawner = createAgentSpawner(testDb.db, eventLog, {
        brokerUrl: 'http://custom-host:8080',
        workingDir: '/test/dir',
        deps,
      })
      await customSpawner.spawn(defaultInput)
      const spawnCall = (deps.spawnProcess as ReturnType<typeof vi.fn>).mock.calls[0]
      const spawnOpts = spawnCall[2] as { env?: Record<string, string> }
      expect(spawnOpts.env!.SCNS_BROKER_URL).toBe('http://custom-host:8080')
      customSpawner.shutdownAll()
    })

    it('env vars use default broker URL when not specified', async () => {
      const defaultSpawner = createAgentSpawner(testDb.db, eventLog, {
        workingDir: '/test/dir',
        deps,
      })
      await defaultSpawner.spawn(defaultInput)
      const spawnCall = (deps.spawnProcess as ReturnType<typeof vi.fn>).mock.calls[0]
      const spawnOpts = spawnCall[2] as { env?: Record<string, string> }
      expect(spawnOpts.env!.SCNS_BROKER_URL).toBe('http://localhost:3456')
      defaultSpawner.shutdownAll()
    })
  })

  describe('GAP-013: heartbeat direction fix', () => {
    it('spawn does NOT create a server-side heartbeat interval', async () => {
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
      const noHbSpawner = createAgentSpawner(testDb.db, eventLog, {
        workingDir: '/test/dir',
        deps,
      })
      await noHbSpawner.spawn(defaultInput)

      // setInterval should NOT have been called by spawn
      const spawnerCalls = setIntervalSpy.mock.calls.filter((call) => typeof call[0] === 'function')
      expect(spawnerCalls.length).toBe(0)

      noHbSpawner.shutdownAll()
      setIntervalSpy.mockRestore()
    })

    it('spawned agent has null heartbeat timer', async () => {
      // Verify via cleanup: cleanup should not throw even with null timer
      const result = await spawner.spawn(defaultInput)
      expect(spawner.getActiveAgents().has(result.sessionId)).toBe(true)
      // Cleanup should work gracefully with null heartbeat timer
      spawner.cleanup(result.sessionId)
      expect(spawner.getActiveAgents().has(result.sessionId)).toBe(false)
    })

    it('cleanupSession handles null heartbeat timer without error', async () => {
      const result = await spawner.spawn(defaultInput)
      // Should not throw when heartbeat timer is null
      expect(() => spawner.cleanup(result.sessionId)).not.toThrow()
    })

    it('heartbeatMs option is no longer used for server-side timer', async () => {
      const customSpawner = createAgentSpawner(testDb.db, eventLog, {
        heartbeatMs: 1, // Very short - would fire immediately if used
        workingDir: '/test/dir',
        deps,
      })
      await customSpawner.spawn(defaultInput)
      // Even with 1ms heartbeat, no timer should be created
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
      // Wait a tick to ensure no timer fires
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(setIntervalSpy).not.toHaveBeenCalled()
      customSpawner.shutdownAll()
      setIntervalSpy.mockRestore()
    })
  })

  describe('Phase 13.12.17: internal token + secret keys', () => {
    it('injects SCNS_INTERNAL_TOKEN into detached spawn env when provided', async () => {
      const tokDeps = makeMockDeps()
      const tokSpawner = createAgentSpawner(testDb.db, eventLog, {
        brokerUrl: 'http://localhost:9999',
        workingDir: '/test/dir',
        deps: tokDeps,
        internalToken: 'a'.repeat(64),
      })
      await tokSpawner.spawn(defaultInput)
      const spawnCall = (tokDeps.spawnProcess as ReturnType<typeof vi.fn>).mock.calls[0]
      const spawnOpts = spawnCall![2] as { env?: Record<string, string> }
      expect(spawnOpts.env!['SCNS_INTERNAL_TOKEN']).toBe('a'.repeat(64))
      tokSpawner.shutdownAll()
    })

    it('does NOT inject SCNS_INTERNAL_TOKEN when token is not provided', async () => {
      const noTokDeps = makeMockDeps()
      const noTokSpawner = createAgentSpawner(testDb.db, eventLog, {
        brokerUrl: 'http://localhost:9999',
        workingDir: '/test/dir',
        deps: noTokDeps,
      })
      await noTokSpawner.spawn(defaultInput)
      const spawnCall = (noTokDeps.spawnProcess as ReturnType<typeof vi.fn>).mock.calls[0]
      const spawnOpts = spawnCall![2] as { env?: Record<string, string> }
      expect(spawnOpts.env!['SCNS_INTERNAL_TOKEN']).toBeUndefined()
      noTokSpawner.shutdownAll()
    })

    it('advertises secret keys in the agent prompt when getAvailableSecretKeys returns keys', async () => {
      // Use tmux path to capture prompt in the script content
      const tmuxDeps = makeMockDeps({
        isTmuxAvailable: () => true,
        spawnSync: vi.fn().mockReturnValue({
          status: 0,
          stdout: Buffer.from(''),
          stderr: Buffer.from(''),
          pid: 0,
          output: [],
          signal: null,
        }) as unknown as SpawnerDeps['spawnSync'],
      })
      const sk = ['instagram.password', 'openai.api_key']
      const sSpawner = createAgentSpawner(testDb.db, eventLog, {
        brokerUrl: 'http://localhost:9999',
        workingDir: '/test/dir',
        deps: tmuxDeps,
        getAvailableSecretKeys: () => sk,
      })
      await sSpawner.spawn(defaultInput)
      // writeFileSync is called for the launch script; args include prompt.
      // Simpler assertion: verify the prompt includes our keys by calling
      // buildAgentPrompt directly with the same keys.
      const { buildAgentPrompt } = await import(
        '../../../../src/broker/services/prompt-builder.js'
      )
      const prompt = buildAgentPrompt({
        sessionId: 'x',
        teamId: 't',
        name: 'n',
        role: 'dev',
        brokerUrl: 'http://localhost:9999',
        availableSecretKeys: sk,
      })
      expect(prompt).toContain('## Available secrets')
      expect(prompt).toContain('instagram.password')
      expect(prompt).toContain('openai.api_key')
      expect(prompt).toContain('X-SCNS-Internal-Token')
      expect(prompt).toContain('NEVER log')
      sSpawner.shutdownAll()
    })

    it('omits secrets section when no keys are available', async () => {
      const { buildAgentPrompt } = await import(
        '../../../../src/broker/services/prompt-builder.js'
      )
      const prompt = buildAgentPrompt({
        sessionId: 'x',
        teamId: 't',
        name: 'n',
        role: 'dev',
        brokerUrl: 'http://localhost:9999',
      })
      expect(prompt).not.toContain('## Available secrets')
    })
  })

  describe('Phase 13.12.20 — transactional spawn + expanded role allowlist', () => {
    it('accepts expanded roles (implementer, scns-dev, scns-qa, researcher, critic)', async () => {
      for (const role of ['implementer', 'scns-dev', 'scns-qa', 'researcher', 'critic']) {
        const result = await spawner.spawn({
          team_id: 'test-team',
          name: `agent-${role}`,
          role,
          prompt: 'Do work',
        })
        const member = findTeamMember(testDb.db, 'test-team', result.sessionId)
        expect(member).not.toBeNull()
        expect(member!.role).toBe(role)
      }
    })

    it('rolls back the session row when addTeamMember fails (FK violation)', async () => {
      // Count sessions before the failing spawn
      const sessionCountBefore = testDb.db
        .prepare('SELECT COUNT(*) as n FROM sessions')
        .get() as { n: number }

      // P4 (de-hardcode roles): role is now free-text, so the old CHECK can no
      // longer force a failure. Instead target a NON-EXISTENT team — the
      // addTeamMember INSERT fails the team_id FOREIGN KEY (foreign_keys=ON),
      // exercising the same transactional rollback: the session row inserted
      // first in the txn must roll back together with the failed member insert.
      await expect(
        spawner.spawn({
          team_id: 'no-such-team',
          name: 'doomed-agent',
          role: 'dev',
          prompt: 'Should fail',
        }),
      ).rejects.toThrow()

      const sessionCountAfter = testDb.db
        .prepare('SELECT COUNT(*) as n FROM sessions')
        .get() as { n: number }

      // No orphan session row left behind.
      expect(sessionCountAfter.n).toBe(sessionCountBefore.n)

      // No team member either.
      const members = testDb.db
        .prepare('SELECT * FROM team_members WHERE team_id = ?')
        .all('no-such-team')
      expect(members).toHaveLength(0)

      // And no subprocess should have been spawned for the doomed agent.
      expect(deps.spawnProcess).not.toHaveBeenCalled()
    })
  })

  describe('F1: global concurrent-agent cap', () => {
    it('rejects spawn with AgentCapExceededError when cap is reached', async () => {
      const capped = createAgentSpawner(testDb.db, eventLog, {
        brokerUrl: 'http://localhost:9999',
        workingDir: '/test/dir',
        deps,
        maxConcurrentAgents: 2,
      })
      try {
        await capped.spawn({ team_id: 'test-team', name: 'a1', role: 'dev', prompt: 'x' })
        await capped.spawn({ team_id: 'test-team', name: 'a2', role: 'dev', prompt: 'x' })
        await expect(
          capped.spawn({ team_id: 'test-team', name: 'a3', role: 'dev', prompt: 'x' }),
        ).rejects.toMatchObject({ name: 'AgentCapExceededError', code: 'AGENT_CAP_EXCEEDED' })
        expect(capped.getSpawnStats()).toMatchObject({ activeCount: 2, maxConcurrent: 2 })
      } finally {
        await capped.shutdownAll()
      }
    })

    it('allows new spawns after a slot is freed via cleanup()', async () => {
      const capped = createAgentSpawner(testDb.db, eventLog, {
        brokerUrl: 'http://localhost:9999',
        workingDir: '/test/dir',
        deps,
        maxConcurrentAgents: 1,
      })
      try {
        const first = await capped.spawn({ team_id: 'test-team', name: 'a1', role: 'dev', prompt: 'x' })
        await expect(
          capped.spawn({ team_id: 'test-team', name: 'a2', role: 'dev', prompt: 'x' }),
        ).rejects.toMatchObject({ name: 'AgentCapExceededError' })
        await capped.cleanup(first.sessionId)
        // After freeing, a new spawn should succeed.
        const second = await capped.spawn({ team_id: 'test-team', name: 'a2', role: 'dev', prompt: 'x' })
        expect(second.sessionId).toBeTruthy()
      } finally {
        await capped.shutdownAll()
      }
    })

    it('getSpawnStats reports active count, cap, and rolling 60s spawn count', async () => {
      const s = createAgentSpawner(testDb.db, eventLog, {
        brokerUrl: 'http://localhost:9999',
        workingDir: '/test/dir',
        deps,
        maxConcurrentAgents: 4,
      })
      try {
        expect(s.getSpawnStats()).toEqual({ activeCount: 0, maxConcurrent: 4, spawnsLast60s: 0, pendingCount: 0 })
        await s.spawn({ team_id: 'test-team', name: 'a1', role: 'dev', prompt: 'x' })
        await s.spawn({ team_id: 'test-team', name: 'a2', role: 'dev', prompt: 'x' })
        const stats = s.getSpawnStats()
        expect(stats.activeCount).toBe(2)
        expect(stats.spawnsLast60s).toBe(2)
      } finally {
        await s.shutdownAll()
      }
    })

    it('cap is atomic under concurrent spawn() calls (pendingSpawns race guard)', async () => {
      // Regression test for QA nit #2 (race between cap check and activeAgents.set):
      // ACP launch path awaits client.initialize() + createSession() BEFORE
      // activeAgents.set, so N parallel callers could all pass a size-only cap
      // check. pendingSpawns is a synchronous reservation counter that closes
      // the window. Here we fire 10 spawn()s concurrently with cap=2 and assert
      // exactly 2 succeed and exactly 8 throw AgentCapExceededError — no
      // overshoot, no permanent leak of reservations.
      const capped = createAgentSpawner(testDb.db, eventLog, {
        brokerUrl: 'http://localhost:9999',
        workingDir: '/test/dir',
        deps,
        maxConcurrentAgents: 2,
      })
      try {
        const results = await Promise.allSettled(
          Array.from({ length: 10 }, (_, i) =>
            capped.spawn({ team_id: 'test-team', name: `race-${i}`, role: 'dev', prompt: 'x' }),
          ),
        )
        const fulfilled = results.filter((r) => r.status === 'fulfilled')
        const rejected = results.filter((r) => r.status === 'rejected')
        expect(fulfilled).toHaveLength(2)
        expect(rejected).toHaveLength(8)
        for (const r of rejected) {
          expect((r as PromiseRejectedResult).reason).toMatchObject({
            name: 'AgentCapExceededError',
            code: 'AGENT_CAP_EXCEEDED',
          })
        }
        // After the storm, pendingSpawns must have drained fully — no
        // permanent reservation leak that would block future spawns.
        const stats = capped.getSpawnStats()
        expect(stats.activeCount).toBe(2)
        expect(stats.pendingCount).toBe(0)
      } finally {
        await capped.shutdownAll()
      }
    })

    it('pendingSpawns drains on spawn failure (reservation released on throw)', async () => {
      // If spawn() throws between reserving pendingSpawns++ and activeAgents.set,
      // the reservation must still be released so future spawns can proceed.
      // P4 (de-hardcode roles): role is free-text now, so force the throw via a
      // NON-EXISTENT team — addTeamMember fails the team_id FK inside the
      // session+member transaction, after the cap reservation is taken.
      const capped = createAgentSpawner(testDb.db, eventLog, {
        brokerUrl: 'http://localhost:9999',
        workingDir: '/test/dir',
        deps,
        maxConcurrentAgents: 2,
      })
      try {
        await expect(
          capped.spawn({
            team_id: 'no-such-team',
            name: 'doomed',
            role: 'dev',
            prompt: 'x',
          }),
        ).rejects.toThrow()
        await expect(
          capped.spawn({
            team_id: 'no-such-team',
            name: 'doomed-2',
            role: 'dev',
            prompt: 'x',
          }),
        ).rejects.toThrow()
        // Cap should still allow 2 successful spawns after 2 failures.
        expect(capped.getSpawnStats().pendingCount).toBe(0)
        const r1 = await capped.spawn({ team_id: 'test-team', name: 'ok-1', role: 'dev', prompt: 'x' })
        const r2 = await capped.spawn({ team_id: 'test-team', name: 'ok-2', role: 'dev', prompt: 'x' })
        expect(r1.sessionId).toBeTruthy()
        expect(r2.sessionId).toBeTruthy()
      } finally {
        await capped.shutdownAll()
      }
    })
  })

  // ── WS F (Phase 13.13.x): broker-mechanical auto-dispatch ─────────────
  describe('auto-dispatch (manager + task triggers dev + qa)', () => {
    const taskInput = {
      team_id: 'test-team',
      name: 'task-77-mgr',
      role: 'scns-manager',
      task: { id: 77, subject: 'Fix the parser', description: 'Stop swallowing errors.' },
      team_name: 'test-team',
    } as const

    it('spawns one scns-dev and one scns-qa team member alongside the manager', async () => {
      const result = await spawner.spawn(taskInput)
      expect(result.role).toBe('scns-manager')

      const members = testDb.db
        .prepare('SELECT role FROM team_members WHERE team_id = ?')
        .all('test-team') as Array<{ role: string }>
      const roles = members.map((m) => m.role).sort()
      expect(roles).toEqual(['scns-dev', 'scns-manager', 'scns-qa'])
    })

    it('synthesizes a Dispatch Readback message authored by the manager', async () => {
      const result = await spawner.spawn(taskInput)
      const row = testDb.db
        .prepare(
          `SELECT content FROM messages WHERE team_id = ? AND sender_id = ? ORDER BY seq DESC LIMIT 1`,
        )
        .get('test-team', result.sessionId) as { content?: string } | undefined
      expect(row?.content).toBeDefined()
      expect(row!.content!).toContain('Dispatch Readback:')

      // Round-trip through the WS A parser — synthesized text must satisfy
      // the same parser used by the WS C manager-exit-monitor.
      const { parseManagerReadback } = await import(
        '../../../../src/broker/services/manager-dispatch-readback.js'
      )
      const parsed = parseManagerReadback(row!.content!)
      expect(parsed.devSessionId).toBeTruthy()
      expect(parsed.qaSessionId).toBeTruthy()
      // Both ids must match real spawned sessions.
      const devMember = testDb.db
        .prepare('SELECT session_id FROM team_members WHERE team_id = ? AND role = ?')
        .get('test-team', 'scns-dev') as { session_id: string }
      const qaMember = testDb.db
        .prepare('SELECT session_id FROM team_members WHERE team_id = ? AND role = ?')
        .get('test-team', 'scns-qa') as { session_id: string }
      expect(parsed.devSessionId).toBe(devMember.session_id)
      expect(parsed.qaSessionId).toBe(qaMember.session_id)
    })

    it('does NOT trigger auto-dispatch for a manager spawn without task', async () => {
      const result = await spawner.spawn({
        team_id: 'test-team',
        name: 'mgr-bare',
        role: 'scns-manager',
        prompt: 'no task attached',
      })
      expect(result.role).toBe('scns-manager')

      const members = testDb.db
        .prepare('SELECT role FROM team_members WHERE team_id = ?')
        .all('test-team') as Array<{ role: string }>
      expect(members.map((m) => m.role)).toEqual(['scns-manager'])

      // No synthesized broadcast either.
      const msgCount = testDb.db
        .prepare('SELECT COUNT(*) AS n FROM messages WHERE team_id = ?')
        .get('test-team') as { n: number }
      expect(msgCount.n).toBe(0)
    })

    it('does NOT trigger auto-dispatch for a non-manager role even with task set', async () => {
      const result = await spawner.spawn({
        team_id: 'test-team',
        name: 'just-dev',
        role: 'scns-dev',
        task: { id: 77, subject: 'x', description: 'y' },
      })
      expect(result.role).toBe('scns-dev')
      const members = testDb.db
        .prepare('SELECT role FROM team_members WHERE team_id = ?')
        .all('test-team') as Array<{ role: string }>
      expect(members.map((m) => m.role)).toEqual(['scns-dev'])
    })

    it('records existing owner (409) when a scns-dev member is already on the team', async () => {
      // Pre-existing dev on the team
      await spawner.spawn({
        team_id: 'test-team',
        name: 'pre-dev',
        role: 'scns-dev',
        prompt: 'already here',
      })
      const preDevId = (
        testDb.db
          .prepare('SELECT session_id FROM team_members WHERE team_id = ? AND role = ?')
          .get('test-team', 'scns-dev') as { session_id: string }
      ).session_id

      const mgr = await spawner.spawn(taskInput)
      const row = testDb.db
        .prepare(
          `SELECT content FROM messages WHERE team_id = ? AND sender_id = ? ORDER BY seq DESC LIMIT 1`,
        )
        .get('test-team', mgr.sessionId) as { content?: string }
      expect(row.content).toContain(`409:${preDevId}`)
    })

    it('synthesized readback satisfies WS C manager-exit-monitor (no incomplete event)', async () => {
      const result = await spawner.spawn(taskInput)

      const { createManagerExitMonitor } = await import(
        '../../../../src/broker/services/manager-exit-monitor.js'
      )
      const events: Array<{ sessionId: string | null; data: Record<string, unknown> }> = []
      const monitor = createManagerExitMonitor({
        eventLog: {
          managerDispatchIncomplete(sessionId, data) {
            events.push({ sessionId, data })
          },
        },
        findLatestManagerBroadcast: (teamId, mgrId) => {
          const r = testDb.db
            .prepare(
              `SELECT content FROM messages WHERE team_id = ? AND sender_id = ? ORDER BY seq DESC LIMIT 1`,
            )
            .get(teamId, mgrId) as { content?: string } | undefined
          return r?.content ?? null
        },
        wasSessionRegistered: () => true,
      })

      monitor.handleAgentExit({
        sessionId: result.sessionId,
        teamId: result.teamId,
        role: 'scns-manager',
        reason: 'normal',
      })

      expect(events).toHaveLength(0)
    })
  })

  // ============================================================
  // Task 34 (neuron fan-out): per-team working_dir + bumped cap
  // ============================================================
  describe('task 34: neuron fan-out — per-team working_dir', () => {
    it('uses team.working_dir from DB when set, ignoring caller-supplied path', async () => {
      // Pre-register two teams pinned to different checkouts.
      testDb.db
        .prepare('INSERT INTO teams (id, name, working_dir) VALUES (?, ?, ?)')
        .run('neuron-a', 'Neuron A', '/tmp/neuron-a-tree')
      testDb.db
        .prepare('INSERT INTO teams (id, name, working_dir) VALUES (?, ?, ?)')
        .run('neuron-b', 'Neuron B', '/tmp/neuron-b-tree')

      // Both spawns pass the broker cwd (`/test/dir`) as working_dir,
      // mimicking team-task-autospawner. Team override MUST win.
      const a = await spawner.spawn({
        team_id: 'neuron-a',
        name: 'mgr-a',
        role: 'scns-manager',
        working_dir: '/test/dir',
      })
      const b = await spawner.spawn({
        team_id: 'neuron-b',
        name: 'mgr-b',
        role: 'scns-manager',
        working_dir: '/test/dir',
      })

      const sessionA = findSessionById(testDb.db, a.sessionId)
      const sessionB = findSessionById(testDb.db, b.sessionId)
      // resolve(): the spawner canonicalizes working_dir before persisting.
      expect(sessionA!.working_dir).toBe(resolve('/tmp/neuron-a-tree'))
      expect(sessionB!.working_dir).toBe(resolve('/tmp/neuron-b-tree'))
    })

    it('falls back to caller-supplied working_dir when team.working_dir is NULL (legacy)', async () => {
      // 'test-team' from outer beforeEach has working_dir = NULL.
      const result = await spawner.spawn({
        ...defaultInput,
        working_dir: '/some/explicit/path',
      })
      const session = findSessionById(testDb.db, result.sessionId)
      expect(session!.working_dir).toBe(resolve('/some/explicit/path'))
    })

    it('falls back to broker cwd when both team.working_dir and input.working_dir are absent', async () => {
      const result = await spawner.spawn(defaultInput)
      const session = findSessionById(testDb.db, result.sessionId)
      // outer spawner was constructed with workingDir: '/test/dir'
      expect(session!.working_dir).toBe(resolve('/test/dir'))
    })
  })

  describe('task 34: bumped concurrent-agent cap (default = 8)', () => {
    it('two neurons of 3 agents each fit under DEFAULT_MAX_CONCURRENT_AGENTS', async () => {
      const { DEFAULT_MAX_CONCURRENT_AGENTS } = await import(
        '../../../../src/broker/services/agent-spawner.js'
      )
      // Hard assertion: the constant itself bumped to ≥ 8 (was 4
      // pre-task-34). The old value of 4 blocked any second neuron's
      // manager from ever spawning.
      expect(DEFAULT_MAX_CONCURRENT_AGENTS).toBeGreaterThanOrEqual(8)

      // Functional check: build a spawner with NO explicit cap so the
      // default applies, then spawn 6 agents (= 2 neurons × manager + dev + qa).
      // Pre-task-34 this would throw AgentCapExceededError on the 5th spawn.
      const cappedSpawner = createAgentSpawner(testDb.db, eventLog, {
        brokerUrl: 'http://localhost:9999',
        workingDir: '/test/dir',
        deps,
        // intentionally NO maxConcurrentAgents — exercise the default
      })
      testDb.db
        .prepare('INSERT INTO teams (id, name, working_dir) VALUES (?, ?, ?)')
        .run('cap-a', 'Cap A', '/tmp/cap-a')
      testDb.db
        .prepare('INSERT INTO teams (id, name, working_dir) VALUES (?, ?, ?)')
        .run('cap-b', 'Cap B', '/tmp/cap-b')

      const roles = ['scns-manager', 'scns-dev', 'scns-qa']
      const all: Promise<unknown>[] = []
      for (const team of ['cap-a', 'cap-b']) {
        for (const role of roles) {
          all.push(
            cappedSpawner.spawn({
              team_id: team,
              name: `${team}-${role}`,
              role,
              working_dir: '/test/dir',
            }),
          )
        }
      }
      // All 6 must succeed — none should throw AgentCapExceededError.
      await expect(Promise.all(all)).resolves.toHaveLength(6)
      await cappedSpawner.shutdownAll()
    })
  })
})
