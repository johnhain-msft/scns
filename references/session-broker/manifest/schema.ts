import { z } from 'zod'

export const ManifestRoleSchema = z.object({
  name: z.string().min(1).describe('Role name (maps to team_members.role)'),
  count: z.number().int().min(1).max(10).describe('Desired number of agents with this role'),
  agent: z.string().default('teammate').describe('Agent profile to use'),
  prompt: z.string().optional().describe('Initial prompt for spawned agents'),
  capabilities: z.array(z.string()).optional().describe('Required capabilities for this role'),
})

export type ManifestRole = z.infer<typeof ManifestRoleSchema>

export const ManifestTaskSchema = z.object({
  subject: z.string().min(1).describe('Task title'),
  description: z.string().optional().describe('Task description'),
  assignTo: z.string().optional().describe('Role to assign this task to'),
  blockedBy: z.array(z.string()).optional().describe('Subjects of tasks that block this one'),
})

export type ManifestTask = z.infer<typeof ManifestTaskSchema>

export const ManifestRespawnPolicySchema = z.object({
  enabled: z.boolean().default(true),
  maxRetries: z.number().int().min(0).max(10).default(3),
  backoffBaseMs: z.number().int().min(0).max(60000).default(5000),
})

export type ManifestRespawnPolicy = z.infer<typeof ManifestRespawnPolicySchema>

export const ManifestScalingPolicySchema = z.object({
  enabled: z.boolean().default(true),
  minCount: z.number().int().min(0).max(10).default(1),
  maxCount: z.number().int().min(1).max(20).default(5),
  scaleUpThreshold: z.number().int().min(1).max(100).default(3),
  scaleDownThreshold: z.number().int().min(0).max(100).default(0),
  cooldownMs: z.number().int().min(0).max(600000).default(60000),
})

export type ManifestScalingPolicy = z.infer<typeof ManifestScalingPolicySchema>

export const TeamManifestSchema = z.object({
  apiVersion: z.literal('v1'),
  kind: z.literal('TeamManifest'),
  metadata: z.object({
    name: z.string().min(1).max(100),
  }),
  spec: z.object({
    description: z.string().optional(),
    roles: z.array(ManifestRoleSchema).min(1),
    tasks: z.array(ManifestTaskSchema).optional().default([]),
    respawnPolicy: ManifestRespawnPolicySchema.optional(),
    scalingPolicy: ManifestScalingPolicySchema.optional(),
  }),
})

export type TeamManifest = z.infer<typeof TeamManifestSchema>
