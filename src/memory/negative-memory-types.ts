/**
 * Negative Memory types — stored when the user expresses frustration,
 * corrections, or prohibitions about agent behavior.
 */

import type { RecommendedTarget, SentimentSignalType } from './sentiment-analyzer.js'

/** Verdict from the negative-memory critic stage. */
export type CriticStatus = 'keep' | 'suppress' | 'revise'
export type CriticSource = 'heuristic' | 'llm'

export interface CriticVerdict {
  readonly status: CriticStatus
  readonly rationale: string
  readonly source: CriticSource
  readonly reviewedAt: string
  /**
   * Replacement text suggested by the critic when status === 'revise'.
   * Applicators should treat the revised text as authoritative.
   */
  readonly revisedRule?: string
  /**
   * Number of consecutive 'suppress' verdicts this memory has received.
   * Used by `scns memory critic --purge` to hard-delete persistent noise.
   */
  readonly consecutiveSuppressCount?: number
}

/** A stored negative memory — represents a "don't do this" learning. */
export interface NegativeMemory {
  readonly id: string
  readonly originalText: string
  readonly dontRule: string
  readonly category: SentimentSignalType
  readonly recommendedTarget: RecommendedTarget
  readonly confidence: number
  readonly sessionId: string | null
  readonly source: 'copilot-tool' | 'heuristic' | 'manual'
  readonly targetApplied: boolean
  readonly appliedTo: string | null
  readonly createdAt: string
  /**
   * W5.4 provenance — who AUTHORED the feedback text, classified at the store
   * boundary with `classifyPromptAuthorship` (same discipline as
   * `retrieval_experience.prompt_origin`). Heuristic entries are always
   * `machine`; legacy files without the field parse as `unknown`.
   */
  readonly promptOrigin: 'human' | 'machine' | 'unknown'
  /** The classifier rule that produced {@link promptOrigin} (e.g. `no-machine-marker`). */
  readonly promptOriginRule?: string
  /** Last time the memory's body/rule was modified (defaults to createdAt). */
  readonly updatedAt?: string
  /** Critic verdict — null/undefined means "not yet reviewed". */
  readonly criticVerdict?: CriticVerdict | null
  /** Manual override: user-vouched memories bypass the critic. */
  readonly pinned?: boolean
}

/** Input for creating a negative memory via the Copilot tool (primary path). */
export interface NegativeMemoryInput {
  readonly feedback: string
  readonly context?: string
  readonly category?: SentimentSignalType
  readonly target?: RecommendedTarget
  readonly severity?: 'low' | 'medium' | 'high'
  readonly sessionId?: string
  /**
   * Blind-review finding 1: how the report REACHED the broker. `team-agent`
   * (the extension ran under SCNS_TEAM_ID, i.e. a spawned autonomous agent)
   * forces machine origin regardless of prose shape — the shape classifier
   * defaults to `human` and must not let agent feedback mint High tasks.
   */
  readonly transportOrigin?: 'team-agent' | 'interactive'
}

/** Input for creating a negative memory from heuristic detection (secondary path). */
export interface HeuristicNegativeMemoryInput {
  readonly originalText: string
  readonly dontRule: string
  readonly category: SentimentSignalType
  readonly recommendedTarget: RecommendedTarget
  readonly confidence: number
  readonly sessionId?: string
}
