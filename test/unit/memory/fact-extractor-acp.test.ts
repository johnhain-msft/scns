import { describe, it, expect } from 'vitest'
import {
  createAcpFactExtractor,
  isFactExtractEnabled,
  FACT_EXTRACT_ENV,
} from '../../../src/memory/fact-extractor-acp.js'

describe('createAcpFactExtractor — transport (injected fake client, no spawn)', () => {
  it('initialises, sends the prompt, and parses the JSON response', async () => {
    const chunks = [
      { id: '0', path: 'chain_b.md', content: 'Melanie volunteers every week at Riverdale Settlement House.' },
      { id: '1', path: 'chain_c.md', content: 'Riverdale Settlement House is notable for its pipe organ.' },
    ]
    let sawInit = false
    let sentPrompt = ''
    const fakeClient = {
      async initialize() {
        sawInit = true
      },
      async createSession() {
        return 'session-1'
      },
      async sendPrompt(_sessionId: string, prompt: string) {
        sentPrompt = prompt
        return {
          stopReason: 'end_turn',
          output: JSON.stringify([
            { sourceId: '1', content: 'Riverdale, where Melanie volunteers, is notable for its pipe organ.' },
          ]),
        }
      },
      async close() {},
    }
    const extractor = createAcpFactExtractor({
      cwd: '/tmp/scns-factext-test-isolated',
      createClient: () => fakeClient as never,
    })
    const facts = await extractor.extract({ chunks })
    expect(sawInit).toBe(true)
    expect(sentPrompt).toContain('Melanie volunteers')
    expect(facts).toHaveLength(1)
    expect(facts[0]).toMatchObject({ sourceId: '1' })
    expect(facts[0]!.content).toContain('pipe organ')
  })

  it('returns [] (do no harm) when the client throws — index never corrupted', async () => {
    const throwingClient = {
      async initialize() {
        throw new Error('spawn failed')
      },
      async createSession() {
        return 's'
      },
      async sendPrompt() {
        return { stopReason: 'end_turn', output: '[]' }
      },
      async close() {},
    }
    const extractor = createAcpFactExtractor({
      cwd: '/tmp/scns-factext-test-isolated',
      createClient: () => throwingClient as never,
    })
    const facts = await extractor.extract({
      chunks: [{ id: '0', path: 'a.md', content: 'x' }],
    })
    expect(facts).toEqual([])
  })

  it('returns [] for an empty passage set without spawning', async () => {
    let created = false
    const extractor = createAcpFactExtractor({
      cwd: '/tmp/scns-factext-test-isolated',
      createClient: () => {
        created = true
        return {} as never
      },
    })
    expect(await extractor.extract({ chunks: [] })).toEqual([])
    expect(created).toBe(false)
  })

  it('requires an isolated cwd (never the live checkout)', () => {
    expect(() => createAcpFactExtractor({ cwd: '' })).toThrow()
  })
})

describe('isFactExtractEnabled', () => {
  it('is default-OFF when the env flag is unset', () => {
    expect(isFactExtractEnabled({})).toBe(false)
  })

  it('recognises truthy values', () => {
    for (const v of ['1', 'true', 'yes', 'on', 'TRUE']) {
      expect(isFactExtractEnabled({ [FACT_EXTRACT_ENV]: v })).toBe(true)
    }
  })

  it('treats other values as OFF', () => {
    for (const v of ['0', 'false', 'no', '']) {
      expect(isFactExtractEnabled({ [FACT_EXTRACT_ENV]: v })).toBe(false)
    }
  })
})
