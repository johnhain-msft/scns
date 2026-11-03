import { describe, it, expect } from 'vitest'
import { extractGithubActionSuggestions } from '../../../../src/suggest/extractors/github-action-extractor.js'
import type {
  PatternSources,
  ObservationPatternData,
} from '../../../../src/suggest/extractors/types.js'

function makeObs(overrides: Partial<ObservationPatternData> = {}): ObservationPatternData {
  return {
    topApps: [],
    appCounts: new Map(),
    topRepos: [],
    repoCounts: new Map(),
    fileTypeCounts: new Map(),
    recentFocus: null,
    ...overrides,
  }
}

describe('extractGithubActionSuggestions', () => {
  it('returns empty array when sources are empty', () => {
    const result = extractGithubActionSuggestions({})
    expect(result).toEqual([])
  })

  it('returns empty array when observations are missing', () => {
    const result = extractGithubActionSuggestions({ otel: undefined })
    expect(result).toEqual([])
  })

  it('returns empty array when commit counts are below threshold (< 5)', () => {
    const sources: PatternSources = {
      observations: makeObs({
        topRepos: ['repo-a'],
        repoCounts: new Map([['repo-a', 3]]),
      }),
    }
    const result = extractGithubActionSuggestions(sources)
    expect(result).toEqual([])
  })

  it('suggests CI/CD workflow for high commit frequency repo', () => {
    const sources: PatternSources = {
      observations: makeObs({
        topRepos: ['my-app'],
        repoCounts: new Map([['my-app', 15]]),
      }),
    }
    const result = extractGithubActionSuggestions(sources)
    expect(result.length).toBeGreaterThanOrEqual(1)
    const candidate = result.find((c) => c.title.toLowerCase().includes('my-app'))
    expect(candidate).toBeDefined()
    expect(candidate!.type).toBe('github-action')
    expect(candidate!.tags).toContain('ci-cd')
    expect(candidate!.evidence.length).toBeGreaterThan(0)
    expect(candidate!.evidence[0]!.source).toBe('observation-project-focus')
  })

  it('suggests lint/test action when file type patterns detected', () => {
    const sources: PatternSources = {
      observations: makeObs({
        topRepos: ['ts-project'],
        repoCounts: new Map([['ts-project', 10]]),
        fileTypeCounts: new Map([
          ['.ts', 20],
          ['.test.ts', 8],
        ]),
      }),
    }
    const result = extractGithubActionSuggestions(sources)
    expect(result.length).toBeGreaterThanOrEqual(1)
    const ciCandidate = result.find(
      (c) => c.title.toLowerCase().includes('ci') || c.title.toLowerCase().includes('test'),
    )
    expect(ciCandidate).toBeDefined()
    expect(ciCandidate!.type).toBe('github-action')
  })

  it('returns multiple candidates for multiple active repos', () => {
    const sources: PatternSources = {
      observations: makeObs({
        topRepos: ['repo-a', 'repo-b', 'repo-c'],
        repoCounts: new Map([
          ['repo-a', 10],
          ['repo-b', 8],
          ['repo-c', 6],
        ]),
      }),
    }
    const result = extractGithubActionSuggestions(sources)
    expect(result.length).toBeGreaterThanOrEqual(3)
    const repos = result.map((c) => c.title)
    expect(repos.some((t) => t.includes('repo-a'))).toBe(true)
    expect(repos.some((t) => t.includes('repo-b'))).toBe(true)
    expect(repos.some((t) => t.includes('repo-c'))).toBe(true)
  })

  it('does not duplicate suggestions for the same repo', () => {
    const sources: PatternSources = {
      observations: makeObs({
        topRepos: ['my-app'],
        repoCounts: new Map([['my-app', 20]]),
      }),
    }
    const result = extractGithubActionSuggestions(sources)
    const titles = result.map((c) => c.title)
    const uniqueTitles = new Set(titles)
    expect(uniqueTitles.size).toBe(titles.length)
  })

  it('includes recent focus in evidence when matching', () => {
    const sources: PatternSources = {
      observations: makeObs({
        topRepos: ['main-project'],
        repoCounts: new Map([['main-project', 12]]),
        recentFocus: 'main-project',
      }),
    }
    const result = extractGithubActionSuggestions(sources)
    expect(result.length).toBeGreaterThanOrEqual(1)
    const candidate = result[0]!
    const focusEvidence = candidate.evidence.find((e) => e.detail.includes('recent focus'))
    expect(focusEvidence).toBeDefined()
  })
})
