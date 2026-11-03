import { describe, it, expect } from 'vitest'
import {
  createAcpQaGenerator,
  isQaGeneratorEnabled,
  GEN_ENV,
  DEFAULT_GEN_ATTEMPT_TIMEOUT_MS,
} from '../../../src/memory/qa-generator-acp.js'

// Transport for the App C.2 QA generator — an isolated, ephemeral, deny-all `copilot --acp` answer over
// retrieved context. Mirrors createAcpFactExtractor / createAcpJudge. Unit tests inject a fake client.

describe('createAcpQaGenerator — transport (injected fake client, no spawn)', () => {
  it('initialises, sends the C.2 prompt (context + question + intent instruction), parses the answer', async () => {
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
        return { stopReason: 'end_turn', output: 'Adoption agencies' }
      },
      async close() {
        closed = true
      },
    }
    const gen = createAcpQaGenerator({
      cwd: '/tmp/scns-gen-test-isolated',
      createClient: (opts) => {
        clientOpts = opts as unknown as Record<string, unknown>
        return fakeClient as never
      },
    })
    const r = await gen.generate({
      question: 'What did Caroline research?',
      context: 'Relevant SCNS memories:\nCaroline: I researched adoption agencies.',
      intent: 'ENTITY',
    })
    expect(sawInit).toBe(true)
    expect(closed).toBe(true)
    expect(r.answer).toBe('Adoption agencies')
    expect(r.notFound).toBe(false)
    expect(r.error).toBeFalsy()
    expect(sentPrompt).toContain('adoption agencies') // context present
    expect(sentPrompt.toLowerCase()).toMatch(/specific entity|extract/) // ENTITY → single-hop instruction
    expect(clientOpts?.['allowAllTools']).toBe(false)
    expect(clientOpts?.['permissionPolicy']).toBeDefined()
  })

  it('flags error=true (do no harm, DROPPED not scored) when the client throws — always closes', async () => {
    let closed = false
    const throwingClient = {
      async initialize() {
        throw new Error('spawn failed')
      },
      async createSession() {
        return 's'
      },
      async sendPrompt() {
        return { stopReason: 'end_turn', output: 'x' }
      },
      async close() {
        closed = true
      },
    }
    const gen = createAcpQaGenerator({
      cwd: '/tmp/scns-gen-test-isolated',
      createClient: () => throwingClient as never,
    })
    const r = await gen.generate({ question: 'q', context: 'c', intent: 'DEFAULT' })
    expect(r.error).toBe(true)
    expect(closed).toBe(true)
  })

  it('requires an isolated cwd (never the live checkout)', () => {
    expect(() => createAcpQaGenerator({ cwd: '' })).toThrow()
  })

  it('exposes a bounded default attempt timeout', () => {
    expect(DEFAULT_GEN_ATTEMPT_TIMEOUT_MS).toBeGreaterThan(0)
    expect(DEFAULT_GEN_ATTEMPT_TIMEOUT_MS).toBeLessThanOrEqual(240_000)
  })
})

describe('isQaGeneratorEnabled — default-OFF', () => {
  it('is OFF when the env flag is unset', () => {
    expect(isQaGeneratorEnabled({})).toBe(false)
  })
  it('recognises truthy values', () => {
    for (const v of ['1', 'true', 'yes', 'on', 'TRUE']) {
      expect(isQaGeneratorEnabled({ [GEN_ENV]: v })).toBe(true)
    }
  })
})
