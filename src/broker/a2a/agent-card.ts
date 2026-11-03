import { z } from 'zod'

// ---------------------------------------------------------------------------
// A2A Agent Card schema — describes an agent's capabilities
// ---------------------------------------------------------------------------

export const AgentCardSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  description: z.string(),
  url: z.string().url().optional(),
  version: z.string().default('1.0.0'),
  capabilities: z.array(z.string()),
  skills: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        description: z.string(),
        inputSchema: z.record(z.unknown()).optional(),
      }),
    )
    .default([]),
  provider: z
    .object({
      name: z.string(),
      url: z.string().url().optional(),
    })
    .optional(),
  authentication: z
    .object({
      type: z.enum(['none', 'bearer', 'api-key']),
      required: z.boolean().default(false),
    })
    .default({ type: 'none', required: false }),
  metadata: z.record(z.unknown()).optional(),
  registeredAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
})

export type AgentCard = z.infer<typeof AgentCardSchema>

// ---------------------------------------------------------------------------
// Agent Card registry — in-memory store of registered agents
// ---------------------------------------------------------------------------

export interface AgentCardRegistry {
  register(card: AgentCard): void
  unregister(id: string): boolean
  get(id: string): AgentCard | null
  findByCapability(capability: string): readonly AgentCard[]
  findBySkill(skillId: string): readonly AgentCard[]
  list(): readonly AgentCard[]
  updateLastSeen(id: string): void
  toWellKnownJson(): object
}

export function createAgentCardRegistry(): AgentCardRegistry {
  const cards = new Map<string, AgentCard>()

  return {
    register(card: AgentCard): void {
      cards.set(card.id, card)
    },

    unregister(id: string): boolean {
      return cards.delete(id)
    },

    get(id: string): AgentCard | null {
      return cards.get(id) ?? null
    },

    findByCapability(capability: string): readonly AgentCard[] {
      const results: AgentCard[] = []
      for (const card of cards.values()) {
        if (card.capabilities.includes(capability)) {
          results.push(card)
        }
      }
      return results
    },

    findBySkill(skillId: string): readonly AgentCard[] {
      const results: AgentCard[] = []
      for (const card of cards.values()) {
        if (card.skills.some((s) => s.id === skillId)) {
          results.push(card)
        }
      }
      return results
    },

    list(): readonly AgentCard[] {
      return [...cards.values()]
    },

    updateLastSeen(id: string): void {
      const card = cards.get(id)
      if (card) {
        cards.set(id, { ...card, lastSeenAt: new Date().toISOString() })
      }
    },

    toWellKnownJson(): object {
      return { agents: [...cards.values()] }
    },
  }
}
