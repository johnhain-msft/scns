/**
 * Phase 1 wedge — AcpReplayBackend driven through replayOne with an INJECTED
 * fake AcpClient. The suite NEVER spawns a real copilot process: the fake
 * replaces the client factory entirely, so `createAcpClient` (and thus
 * `nodeSpawn`) is unreachable. Asserts recorded + rule scoring, isolation of the
 * session cwd, always-close, the wall-clock timeout, and the default wiring.
 */
import { describe, it, expect } from 'vitest'
import {
  AcpReplayBackend,
  buildReplayPrompt,
} from '../../../src/selfopt/acp-replay-backend.js'
import { replayOne } from '../../../src/selfopt/replay.js'
import { createAcpClient } from '../../../src/broker/services/acp-client.js'
import type {
  AcpClient,
  AcpClientOptions,
  AcpPromptResult,
} from '../../../src/broker/services/acp-client.js'
import type { RuleCheck, TaskRecord } from '../../../src/selfopt/types.js'

const ISOLATED_CWD = '/tmp/scns-acp-replay-isolated-wt'

interface ClientSpy {
  factoryCalls: number
  lastOptions: AcpClientOptions | null
  initialized: boolean
  sessionCwd: string | null
  prompt: string | null
  closed: boolean
}

interface FakeBehavior {
  readonly output?: string
  readonly stopReason?: string
  readonly failOn?: 'sendPrompt'
  readonly hang?: boolean
}

function freshSpy(): ClientSpy {
  return {
    factoryCalls: 0,
    lastOptions: null,
    initialized: false,
    sessionCwd: null,
    prompt: null,
    closed: false,
  }
}

/** A fake AcpClient factory — canned result, NO process spawn, NO network. */
function fakeFactory(
  spy: ClientSpy,
  behavior: FakeBehavior = {},
): (opts: AcpClientOptions) => AcpClient {
  return (opts: AcpClientOptions): AcpClient => {
    spy.factoryCalls++
    spy.lastOptions = opts
    return {
      async initialize() {
        spy.initialized = true
        return { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'fake', version: '0' } }
      },
      async createSession(cwd: string) {
        spy.sessionCwd = cwd
        return 'sess-1'
      },
      async sendPrompt(_sessionId: string, prompt: string): Promise<AcpPromptResult> {
        spy.prompt = prompt
        if (behavior.failOn === 'sendPrompt') throw new Error('fake sendPrompt failure')
        if (behavior.hang) return new Promise<AcpPromptResult>(() => {})
        return { stopReason: behavior.stopReason ?? 'end_turn', output: behavior.output ?? '' }
      },
      onUpdate() {},
      getAvailableCommands() {
        return null
      },
      cancelSession() {},
      async close() {
        spy.closed = true
      },
      state: 'ready',
      pid: null,
      timings: {
        processSpawnStartedAt: null,
        initializeResolvedAt: null,
        sessionNewStartedAt: null,
        sessionNewResolvedAt: null,
      },
    }
  }
}

function recordedTask(id: string, recordedScore: number): TaskRecord {
  return {
    id,
    project: 'scns',
    intent: `intent for ${id}`,
    contextExcerpt: '',
    attemptedSolution: '',
    outcome: 'success',
    referenceKind: 'recorded',
    reference: '',
    recordedScore,
    judge: null,
    tags: ['task'],
    sourceSessions: [],
    split: 'val',
    origin: 'real',
    derivedFrom: '',
  }
}

function ruleTask(id: string, intent: string, checks: RuleCheck[]): TaskRecord {
  return {
    id,
    project: 'scns',
    intent,
    contextExcerpt: '',
    attemptedSolution: '',
    outcome: 'mixed',
    referenceKind: 'rule',
    reference: '',
    recordedScore: null,
    judge: { kind: 'rule', checks },
    tags: ['task'],
    sourceSessions: [],
    split: 'val',
    origin: 'real',
    derivedFrom: '',
  }
}

describe('AcpReplayBackend — recorded task via replayOne (fake client)', () => {
  it('scores a recorded task from its label and always closes the client', async () => {
    const spy = freshSpy()
    const backend = new AcpReplayBackend({
      cwd: ISOLATED_CWD,
      createClient: fakeFactory(spy, { output: 'text is ignored for recorded tasks' }),
    })

    const r = await replayOne(backend, recordedTask('rec1', 0.9))

    expect(r.id).toBe('rec1')
    expect(r.hard).toBe(0.9)
    expect(r.soft).toBe(0.9)
    expect(spy.initialized).toBe(true)
    expect(spy.closed).toBe(true)
    expect(spy.factoryCalls).toBe(1)
  })
})

