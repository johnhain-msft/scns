/**
 * WS L (Phase 13.13.x) — RED→GREEN tests for the bounded agentic loop in
 * agent-spawner.ts.
 *
 * The bug: Copilot-CLI's ACP server returns `stopReason="end_turn"` after
 * the model's first response. Pre-WS L, agent-spawner.ts did a single
 * `sendPrompt → close`, so a text-only first response left the working_dir
 * with no staged changes and the dev never got a second turn.
 *
 * The fix: nudge up to N times until either (a) staged changes appear,
 * (b) the budget is exhausted, (c) the wall-clock cap is hit, or
 * (d) the transport errors out.
 *
 * These tests inject an AcpClient mock (no real subprocess) and a
 * deterministic git-stage probe via `deps.spawnSync`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { TestDb } from '../../../helpers/db-harness.js'
import { createBrokerTestDb } from '../../../helpers/broker-db-harness.js'
import {
  createAgentSpawner,
  resolveAgentNudgeBudget,
  resolveAgentNudgeWallClockMs,
  resolveAutopilotRoles,
  DEFAULT_AGENT_NUDGE_BUDGET,
  DEFAULT_AGENT_NUDGE_WALL_CLOCK_MS,
  DEFAULT_AUTOPILOT_ROLES,
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
  sendPromptCalls: string[]
  closeCalled: boolean
}

function makeMockAcpClient(seq: { promptResult?: AcpPromptResult; failOnSendN?: { n: number; error: Error } } = {}): MockAcpClient {
  const sendPromptCalls: string[] = []
  let state: AcpSessionStateType = 'closed'
  let closed = false
  const updateHandlers: ((u: AcpSessionUpdate) => void)[] = []
  const promptResult = seq.promptResult ?? { stopReason: 'end_turn', output: '' }
  const client: MockAcpClient = {
    sendPromptCalls,
    get closeCalled() {
      return closed
    },
    get state() {
      return state
    },
    get pid() {
      return null
    },
    get timings() {
      // Phase 1.5 step 5 — ws-l-loop tests don't drive the
      // agent_acp_timing probe (covered in acp-cold-start-probe.test.ts).
      // Return all-null marks so the spawner's emit guard skips cleanly.
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
    async sendPrompt(_sid: string, prompt: string): Promise<AcpPromptResult> {
      sendPromptCalls.push(prompt)
      if (seq.failOnSendN && sendPromptCalls.length === seq.failOnSendN.n) {
        throw seq.failOnSendN.error
      }
      return promptResult
    },
    onUpdate(handler) {
      updateHandlers.push(handler)
    },
    getAvailableCommands() {
      return null
    },
    cancelSession() {
      // No-op for ws-l-loop tests — these exercise nudge/turn-end logic
      // via close(), not the Phase 1.5 step 3 cancel path.
    },
    async close() {
      closed = true
      state = 'closed'
    },
  }
  return client
}

function makeMockDeps(stagedSequence: boolean[]): SpawnerDeps {
  let stageIdx = 0
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
    // WS L: spawner uses spawnSync('git', ['diff', '--cached', '--quiet']) to
    // probe staged work. exit 0 = clean; exit 1 = staged changes present.
    spawnSync: vi.fn((cmd: string, args: readonly string[]) => {
      if (cmd === 'git' && args[0] === 'diff' && args.includes('--cached')) {
        const staged = stagedSequence[stageIdx] ?? false
        stageIdx += 1
        return {
          status: staged ? 1 : 0,
          stdout: Buffer.from(''),
          stderr: Buffer.from(''),
          pid: 0,
          output: [],
          signal: null,
        }
      }
      return {
        status: 0,
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
        pid: 0,
        output: [],
        signal: null,
      }
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

async function flushPromises(): Promise<void> {
  // Yield several microtasks so the fire-and-forget agentic loop runs to
  // completion. Each iteration awaits one promise (sendPrompt) plus a few
  // microtask hops; 10 yields is plenty for the ≤4-iteration test cases here.
  for (let i = 0; i < 25; i += 1) {
    await Promise.resolve()
  }
}

// ── Setup ───────────────────────────────────────────────────────────────────

describe('WS L: agent-spawner agentic loop', () => {
  let testDb: TestDb
  let eventLog: SpawnerEventLog
  let spawner: AgentSpawner
  let mockClient: MockAcpClient

  beforeEach(() => {
    testDb = createBrokerTestDb()
    testDb.db.prepare('INSERT INTO teams (id, name) VALUES (?, ?)').run('test-team', 'Test')
    eventLog = makeMockEventLog()
  })

  afterEach(async () => {
    await spawner.shutdownAll()
    testDb.close()
  })

  function buildSpawner(opts: {
    stagedSequence: boolean[]
    nudgeBudget?: number
    nudgeRoles?: readonly string[]
    failOnSendN?: { n: number; error: Error }
  }): { spawner: AgentSpawner; client: MockAcpClient } {
    mockClient = makeMockAcpClient({ failOnSendN: opts.failOnSendN })
    const deps = makeMockDeps(opts.stagedSequence)
    const sp = createAgentSpawner(testDb.db, eventLog, {
      brokerUrl: 'http://localhost:9999',
      heartbeatMs: 60_000,
      workingDir: '/test/dir',
      deps,
      maxConcurrentAgents: Infinity,
      agentNudgeBudget: opts.nudgeBudget ?? 3,
      agentNudgeWallClockMs: 60_000,
      nudgeRoles: opts.nudgeRoles ?? ['scns-dev'],
      acpClientFactory: (_o?: AcpClientOptions) => mockClient,
    })
    spawner = sp
    return { spawner: sp, client: mockClient }
  }

  const acpDevInput = {
    team_id: 'test-team',
    name: 'dev-1',
    role: 'scns-dev',
    prompt: 'Implement feature X',
    launch_method: 'acp' as const,
    working_dir: '/repo/under/test',
  }

  it('nudges up to budget when sendPrompt resolves end_turn but no diff is staged', async () => {
    // Stage check returns false (empty) on every call → exhaust the budget.
    const { client } = buildSpawner({
      stagedSequence: [false, false, false, false],
      nudgeBudget: 3,
    })

    await spawner.spawn(acpDevInput)
    await flushPromises()

    // Initial prompt + 3 nudges = 4 sendPrompt calls total.
    expect(client.sendPromptCalls.length).toBe(4)
    // First call carries the original prompt; nudges 1..3 carry the nudge body.
    expect(client.sendPromptCalls[0]).toContain('Implement feature X')
    for (let i = 1; i <= 3; i += 1) {
      expect(client.sendPromptCalls[i]).toMatch(/nudge \d of 3/i)
      expect(client.sendPromptCalls[i]).toMatch(/git add -A/)
    }
    // Three nudge events with monotonically increasing nudge_index.
    const nudgeFn = eventLog.agentNudgeSent as ReturnType<typeof vi.fn>
    expect(nudgeFn).toHaveBeenCalledTimes(3)
    const indices = nudgeFn.mock.calls.map((c) => (c[1] as { nudge_index: number }).nudge_index)
    expect(indices).toEqual([1, 2, 3])
    // Payload shape check.
    const [sid, payload] = nudgeFn.mock.calls[0]!
    expect(typeof sid).toBe('string')
    expect(payload).toMatchObject({
      role: 'scns-dev',
      team_id: 'test-team',
      acp_session_id: 'acp-session-mock',
      budget: 3,
    })
    expect((payload as { reason: string }).reason).toMatch(/end_turn/)
    // Client must be closed after the loop ends.
    expect(client.closeCalled).toBe(true)
  })

  it('stops nudging once a staged diff appears', async () => {
    // Empty after initial prompt; staged after first nudge.
    const { client } = buildSpawner({
      stagedSequence: [false, true],
      nudgeBudget: 3,
    })

    await spawner.spawn(acpDevInput)
    await flushPromises()

    // Initial prompt + 1 nudge = 2 sendPrompt calls.
    expect(client.sendPromptCalls.length).toBe(2)
    expect(eventLog.agentNudgeSent).toHaveBeenCalledTimes(1)
    expect(client.closeCalled).toBe(true)
  })

  it('does NOT nudge when nudgeBudget is 0 (legacy single-turn behaviour)', async () => {
    const { client } = buildSpawner({
      stagedSequence: [false, false, false],
      nudgeBudget: 0,
    })

    await spawner.spawn(acpDevInput)
    await flushPromises()

    // Only the initial prompt, no nudges.
    expect(client.sendPromptCalls.length).toBe(1)
    expect(eventLog.agentNudgeSent).not.toHaveBeenCalled()
    expect(client.closeCalled).toBe(true)
  })

  it('does NOT nudge non-eligible roles (e.g. scns-manager)', async () => {
    const { client } = buildSpawner({
      stagedSequence: [false, false],
      nudgeBudget: 3,
      nudgeRoles: ['scns-dev'],
    })
    await spawner.spawn({ ...acpDevInput, role: 'scns-manager', name: 'mgr-1' })
    await flushPromises()
    expect(client.sendPromptCalls.length).toBe(1)
    expect(eventLog.agentNudgeSent).not.toHaveBeenCalled()
    expect(client.closeCalled).toBe(true)
  })

  it('emits agent_launch_failed and stops nudging on transport error mid-loop', async () => {
    const { client } = buildSpawner({
      stagedSequence: [false, false, false],
      nudgeBudget: 5,
      failOnSendN: { n: 2, error: new Error('ACP transport closed') },
    })
    await spawner.spawn(acpDevInput)
    await flushPromises()

    // 1 initial + 1 failed nudge = 2 sendPrompt attempts.
    expect(client.sendPromptCalls.length).toBe(2)
    // One nudge event was emitted (right before the failed sendPrompt).
    expect(eventLog.agentNudgeSent).toHaveBeenCalledTimes(1)
    // launch_failed event with stage=prompt fires.
    const failFn = eventLog.agentLaunchFailed as ReturnType<typeof vi.fn>
    expect(failFn).toHaveBeenCalled()
    const [, payload] = failFn.mock.calls[0]!
    expect(payload).toMatchObject({ stage: 'prompt', transport: 'acp' })
  })
})

// ── Pure-function coverage ──────────────────────────────────────────────────

describe('WS L: nudge config resolvers', () => {
  it('resolveAgentNudgeBudget honours explicit option', () => {
    expect(resolveAgentNudgeBudget(5, {})).toBe(5)
    expect(resolveAgentNudgeBudget(0, {})).toBe(0)
  })

  it('resolveAgentNudgeBudget reads SCNS_AGENT_NUDGE_BUDGET env', () => {
    expect(resolveAgentNudgeBudget(undefined, { SCNS_AGENT_NUDGE_BUDGET: '7' })).toBe(7)
    expect(resolveAgentNudgeBudget(undefined, { SCNS_AGENT_NUDGE_BUDGET: '0' })).toBe(0)
  })

  it('resolveAgentNudgeBudget falls back to default for invalid input', () => {
    expect(resolveAgentNudgeBudget(undefined, { SCNS_AGENT_NUDGE_BUDGET: 'nope' })).toBe(
      DEFAULT_AGENT_NUDGE_BUDGET,
    )
    expect(resolveAgentNudgeBudget(-1, {})).toBe(DEFAULT_AGENT_NUDGE_BUDGET)
  })

  it('resolveAgentNudgeWallClockMs honours explicit option and env', () => {
    expect(resolveAgentNudgeWallClockMs(123, {})).toBe(123)
    expect(resolveAgentNudgeWallClockMs(undefined, { SCNS_AGENT_NUDGE_WALL_MS: '4567' })).toBe(4567)
    expect(resolveAgentNudgeWallClockMs(undefined, {})).toBe(DEFAULT_AGENT_NUDGE_WALL_CLOCK_MS)
  })
})

describe('Phase 1.5 step 4: autopilot-role resolver', () => {
  it('explicit option wins over env', () => {
    expect(
      resolveAutopilotRoles(['only-this-role'], { SCNS_ACP_AUTOPILOT_ROLES: 'overridden' }),
    ).toEqual(['only-this-role'])
    // Empty explicit option also wins (caller said "no autopilot").
    expect(
      resolveAutopilotRoles([], { SCNS_ACP_AUTOPILOT_ROLES: 'scns-dev,scns-qa' }),
    ).toEqual([])
  })

  it('falls back to DEFAULT_AUTOPILOT_ROLES when env unset', () => {
    expect(resolveAutopilotRoles(undefined, {})).toEqual(DEFAULT_AUTOPILOT_ROLES)
  })

  it('parses comma-separated env values, trimming whitespace and dropping empties', () => {
    expect(
      resolveAutopilotRoles(undefined, { SCNS_ACP_AUTOPILOT_ROLES: 'scns-dev,scns-qa' }),
    ).toEqual(['scns-dev', 'scns-qa'])
    expect(
      resolveAutopilotRoles(undefined, { SCNS_ACP_AUTOPILOT_ROLES: ' scns-dev , scns-qa ' }),
    ).toEqual(['scns-dev', 'scns-qa'])
    expect(
      resolveAutopilotRoles(undefined, { SCNS_ACP_AUTOPILOT_ROLES: 'scns-dev,,scns-qa' }),
    ).toEqual(['scns-dev', 'scns-qa'])
  })

  it('treats empty env value as explicit "disable autopilot" (kill-switch)', () => {
    // Distinct from "env unset": explicit empty disables autopilot for
    // ALL roles. This is the operational rollback knob.
    expect(resolveAutopilotRoles(undefined, { SCNS_ACP_AUTOPILOT_ROLES: '' })).toEqual([])
    expect(resolveAutopilotRoles(undefined, { SCNS_ACP_AUTOPILOT_ROLES: '   ' })).toEqual([])
  })

  it('preserves DEFAULT_AUTOPILOT_ROLES contents for reference', () => {
    // Pin the shipping default so a regression "autopilot disabled by
    // default" change shows up in a test diff.
    expect(DEFAULT_AUTOPILOT_ROLES).toEqual(['scns-dev', 'scns-qa'])
  })
})
