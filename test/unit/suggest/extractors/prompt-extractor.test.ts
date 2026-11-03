import { describe, it, expect } from 'vitest'
import { extractPromptSuggestions } from '../../../../src/suggest/extractors/prompt-extractor.js'
import type { PatternSources, OtelPatternData } from '../../../../src/suggest/extractors/types.js'

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

describe('extractPromptSuggestions', () => {
  it('returns empty array when sources are empty', () => {
    const result = extractPromptSuggestions({})
    expect(result).toEqual([])
  })

  it('returns empty array when otel data is missing', () => {
    const result = extractPromptSuggestions({ observations: undefined })
    expect(result).toEqual([])
  })

  it('returns empty array when sessions below threshold (< 3)', () => {
    const sources: PatternSources = {
      otel: makeOtel({
        totalSessions: 2,
        models: [{ model: 'claude-sonnet-4', totalCalls: 10, sessionCount: 2 }],
      }),
    }
    const result = extractPromptSuggestions(sources)
    expect(result).toEqual([])
  })

  it('suggests system prompt optimization for consistent model usage', () => {
    const sources: PatternSources = {
      otel: makeOtel({
        totalSessions: 10,
        models: [
          { model: 'claude-sonnet-4', totalCalls: 50, sessionCount: 8 },
          { model: 'gpt-4', totalCalls: 5, sessionCount: 2 },
        ],
      }),
    }
    const result = extractPromptSuggestions(sources)
    expect(result.length).toBeGreaterThanOrEqual(1)
    const candidate = result.find((c) => c.title.includes('claude-sonnet-4'))
    expect(candidate).toBeDefined()
    expect(candidate!.type).toBe('prompt')
    expect(candidate!.tags).toContain('model')
    expect(candidate!.evidence.length).toBeGreaterThan(0)
    expect(candidate!.evidence[0]!.source).toBe('otel-model')
  })

  it('suggests instruction file entries for repeated tool patterns', () => {
    const sources: PatternSources = {
      otel: makeOtel({
        totalSessions: 5,
        topTools: [
          { tool: 'grep', totalUses: 30, avgDurationMs: 100 },
          { tool: 'view', totalUses: 25, avgDurationMs: 50 },
          { tool: 'edit', totalUses: 20, avgDurationMs: 200 },
        ],
      }),
    }
    const result = extractPromptSuggestions(sources)
    const toolCandidate = result.find((c) => c.title.toLowerCase().includes('instruction'))
    expect(toolCandidate).toBeDefined()
    expect(toolCandidate!.type).toBe('prompt')
    expect(toolCandidate!.tags).toContain('tools')
  })

  it('returns multiple candidates when both model and tool patterns qualify', () => {
    const sources: PatternSources = {
      otel: makeOtel({
        totalSessions: 10,
        models: [{ model: 'claude-sonnet-4', totalCalls: 50, sessionCount: 8 }],
        topTools: [
          { tool: 'grep', totalUses: 40, avgDurationMs: 100 },
          { tool: 'view', totalUses: 35, avgDurationMs: 50 },
          { tool: 'edit', totalUses: 30, avgDurationMs: 200 },
        ],
      }),
    }
    const result = extractPromptSuggestions(sources)
    expect(result.length).toBeGreaterThanOrEqual(2)
    const types = result.map((c) => c.type)
    expect(types.every((t) => t === 'prompt')).toBe(true)
  })

  it('does not duplicate suggestions for the same model', () => {
    const sources: PatternSources = {
      otel: makeOtel({
        totalSessions: 10,
        models: [{ model: 'claude-sonnet-4', totalCalls: 50, sessionCount: 9 }],
      }),
    }
    const result = extractPromptSuggestions(sources)
    const modelCandidates = result.filter((c) => c.title.includes('claude-sonnet-4'))
    expect(modelCandidates.length).toBe(1)
  })

  it('ignores models used in fewer than 60% of sessions', () => {
    const sources: PatternSources = {
      otel: makeOtel({
        totalSessions: 10,
        models: [
          { model: 'model-a', totalCalls: 10, sessionCount: 4 },
          { model: 'model-b', totalCalls: 10, sessionCount: 3 },
        ],
      }),
    }
    const result = extractPromptSuggestions(sources)
    const modelCandidates = result.filter((c) => c.tags.includes('model'))
    expect(modelCandidates.length).toBe(0)
  })
})
