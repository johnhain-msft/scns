/**
 * Extended handoff type definitions for Phase 8.
 * Rich handoff documents for session continuity.
 */

// ── Handoff status ───────────────────────────────────────────────────

export const HandoffStatus = {
  Draft: 'draft',
  Ready: 'ready',
  Consumed: 'consumed',
  Expired: 'expired',
} as const
export type HandoffStatus = (typeof HandoffStatus)[keyof typeof HandoffStatus]

// ── Work items ───────────────────────────────────────────────────────

export interface WorkItem {
  readonly description: string
  readonly priority: 'critical' | 'high' | 'normal' | 'low'
  readonly context?: string
}

export interface BlockedItem {
  readonly description: string
  readonly blockedBy: string
  readonly since: string
}

export interface Decision {
  readonly description: string
  readonly rationale: string
  readonly alternatives?: readonly string[]
}

export interface FileChange {
  readonly path: string
  readonly changeType: 'modified' | 'created' | 'deleted'
  readonly summary?: string
}

// ── Handoff document ─────────────────────────────────────────────────

export interface HandoffDocument {
  readonly id: string
  readonly sourceSessionId: string
  readonly targetSessionId: string | null
  readonly createdAt: string
  readonly status: HandoffStatus

  // Session context
  readonly sessionPurpose: string
  readonly workingDir: string
  readonly elapsedMinutes: number
  readonly tokenUsage: { estimated: number; max: number; percent: number }

  // Work state
  readonly currentTask: string | null
  readonly pendingWork: readonly WorkItem[]
  readonly completedWork: readonly string[]
  readonly blockedWork: readonly BlockedItem[]

  // Decisions & knowledge
  readonly keyDecisions: readonly Decision[]
  readonly discoveredFacts: readonly string[]
  readonly warnings: readonly string[]

  // Files
  readonly filesModified: readonly FileChange[]
  readonly filesCreated: readonly string[]
  readonly filesDeleted: readonly string[]

  // Team context
  readonly teamId: string | null
  readonly teamRole: string | null
  readonly teamPhase: string | null

  // Memory references
  readonly relevantMemoryRefs: readonly string[]
  readonly suggestedMemoryUpdates: readonly string[]

  // Continuation instructions
  readonly resumptionInstructions: string
}

// ── Handoff document summary (for listing) ───────────────────────────

export interface HandoffDocumentSummary {
  readonly id: string
  readonly sourceSessionId: string
  readonly targetSessionId: string | null
  readonly status: HandoffStatus
  readonly createdAt: string
}
