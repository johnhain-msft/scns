/**
 * Gap 4 (prong b) — self-improvement extractor.
 *
 * When the user is actively developing the SCNS repo itself, propose
 * actionable improvements to SCNS's own agents/flows/prompts (typed
 * `agentic-workflow` so the delivery loop can pick them up) — aiming
 * SCNS's autonomous improvement at ITSELF.
 */
import { describe, it, expect } from 'vitest'
import {
  extractSelfImprovementSuggestions,
  SCNS_SELF_IMPROVEMENT_SEEDS,
} from '../../../../src/suggest/extractors/self-improvement-extractor.js'
import type { PatternSources, ObservationPatternData } from '../../../../src/suggest/extractors/types.js'

function obs(partial: Partial<ObservationPatternData>): PatternSources {
  return {
    observations: {
      topApps: [],
      appCounts: new Map(),
      topRepos: [],
      repoCounts: new Map(),
      fileTypeCounts: new Map(),
      recentFocus: null,
      ...partial,
    },
  }
}

describe('extractSelfImprovementSuggestions', () => {
  it('emits the seed catalog when the SCNS repo is under active development', () => {
    const out = extractSelfImprovementSuggestions(
      obs({ topRepos: ['scns'], repoCounts: new Map([['scns', 12]]), recentFocus: 'scns' }),
    )
    expect(out.length).toBe(SCNS_SELF_IMPROVEMENT_SEEDS.length)
    expect(out.length).toBeGreaterThan(0)
    for (const c of out) {
      expect(c.type).toBe('agentic-workflow') // actionable in actionableShape
      expect(c.tags).toContain('self-improvement')
      expect(c.tags).toContain('scns-self-improvement')
      expect(c.evidence.length).toBeGreaterThan(0)
    }
    // Distinct titles (one per seed).
    expect(new Set(out.map((c) => c.title)).size).toBe(out.length)
  })

  it('matches an scns-suffixed repo path (e.g. johnhain-msft/scns)', () => {
    const out = extractSelfImprovementSuggestions(
      obs({ topRepos: ['johnhain-msft/scns'], repoCounts: new Map([['johnhain-msft/scns', 9]]) }),
    )
    expect(out.length).toBe(SCNS_SELF_IMPROVEMENT_SEEDS.length)
  })

  it('returns nothing when there are no observations', () => {
    expect(extractSelfImprovementSuggestions({}).length).toBe(0)
  })

  it('returns nothing when no SCNS repo is in the active set', () => {
    const out = extractSelfImprovementSuggestions(
      obs({ topRepos: ['some-other-app'], repoCounts: new Map([['some-other-app', 30]]) }),
    )
    expect(out.length).toBe(0)
  })

  it('returns nothing when SCNS activity is below the minimum-commits threshold', () => {
    const out = extractSelfImprovementSuggestions(
      obs({ topRepos: ['scns'], repoCounts: new Map([['scns', 1]]) }),
    )
    expect(out.length).toBe(0)
  })

  // ── Broadened activation: real-time file-change dev activity (not just commits) ──

  it('activates on SCNS file-change dev activity even with zero fresh commits', () => {
    // No git commits (commit freeze) but the repo is being actively edited.
    const out = extractSelfImprovementSuggestions(
      obs({
        topRepos: [],
        repoCounts: new Map(),
        repoActivityCounts: new Map([['scns', 12]]),
      }),
    )
    expect(out.length).toBe(SCNS_SELF_IMPROVEMENT_SEEDS.length)
    for (const c of out) {
      expect(c.tags).toContain('self-improvement')
      expect(c.evidence.length).toBeGreaterThan(0)
    }
  })

  it('does not activate when SCNS dev activity is below the activity threshold', () => {
    const out = extractSelfImprovementSuggestions(
      obs({ repoActivityCounts: new Map([['scns', 2]]) }),
    )
    expect(out.length).toBe(0)
  })

  it('activates via file activity even when git commits are below the commit minimum', () => {
    const out = extractSelfImprovementSuggestions(
      obs({
        topRepos: ['scns'],
        repoCounts: new Map([['scns', 1]]), // below MIN_SCNS_COMMITS
        repoActivityCounts: new Map([['scns', 20]]), // well above the activity minimum
      }),
    )
    expect(out.length).toBe(SCNS_SELF_IMPROVEMENT_SEEDS.length)
  })

  it('does not activate from non-SCNS file activity', () => {
    const out = extractSelfImprovementSuggestions(
      obs({ repoActivityCounts: new Map([['some-other-app', 99]]) }),
    )
    expect(out.length).toBe(0)
  })

  it('is backward-compatible when repoActivityCounts is absent (git path only)', () => {
    const out = extractSelfImprovementSuggestions(
      obs({ topRepos: ['scns'], repoCounts: new Map([['scns', 5]]) }),
    )
    expect(out.length).toBe(SCNS_SELF_IMPROVEMENT_SEEDS.length)
  })
})
