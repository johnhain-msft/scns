/**
 * WS-2 Phase B3 — real ACP conversation event extractor (transport) unit tests.
 *
 * The production transport for {@link ConversationEventExtractor}: ONE isolated, bounded, deny-all
 * (think-only) Copilot ACP session per conversation session. Mirrors the `createAcpCausalProvider` /
 * `createAcpFactExtractor` transport tests — the client factory is INJECTED so this never spawns a
 * real process; we assert init + prompt shape + JSON parse + the isolated-cwd guard + do-no-harm
 * degradation. The real deny-all spawn is exercised ONLY in the deferred measurement harness.
 */
import { describe, it, expect } from 'vitest'
import {
  createAcpConversationEventExtractor,
  isConversationEventExtractEnabled,
  CONVERSATION_EVENT_ACP_ENV,
} from '../../../src/memory/conversation-event-extractor-acp.js'
import type { ConversationEpisodeInput } from '../../../src/memory/conversation-event-extractor.js'

const EPISODE: ConversationEpisodeInput = {
  episodeId: 'session_2',
  speakers: ['Caroline', 'Melanie'],
  turns: [{ speaker: 'Caroline', text: 'I adopted a rescue dog named Biscuit this weekend.' }],
}

describe('createAcpConversationEventExtractor — transport (injected fake client, no spawn)', () => {
  it('initialises, sends a prompt containing the turns, and parses the JSON response', async () => {
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
          output: JSON.stringify([
            {
              entity: 'Caroline',
              decision: 'adopt a rescue dog',
              observation: 'brought home a dog named Biscuit',
              outcome: 'has a new companion',
              content: 'Caroline adopted a rescue dog named Biscuit.',
            },
          ]),
        }
      },
      async close() {},
    }
    const extractor = createAcpConversationEventExtractor({
      cwd: '/tmp/scns-conv-event-isolated',
      createClient: () => fakeClient as never,
    })
    const events = await extractor.extract(EPISODE)
    expect(sawInit).toBe(true)
    expect(sentPrompt).toContain('Biscuit')
    expect(sentPrompt).toContain('Caroline')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      entity: 'Caroline',
      action: 'brought home a dog named Biscuit',
      content: 'Caroline adopted a rescue dog named Biscuit.',
    })
  })

  it('requires an isolated cwd (never the live checkout)', () => {
    expect(() => createAcpConversationEventExtractor({ cwd: '' })).toThrow()
  })

  it('degrades to zero events (do no harm) when the client throws', async () => {
    const throwingClient = {
      async initialize() {
        throw new Error('spawn failed')
      },
      async createSession() {
        return 's'
      },
      async sendPrompt() {
        return { output: '[]' }
      },
      async close() {},
    }
    const extractor = createAcpConversationEventExtractor({
      cwd: '/tmp/scns-conv-event-isolated',
      createClient: () => throwingClient as never,
    })
    await expect(extractor.extract(EPISODE)).resolves.toEqual([])
  })

  it('returns [] for an empty episode without touching the client', async () => {
    let created = false
    const extractor = createAcpConversationEventExtractor({
      cwd: '/tmp/scns-conv-event-isolated',
      createClient: () => {
        created = true
        return {} as never
      },
    })
    const events = await extractor.extract({ episodeId: 'session_9', speakers: [], turns: [] })
    expect(events).toEqual([])
    expect(created).toBe(false)
  })
})

describe('isConversationEventExtractEnabled — env opt-in (default-OFF)', () => {
  it('is false when the flag is absent, true when truthy', () => {
    expect(isConversationEventExtractEnabled({})).toBe(false)
    expect(isConversationEventExtractEnabled({ [CONVERSATION_EVENT_ACP_ENV]: '1' })).toBe(true)
    expect(isConversationEventExtractEnabled({ [CONVERSATION_EVENT_ACP_ENV]: 'on' })).toBe(true)
    expect(isConversationEventExtractEnabled({ [CONVERSATION_EVENT_ACP_ENV]: '0' })).toBe(false)
  })
})
