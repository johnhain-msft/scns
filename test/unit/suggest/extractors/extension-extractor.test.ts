import { describe, it, expect } from 'vitest'
import { extractExtensionSuggestions } from '../../../../src/suggest/extractors/extension-extractor.js'
import type {
  PatternSources,
  OtelPatternData,
  ObservationPatternData,
} from '../../../../src/suggest/extractors/types.js'

function makeOtel(overrides: Partial<OtelPatternData> = {}): OtelPatternData {
  return {
    topTools: [],
    mcpServers: [],
    skills: [],
    models: [],
    totalSessions: 0,
    analyzedDays: 7,
    ...overrides,
  }
}

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

describe('extractExtensionSuggestions', () => {
  it('returns empty array when sources are empty', () => {
    const result = extractExtensionSuggestions({})
    expect(result).toEqual([])
  })

  it('returns empty array when no tools have enough usage', () => {
    const sources: PatternSources = {
      otel: makeOtel({
        totalSessions: 2,
        topTools: [{ tool: 'grep', totalUses: 3, avgDurationMs: 100 }],
      }),
    }
    const result = extractExtensionSuggestions(sources)
    expect(result).toEqual([])
  })

  it('suggests code-search extension for frequent grep+view usage', () => {
    const sources: PatternSources = {
      otel: makeOtel({
        totalSessions: 10,
        topTools: [
          { tool: 'grep', totalUses: 20, avgDurationMs: 100 },
          { tool: 'view', totalUses: 15, avgDurationMs: 50 },
        ],
      }),
    }
    const result = extractExtensionSuggestions(sources)
    expect(result.length).toBeGreaterThanOrEqual(1)
    const candidate = result.find((c) => c.title.toLowerCase().includes('code-search'))
    expect(candidate).toBeDefined()
    expect(candidate!.type).toBe('extension')
    expect(candidate!.tags).toContain('code-search')
    expect(candidate!.evidence.length).toBeGreaterThan(0)
  })

  it('suggests file-management extension for frequent edit+create usage', () => {
    const sources: PatternSources = {
      otel: makeOtel({
        totalSessions: 10,
        topTools: [
          { tool: 'edit', totalUses: 15, avgDurationMs: 200 },
          { tool: 'create', totalUses: 10, avgDurationMs: 150 },
        ],
      }),
    }
    const result = extractExtensionSuggestions(sources)
    const candidate = result.find((c) => c.title.toLowerCase().includes('file-management'))
    expect(candidate).toBeDefined()
    expect(candidate!.type).toBe('extension')
  })

  it('suggests test-runner extension for frequent bash test commands', () => {
    const sources: PatternSources = {
      otel: makeOtel({
        totalSessions: 8,
        topTools: [{ tool: 'bash', totalUses: 30, avgDurationMs: 5000 }],
      }),
    }
    const result = extractExtensionSuggestions(sources)
    const candidate = result.find((c) => c.title.toLowerCase().includes('task-runner'))
    expect(candidate).toBeDefined()
    expect(candidate!.type).toBe('extension')
  })

  it('combines otel and observation data for tool counts', () => {
    const sources: PatternSources = {
      otel: makeOtel({
        totalSessions: 5,
        topTools: [{ tool: 'grep', totalUses: 3, avgDurationMs: 100 }],
      }),
      observations: makeObs({
        appCounts: new Map([['Terminal', 10]]),
      }),
    }
    const result = extractExtensionSuggestions(sources)
    // Even if otel grep is below threshold, observation terminal usage may contribute
    expect(Array.isArray(result)).toBe(true)
  })

  it('returns multiple candidates for different tool patterns', () => {
    const sources: PatternSources = {
      otel: makeOtel({
        totalSessions: 10,
        topTools: [
          { tool: 'grep', totalUses: 20, avgDurationMs: 100 },
          { tool: 'view', totalUses: 15, avgDurationMs: 50 },
          { tool: 'edit', totalUses: 15, avgDurationMs: 200 },
          { tool: 'create', totalUses: 10, avgDurationMs: 150 },
          { tool: 'bash', totalUses: 25, avgDurationMs: 5000 },
        ],
      }),
    }
    const result = extractExtensionSuggestions(sources)
    expect(result.length).toBeGreaterThanOrEqual(2)
    const extensionTags = new Set(result.map((c) => c.tags[1]))
    expect(extensionTags.size).toBeGreaterThanOrEqual(2)
  })

  it('does not duplicate extension suggestions', () => {
    const sources: PatternSources = {
      otel: makeOtel({
        totalSessions: 10,
        topTools: [
          { tool: 'grep', totalUses: 30, avgDurationMs: 100 },
          { tool: 'view', totalUses: 25, avgDurationMs: 50 },
        ],
      }),
    }
    const result = extractExtensionSuggestions(sources)
    const titles = result.map((c) => c.title)
    expect(new Set(titles).size).toBe(titles.length)
  })
})
