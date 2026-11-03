import { describe, it, expect } from 'vitest'
import {
  calculateQualityScore,
  applyCompactionPenalty,
  applyErrorPenalty,
  createInitialQualityState,
} from '../../../src/context/quality-decay.js'

describe('quality-decay', () => {
  const baseTime = '2025-01-01T00:00:00.000Z'

  describe('createInitialQualityState', () => {
    it('creates state with quality 100 and zero penalties', () => {
      const state = createInitialQualityState('sess-1')
      expect(state.sessionId).toBe('sess-1')
      expect(state.initialQuality).toBe(100)
      expect(state.compactionPenalty).toBe(0)
      expect(state.errorPenalty).toBe(0)
    })

    it('sets startedAt and lastActivityAt to current time', () => {
      const before = new Date().toISOString()
      const state = createInitialQualityState('sess-2')
      const after = new Date().toISOString()
      expect(state.startedAt >= before).toBe(true)
      expect(state.startedAt <= after).toBe(true)
      expect(state.lastActivityAt).toBe(state.startedAt)
    })
  })

  describe('calculateQualityScore', () => {
    it('returns 100 for brand-new session with no elapsed time', () => {
      const now = new Date(baseTime)
      const state = createQualityState({ startedAt: baseTime })
      expect(calculateQualityScore(state, 2, now)).toBe(100)
    })

    it('decays over time at the configured rate', () => {
      const state = createQualityState({ startedAt: baseTime })
      // 1 hour later with 2% decay rate → 100 - 2 = 98
      const oneHourLater = new Date('2025-01-01T01:00:00.000Z')
      expect(calculateQualityScore(state, 2, oneHourLater)).toBe(98)
    })

    it('decays proportionally for partial hours', () => {
      const state = createQualityState({ startedAt: baseTime })
      // 30 min later with 2% rate → 100 - 1 = 99
      const thirtyMinLater = new Date('2025-01-01T00:30:00.000Z')
      expect(calculateQualityScore(state, 2, thirtyMinLater)).toBe(99)
    })

    it('floors at 0', () => {
      const state = createQualityState({ startedAt: baseTime })
      // 100 hours later with 2% rate → 100 - 200 → floor at 0
      const farFuture = new Date('2025-01-05T04:00:00.000Z')
      expect(calculateQualityScore(state, 2, farFuture)).toBe(0)
    })

    it('accounts for compaction penalty', () => {
      const state = createQualityState({ startedAt: baseTime, compactionPenalty: 15 })
      const now = new Date(baseTime)
      expect(calculateQualityScore(state, 2, now)).toBe(85)
    })

    it('accounts for error penalty', () => {
      const state = createQualityState({ startedAt: baseTime, errorPenalty: 10 })
      const now = new Date(baseTime)
      expect(calculateQualityScore(state, 2, now)).toBe(90)
    })

    it('stacks all penalties together', () => {
      const state = createQualityState({
        startedAt: baseTime,
        compactionPenalty: 10,
        errorPenalty: 6,
      })
      // 2 hours later: 100 - 4 (time) - 10 (compaction) - 6 (error) = 80
      const twoHoursLater = new Date('2025-01-01T02:00:00.000Z')
      expect(calculateQualityScore(state, 2, twoHoursLater)).toBe(80)
    })

    it('supports custom decay rates', () => {
      const state = createQualityState({ startedAt: baseTime })
      const oneHourLater = new Date('2025-01-01T01:00:00.000Z')
      // 10% per hour → 100 - 10 = 90
      expect(calculateQualityScore(state, 10, oneHourLater)).toBe(90)
    })

    it('caps at 100 (no score above initial quality)', () => {
      const state = createQualityState({ startedAt: baseTime, initialQuality: 100 })
      const now = new Date(baseTime)
      expect(calculateQualityScore(state, 2, now)).toBeLessThanOrEqual(100)
    })
  })

  describe('applyCompactionPenalty', () => {
    it('applies default 5-point penalty', () => {
      const state = createQualityState({ compactionPenalty: 0 })
      const updated = applyCompactionPenalty(state)
      expect(updated.compactionPenalty).toBe(5)
    })

    it('applies custom penalty', () => {
      const state = createQualityState({ compactionPenalty: 0 })
      const updated = applyCompactionPenalty(state, 8)
      expect(updated.compactionPenalty).toBe(8)
    })

    it('stacks penalties with repeated calls', () => {
      const state = createQualityState({ compactionPenalty: 5 })
      const updated = applyCompactionPenalty(state)
      expect(updated.compactionPenalty).toBe(10)
    })

    it('returns a new object (immutable)', () => {
      const state = createQualityState({ compactionPenalty: 0 })
      const updated = applyCompactionPenalty(state)
      expect(updated).not.toBe(state)
      expect(state.compactionPenalty).toBe(0)
    })
  })

  describe('applyErrorPenalty', () => {
    it('applies default 2-point penalty', () => {
      const state = createQualityState({ errorPenalty: 0 })
      const updated = applyErrorPenalty(state)
      expect(updated.errorPenalty).toBe(2)
    })

    it('applies custom penalty', () => {
      const state = createQualityState({ errorPenalty: 0 })
      const updated = applyErrorPenalty(state, 4)
      expect(updated.errorPenalty).toBe(4)
    })

    it('stacks penalties with repeated calls', () => {
      const state = createQualityState({ errorPenalty: 2 })
      const updated = applyErrorPenalty(state)
      expect(updated.errorPenalty).toBe(4)
    })
  })
})

// ── Helper ──────────────────────────────────────────────────────────────────

function createQualityState(
  overrides: Partial<{
    sessionId: string
    startedAt: string
    lastActivityAt: string
    initialQuality: number
    compactionPenalty: number
    errorPenalty: number
  }> = {},
) {
  const startedAt = overrides.startedAt ?? new Date().toISOString()
  return {
    sessionId: overrides.sessionId ?? 'test-sess',
    startedAt,
    lastActivityAt: overrides.lastActivityAt ?? startedAt,
    initialQuality: overrides.initialQuality ?? 100,
    compactionPenalty: overrides.compactionPenalty ?? 0,
    errorPenalty: overrides.errorPenalty ?? 0,
  }
}
