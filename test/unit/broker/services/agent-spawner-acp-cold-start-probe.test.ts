/**
 * Phase 1.5 step 5 — agent-spawner cold-start timing probe.
 *
 * Verifies that after a successful `client.initialize() + createSession()`
 * sequence, the spawner reads `client.timings`, computes the three latency
 * deltas, and emits `agent_acp_timing` via the SpawnerEventLog. The probe
 * is observe-only and must NEVER block the spawn flow — these tests
 * confirm that an emit failure, a missing-timings mock, or a thrown
 * SpawnerEventLog method does not surface to the spawn caller.
 *
 * The probe is what the Step-5b warm-pool design will key on: if
 * `process_spawn_to_initialize_ms` dominates the typical 3-5s cold start,
 * a post-initialize/pre-session-new pool saves most of the cost; if
 * `session_new_ms` dominates, a pool only saves a fraction (every spawn
 * must hit session/new with its own cwd anyway). Without this probe the
 * design is guesswork — exactly the rubber-duck-flagged risk.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { TestDb } from '../../../helpers/db-harness.js'
import { createBrokerTestDb } from '../../../helpers/broker-db-harness.js'
import {
  createAgentSpawner,
} from '../../../../src/broker/services/agent-spawner.js'
import type {
  AgentSpawner,
  SpawnerDeps,
  SpawnerEventLog,
} from '../../../../src/broker/services/agent-spawner.js'
import type {
  AcpClient,
  AcpClientOptions,
  AcpClientTimings,
  AcpInitResult,
  AcpPromptResult,
  AcpSessionUpdate,
  AcpSessionStateType,
} from '../../../../src/broker/services/acp-client.js'
import type { CliInfo, Platform } from '../../../../src/broker/services/platform.js'

// ── Mock helpers ────────────────────────────────────────────────────────────

function makeMockEventLog(): SpawnerEventLog {
  return {
    sessionRegistered: vi.fn(),
    sessionDeregistered: vi.fn(),
    teamMemberJoined: vi.fn(),
    agentLaunchStarted: vi.fn(),
    agentPromptDelivered: vi.fn(),
    agentFirstOutputReceived: vi.fn(),
    agentLaunchFailed: vi.fn(),
    agentNudgeSent: vi.fn(),
    agentAcpTiming: vi.fn(),
  }
}

interface MockAcpClient extends AcpClient {
  readonly updateHandlers: ReadonlyArray<(u: AcpSessionUpdate) => void>
}

function makeMockAcpClient(timings: AcpClientTimings): MockAcpClient & {
  resolveSendPrompt: () => void
} {
  const updateHandlers: ((u: AcpSessionUpdate) => void)[] = []
  let state: AcpSessionStateType = 'closed'
  let sendPromptResolve: ((r: AcpPromptResult) => void) | null = null
  const client = {
    get updateHandlers() {
      return updateHandlers
    },
    get state() {
      return state
    },
    get pid() {
      return null
    },
    get timings() {
      return timings
    },
    async initialize(): Promise<AcpInitResult> {
      state = 'ready'
      return { protocolVersion: 1 } as AcpInitResult
    },
    async createSession(): Promise<string> {
      return 'acp-session-mock'
    },
    sendPrompt(_sid: string, _prompt: string): Promise<AcpPromptResult> {
      return new Promise<AcpPromptResult>((resolve) => {
        sendPromptResolve = resolve
      })
    },
    onUpdate(handler: (u: AcpSessionUpdate) => void) {
      updateHandlers.push(handler)
    },
    getAvailableCommands() {
      return null
    },
    cancelSession() {
      // no-op
    },
    async close() {
      state = 'closed'
      if (sendPromptResolve) {
        sendPromptResolve({ stopReason: 'end_turn', output: '' })
        sendPromptResolve = null
      }
    },
  } as MockAcpClient & { resolveSendPrompt: () => void }
  client.resolveSendPrompt = () => {
    if (sendPromptResolve) {
      sendPromptResolve({ stopReason: 'end_turn', output: '' })
      sendPromptResolve = null
    }
  }
  return client
}

function makeMockDeps(): SpawnerDeps {
  return {
    detectPlatform: () => 'darwin' as Platform,
    findCli: () => ({ command: 'copilot' }) as CliInfo,
    isTmuxAvailable: () => false,
    spawnProcess: vi.fn() as unknown as SpawnerDeps['spawnProcess'],
    spawnSync: vi.fn(() => ({
      status: 0,
      stdout: Buffer.from(''),
      stderr: Buffer.from(''),
      pid: 0,
      output: [],
      signal: null,
    })) as unknown as SpawnerDeps['spawnSync'],
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

async function microFlush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Phase 1.5 step 5 — agent-spawner ACP cold-start timing probe', () => {
  let testDb: TestDb
  let eventLog: SpawnerEventLog
  let spawner: AgentSpawner
  let mockClient: MockAcpClient & { resolveSendPrompt: () => void }

  beforeEach(() => {
    testDb = createBrokerTestDb()
    testDb.db.prepare('INSERT INTO teams (id, name) VALUES (?, ?)').run('t1', 'T1')
    eventLog = makeMockEventLog()
  })

  afterEach(async () => {
    if (mockClient) mockClient.resolveSendPrompt()
    if (spawner) await spawner.shutdownAll()
    testDb.close()
  })

  function bootSpawner(client: MockAcpClient): AgentSpawner {
    return createAgentSpawner(testDb.db, eventLog, {
      brokerUrl: 'http://localhost:9999',
      heartbeatMs: 60_000,
      workingDir: '/repo',
      deps: makeMockDeps(),
      maxConcurrentAgents: Infinity,
      nudgeRoles: [],
      acpClientFactory: (_o?: AcpClientOptions) => client,
    })
  }

  it('emits agent_acp_timing with the three deltas + raw marks after createSession', async () => {
    // Plausible cold-start: 2.4s for spawn+initialize, 1.2s for session/new.
    mockClient = makeMockAcpClient({
      processSpawnStartedAt: 1_000_000,
      initializeResolvedAt: 1_002_400,
      sessionNewStartedAt: 1_002_400,
      sessionNewResolvedAt: 1_003_600,
    })
    spawner = bootSpawner(mockClient)

    const spawnP = spawner.spawn({
      team_id: 't1',
      name: 'dev-1',
      role: 'scns-dev',
      prompt: 'Implement task',
      launch_method: 'acp',
      working_dir: '/repo',
    })
    // Wait until the spawn loop has reached the post-createSession line.
    for (let i = 0; i < 50 && (eventLog.agentAcpTiming as ReturnType<typeof vi.fn>).mock.calls.length === 0; i += 1) {
      await microFlush()
    }

    const emit = eventLog.agentAcpTiming as ReturnType<typeof vi.fn>
    expect(emit).toHaveBeenCalledTimes(1)
    const [sessionId, payload] = emit.mock.calls[0]! as [string, Record<string, unknown>]
    expect(typeof sessionId).toBe('string')
    expect(sessionId.length).toBeGreaterThan(0)
    expect(payload['role']).toBe('scns-dev')
    expect(payload['team_id']).toBe('t1')
    expect(payload['acp_session_id']).toBe('acp-session-mock')
    expect(payload['process_spawn_to_initialize_ms']).toBe(2400)
    expect(payload['session_new_ms']).toBe(1200)
    expect(payload['cold_start_ms']).toBe(3600)
    expect(payload['process_spawn_started_at']).toBe(1_000_000)
    expect(payload['initialize_resolved_at']).toBe(1_002_400)
    expect(payload['session_new_started_at']).toBe(1_002_400)
    expect(payload['session_new_resolved_at']).toBe(1_003_600)

    mockClient.resolveSendPrompt()
    await spawnP
  })

  it('does NOT emit when timings are all null (back-compat with mocks that ignore the probe)', async () => {
    mockClient = makeMockAcpClient({
      processSpawnStartedAt: null,
      initializeResolvedAt: null,
      sessionNewStartedAt: null,
      sessionNewResolvedAt: null,
    })
    spawner = bootSpawner(mockClient)

    const spawnP = spawner.spawn({
      team_id: 't1',
      name: 'dev-2',
      role: 'scns-dev',
      prompt: 'Implement task',
      launch_method: 'acp',
      working_dir: '/repo',
    })
    // Let the spawn make all the way through createSession.
    for (let i = 0; i < 20; i += 1) await microFlush()
    // resolve to let the spawn settle past sendPrompt.
    mockClient.resolveSendPrompt()
    await spawnP

    const emit = eventLog.agentAcpTiming as ReturnType<typeof vi.fn>
    expect(emit).not.toHaveBeenCalled()
  })

  it('does NOT emit when only a subset of marks is populated (partial-mock case)', async () => {
    mockClient = makeMockAcpClient({
      processSpawnStartedAt: 1_000_000,
      initializeResolvedAt: 1_002_400,
      sessionNewStartedAt: null,
      sessionNewResolvedAt: null,
    })
    spawner = bootSpawner(mockClient)

    const spawnP = spawner.spawn({
      team_id: 't1',
      name: 'qa-1',
      role: 'scns-qa',
      prompt: 'Verify task',
      launch_method: 'acp',
      working_dir: '/repo',
    })
    for (let i = 0; i < 20; i += 1) await microFlush()
    mockClient.resolveSendPrompt()
    await spawnP

    const emit = eventLog.agentAcpTiming as ReturnType<typeof vi.fn>
    expect(emit).not.toHaveBeenCalled()
  })

  it('spawn still completes when agentAcpTiming method is omitted from the event log', async () => {
    mockClient = makeMockAcpClient({
      processSpawnStartedAt: 1_000_000,
      initializeResolvedAt: 1_002_400,
      sessionNewStartedAt: 1_002_400,
      sessionNewResolvedAt: 1_003_600,
    })
    // Build an event log WITHOUT agentAcpTiming — the field is optional on
    // SpawnerEventLog. The spawner's safeEmit wrapper must swallow the
    // missing handler cleanly.
    eventLog = {
      sessionRegistered: vi.fn(),
      sessionDeregistered: vi.fn(),
      teamMemberJoined: vi.fn(),
      agentLaunchStarted: vi.fn(),
      agentPromptDelivered: vi.fn(),
      agentFirstOutputReceived: vi.fn(),
      agentLaunchFailed: vi.fn(),
      agentNudgeSent: vi.fn(),
      // agentAcpTiming intentionally omitted.
    }
    spawner = bootSpawner(mockClient)

    const spawnP = spawner.spawn({
      team_id: 't1',
      name: 'dev-3',
      role: 'scns-dev',
      prompt: 'Task',
      launch_method: 'acp',
      working_dir: '/repo',
    })
    for (let i = 0; i < 20; i += 1) await microFlush()
    mockClient.resolveSendPrompt()
    // The spawn must NOT reject just because the optional emit field is
    // missing — back-compat with pre-step-5 callers.
    await expect(spawnP).resolves.toBeDefined()
  })

  it('spawn still completes when the agentAcpTiming handler throws (probe must be non-blocking)', async () => {
    mockClient = makeMockAcpClient({
      processSpawnStartedAt: 1_000_000,
      initializeResolvedAt: 1_002_400,
      sessionNewStartedAt: 1_002_400,
      sessionNewResolvedAt: 1_003_600,
    })
    eventLog = makeMockEventLog()
    ;(eventLog.agentAcpTiming as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('synthetic event-log failure')
    })
    spawner = bootSpawner(mockClient)

    const spawnP = spawner.spawn({
      team_id: 't1',
      name: 'dev-4',
      role: 'scns-dev',
      prompt: 'Task',
      launch_method: 'acp',
      working_dir: '/repo',
    })
    for (let i = 0; i < 20; i += 1) await microFlush()
    mockClient.resolveSendPrompt()
    await expect(spawnP).resolves.toBeDefined()
  })
})
