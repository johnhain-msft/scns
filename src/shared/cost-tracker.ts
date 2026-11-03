/**
 * Per-session and aggregate cost tracking.
 * Tracks token usage in memory with simple cost estimation.
 */

// Pricing: input $3/1M tokens, output $15/1M tokens (Claude-like)
const INPUT_COST_PER_TOKEN = 3 / 1_000_000
const OUTPUT_COST_PER_TOKEN = 15 / 1_000_000

export interface CostTrackerConfig {
  readonly stateDir: string
}

export interface TokenUsage {
  readonly sessionId: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
  readonly estimatedCostUSD: number
  readonly timestamp: string
}

export interface CostSummary {
  readonly totalInputTokens: number
  readonly totalOutputTokens: number
  readonly totalTokens: number
  readonly estimatedTotalCostUSD: number
  readonly sessionCount: number
  readonly perSession: readonly SessionCost[]
}

export interface SessionCost {
  readonly sessionId: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
  readonly estimatedCostUSD: number
}

export interface CostTracker {
  recordUsage(usage: TokenUsage): void
  getSessionCost(sessionId: string): SessionCost | null
  getSummary(): CostSummary
  reset(): void
}

interface MutableSessionData {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  estimatedCostUSD: number
}

export function estimateCost(inputTokens: number, outputTokens: number): number {
  return inputTokens * INPUT_COST_PER_TOKEN + outputTokens * OUTPUT_COST_PER_TOKEN
}

export function createCostTracker(_config?: Partial<CostTrackerConfig>): CostTracker {
  const sessions = new Map<string, MutableSessionData>()

  function recordUsage(usage: TokenUsage): void {
    const existing = sessions.get(usage.sessionId)
    if (existing) {
      existing.inputTokens += usage.inputTokens
      existing.outputTokens += usage.outputTokens
      existing.totalTokens += usage.totalTokens
      existing.estimatedCostUSD += usage.estimatedCostUSD
    } else {
      sessions.set(usage.sessionId, {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        estimatedCostUSD: usage.estimatedCostUSD,
      })
    }
  }

  function getSessionCost(sessionId: string): SessionCost | null {
    const data = sessions.get(sessionId)
    if (!data) return null
    return {
      sessionId,
      inputTokens: data.inputTokens,
      outputTokens: data.outputTokens,
      totalTokens: data.totalTokens,
      estimatedCostUSD: data.estimatedCostUSD,
    }
  }

  function getSummary(): CostSummary {
    let totalInputTokens = 0
    let totalOutputTokens = 0
    let totalTokens = 0
    let estimatedTotalCostUSD = 0
    const perSession: SessionCost[] = []

    for (const [sessionId, data] of sessions) {
      totalInputTokens += data.inputTokens
      totalOutputTokens += data.outputTokens
      totalTokens += data.totalTokens
      estimatedTotalCostUSD += data.estimatedCostUSD
      perSession.push({
        sessionId,
        inputTokens: data.inputTokens,
        outputTokens: data.outputTokens,
        totalTokens: data.totalTokens,
        estimatedCostUSD: data.estimatedCostUSD,
      })
    }

    return {
      totalInputTokens,
      totalOutputTokens,
      totalTokens,
      estimatedTotalCostUSD,
      sessionCount: sessions.size,
      perSession,
    }
  }

  function reset(): void {
    sessions.clear()
  }

  return { recordUsage, getSessionCost, getSummary, reset }
}
