import { describe, it, expect } from 'vitest'
import {
  createAcpJudge,
  isJudgeEnabled,
  JUDGE_ENV,
  DEFAULT_JUDGE_ATTEMPT_TIMEOUT_MS,
} from '../../../src/memory/judge-acp.js'
import { NULL_JUDGE_SCORE } from '../../../src/memory/judge-provider.js'

// Transport for the App C.3 judge — an isolated, ephemeral, deny-all `copilot --acp` grade over ONLY
// {question, gold, candidate}. Mirrors createAcpFactExtractor. Unit tests inject a fake client (no spawn).

describe('createAcpJudge — transport (injected fake client, no spawn)', () => {
  it('initialises, sends the blind rubric prompt, and parses the JSON score', async () => {
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
        return { stopReason: 'end_turn', output: '{"score": 0.8, "reasoning": "substantially correct"}' }
      },
      async close() {
        closed = true
      },
    }
    const judge = createAcpJudge({
      cwd: '/tmp/scns-judge-test-isolated',
      createClient: (opts) => {
        clientOpts = opts as unknown as Record<string, unknown>
        return fakeClient as never
      },
    })
    const r = await judge.judge({ question: 'When?', gold: '7 May 2023', candidate: 'May 7 2023' })
    expect(sawInit).toBe(true)
    expect(closed).toBe(true) // ephemeral: always torn down
    expect(r.score).toBeCloseTo(0.8)
    // Blind: prompt carries candidate + gold but NOT any retrieved context.
    expect(sentPrompt).toContain('7 May 2023')
    expect(sentPrompt).toContain('May 7 2023')
    expect(sentPrompt.toLowerCase()).not.toContain('retrieved')
    // Deny-all + text-only: never allow-all-tools; a permission policy is supplied.
    expect(clientOpts?.['allowAllTools']).toBe(false)
    expect(clientOpts?.['permissionPolicy']).toBeDefined()
  })

  it('returns the NULL sentinel (do no harm) when the client throws — never throws, always closes', async () => {
    let closed = false
    const throwingClient = {
      async initialize() {
        throw new Error('spawn failed')
      },
      async createSession() {
        return 's'
      },
      async sendPrompt() {
        return { stopReason: 'end_turn', output: '{}' }
      },
      async close() {
        closed = true
      },
    }
    const judge = createAcpJudge({
      cwd: '/tmp/scns-judge-test-isolated',
      createClient: () => throwingClient as never,
    })
    const r = await judge.judge({ question: 'q', gold: 'g', candidate: 'c' })
    expect(r.score).toBe(NULL_JUDGE_SCORE)
    expect(closed).toBe(true)
  })

  it('requires an isolated cwd (never the live checkout)', () => {
    expect(() => createAcpJudge({ cwd: '' })).toThrow()
  })

  it('exposes a bounded default attempt timeout', () => {
    expect(DEFAULT_JUDGE_ATTEMPT_TIMEOUT_MS).toBeGreaterThan(0)
    expect(DEFAULT_JUDGE_ATTEMPT_TIMEOUT_MS).toBeLessThanOrEqual(240_000)
  })
})

describe('isJudgeEnabled — default-OFF', () => {
  it('is OFF when the env flag is unset', () => {
    expect(isJudgeEnabled({})).toBe(false)
  })
  it('recognises truthy values', () => {
    for (const v of ['1', 'true', 'yes', 'on', 'TRUE']) {
      expect(isJudgeEnabled({ [JUDGE_ENV]: v })).toBe(true)
    }
  })
  it('treats other values as OFF', () => {
    for (const v of ['0', 'false', 'no', '']) {
      expect(isJudgeEnabled({ [JUDGE_ENV]: v })).toBe(false)
    }
  })
})
