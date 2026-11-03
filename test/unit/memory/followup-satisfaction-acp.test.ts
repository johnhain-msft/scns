import { describe, it, expect } from 'vitest'
import {
  createAcpFollowupProvider,
  DEFAULT_FOLLOWUP_TIMEOUT_MS,
  FOLLOWUP_WORKER_SIGNATURE,
} from '../../../src/memory/followup-satisfaction-acp.js'
import { FOLLOWUP_SYSTEM_PROMPT } from '../../../src/memory/followup-satisfaction.js'

// Transport for the follow-up satisfaction reader — an isolated, ephemeral, deny-all `copilot --acp`
// turn over ONLY the two message texts. Mirrors createAcpGateQuestionProvider. Unit tests inject a
// fake client (no spawn). Every failure mode must degrade to null = ABSTAIN, never to a label.

const ISOLATED = '/tmp/scns-followup-test-isolated'

describe('createAcpFollowupProvider — transport (injected fake client, no spawn)', () => {
  it('initialises, sends the neutral prompt, parses the verdict, and always tears down', async () => {
    let sawInit = false
    let closed = false
    let sentPrompt = ''
    let clientOpts: Record<string, unknown> | undefined
    const fakeClient = {
      async initialize() {
        sawInit = true
      },
      async createSession() {
        return 'session-1'
      },
      async sendPrompt(_s: string, prompt: string) {
        sentPrompt = prompt
        return { stopReason: 'end_turn', output: 'same_need: yes\npattern: dispute\nconfidence: 0.78' }
      },
      async close() {
        closed = true
      },
    }
    const provider = createAcpFollowupProvider({
      cwd: ISOLATED,
      createClient: (opts) => {
        clientOpts = opts as unknown as Record<string, unknown>
        return fakeClient as never
      },
    })
    const v = await provider.classify({
      priorQuery: 'SCNS scheduling: two distinct layers',
      nextTurn: 'confirm that those tasks never actually run -- pretty sure they do',
    })
    expect(sawInit).toBe(true)
    expect(closed).toBe(true)
    expect(v).toEqual({ pattern: 'dispute', confidence: 0.78, sameNeed: 'yes' })
    expect(sentPrompt).toContain('pretty sure they do')
    // Deny-all + text-only: never allow-all-tools; a permission policy is supplied.
    expect(clientOpts?.['allowAllTools']).toBe(false)
    expect(clientOpts?.['permissionPolicy']).toBeDefined()
  })

  it('NEGATIVE: a throwing client ABSTAINS (null) — never throws, always closes', async () => {
    let closed = false
    const throwingClient = {
      async initialize() {
        throw new Error('spawn failed')
      },
      async createSession() {
        return 's'
      },
      async sendPrompt() {
        return { stopReason: 'end_turn', output: '' }
      },
      async close() {
        closed = true
      },
    }
    const provider = createAcpFollowupProvider({
      cwd: ISOLATED,
      createClient: () => throwingClient as never,
    })
    expect(
      await provider.classify({ priorQuery: 'a prior query', nextTurn: 'a substantive follow-up' }),
    ).toBeNull()
    expect(closed).toBe(true)
  })

  it('NEGATIVE: unparseable model output ABSTAINS rather than guessing a label', async () => {
    const chattyClient = {
      async initialize() {},
      async createSession() {
        return 's'
      },
      async sendPrompt() {
        return { stopReason: 'end_turn', output: 'Sure! The user seemed pretty happy with that.' }
      },
      async close() {},
    }
    const provider = createAcpFollowupProvider({
      cwd: ISOLATED,
      createClient: () => chattyClient as never,
    })
    expect(
      await provider.classify({ priorQuery: 'a prior query', nextTurn: 'a substantive follow-up' }),
    ).toBeNull()
  })

  it('NEGATIVE: empty inputs never reach the model', async () => {
    let spawned = false
    const provider = createAcpFollowupProvider({
      cwd: ISOLATED,
      createClient: () => {
        spawned = true
        return {} as never
      },
    })
    expect(await provider.classify({ priorQuery: '', nextTurn: 'x' })).toBeNull()
    expect(await provider.classify({ priorQuery: 'x', nextTurn: '  ' })).toBeNull()
    expect(spawned).toBe(false)
  })

  it('requires an isolated cwd (never the live checkout)', () => {
    expect(() => createAcpFollowupProvider({ cwd: '' })).toThrow()
  })

  it('exposes a bounded default timeout and a recursion-guard signature', () => {
    expect(DEFAULT_FOLLOWUP_TIMEOUT_MS).toBeGreaterThan(0)
    expect(DEFAULT_FOLLOWUP_TIMEOUT_MS).toBeLessThanOrEqual(240_000)
    expect(FOLLOWUP_SYSTEM_PROMPT).toContain(FOLLOWUP_WORKER_SIGNATURE)
  })
})
