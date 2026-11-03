/**
 * Context health monitoring engine.
 * Tracks token usage per session and manages rotation recommendations.
 */

import {
  ContextStatus,
  RotationAction,
  ContextHealthConfigSchema,
  type ContextHealth,
  type ContextHealthConfig,
  type RotationRecommendation,
  type HandoffState,
} from './types.js'

// ── Internal session tracker ─────────────────────────────────────────

interface SessionTracker {
  sessionId: string
  maxTokens: number
  estimatedTokens: number
  turnCount: number
  toolCallCount: number
  compactionCount: number
  lastUpdated: string
  turnsSinceCompaction: number | null // null = no compaction yet
  hasBeenCompacted: boolean
}

// ── Factory ──────────────────────────────────────────────────────────

export interface HealthMonitorOptions {
  readonly config?: ContextHealthConfig
}

export function createHealthMonitor(options?: HealthMonitorOptions) {
  const config = ContextHealthConfigSchema.parse(options?.config ?? {})
  const sessions = new Map<string, SessionTracker>()

  function computeStatus(tracker: SessionTracker): ContextStatus {
    const usagePercent = computeUsagePercent(tracker)

    // Compacted override: within 5 turns of compaction
    if (tracker.turnsSinceCompaction !== null && tracker.turnsSinceCompaction < 5) {
      return ContextStatus.Compacted
    }

    if (usagePercent >= config.rotationThreshold) return ContextStatus.RotationNeeded
    if (usagePercent >= config.criticalThreshold) return ContextStatus.Critical
    if (usagePercent >= config.warningThreshold) return ContextStatus.Warning
    return ContextStatus.Healthy
  }

  function computeUsagePercent(tracker: SessionTracker): number {
    if (tracker.maxTokens === 0) return 0
    return (tracker.estimatedTokens / tracker.maxTokens) * 100
  }

  function toHealth(tracker: SessionTracker): ContextHealth {
    return {
      sessionId: tracker.sessionId,
      estimatedTokens: tracker.estimatedTokens,
      maxTokens: tracker.maxTokens,
      usagePercent: computeUsagePercent(tracker),
      status: computeStatus(tracker),
      lastUpdated: tracker.lastUpdated,
      turnCount: tracker.turnCount,
      toolCallCount: tracker.toolCallCount,
      compactionCount: tracker.compactionCount,
    }
  }

  function computeUrgency(tracker: SessionTracker): RotationRecommendation['urgency'] {
    const status = computeStatus(tracker)
    const underlyingUsage = computeUsagePercent(tracker)

    // Compacted but still critical or worse → immediate
    if (
      tracker.turnsSinceCompaction !== null &&
      tracker.turnsSinceCompaction < 5 &&
      underlyingUsage >= config.criticalThreshold
    ) {
      return 'immediate'
    }

    if (status === ContextStatus.RotationNeeded) return 'high'
    if (status === ContextStatus.Critical) return 'medium'
    if (status === ContextStatus.Warning) return 'low'
    return 'none'
  }

  function computeAction(tracker: SessionTracker): RotationAction {
    const urgency = computeUrgency(tracker)
    if (urgency === 'immediate') return RotationAction.Split
    if (urgency === 'high') return RotationAction.Handoff
    if (urgency === 'medium') return RotationAction.Compact
    return RotationAction.None
  }

  function computeReason(tracker: SessionTracker): string {
    const urgency = computeUrgency(tracker)
    const pct = Math.round(computeUsagePercent(tracker))
    if (urgency === 'immediate') return `Context at ${pct}% after compaction — split recommended`
    if (urgency === 'high') return `Context at ${pct}% — handoff recommended`
    if (urgency === 'medium') return `Context at ${pct}% — compaction recommended`
    if (urgency === 'low') return `Context at ${pct}% — monitoring`
    return `Context at ${pct}% — healthy`
  }

  function computeTokensSaved(tracker: SessionTracker): number {
    const action = computeAction(tracker)
    if (action === RotationAction.None) return 0
    if (action === RotationAction.Compact) {
      return Math.round(tracker.estimatedTokens * (config.compactionSavingsPercent / 100))
    }
    // Handoff or split: save most of current context
    return Math.round(tracker.estimatedTokens * 0.8)
  }

  return {
    registerSession(sessionId: string, maxTokens?: number): void {
      if (sessions.has(sessionId)) return
      sessions.set(sessionId, {
        sessionId,
        maxTokens: maxTokens ?? config.defaultMaxTokens,
        estimatedTokens: 0,
        turnCount: 0,
        toolCallCount: 0,
        compactionCount: 0,
        lastUpdated: new Date().toISOString(),
        turnsSinceCompaction: null,
        hasBeenCompacted: false,
      })
    },

    unregisterSession(sessionId: string): void {
      sessions.delete(sessionId)
    },

    recordTurn(sessionId: string, estimatedTokens?: number): void {
      const tracker = sessions.get(sessionId)
      if (!tracker) return
      tracker.estimatedTokens += estimatedTokens ?? config.tokensPerTurn
      tracker.turnCount += 1
      if (tracker.turnsSinceCompaction !== null) {
        tracker.turnsSinceCompaction += 1
      }
      tracker.lastUpdated = new Date().toISOString()
    },

    recordToolCall(sessionId: string, estimatedTokens?: number): void {
      const tracker = sessions.get(sessionId)
      if (!tracker) return
      tracker.estimatedTokens += estimatedTokens ?? config.tokensPerToolCall
      tracker.toolCallCount += 1
      tracker.lastUpdated = new Date().toISOString()
    },

    recordCompaction(sessionId: string, savingsPercent?: number): void {
      const tracker = sessions.get(sessionId)
      if (!tracker) return
      const savings = savingsPercent ?? config.compactionSavingsPercent
      tracker.estimatedTokens = Math.max(
        0,
        Math.round(tracker.estimatedTokens * (1 - savings / 100)),
      )
      tracker.compactionCount += 1
      tracker.turnsSinceCompaction = 0
      tracker.hasBeenCompacted = true
      tracker.lastUpdated = new Date().toISOString()
    },

    getHealth(sessionId: string): ContextHealth | null {
      const tracker = sessions.get(sessionId)
      if (!tracker) return null
      return toHealth(tracker)
    },

    getAllHealth(): readonly ContextHealth[] {
      return [...sessions.values()].map(toHealth)
    },

    getRotationRecommendation(sessionId: string): RotationRecommendation | null {
      const tracker = sessions.get(sessionId)
      if (!tracker) return null
      return {
        sessionId,
        urgency: computeUrgency(tracker),
        reason: computeReason(tracker),
        suggestedAction: computeAction(tracker),
        estimatedTokensSaved: computeTokensSaved(tracker),
      }
    },

    prepareHandoff(
      sessionId: string,
      summary: string,
      pendingWork: readonly string[],
      keyDecisions: readonly string[],
      filesModified: readonly string[],
    ): HandoffState {
      return {
        sessionId,
        summary,
        pendingWork,
        keyDecisions,
        filesModified,
        timestamp: new Date().toISOString(),
      }
    },

    getUrgentSessions(): readonly ContextHealth[] {
      return [...sessions.values()]
        .filter((t) => {
          const status = computeStatus(t)
          return status === ContextStatus.Critical || status === ContextStatus.RotationNeeded
        })
        .map(toHealth)
    },

    getStats(): {
      total: number
      healthy: number
      warning: number
      critical: number
      rotationNeeded: number
    } {
      let healthy = 0
      let warning = 0
      let critical = 0
      let rotationNeeded = 0

      for (const tracker of sessions.values()) {
        const status = computeStatus(tracker)
        switch (status) {
          case ContextStatus.Healthy:
          case ContextStatus.Compacted:
            healthy += 1
            break
          case ContextStatus.Warning:
            warning += 1
            break
          case ContextStatus.Critical:
            critical += 1
            break
          case ContextStatus.RotationNeeded:
            rotationNeeded += 1
            break
        }
      }

      return { total: sessions.size, healthy, warning, critical, rotationNeeded }
    },
  }
}
