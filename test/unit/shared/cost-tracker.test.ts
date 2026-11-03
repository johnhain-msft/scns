import { describe, it, expect, beforeEach } from 'vitest'
import { createCostTracker, estimateCost } from '../../../src/shared/cost-tracker.js'
import type { TokenUsage, CostTracker } from '../../../src/shared/cost-tracker.js'

function makeUsage(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return {
    sessionId: 'session-1',
    inputTokens: 1000,
    outputTokens: 500,
    totalTokens: 1500,
    estimatedCostUSD: estimateCost(1000, 500),
    timestamp: '2024-01-01T00:00:00Z',
    ...overrides,
  }
}

describe('cost-tracker', () => {
  let tracker: CostTracker

  beforeEach(() => {
    tracker = createCostTracker()
  })

  describe('estimateCost', () => {
    it('calculates cost correctly with input $3/1M and output $15/1M', () => {
      const cost = estimateCost(1_000_000, 1_000_000)
      expect(cost).toBeCloseTo(3 + 15, 5)
    })

    it('returns 0 for zero tokens', () => {
      expect(estimateCost(0, 0)).toBe(0)
    })

    it('handles input-only usage', () => {
      const cost = estimateCost(1_000_000, 0)
      expect(cost).toBeCloseTo(3, 5)
    })

    it('handles output-only usage', () => {
      const cost = estimateCost(0, 1_000_000)
      expect(cost).toBeCloseTo(15, 5)
    })
  })

  describe('recordUsage', () => {
    it('records usage for a new session', () => {
      tracker.recordUsage(makeUsage())
      const cost = tracker.getSessionCost('session-1')
      expect(cost).not.toBeNull()
      expect(cost!.inputTokens).toBe(1000)
      expect(cost!.outputTokens).toBe(500)
    })

    it('accumulates multiple records for same session', () => {
      tracker.recordUsage(
        makeUsage({
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          estimatedCostUSD: estimateCost(100, 50),
        }),
      )
      tracker.recordUsage(
        makeUsage({
          inputTokens: 200,
          outputTokens: 100,
          totalTokens: 300,
          estimatedCostUSD: estimateCost(200, 100),
        }),
      )

      const cost = tracker.getSessionCost('session-1')
      expect(cost!.inputTokens).toBe(300)
      expect(cost!.outputTokens).toBe(150)
      expect(cost!.totalTokens).toBe(450)
    })
  })

  describe('getSessionCost', () => {
    it('returns null for unknown session', () => {
      expect(tracker.getSessionCost('nonexistent')).toBeNull()
    })

    it('returns correct totals for recorded session', () => {
      tracker.recordUsage(
        makeUsage({
          sessionId: 'abc',
          inputTokens: 5000,
          outputTokens: 2000,
          totalTokens: 7000,
          estimatedCostUSD: estimateCost(5000, 2000),
        }),
      )
      const cost = tracker.getSessionCost('abc')
      expect(cost).not.toBeNull()
      expect(cost!.sessionId).toBe('abc')
      expect(cost!.totalTokens).toBe(7000)
      expect(cost!.estimatedCostUSD).toBeCloseTo(estimateCost(5000, 2000), 10)
    })
  })

  describe('getSummary', () => {
    it('returns empty summary with no data', () => {
      const summary = tracker.getSummary()
      expect(summary.sessionCount).toBe(0)
      expect(summary.totalTokens).toBe(0)
      expect(summary.estimatedTotalCostUSD).toBe(0)
      expect(summary.perSession).toHaveLength(0)
    })

    it('aggregates across multiple sessions', () => {
      tracker.recordUsage(
        makeUsage({
          sessionId: 's1',
          inputTokens: 1000,
          outputTokens: 500,
          totalTokens: 1500,
          estimatedCostUSD: estimateCost(1000, 500),
        }),
      )
      tracker.recordUsage(
        makeUsage({
          sessionId: 's2',
          inputTokens: 2000,
          outputTokens: 1000,
          totalTokens: 3000,
          estimatedCostUSD: estimateCost(2000, 1000),
        }),
      )

      const summary = tracker.getSummary()
      expect(summary.sessionCount).toBe(2)
      expect(summary.totalInputTokens).toBe(3000)
      expect(summary.totalOutputTokens).toBe(1500)
      expect(summary.totalTokens).toBe(4500)
      expect(summary.perSession).toHaveLength(2)
    })

    it('cost estimation math is correct in summary', () => {
      tracker.recordUsage(
        makeUsage({
          sessionId: 's1',
          inputTokens: 1_000_000,
          outputTokens: 0,
          totalTokens: 1_000_000,
          estimatedCostUSD: estimateCost(1_000_000, 0),
        }),
      )
      const summary = tracker.getSummary()
      expect(summary.estimatedTotalCostUSD).toBeCloseTo(3.0, 5)
    })
  })

  describe('reset', () => {
    it('clears all data', () => {
      tracker.recordUsage(makeUsage({ sessionId: 's1' }))
      tracker.recordUsage(makeUsage({ sessionId: 's2' }))
      tracker.reset()

      expect(tracker.getSessionCost('s1')).toBeNull()
      expect(tracker.getSessionCost('s2')).toBeNull()
      const summary = tracker.getSummary()
      expect(summary.sessionCount).toBe(0)
    })
  })
})
