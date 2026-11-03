/**
 * Unit tests for the heuristic prefilter of the negative-memory critic.
 */

import { describe, it, expect } from 'vitest'
import {
  judgeMemoryHeuristic,
  judgeMemoriesHeuristic,
  normalizeRuleTemplate,
} from '../../../src/memory/negative-memory-critic-heuristics.js'
import type { NegativeMemory } from '../../../src/memory/negative-memory-types.js'

function mkMemory(overrides: Partial<NegativeMemory> & { dontRule: string }): NegativeMemory {
  return {
    id: overrides.id ?? Math.random().toString(36).slice(2),
    originalText: overrides.originalText ?? overrides.dontRule,
    dontRule: overrides.dontRule,
    category: overrides.category ?? 'frustration',
    recommendedTarget: overrides.recommendedTarget ?? 'general',
    confidence: overrides.confidence ?? 0.8,
    sessionId: overrides.sessionId ?? null,
    source: overrides.source ?? 'heuristic',
    targetApplied: overrides.targetApplied ?? false,
    appliedTo: overrides.appliedTo ?? null,
    createdAt: overrides.createdAt ?? '2026-01-01T00:00:00.000Z',
    ...(overrides.pinned !== undefined ? { pinned: overrides.pinned } : {}),
    ...(overrides.criticVerdict !== undefined ? { criticVerdict: overrides.criticVerdict } : {}),
  }
}

describe('negative-memory-critic-heuristics', () => {
  describe('pipeline-artifact suppression', () => {
    it('suppresses "Quality gate rejected" rules', () => {
      const m = mkMemory({
        dontRule:
          'Quality gate rejected team team-sugg-9872e17a: npm test failed; npm run lint failed',
      })
      const v = judgeMemoryHeuristic(m)
      expect(v.status).toBe('suppress')
      expect(v.rationale).toMatch(/quality-gate/i)
    })

    it('suppresses "no staged diff" rules', () => {
      const m = mkMemory({
        dontRule: 'Quality gate rejected team brain-solo: Team produced no staged diff',
      })
      expect(judgeMemoryHeuristic(m).status).toBe('suppress')
    })

    it('suppresses transient npm test/lint failures', () => {
      expect(judgeMemoryHeuristic(mkMemory({ dontRule: 'npm test failed' })).status).toBe(
        'suppress',
      )
      expect(
        judgeMemoryHeuristic(mkMemory({ dontRule: 'npm run lint failed in CI' })).status,
      ).toBe('suppress')
    })

    it('suppresses team archive churn', () => {
      const m = mkMemory({
        dontRule: 'team-sugg-76707c3d archived after 308s with no activity',
      })
      expect(judgeMemoryHeuristic(m).status).toBe('suppress')
    })
  })

  describe('system-message suppression', () => {
    it('suppresses INFO/WARN/ERROR log lines', () => {
      const m = mkMemory({ dontRule: '[ERROR] Something went wrong in handler' })
      expect(judgeMemoryHeuristic(m).status).toBe('suppress')
    })

    it('suppresses stack-trace text', () => {
      const m = mkMemory({
        dontRule: 'TypeError: Cannot read properties of undefined',
        originalText: 'TypeError: Cannot read properties of undefined\n    at foo (file.ts:1:1)',
      })
      expect(judgeMemoryHeuristic(m).status).toBe('suppress')
    })
  })

  describe('vague-rule suppression', () => {
    it('suppresses rules with too few words after id-stripping', () => {
      const m = mkMemory({ dontRule: 'stop doing this' })
      const v = judgeMemoryHeuristic(m)
      expect(v.status).toBe('suppress')
      expect(v.rationale).toMatch(/vague/i)
    })

    it('keeps rules with substantive content as undecided', () => {
      const m = mkMemory({
        dontRule:
          'Never fabricate evidence or claim to have performed verification steps that were not actually done',
      })
      expect(judgeMemoryHeuristic(m).status).toBe('undecided')
    })
  })

  describe('pinned bypass', () => {
    it('returns keep for pinned memories regardless of content', () => {
      const m = mkMemory({ dontRule: 'Quality gate rejected', pinned: true })
      expect(judgeMemoryHeuristic(m).status).toBe('keep')
    })
  })

  describe('normalizeRuleTemplate', () => {
    it('replaces UUIDs, team-ids, shas, dates with placeholders', () => {
      const a = normalizeRuleTemplate(
        'Quality gate rejected team team-sugg-9872e17a: npm test failed at 2026-04-21T10:11:12Z',
      )
      const b = normalizeRuleTemplate(
        'Quality gate rejected team team-sugg-71b0181f: npm test failed at 2026-04-22T11:12:13Z',
      )
      expect(a).toBe(b)
    })
  })

  describe('duplicate-template collapse', () => {
    it('marks all-but-first instances of the same template as suppress', () => {
      // Pick rules that aren't already suppressed by the artifact patterns
      const memories = [
        mkMemory({
          id: 'a',
          dontRule:
            'Always carefully verify the staged diff for team team-sugg-deadbeef before merge',
          createdAt: '2026-01-01T00:00:00.000Z',
        }),
        mkMemory({
          id: 'b',
          dontRule:
            'Always carefully verify the staged diff for team team-sugg-cafebabe before merge',
          createdAt: '2026-01-02T00:00:00.000Z',
        }),
        mkMemory({
          id: 'c',
          dontRule:
            'Always carefully verify the staged diff for team team-sugg-f00dface before merge',
          createdAt: '2026-01-03T00:00:00.000Z',
        }),
      ]
      const verdicts = judgeMemoriesHeuristic(memories)
      expect(verdicts.get('a')?.status).toBe('undecided')
      expect(verdicts.get('b')?.status).toBe('suppress')
      expect(verdicts.get('b')?.rationale).toMatch(/duplicate/)
      expect(verdicts.get('c')?.status).toBe('suppress')
    })
  })

  describe('empty rule', () => {
    it('suppresses empty dontRule', () => {
      const m = mkMemory({ dontRule: '' })
      expect(judgeMemoryHeuristic(m).status).toBe('suppress')
    })
  })
})
