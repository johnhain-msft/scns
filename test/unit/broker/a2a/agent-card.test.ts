import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  AgentCardSchema,
  createAgentCardRegistry,
  type AgentCard,
} from '../../../../src/broker/a2a/agent-card.js'

function makeCard(overrides: Partial<AgentCard> = {}): AgentCard {
  const now = new Date().toISOString()
  return AgentCardSchema.parse({
    id: randomUUID(),
    name: 'test-agent',
    description: 'A test agent',
    capabilities: ['code-generation'],
    registeredAt: now,
    lastSeenAt: now,
    ...overrides,
  })
}

describe('AgentCardSchema', () => {
  it('validates a correct agent card', () => {
    const card = makeCard()
    expect(card.name).toBe('test-agent')
    expect(card.capabilities).toEqual(['code-generation'])
  })

  it('rejects missing name', () => {
    expect(() =>
      AgentCardSchema.parse({
        id: randomUUID(),
        description: 'no name',
        capabilities: [],
        registeredAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
      }),
    ).toThrow()
  })

  it('rejects empty name', () => {
    expect(() =>
      AgentCardSchema.parse({
        id: randomUUID(),
        name: '',
        description: 'empty name',
        capabilities: [],
        registeredAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
      }),
    ).toThrow()
  })

  it('rejects invalid uuid for id', () => {
    expect(() =>
      AgentCardSchema.parse({
        id: 'not-a-uuid',
        name: 'agent',
        description: 'bad id',
        capabilities: [],
        registeredAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
      }),
    ).toThrow()
  })

  it('applies default version', () => {
    const card = makeCard()
    expect(card.version).toBe('1.0.0')
  })

  it('applies default authentication', () => {
    const card = makeCard()
    expect(card.authentication).toEqual({ type: 'none', required: false })
  })

  it('applies default empty skills', () => {
    const card = makeCard()
    expect(card.skills).toEqual([])
  })

  it('accepts optional url', () => {
    const card = makeCard({ url: 'https://example.com/agent' })
    expect(card.url).toBe('https://example.com/agent')
  })

  it('rejects invalid url', () => {
    expect(() => makeCard({ url: 'not-a-url' })).toThrow()
  })

  it('accepts skills with input schema', () => {
    const card = makeCard({
      skills: [
        {
          id: 'gen-code',
          name: 'Code Generation',
          description: 'Generates code',
          inputSchema: { type: 'object', properties: { language: { type: 'string' } } },
        },
      ],
    })
    expect(card.skills).toHaveLength(1)
    expect(card.skills[0]!.id).toBe('gen-code')
  })

  it('accepts provider info', () => {
    const card = makeCard({ provider: { name: 'Acme', url: 'https://acme.com' } })
    expect(card.provider?.name).toBe('Acme')
  })

  it('accepts metadata', () => {
    const card = makeCard({ metadata: { region: 'us-east-1' } })
    expect(card.metadata).toEqual({ region: 'us-east-1' })
  })
})

describe('AgentCardRegistry', () => {
  let registry: ReturnType<typeof createAgentCardRegistry>

  beforeEach(() => {
    registry = createAgentCardRegistry()
  })

  it('register adds card to registry', () => {
    const card = makeCard()
    registry.register(card)
    expect(registry.get(card.id)).toEqual(card)
  })

  it('unregister removes card and returns true', () => {
    const card = makeCard()
    registry.register(card)
    expect(registry.unregister(card.id)).toBe(true)
    expect(registry.get(card.id)).toBeNull()
  })

  it('unregister returns false for unknown id', () => {
    expect(registry.unregister(randomUUID())).toBe(false)
  })

  it('get returns null for unknown id', () => {
    expect(registry.get(randomUUID())).toBeNull()
  })

  it('findByCapability returns matching agents', () => {
    const card1 = makeCard({ capabilities: ['code-generation', 'testing'] })
    const card2 = makeCard({ capabilities: ['research'] })
    const card3 = makeCard({ capabilities: ['code-generation'] })
    registry.register(card1)
    registry.register(card2)
    registry.register(card3)

    const results = registry.findByCapability('code-generation')
    expect(results).toHaveLength(2)
    expect(results.map((c) => c.id).sort()).toEqual([card1.id, card3.id].sort())
  })

  it('findByCapability returns empty for no match', () => {
    registry.register(makeCard({ capabilities: ['research'] }))
    expect(registry.findByCapability('dancing')).toEqual([])
  })

  it('findBySkill returns matching agents', () => {
    const card1 = makeCard({
      skills: [{ id: 'gen-code', name: 'Gen Code', description: 'generates' }],
    })
    const card2 = makeCard({
      skills: [{ id: 'review', name: 'Review', description: 'reviews' }],
    })
    registry.register(card1)
    registry.register(card2)

    const results = registry.findBySkill('gen-code')
    expect(results).toHaveLength(1)
    expect(results[0]!.id).toBe(card1.id)
  })

  it('findBySkill returns empty for no match', () => {
    expect(registry.findBySkill('nonexistent')).toEqual([])
  })

  it('list returns all registered cards', () => {
    const card1 = makeCard()
    const card2 = makeCard()
    registry.register(card1)
    registry.register(card2)
    expect(registry.list()).toHaveLength(2)
  })

  it('list returns empty for empty registry', () => {
    expect(registry.list()).toEqual([])
  })

  it('updateLastSeen updates timestamp', () => {
    const card = makeCard({ lastSeenAt: '2020-01-01T00:00:00.000Z' })
    registry.register(card)

    const before = registry.get(card.id)!.lastSeenAt
    registry.updateLastSeen(card.id)
    const after = registry.get(card.id)!.lastSeenAt

    expect(after).not.toBe(before)
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime())
  })

  it('updateLastSeen is no-op for unknown id', () => {
    // Should not throw
    registry.updateLastSeen(randomUUID())
  })

  it('duplicate ID registration overwrites', () => {
    const id = randomUUID()
    const card1 = makeCard({ id, name: 'original' })
    const card2 = makeCard({ id, name: 'updated' })
    registry.register(card1)
    registry.register(card2)

    expect(registry.get(id)?.name).toBe('updated')
    expect(registry.list()).toHaveLength(1)
  })

  it('toWellKnownJson produces correct format', () => {
    const card = makeCard({ name: 'wk-agent' })
    registry.register(card)

    const json = registry.toWellKnownJson() as Record<string, unknown>
    expect(json).toHaveProperty('agents')
    expect(Array.isArray(json['agents'])).toBe(true)
    const agents = json['agents'] as AgentCard[]
    expect(agents).toHaveLength(1)
    expect(agents[0]!.name).toBe('wk-agent')
  })
})