describe('AcpReplayBackend — rule task via replayOne (fake client)', () => {
  it('scores hard=1 when the agent output satisfies the rule judge', async () => {
    const spy = freshSpy()
    const backend = new AcpReplayBackend({
      cwd: ISOLATED_CWD,
      createClient: fakeFactory(spy, { output: 'I verified the change by running the tests.' }),
    })

    const r = await replayOne(backend, ruleTask('rule_ok', 'Confirm the change works', [
      { op: 'contains', arg: 'verified' },
    ]))

    expect(r.hard).toBe(1)
    expect(r.soft).toBe(1)
    expect(spy.prompt).toContain('Confirm the change works')
    expect(spy.sessionCwd).toBe(ISOLATED_CWD)
    expect(spy.closed).toBe(true)
  })

  it('scores hard=0 when the agent output fails the rule judge', async () => {
    const spy = freshSpy()
    const backend = new AcpReplayBackend({
      cwd: ISOLATED_CWD,
      createClient: fakeFactory(spy, { output: 'nothing relevant here' }),
    })

    const r = await replayOne(backend, ruleTask('rule_bad', 'Confirm the change works', [
      { op: 'contains', arg: 'verified' },
    ]))

    expect(r.hard).toBe(0)
    expect(spy.closed).toBe(true)
  })
})

describe('AcpReplayBackend — robustness', () => {
  it('always closes the client when sendPrompt throws (and rethrows)', async () => {
    const spy = freshSpy()
    const backend = new AcpReplayBackend({
      cwd: ISOLATED_CWD,
      createClient: fakeFactory(spy, { failOn: 'sendPrompt' }),
    })

    await expect(backend.attempt(recordedTask('x', 1), '', '')).rejects.toThrow(/fake sendPrompt failure/)
    expect(spy.closed).toBe(true)
  })

  it('enforces the wall-clock timeout and closes the client', async () => {
    const spy = freshSpy()
    const backend = new AcpReplayBackend({
      cwd: ISOLATED_CWD,
      attemptTimeoutMs: 20,
      createClient: fakeFactory(spy, { hang: true }),
    })

    await expect(
      backend.attempt(ruleTask('hang', 'do', [{ op: 'contains', arg: 'x' }]), '', ''),
    ).rejects.toThrow(/timed out/i)
    expect(spy.closed).toBe(true)
  })
})

describe('AcpReplayBackend — CI-safe wiring (no real spawn)', () => {
  it('defaults createClient to createAcpClient WITHOUT invoking it', () => {
    const backend = new AcpReplayBackend({ cwd: ISOLATED_CWD })
    expect(backend.createClient).toBe(createAcpClient)
  })

  it('threads the isolated cwd + conservative allowAllTools default into client options', async () => {
    const spy = freshSpy()
    const backend = new AcpReplayBackend({
      cwd: ISOLATED_CWD,
      createClient: fakeFactory(spy, { output: 'ok' }),
    })

    await backend.attempt(ruleTask('opt', 'x', [{ op: 'contains', arg: 'x' }]), '', '')

    expect(spy.lastOptions?.cwd).toBe(ISOLATED_CWD)
    expect(spy.lastOptions?.allowAllTools).toBe(false)
    expect(spy.lastOptions?.spawnFn).toBeUndefined()
  })

  it('requires an isolated cwd', () => {
    expect(() => new AcpReplayBackend({ cwd: '' })).toThrow(/isolated cwd/)
  })
})

