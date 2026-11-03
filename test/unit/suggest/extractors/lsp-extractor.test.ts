import { describe, it, expect } from 'vitest'
import { extractLspSuggestions } from '../../../../src/suggest/extractors/lsp-extractor.js'
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

describe('extractLspSuggestions', () => {
  it('returns empty array when sources are empty', () => {
    const result = extractLspSuggestions({})
    expect(result).toEqual([])
  })

  it('returns empty array when observations are missing', () => {
    const result = extractLspSuggestions({ otel: undefined })
    expect(result).toEqual([])
  })

  it('returns empty array when file type counts are below threshold (< 10)', () => {
    const sources: PatternSources = {
      observations: makeObs({
        fileTypeCounts: new Map([
          ['.ts', 5],
          ['.js', 3],
        ]),
      }),
    }
    const result = extractLspSuggestions(sources)
    expect(result).toEqual([])
  })

  it('suggests TypeScript LSP config for heavy .ts usage', () => {
    const sources: PatternSources = {
      observations: makeObs({
        fileTypeCounts: new Map([
          ['.ts', 60],
          ['.tsx', 20],
        ]),
      }),
    }
    const result = extractLspSuggestions(sources)
    expect(result.length).toBeGreaterThanOrEqual(1)
    const candidate = result.find(
      (c) => c.title.toLowerCase().includes('typescript') || c.title.toLowerCase().includes('.ts'),
    )
    expect(candidate).toBeDefined()
    expect(candidate!.type).toBe('lsp')
    expect(candidate!.tags).toContain('typescript')
    expect(candidate!.evidence.length).toBeGreaterThan(0)
    expect(candidate!.evidence[0]!.source).toBe('observation-file-types')
  })

  it('suggests Python LSP config for heavy .py usage', () => {
    const sources: PatternSources = {
      observations: makeObs({
        fileTypeCounts: new Map([['.py', 60]]),
      }),
    }
    const result = extractLspSuggestions(sources)
    const candidate = result.find((c) => c.title.toLowerCase().includes('python'))
    expect(candidate).toBeDefined()
    expect(candidate!.type).toBe('lsp')
    expect(candidate!.tags).toContain('python')
  })

  it('suggests Rust LSP config for heavy .rs usage', () => {
    const sources: PatternSources = {
      observations: makeObs({
        fileTypeCounts: new Map([['.rs', 55]]),
      }),
    }
    const result = extractLspSuggestions(sources)
    const candidate = result.find((c) => c.title.toLowerCase().includes('rust'))
    expect(candidate).toBeDefined()
    expect(candidate!.type).toBe('lsp')
    expect(candidate!.tags).toContain('rust')
  })

  it('suggests Go LSP config for heavy .go usage', () => {
    const sources: PatternSources = {
      observations: makeObs({
        fileTypeCounts: new Map([['.go', 55]]),
      }),
    }
    const result = extractLspSuggestions(sources)
    const candidate = result.find((c) => c.title.toLowerCase().includes('go'))
    expect(candidate).toBeDefined()
    expect(candidate!.type).toBe('lsp')
  })

  it('returns multiple candidates for multiple qualifying languages', () => {
    const sources: PatternSources = {
      observations: makeObs({
        fileTypeCounts: new Map([
          ['.ts', 60],
          ['.py', 55],
          ['.go', 52],
        ]),
      }),
    }
    const result = extractLspSuggestions(sources)
    expect(result.length).toBeGreaterThanOrEqual(3)
    const types = result.map((c) => c.type)
    expect(types.every((t) => t === 'lsp')).toBe(true)
  })

  it('does not duplicate suggestions for related extensions (.ts and .tsx)', () => {
    const sources: PatternSources = {
      observations: makeObs({
        fileTypeCounts: new Map([
          ['.ts', 40],
          ['.tsx', 20],
        ]),
      }),
    }
    const result = extractLspSuggestions(sources)
    const tsCandidates = result.filter((c) => c.tags.includes('typescript'))
    expect(tsCandidates.length).toBe(1)
  })

  it('includes project focus in evidence when available', () => {
    const sources: PatternSources = {
      observations: makeObs({
        fileTypeCounts: new Map([['.ts', 60]]),
        recentFocus: 'my-project',
      }),
    }
    const result = extractLspSuggestions(sources)
    expect(result.length).toBeGreaterThanOrEqual(1)
    const candidate = result[0]!
    const focusEvidence = candidate.evidence.find((e) => e.detail.includes('my-project'))
    expect(focusEvidence).toBeDefined()
  })
})
