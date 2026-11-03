/**
 * Phase 1.5 step 2 — agent-spawner ACP bootstrap-update filtering.
 *
 * Background: the broker's `agent_first_output_received` event was firing
 * on ANY ACP `session/update` notification — including bootstrap-stream
 * notifications (`available_commands_update`, `config_option_update`)
 * that arrive BEFORE the agent has reacted to the prompt. The known
 * "manager exited without dispatch, no output" failure class observed in
 * production showed exactly this masking effect: `first_output sample=
 * 'available_commands_update'`, then NO message_sent events ever from
 * the agent. Treating bootstrap signals as "first output" lied about the
 * launch's health.
 *
 * The fix: only count notification kinds NOT in
 * `ACP_BOOTSTRAP_UPDATE_KINDS` as first output.
 *
 * These tests inject an AcpClient mock that captures the onUpdate
 * handler and pushes synthetic notifications through it, then asserts
 * `agentFirstOutputReceived` is (a) not called for bootstrap kinds and
 * (b) IS called for the first meaningful update.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { TestDb } from '../../../helpers/db-harness.js'
import { createBrokerTestDb } from '../../../helpers/broker-db-harness.js'
import {
  createAgentSpawner,
  ACP_BOOTSTRAP_UPDATE_KINDS,
} from '../../../../src/broker/services/agent-spawner.js'
import type {
  AgentSpawner,
  SpawnerDeps,
  SpawnerEventLog,
} from '../../../../src/broker/services/agent-spawner.js'
import type {
  AcpClient,
  AcpClientOptions,
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
  }
}

interface MockAcpClient extends AcpClient {
  readonly updateHandlers: ReadonlyArray<(u: AcpSessionUpdate) => void>
  readonly sendPromptCalls: ReadonlyArray<string>
}

function makeMockAcpClient(): MockAcpClient {
  const updateHandlers: ((u: AcpSessionUpdate) => void)[] = []
  const sendPromptCalls: string[] = []
  let state: AcpSessionStateType = 'closed'
  let closed = false
  // Resolve sendPrompt only when the test asks (we want to push
  // bootstrap updates BEFORE the prompt resolves, exactly mirroring the
  // observed production sequence).
  let sendPromptResolve: ((r: AcpPromptResult) => void) | null = null
  const client: MockAcpClient = {
    get updateHandlers() {
      return updateHandlers
    },
    get sendPromptCalls() {
      return sendPromptCalls
    },
    get state() {
      return state
    },
    get pid() {
      return null
    },
    get timings() {
      // Phase 1.5 step 5 — bootstrap-filter tests don't exercise the
      // timing probe (the agentAcpTiming emit-path is covered in
      // acp-cold-start-probe.test.ts). Return all-null marks so the
      // spawner's emit guard skips the emit cleanly.
      return {
        processSpawnStartedAt: null,
        initializeResolvedAt: null,
        sessionNewStartedAt: null,
        sessionNewResolvedAt: null,
      }
    },
    async initialize(): Promise<AcpInitResult> {
      state = 'ready'
      return { protocolVersion: 1 } as AcpInitResult
    },
    async createSession(): Promise<string> {
      return 'acp-session-mock'
    },
    sendPrompt(_sid: string, prompt: string): Promise<AcpPromptResult> {
      sendPromptCalls.push(prompt)
      return new Promise<AcpPromptResult>((resolve) => {
        sendPromptResolve = resolve
      })
    },
    onUpdate(handler) {
      updateHandlers.push(handler)
    },
    getAvailableCommands() {
      return null
    },
    cancelSession() {
      // No-op for this mock — bootstrap-filter tests don't exercise the
      // Phase 1.5 step 3 cancel path (close() goes through the mock's
      // close() override which doesn't engage the grace dance).
    },
    async close() {
      closed = true
      state = 'closed'
      // If sendPrompt is in flight, unblock it so spawn() can settle.
      if (sendPromptResolve) {
        sendPromptResolve({ stopReason: 'end_turn', output: '' })
        sendPromptResolve = null
      }
    },
  }
  // Expose the resolver for tests to drive prompt completion.
  ;(client as MockAcpClient & { resolveSendPrompt: () => void }).resolveSendPrompt = () => {
    if (sendPromptResolve) {
      sendPromptResolve({ stopReason: 'end_turn', output: '' })
      sendPromptResolve = null
    }
  }
  // Track closed state for tests if needed
  ;(client as MockAcpClient & { isClosed: () => boolean }).isClosed = () => closed
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

describe('Phase 1.5 step 2 — agent-spawner ACP bootstrap-update filtering', () => {
  let testDb: TestDb
  let eventLog: SpawnerEventLog
  let spawner: AgentSpawner
  let mockClient: MockAcpClient & { resolveSendPrompt: () => void }

  beforeEach(() => {
    testDb = createBrokerTestDb()
    testDb.db.prepare('INSERT INTO teams (id, name) VALUES (?, ?)').run('t1', 'T1')
    eventLog = makeMockEventLog()
    mockClient = makeMockAcpClient() as MockAcpClient & { resolveSendPrompt: () => void }
    spawner = createAgentSpawner(testDb.db, eventLog, {
      brokerUrl: 'http://localhost:9999',
      heartbeatMs: 60_000,
      workingDir: '/repo',
      deps: makeMockDeps(),
      maxConcurrentAgents: Infinity,
      // Disable nudge loop — we are testing the onUpdate handler, not the
      // agentic-loop. scns-manager is not nudge-eligible by default.
      nudgeRoles: [],
      acpClientFactory: (_o?: AcpClientOptions) => mockClient,
    })
  })

  afterEach(async () => {
    mockClient.resolveSendPrompt()
    await spawner.shutdownAll()
    testDb.close()
  })

  it('exposes ACP_BOOTSTRAP_UPDATE_KINDS with the two known bootstrap signals', () => {
    expect(ACP_BOOTSTRAP_UPDATE_KINDS.has('available_commands_update')).toBe(true)
    expect(ACP_BOOTSTRAP_UPDATE_KINDS.has('config_option_update')).toBe(true)
    // Sanity: meaningful kinds must NOT be in the bootstrap set.
    expect(ACP_BOOTSTRAP_UPDATE_KINDS.has('agent_message_chunk')).toBe(false)
    expect(ACP_BOOTSTRAP_UPDATE_KINDS.has('tool_call')).toBe(false)
    expect(ACP_BOOTSTRAP_UPDATE_KINDS.has('tool_call_update')).toBe(false)
  })

  it('does NOT emit agent_first_output_received for available_commands_update', async () => {
    // Kick off a spawn — will resolve once we trigger sendPrompt resolution.
    const spawnP = spawner.spawn({
      team_id: 't1',
      name: 'mgr-1',
      role: 'scns-manager',
      prompt: 'Decompose task',
      launch_method: 'acp',
      working_dir: '/repo',
    })
    // Yield until the spawn has registered an onUpdate handler.
    for (let i = 0; i < 20 && mockClient.updateHandlers.length === 0; i += 1) {
      await microFlush()
    }
    expect(mockClient.updateHandlers.length).toBeGreaterThan(0)

    // Simulate the production failure pattern: only bootstrap updates arrive.
    const handler = mockClient.updateHandlers[0]!
    handler({
      sessionId: 'acp-session-mock',
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: 'commit' }],
      } as AcpSessionUpdate['update'],
    })
    handler({
      sessionId: 'acp-session-mock',
      update: {
        sessionUpdate: 'config_option_update',
      } as AcpSessionUpdate['update'],
    })
    await microFlush()

    // ASSERT: first_output must NOT have fired — this was the bug.
    expect(eventLog.agentFirstOutputReceived).not.toHaveBeenCalled()

    // Resolve the prompt so the spawn completes cleanly.
    mockClient.resolveSendPrompt()
    await spawnP
  })

  it('DOES emit agent_first_output_received for meaningful updates (agent_message_chunk)', async () => {
    const spawnP = spawner.spawn({
      team_id: 't1',
      name: 'mgr-2',
      role: 'scns-manager',
      prompt: 'Decompose task',
      launch_method: 'acp',
      working_dir: '/repo',
    })
    for (let i = 0; i < 20 && mockClient.updateHandlers.length === 0; i += 1) {
      await microFlush()
    }
    const handler = mockClient.updateHandlers[0]!

    // First push a bootstrap notification — must not satisfy first_output.
    handler({
      sessionId: 'acp-session-mock',
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: 'plan' }],
      } as AcpSessionUpdate['update'],
    })
    await microFlush()
    expect(eventLog.agentFirstOutputReceived).not.toHaveBeenCalled()

    // Now push the real "agent engaged" signal.
    handler({
      sessionId: 'acp-session-mock',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Working on it' },
      } as AcpSessionUpdate['update'],
    })
    await microFlush()
    expect(eventLog.agentFirstOutputReceived).toHaveBeenCalledTimes(1)
    const call = (eventLog.agentFirstOutputReceived as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(call?.[1]).toMatchObject({
      role: 'scns-manager',
      team_id: 't1',
      launch_method: 'acp',
    })
    expect(call?.[1]?.sample).toContain('Working on it')

    mockClient.resolveSendPrompt()
    await spawnP
  })

  it('DOES emit agent_first_output_received for tool_call (the namespaced MCP tool surface)', async () => {
    const spawnP = spawner.spawn({
      team_id: 't1',
      name: 'mgr-3',
      role: 'scns-manager',
      prompt: 'List sessions',
      launch_method: 'acp',
      working_dir: '/repo',
    })
    for (let i = 0; i < 20 && mockClient.updateHandlers.length === 0; i += 1) {
      await microFlush()
    }
    const handler = mockClient.updateHandlers[0]!

    handler({
      sessionId: 'acp-session-mock',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-1',
        title: 'session-broker-list_sessions',
        kind: 'read',
        status: 'pending',
        rawInput: {},
      } as AcpSessionUpdate['update'],
    })
    await microFlush()

    expect(eventLog.agentFirstOutputReceived).toHaveBeenCalledTimes(1)
    const call = (eventLog.agentFirstOutputReceived as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(call?.[1]?.sample).toBe('tool_call')

    mockClient.resolveSendPrompt()
    await spawnP
  })
})

describe('Phase 1.5 step 2 — agent-spawner passes mcpServers to createSession', () => {
  let testDb: TestDb
  let eventLog: SpawnerEventLog

  beforeEach(() => {
    testDb = createBrokerTestDb()
    testDb.db.prepare('INSERT INTO teams (id, name) VALUES (?, ?)').run('t1', 'T1')
    eventLog = makeMockEventLog()
  })

  afterEach(() => {
    testDb.close()
  })

  it('forwards AgentSpawnerOptions.mcpServers verbatim into AcpClient.createSession', async () => {
    const seenMcpServers: unknown[] = []
    const mockClient = makeMockAcpClient() as MockAcpClient & { resolveSendPrompt: () => void }
    // Wrap createSession to record what the spawner passed through.
    const originalCreate = mockClient.createSession.bind(mockClient)
    ;(mockClient as { createSession: unknown }).createSession = async (
      cwd: string,
      mcpServers?: unknown[],
    ) => {
      seenMcpServers.push(mcpServers)
      return originalCreate(cwd, mcpServers as never)
    }

    const brokerMcp = [
      {
        name: 'session-broker',
        type: 'http' as const,
        url: 'http://localhost:3456/mcp',
        headers: [],
      },
    ]
    const spawner = createAgentSpawner(testDb.db, eventLog, {
      brokerUrl: 'http://localhost:9999',
      heartbeatMs: 60_000,
      workingDir: '/repo',
      deps: makeMockDeps(),
      maxConcurrentAgents: Infinity,
      nudgeRoles: [],
      mcpServers: brokerMcp,
      acpClientFactory: (_o?: AcpClientOptions) => mockClient,
    })

    const spawnP = spawner.spawn({
      team_id: 't1',
      name: 'mgr-mcp',
      role: 'scns-manager',
      prompt: 'noop',
      launch_method: 'acp',
      working_dir: '/repo',
    })

    // Yield until createSession has been invoked.
    for (let i = 0; i < 20 && seenMcpServers.length === 0; i += 1) {
      await microFlush()
    }

    expect(seenMcpServers.length).toBe(1)
    expect(seenMcpServers[0]).toEqual(brokerMcp)

    mockClient.resolveSendPrompt()
    await spawnP
    await spawner.shutdownAll()
  })
})

describe('Phase 1.5 step 4 — agent-spawner per-role autopilot (--allow-all-tools)', () => {
  // Empirically verified (probe 2026-05-26, session
  // 7b985363-81c3-4d58-a749-3e1e85f940a5; raw logs in /tmp/allow-all-stdout.txt):
  // under Copilot CLI `--acp`, ACP session-mode RPCs (`session/set_mode`,
  // `session/set_config_option`, `currentModeId` in `session/new`) are all
  // blocked or silently ignored. The reliable autonomy lever is the
  // `--allow-all-tools` process arg, which suppresses every
  // `session/request_permission` RPC. AcpClient routes that via the
  // `allowAllTools` option; the spawner picks it per-role based on
  // `autopilotRoles` so dev/qa run autonomously and manager stays gated.

  let testDb: TestDb
  let eventLog: SpawnerEventLog
  let mockClient: MockAcpClient & { resolveSendPrompt: () => void }
  let capturedClientOptions: AcpClientOptions[] = []
  let acpLogEntries: Record<string, unknown>[] = []

  beforeEach(() => {
    testDb = createBrokerTestDb()
    testDb.db.prepare('INSERT INTO teams (id, name) VALUES (?, ?)').run('t1', 'T1')
    eventLog = makeMockEventLog()
    mockClient = makeMockAcpClient() as MockAcpClient & { resolveSendPrompt: () => void }
    capturedClientOptions = []
    acpLogEntries = []
  })

  afterEach(async () => {
    mockClient.resolveSendPrompt()
    testDb.close()
  })

  function buildSpawner(extra?: {
    autopilotRoles?: readonly string[]
    permissionPolicy?: AcpClientOptions['permissionPolicy']
  }): AgentSpawner {
    const deps = makeMockDeps()
    // Capture writeFileSync entries so tests can assert the spawn audit
    // record (Phase 1.5 step 4 — record `usesAutopilot` + `allowAllTools`
    // + `permissionPolicyKind`).
    ;(deps as { writeFileSync: SpawnerDeps['writeFileSync'] }).writeFileSync = ((
      _path: string,
      data: string,
    ) => {
      const trimmed = data.trim()
      if (!trimmed) return
      try {
        acpLogEntries.push(JSON.parse(trimmed) as Record<string, unknown>)
      } catch {
        /* non-JSON; ignore for audit-shape tests */
      }
    }) as SpawnerDeps['writeFileSync']
    return createAgentSpawner(testDb.db, eventLog, {
      brokerUrl: 'http://localhost:9999',
      heartbeatMs: 60_000,
      workingDir: '/repo',
      deps,
      maxConcurrentAgents: Infinity,
      nudgeRoles: [],
      ...(extra?.autopilotRoles !== undefined && { autopilotRoles: extra.autopilotRoles }),
      ...(extra?.permissionPolicy && { permissionPolicy: extra.permissionPolicy }),
      acpClientFactory: (o?: AcpClientOptions) => {
        capturedClientOptions.push(o ?? {})
        return mockClient
      },
    })
  }

  async function spawnAndCapture(spawner: AgentSpawner, role: string): Promise<AcpClientOptions> {
    capturedClientOptions = []
    const spawnP = spawner.spawn({
      team_id: 't1',
      name: `${role}-test`,
      role,
      prompt: 'noop',
      launch_method: 'acp',
      working_dir: '/repo',
    })
    for (let i = 0; i < 20 && capturedClientOptions.length === 0; i += 1) await microFlush()
    expect(capturedClientOptions.length).toBe(1)
    mockClient.resolveSendPrompt()
    await spawnP
    return capturedClientOptions[0]!
  }

  it('scns-dev → factory receives allowAllTools:true', async () => {
    const spawner = buildSpawner()
    const opts = await spawnAndCapture(spawner, 'scns-dev')
    expect(opts.allowAllTools).toBe(true)
    await spawner.shutdownAll()
  })

  it('scns-qa → factory receives allowAllTools:true', async () => {
    const spawner = buildSpawner()
    const opts = await spawnAndCapture(spawner, 'scns-qa')
    expect(opts.allowAllTools).toBe(true)
    await spawner.shutdownAll()
  })

  it('scns-manager → factory receives allowAllTools:false (gated)', async () => {
    const spawner = buildSpawner()
    const opts = await spawnAndCapture(spawner, 'scns-manager')
    expect(opts.allowAllTools).toBe(false)
    await spawner.shutdownAll()
  })

  it('scns-dev → permission policy approves `delete` kind (allow-destructive)', async () => {
    const spawner = buildSpawner()
    const opts = await spawnAndCapture(spawner, 'scns-dev')
    const decision = opts.permissionPolicy!.decide({
      sessionId: 's1',
      toolCall: { toolCallId: 'tc-1', title: 'rm doomed.txt', kind: 'delete' },
      options: [
        { optionId: 'allow-always', kind: 'allow_always' },
        { optionId: 'reject-once', kind: 'reject_once' },
      ],
    })
    expect(decision).toEqual({ outcome: 'selected', optionId: 'allow-always' })
    await spawner.shutdownAll()
  })

  it('scns-manager → permission policy rejects `delete` kind by default', async () => {
    const spawner = buildSpawner()
    const opts = await spawnAndCapture(spawner, 'scns-manager')
    const decision = opts.permissionPolicy!.decide({
      sessionId: 's1',
      toolCall: { toolCallId: 'tc-2', title: 'rm important.txt', kind: 'delete' },
      options: [
        { optionId: 'allow-always', kind: 'allow_always' },
        { optionId: 'reject-once', kind: 'reject_once' },
      ],
    })
    expect(decision).toEqual({ outcome: 'selected', optionId: 'reject-once' })
    await spawner.shutdownAll()
  })

  it('custom autopilotRoles override defaults — orchestrator gets autopilot, dev does not', async () => {
    const spawner = buildSpawner({ autopilotRoles: ['orchestrator'] })
    const coordOpts = await spawnAndCapture(spawner, 'orchestrator')
    expect(coordOpts.allowAllTools).toBe(true)
    const devOpts = await spawnAndCapture(spawner, 'scns-dev')
    expect(devOpts.allowAllTools).toBe(false)
    await spawner.shutdownAll()
  })

  it('autopilotRoles:[] disables autopilot for all roles (back-compat)', async () => {
    const spawner = buildSpawner({ autopilotRoles: [] })
    const devOpts = await spawnAndCapture(spawner, 'scns-dev')
    const qaOpts = await spawnAndCapture(spawner, 'scns-qa')
    const mgrOpts = await spawnAndCapture(spawner, 'scns-manager')
    expect(devOpts.allowAllTools).toBe(false)
    expect(qaOpts.allowAllTools).toBe(false)
    expect(mgrOpts.allowAllTools).toBe(false)
    await spawner.shutdownAll()
  })

  it('explicit permissionPolicy option wins for all roles (caller-supplied policy)', async () => {
    // Caller-supplied policy: always allow regardless of kind.
    let invocations = 0
    const callerPolicy = {
      decide: () => {
        invocations += 1
        return { outcome: 'selected' as const, optionId: 'allow-once' }
      },
    }
    const spawner = buildSpawner({ permissionPolicy: callerPolicy })
    const devOpts = await spawnAndCapture(spawner, 'scns-dev')
    const mgrOpts = await spawnAndCapture(spawner, 'scns-manager')
    // Same caller policy reference must be passed for both roles.
    expect(devOpts.permissionPolicy).toBe(callerPolicy)
    expect(mgrOpts.permissionPolicy).toBe(callerPolicy)
    // allowAllTools is still per-role (separate mechanism): dev autopilot,
    // manager gated.
    expect(devOpts.allowAllTools).toBe(true)
    expect(mgrOpts.allowAllTools).toBe(false)
    // Sanity: the caller policy actually wired in.
    devOpts.permissionPolicy!.decide({
      sessionId: 's',
      toolCall: { toolCallId: 't', kind: 'delete' },
      options: [{ optionId: 'allow-once', kind: 'allow_once' }],
    })
    expect(invocations).toBe(1)
    await spawner.shutdownAll()
  })

  it('ACP spawn audit log records usesAutopilot, allowAllTools, permissionPolicyKind for scns-dev', async () => {
    const spawner = buildSpawner()
    await spawnAndCapture(spawner, 'scns-dev')
    const spawnEntry = acpLogEntries.find((e) => e['type'] === 'spawn')
    expect(spawnEntry).toBeDefined()
    expect(spawnEntry?.['role']).toBe('scns-dev')
    expect(spawnEntry?.['usesAutopilot']).toBe(true)
    expect(spawnEntry?.['allowAllTools']).toBe(true)
    expect(spawnEntry?.['permissionPolicyKind']).toBe('autopilot')
    await spawner.shutdownAll()
  })

  it('ACP spawn audit log records gated state for scns-manager', async () => {
    const spawner = buildSpawner()
    await spawnAndCapture(spawner, 'scns-manager')
    const spawnEntry = acpLogEntries.find((e) => e['type'] === 'spawn')
    expect(spawnEntry?.['usesAutopilot']).toBe(false)
    expect(spawnEntry?.['allowAllTools']).toBe(false)
    expect(spawnEntry?.['permissionPolicyKind']).toBe('base')
    await spawner.shutdownAll()
  })

  it('ACP spawn audit log records "explicit" policy kind when caller supplied permissionPolicy', async () => {
    const callerPolicy = {
      decide: () => ({ outcome: 'selected' as const, optionId: 'allow-once' }),
    }
    const spawner = buildSpawner({ permissionPolicy: callerPolicy })
    await spawnAndCapture(spawner, 'scns-dev')
    const spawnEntry = acpLogEntries.find((e) => e['type'] === 'spawn')
    expect(spawnEntry?.['permissionPolicyKind']).toBe('explicit')
    // allowAllTools still per-role.
    expect(spawnEntry?.['allowAllTools']).toBe(true)
    await spawner.shutdownAll()
  })
})
