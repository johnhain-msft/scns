/**
 * D1c — memory-derived open gaps. Proves gaps are DERIVED from real corpus signals
 * (recurring negmem themes ≥ minThemeSize, failed outcomes) not a fixed seed; that
 * suppressed/low-confidence/pinned filtering matches the applicator; that gaps cite
 * counts (evidence-first), seeds stay a base, output dedups + caps, and it's pure.
 */
import { describe, it, expect } from 'vitest'
import { deriveOpenGaps } from '../../../src/ideate/open-gaps.js'
import type { NegMemThemeInput } from '../../../src/ideate/open-gaps.js'

const SEEDS = [{ source: 'github-issue-5', detail: 'auto-merger refuses dirty tree' }]

function mem(over: Partial<NegMemThemeInput> = {}): NegMemThemeInput {
  return { dontRule: 'never claim done without tests', category: 'verification', confidence: 0.9, ...over }
}

describe('deriveOpenGaps', () => {
  it('clusters a recurring negmem category into one evidence-cited theme gap', () => {
    const gaps = deriveOpenGaps({
      negativeMemories: [mem(), mem({ dontRule: 'verify output' }), mem({ dontRule: 'run the suite' })],
      failed: [],
      seeds: SEEDS,
    })
    const theme = gaps.find((g) => g.source === 'negmem-theme:verification')
    expect(theme).toBeDefined()
    expect(theme!.detail).toContain('×3')
    // highest-confidence rule represents the theme
    expect(theme!.detail).toMatch(/never claim done without tests/)
  })

  it('does NOT emit a theme below minThemeSize but keeps the seeds', () => {
    const gaps = deriveOpenGaps({ negativeMemories: [mem()], failed: [], seeds: SEEDS })
    expect(gaps.some((g) => g.source.startsWith('negmem-theme'))).toBe(false)
    expect(gaps.some((g) => g.source === 'github-issue-5')).toBe(true)
  })

  it('drops suppressed + low-confidence memories, but pinned bypass both', () => {
    const gaps = deriveOpenGaps({
      negativeMemories: [
        mem({ criticStatus: 'suppress' }),
        mem({ criticStatus: 'suppress' }),
        mem({ confidence: 0.1, category: 'noise' }),
        mem({ confidence: 0.1, category: 'noise' }),
        mem({ pinned: true, confidence: 0.0, category: 'pinned' }),
        mem({ pinned: true, confidence: 0.0, category: 'pinned' }),
      ],
      failed: [],
      seeds: SEEDS,
      minConfidence: 0.6,
    })
    expect(gaps.some((g) => g.source === 'negmem-theme:verification')).toBe(false)
    expect(gaps.some((g) => g.source === 'negmem-theme:noise')).toBe(false)
    expect(gaps.some((g) => g.source === 'negmem-theme:pinned')).toBe(true)
  })

  it('turns failed outcomes into gaps and dedups against the seeds, capping at max', () => {
    const gaps = deriveOpenGaps({
      negativeMemories: [],
      failed: ['ship D2 feedback loop', 'ship D2 feedback loop'],
      seeds: SEEDS,
      max: 2,
    })
    expect(gaps).toHaveLength(2)
    expect(gaps[0]!.source).toBe('failed-outcome')
    expect(gaps.filter((g) => g.source === 'failed-outcome')).toHaveLength(1) // family dedup
  })

  it('is deterministic — same input → identical gaps', () => {
    const input = { negativeMemories: [mem(), mem()], failed: ['x'], seeds: SEEDS } as const
    expect(deriveOpenGaps(input)).toEqual(deriveOpenGaps(input))
  })
})