describe('AcpReplayBackend — injectedMemory (asymmetry channel)', () => {
  it('prepends construction-time guidance into the # Guidance section', async () => {
    const spy = freshSpy()
    const backend = new AcpReplayBackend({
      cwd: ISOLATED_CWD,
      injectedMemory: 'HEAD-GUIDANCE: always verify before claiming success.',
      createClient: fakeFactory(spy, { output: 'ok' }),
    })

    await backend.attempt(ruleTask('inj', 'Do the thing', [{ op: 'contains', arg: 'x' }]), '', '')

    expect(spy.prompt).toContain('# Guidance\nHEAD-GUIDANCE: always verify before claiming success.')
    expect(spy.prompt).toContain('# Task\nDo the thing')
  })

  it('merges injectedMemory ABOVE a per-attempt memory string', async () => {
    const spy = freshSpy()
    const backend = new AcpReplayBackend({
      cwd: ISOLATED_CWD,
      injectedMemory: 'FIXED',
      createClient: fakeFactory(spy, { output: 'ok' }),
    })

    await backend.attempt(ruleTask('inj2', 'T', [{ op: 'contains', arg: 'x' }]), '', 'PERATTEMPT')

    expect(spy.prompt).toContain('# Guidance\nFIXED\n\nPERATTEMPT')
  })

  it('is byte-identical to no-injection when injectedMemory is undefined', async () => {
    const withSpy = freshSpy()
    const without = new AcpReplayBackend({ cwd: ISOLATED_CWD, createClient: fakeFactory(withSpy, { output: 'ok' }) })
    await without.attempt(ruleTask('p', 'Only task', [{ op: 'contains', arg: 'x' }]), '', '')

    // No skill, no memory, no injection ⇒ exactly the bare task prompt.
    expect(withSpy.prompt).toBe('# Task\nOnly task')
  })

  it('asymmetric injected guidance moves a rule-judge score (baseline vs candidate)', async () => {
    const baseSpy = freshSpy()
    const candSpy = freshSpy()
    // The rule judge requires the response to contain "verify". The fake echoes a
    // fixed string, so to isolate the channel we make the fake response mirror the
    // injected guidance keyword the agent would carry forward.
    const baseline = new AcpReplayBackend({
      cwd: ISOLATED_CWD,
      injectedMemory: 'Rule: always verify the change.',
      createClient: fakeFactory(baseSpy, { output: 'I will verify the change.' }),
    })
    const candidate = new AcpReplayBackend({
      cwd: ISOLATED_CWD,
      injectedMemory: 'Rule: just confirm it.',
      createClient: fakeFactory(candSpy, { output: 'I will confirm it.' }),
    })

    const task = ruleTask('vt', 'Validate', [{ op: 'contains', arg: 'verify' }])
    const b = await replayOne(baseline, task)
    const c = await replayOne(candidate, task)

    expect(b.hard).toBe(1)
    expect(c.hard).toBe(0)
    expect(baseSpy.prompt).toContain('always verify the change')
    expect(candSpy.prompt).toContain('just confirm it')
  })

  it('resolves a PER-TASK injectedMemory function and injects its result', async () => {
    const spy = freshSpy()
    const backend = new AcpReplayBackend({
      cwd: ISOLATED_CWD,
      // THE BRIDGE: injected context depends on the task (e.g. the retrieval query).
      injectedMemory: (task) => `RETRIEVED-FOR:${task.retrievalQuery ?? task.intent}`,
      createClient: fakeFactory(spy, { output: 'ok' }),
    })

    const task: TaskRecord = {
      ...ruleTask('rq', 'Explicit question', [{ op: 'contains', arg: 'x' }]),
      retrievalQuery: 'vague entity probe',
    }
    await backend.attempt(task, '', '')

    expect(spy.prompt).toContain('# Guidance\nRETRIEVED-FOR:vague entity probe')
    expect(spy.prompt).toContain('# Task\nExplicit question')
  })

  it('awaits an async per-task injectedMemory resolver', async () => {
    const spy = freshSpy()
    const backend = new AcpReplayBackend({
      cwd: ISOLATED_CWD,
      injectedMemory: async (task) => Promise.resolve(`ASYNC:${task.id}`),
      createClient: fakeFactory(spy, { output: 'ok' }),
    })

    await backend.attempt(ruleTask('aid', 'T', [{ op: 'contains', arg: 'x' }]), '', '')

    expect(spy.prompt).toContain('# Guidance\nASYNC:aid')
  })

  it('a resolver returning empty string yields the bare task prompt (merge no-op)', async () => {
    const spy = freshSpy()
    const backend = new AcpReplayBackend({
      cwd: ISOLATED_CWD,
      injectedMemory: () => '',
      createClient: fakeFactory(spy, { output: 'ok' }),
    })

    await backend.attempt(ruleTask('empty', 'Only task', [{ op: 'contains', arg: 'x' }]), '', '')

    expect(spy.prompt).toBe('# Task\nOnly task')
  })
})

describe('buildReplayPrompt', () => {
  it('includes skill, guidance and task sections', () => {
    const p = buildReplayPrompt(ruleTask('p', 'Do the thing', []), 'SKILLTEXT', 'MEMTEXT')
    expect(p).toContain('# Skill\nSKILLTEXT')
    expect(p).toContain('# Guidance\nMEMTEXT')
    expect(p).toContain('# Task\nDo the thing')
  })

  it('omits empty skill/guidance/context sections', () => {
    const p = buildReplayPrompt(ruleTask('p', 'Only task', []), '', '')
    expect(p).toBe('# Task\nOnly task')
  })
})
