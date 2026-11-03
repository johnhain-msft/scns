/**
 * Context health type definitions.
 * Pure data types — no logic, no side effects.
 */

import { z } from 'zod'

// ── Context status ───────────────────────────────────────────────────

export const ContextStatus = {
  Healthy: 'healthy',
  Warning: 'warning',
  Critical: 'critical',
  RotationNeeded: 'rotation-needed',
  Compacted: 'compacted',
} as const
export type ContextStatus = (typeof ContextStatus)[keyof typeof ContextStatus]

// ── Context health per session ───────────────────────────────────────

export interface ContextHealth {
  readonly sessionId: string
  readonly estimatedTokens: number
  readonly maxTokens: number
  readonly usagePercent: number
  readonly status: ContextStatus
  readonly lastUpdated: string
  readonly turnCount: number
  readonly toolCallCount: number
  readonly compactionCount: number
}

// ── Rotation action ──────────────────────────────────────────────────

export const RotationAction = {
  None: 'none',
  Compact: 'compact',
  Handoff: 'handoff',
  Summarize: 'summarize',
  Split: 'split',
} as const
export type RotationAction = (typeof RotationAction)[keyof typeof RotationAction]

// ── Rotation recommendation ──────────────────────────────────────────

export interface RotationRecommendation {
  readonly sessionId: string
  readonly urgency: 'none' | 'low' | 'medium' | 'high' | 'immediate'
  readonly reason: string
  readonly suggestedAction: RotationAction
  readonly estimatedTokensSaved: number
}

// ── Handoff state ────────────────────────────────────────────────────

export interface HandoffState {
  readonly sessionId: string
  readonly summary: string
  readonly pendingWork: readonly string[]
  readonly keyDecisions: readonly string[]
  readonly filesModified: readonly string[]
  readonly timestamp: string
}

// ── Config schema ────────────────────────────────────────────────────

export const ContextHealthConfigSchema = z.object({
  defaultMaxTokens: z.number().default(200_000),
  warningThreshold: z.number().min(0).max(100).default(50),
  criticalThreshold: z.number().min(0).max(100).default(75),
  rotationThreshold: z.number().min(0).max(100).default(85),
  tokensPerTurn: z.number().default(2000),
  tokensPerToolCall: z.number().default(500),
  compactionSavingsPercent: z.number().default(40),
})
export type ContextHealthConfig = z.infer<typeof ContextHealthConfigSchema>
