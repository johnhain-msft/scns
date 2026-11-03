/**
 * D1 — createDefaultIdeationBackend safety wiring, driven through an INJECTED
 * fake AcpClient. This suite NEVER spawns a real copilot process: the fake
 * replaces the client factory, so `createAcpClient` / `nodeSpawn` are
 * unreachable. Asserts the deny-all policy default, isolated cwd, always-close,
 * error propagation, and the wall-clock timeout — the exact hardening proven in
 * wedge C, now reused for ideation.
 */
import { describe, it, expect } from 'vitest'
import {
  createDefaultIdeationBackend,
  DEFAULT_IDEATION_ATTEMPT_TIMEOUT_MS,
} from '../../../src/ideate/backend.js'
import type {
  AcpClient,
  AcpClientOptions,
  AcpPromptResult,
  AcpRequestPermissionParams,
} from '../../../src/broker/services/acp-client.js'

interface Spy {
  factoryCalls: number
  lastOptions: AcpClientOptions | null
  initialized: boolean
  sessionCwd: string | null
  prompt: string | null
  closed: boolean
}

type SendBehavior =
  | { kind: 'resolve'; output: string }
  | { kind: 'reject'; error: Error }
  | { kind: 'hang' }

function makeFactory(behavior: SendBehavior): {
  spy: Spy
  createClient: (opts: AcpClientOptions) => AcpClient
} {
  const spy: Spy = {
    factoryCalls: 0,
    lastOptions: null,
    initialized: false,
    sessionCwd: null,
    prompt: null,
    closed: false,
  }
  const createClient = (opts: AcpClientOptions): AcpClient => {
    spy.factoryCalls++
    spy.lastOptions = opts
    const client: AcpClient = {
      async initialize() {
        spy.initialized = true
        return { protocolVersion: 1 } as never
      },
      async createSession(cwd: string) {
        spy.sessionCwd = cwd
        return 'session-1'
      },
      async sendPrompt(_sessionId: string, prompt: string): Promise<AcpPromptResult> {
        spy.prompt = prompt
        if (behavior.kind === 'resolve') return { stopReason: 'end_turn', output: behavior.output }
        if (behavior.kind === 'reject') throw behavior.error
        return new Promise<AcpPromptResult>(() => {}) // hang forever
      },
      onUpdate() {},
      getAvailableCommands() {
        return null
      },
      cancelSession() {},
      async close() {
        spy.closed = true
      },
      state: 'ready' as never,
      pid: 4242,
      timings: {} as never,
    }
    return client
  }
  return { spy, createClient }
}

const ISOLATED = '/tmp/scns-ideation-isolated-wt'

const execRequest = (options: AcpRequestPermissionParams['options']): AcpRequestPermissionParams => ({
  sessionId: 's',
  toolCall: { kind: 'execute', title: 'run npm install' },
  options,
})

describe('createDefaultIdeationBackend', () => {
  it('throws when constructed without an isolated cwd', () => {
    expect(() => createDefaultIdeationBackend({ cwd: '' })).toThrow(/isolated cwd/)
    expect(() => createDefaultIdeationBackend({ cwd: '   ' })).toThrow(/isolated cwd/)
  })

  it('wires a deny-all permission policy and allowAllTools:false by default', async () => {
    const { spy, createClient } = makeFactory({ kind: 'resolve', output: '[]' })
    const backend = createDefaultIdeationBackend({ cwd: ISOLATED, createClient })
    await backend.ideate('hello')

    expect(spy.lastOptions?.allowAllTools).toBe(false)
    const policy = spy.lastOptions?.permissionPolicy
    expect(policy).toBeDefined()
    // Offered a reject option → must select reject (never allow).
    expect(
      policy!.decide(
        execRequest([
          { optionId: 'a', kind: 'allow_once' },
          { optionId: 'r', kind: 'reject_once' },
        ]),
      ),
    ).toEqual({ outcome: 'selected', optionId: 'r' })
    // Offered ONLY allow options → must cancel (still never allows).
    expect(policy!.decide(execRequest([{ optionId: 'a', kind: 'allow_once' }]))).toEqual({
      outcome: 'cancelled',
    })
  })

  it('runs initialize → createSession(isolated cwd) → sendPrompt and returns output', async () => {
    const { spy, createClient } = makeFactory({ kind: 'resolve', output: 'AGENT-OUTPUT' })
    const backend = createDefaultIdeationBackend({ cwd: ISOLATED, createClient })
    const out = await backend.ideate('PROMPT-TEXT')

    expect(out).toBe('AGENT-OUTPUT')
    expect(spy.initialized).toBe(true)
    expect(spy.sessionCwd).toBe(ISOLATED)
    expect(spy.prompt).toBe('PROMPT-TEXT')
    expect(spy.closed).toBe(true)
  })

  it('propagates a prompt failure and STILL closes the client', async () => {
    const { spy, createClient } = makeFactory({ kind: 'reject', error: new Error('prompt boom') })
    const backend = createDefaultIdeationBackend({ cwd: ISOLATED, createClient })
    await expect(backend.ideate('x')).rejects.toThrow('prompt boom')
    expect(spy.closed).toBe(true)
  })

  it('enforces the wall-clock timeout and closes the client', async () => {
    const { spy, createClient } = makeFactory({ kind: 'hang' })
    const backend = createDefaultIdeationBackend({
      cwd: ISOLATED,
      createClient,
      attemptTimeoutMs: 20,
    })
    await expect(backend.ideate('x')).rejects.toThrow(/timed out after 20ms/)
    expect(spy.closed).toBe(true)
  })

  it('honors a custom permission policy override', async () => {
    const custom = { decide: () => ({ outcome: 'cancelled' as const }) }
    const { spy, createClient } = makeFactory({ kind: 'resolve', output: '[]' })
    const backend = createDefaultIdeationBackend({ cwd: ISOLATED, createClient, permissionPolicy: custom })
    await backend.ideate('x')
    expect(spy.lastOptions?.permissionPolicy).toBe(custom)
  })

  it('exposes a sane default timeout constant', () => {
    expect(DEFAULT_IDEATION_ATTEMPT_TIMEOUT_MS).toBeGreaterThan(0)
  })
})
