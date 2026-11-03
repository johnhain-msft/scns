import { z } from 'zod'

// ---------------------------------------------------------------------------
// Role Slot — a single role requirement in a team manifest
// ---------------------------------------------------------------------------

export const RoleSlotSchema = z.object({
  role: z.string(),
  count: z.number().min(1).default(1),
  capabilities: z.array(z.string()).default([]),
  templateId: z.string().optional(),
})

export type RoleSlot = z.infer<typeof RoleSlotSchema>

// ---------------------------------------------------------------------------
// Team Manifest — describes desired team composition
// ---------------------------------------------------------------------------

export const TeamManifestSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  roles: z.array(RoleSlotSchema).min(1),
  phases: z
    .array(
      z.object({
        name: z.string(),
        roles: z.array(z.string()),
        gateCondition: z
          .enum(['all-complete', 'any-complete', 'majority-complete'])
          .default('all-complete'),
      }),
    )
    .optional(),
  strategy: z.string().default('parallel'),
  maxConcurrent: z.number().default(5),
})

export type TeamManifest = z.infer<typeof TeamManifestSchema>

// ---------------------------------------------------------------------------
// Reconciliation action — what to do to reach desired state
// ---------------------------------------------------------------------------

export interface ReconcileAction {
  readonly type: 'spawn' | 'kill' | 'reassign' | 'noop'
  readonly role: string
  readonly count: number
  readonly reason: string
}

// ---------------------------------------------------------------------------
// Current team state (actual)
// ---------------------------------------------------------------------------

export interface TeamState {
  readonly teamId: string
  readonly members: readonly {
    readonly role: string
    readonly sessionId: string
    readonly status: string
  }[]
}
