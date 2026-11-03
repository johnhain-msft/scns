import { describe, it, expect } from 'vitest'
import { createConfidenceScorer, type ConfidenceInput } from '../../../src/suggest/confidence.js'

describe('createConfidenceScorer', () => {
  const scorer = createConfidenceScorer()

  // ── Frequency scoring ────────────────────────────────────────────

  describe('scoreFrequency', () => {
    it('returns near 1.0 for high observation count', () => {
      // 30 observations in 10 days = 3/day = 3× minimum → 1.0
      expect(scorer.scoreFrequency(30, 10)).toBeCloseTo(1.0, 1)
    })

    it('returns near 0.0 for very low observation count', () => {
      // 1 observation in 100 days = 0.01/day
      const score = scorer.scoreFrequency(1, 100)
      expect(score).toBeLessThan(0.1)
      expect(score).toBeGreaterThanOrEqual(0)
    })

    it('returns 0.5 when exactly at minimumPerDay', () => {
      // 10 observations in 10 days = exactly 1/day (default min)
      expect(scorer.scoreFrequency(10, 10)).toBeCloseTo(0.5, 1)
    })

    it('returns 0.0 for zero observations', () => {
      expect(scorer.scoreFrequency(0, 10)).toBe(0)
    })

    it('returns 1.0 for 3× minimum per day', () => {
      // 30 obs in 10 days, min=1 → raw=3 → ≥3×min → 1.0
      expect(scorer.scoreFrequency(30, 10, 1)).toBe(1.0)
    })

    it('uses custom minimumPerDay', () => {
      // 20 obs in 10 days = 2/day, minimum = 5 → below minimum
      const score = scorer.scoreFrequency(20, 10, 5)
      expect(score).toBeLessThan(0.5)
      expect(score).toBeGreaterThan(0)
    })

    it('handles windowDays of 1', () => {
      const score = scorer.scoreFrequency(5, 1)
      expect(score).toBeGreaterThanOrEqual(0)
      expect(score).toBeLessThanOrEqual(1)
    })
  })

  // ── Consistency scoring ──────────────────────────────────────────

  describe('scoreConsistency', () => {
    it('returns very high score for identical daily counts', () => {
      // CV = 0 → score = 1.0
      const score = scorer.scoreConsistency([5, 5, 5, 5, 5])
      expect(score).toBeGreaterThanOrEqual(0.9)
    })

    it('returns low score for highly variable counts', () => {
      // e.g. [0, 0, 0, 0, 50] → very high CV
      const score = scorer.scoreConsistency([0, 0, 0, 0, 50])
      expect(score).toBeLessThan(0.5)
    })

    it('returns 0.5 when no dailyCounts provided', () => {
      expect(scorer.scoreConsistency([])).toBe(0.5)
    })

    it('returns 0.5 for single day', () => {
      expect(scorer.scoreConsistency([10])).toBe(0.5)
    })

    it('returns low consistency when all zeros except one', () => {
      const score = scorer.scoreConsistency([0, 0, 0, 0, 0, 0, 10])
      expect(score).toBeLessThan(0.4)
    })

    it('returns moderate consistency for gradually increasing counts', () => {
      // [1, 2, 3, 4, 5] → moderate CV
      const score = scorer.scoreConsistency([1, 2, 3, 4, 5])
      expect(score).toBeGreaterThan(0.4)
      expect(score).toBeLessThan(0.9)
    })
  })

  // ── Impact scoring ───────────────────────────────────────────────

  describe('scoreImpact', () => {
    it('returns 0.7 for skill type', () => {
      expect(scorer.scoreImpact('skill')).toBeCloseTo(0.7, 2)
    })

    it('returns 0.8 for agent type', () => {
      expect(scorer.scoreImpact('agent')).toBeCloseTo(0.8, 2)
    })

    it('returns 0.6 for mcp type', () => {
      expect(scorer.scoreImpact('mcp')).toBeCloseTo(0.6, 2)
    })

    it('returns 0.9 for automation type', () => {
      expect(scorer.scoreImpact('automation')).toBeCloseTo(0.9, 2)
    })

    it('returns 0.5 for workflow type', () => {
      expect(scorer.scoreImpact('workflow')).toBeCloseTo(0.5, 2)
    })

    it('returns 0.5 for unknown type', () => {
      expect(scorer.scoreImpact('unknown-type')).toBeCloseTo(0.5, 2)
    })

    it('returns 0.6 for prompt type', () => {
      expect(scorer.scoreImpact('prompt')).toBeCloseTo(0.6, 2)
    })

    it('returns 0.7 for extension type', () => {
      expect(scorer.scoreImpact('extension')).toBeCloseTo(0.7, 2)
    })

    it('returns 0.5 for lsp type', () => {
      expect(scorer.scoreImpact('lsp')).toBeCloseTo(0.5, 2)
    })

    it('returns 0.8 for github-action type', () => {
      expect(scorer.scoreImpact('github-action')).toBeCloseTo(0.8, 2)
    })

    it('returns 0.85 for agentic-workflow type', () => {
      expect(scorer.scoreImpact('agentic-workflow')).toBeCloseTo(0.85, 2)
    })

    it('returns 0.55 for instruction type', () => {
      expect(scorer.scoreImpact('instruction')).toBeCloseTo(0.55, 2)
    })

    it('adjusts score up when metadata contains timesSaved', () => {
      const base = scorer.scoreImpact('skill')
      const boosted = scorer.scoreImpact('skill', { timesSaved: 100 })
      expect(boosted).toBeGreaterThan(base)
      expect(boosted).toBeLessThanOrEqual(1.0)
    })
  })

  // ── Composite scoring ────────────────────────────────────────────

  describe('score (composite)', () => {
    it('returns high composite when all scores are high', () => {
      const input: ConfidenceInput = {
        type: 'automation',
        observationCount: 100,
        windowDays: 10,
        dailyCounts: [10, 10, 10, 10, 10, 10, 10, 10, 10, 10],
      }
      const result = scorer.score(input)
      expect(result.composite).toBeGreaterThan(0.8)
      expect(result.frequency).toBeGreaterThan(0.8)
      expect(result.consistency).toBeGreaterThan(0.8)
      expect(result.impact).toBeGreaterThanOrEqual(0.9)
    })

    it('returns weighted average for mixed scores', () => {
      const input: ConfidenceInput = {
        type: 'workflow', // impact 0.5
        observationCount: 10,
        windowDays: 10, // freq at minimum → ~0.5
        dailyCounts: [10, 10, 10, 10, 10, 10, 10, 10, 10, 10],
      }
      const result = scorer.score(input)
      // composite is a weighted mix
      expect(result.composite).toBeGreaterThan(0.3)
      expect(result.composite).toBeLessThan(0.9)
    })

    it('applies custom weights correctly', () => {
      const custom = createConfidenceScorer({
        frequencyWeight: 1.0,
        consistencyWeight: 0,
        impactWeight: 0,
      })
      const input: ConfidenceInput = {
        type: 'skill',
        observationCount: 30,
        windowDays: 10,
      }
      const result = custom.score(input)
      // composite should match frequency since other weights are 0
      expect(result.composite).toBeCloseTo(result.frequency, 2)
    })

    it('normalises when weights do not sum to 1', () => {
      const custom = createConfidenceScorer({
        frequencyWeight: 2,
        consistencyWeight: 2,
        impactWeight: 2,
      })
      const input: ConfidenceInput = {
        type: 'automation',
        observationCount: 100,
        windowDays: 10,
        dailyCounts: [10, 10, 10, 10, 10, 10, 10, 10, 10, 10],
      }
      const result = custom.score(input)
      expect(result.composite).toBeGreaterThanOrEqual(0)
      expect(result.composite).toBeLessThanOrEqual(1)
    })

    it('clamps composite to [0, 1]', () => {
      const input: ConfidenceInput = {
        type: 'automation',
        observationCount: 1000,
        windowDays: 1,
        dailyCounts: [1000],
      }
      const result = scorer.score(input)
      expect(result.composite).toBeLessThanOrEqual(1)
      expect(result.composite).toBeGreaterThanOrEqual(0)
    })

    it('all scores are between 0 and 1', () => {
      const input: ConfidenceInput = {
        type: 'mcp',
        observationCount: 5,
        windowDays: 30,
        dailyCounts: [
          0, 0, 1, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        ],
      }
      const result = scorer.score(input)
      for (const key of ['frequency', 'consistency', 'impact', 'composite'] as const) {
        expect(result[key]).toBeGreaterThanOrEqual(0)
        expect(result[key]).toBeLessThanOrEqual(1)
      }
    })
  })
})
