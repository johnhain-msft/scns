import { describe, it, expect } from 'vitest'
import { extractInstructionSuggestions } from '../../../../src/suggest/extractors/instruction-extractor.js'
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

describe('extractInstructionSuggestions', () => {
  it('returns empty array when sources are empty', () => {
    const result = extractInstructionSuggestions({})
    expect(result).toEqual([])
  })

  it('returns empty array when otel data is missing', () => {
    const result = extractInstructionSuggestions({ observations: undefined })
    expect(result).toEqual([])
  })

  it('returns empty array when sessions below threshold (< 5)', () => {
    const sources: PatternSources = {
      otel: makeOtel({
        totalSessions: 4,
        models: [{ model: 'claude-sonnet-4', totalCalls: 20, sessionCount: 4 }],
      }),
    }
    const result = extractInstructionSuggestions(sources)
    expect(result).toEqual([])
  })

  it('suggests default model instruction for consistent model preference', () => {
    const sources: PatternSources = {
      otel: makeOtel({
        totalSessions: 10,
        models: [
          { model: 'claude-sonnet-4', totalCalls: 50, sessionCount: 8 },
          { model: 'gpt-4', totalCalls: 10, sessionCount: 3 },
        ],
      }),
    }
    const result = extractInstructionSuggestions(sources)
    expect(result.length).toBeGreaterThanOrEqual(1)
    const candidate = result.find(
      (c) => c.tags.includes('model-preference') || c.title.toLowerCase().includes('model'),
    )
    expect(candidate).toBeDefined()
    expect(candidate!.type).toBe('instruction')
    expect(candidate!.evidence.length).toBeGreaterThan(0)
    expect(candidate!.evidence[0]!.source).toBe('otel-model')
  })

  it('suggests preferred tools instruction for consistent tool preferences', () => {
    const sources: PatternSources = {
      otel: makeOtel({
        totalSessions: 8,
        topTools: [
          { tool: 'grep', totalUses: 40, avgDurationMs: 100 },
          { tool: 'view', totalUses: 35, avgDurationMs: 50 },
          { tool: 'edit', totalUses: 30, avgDurationMs: 200 },
        ],
      }),
    }
    const result = extractInstructionSuggestions(sources)
    const toolCandidate = result.find(
      (c) => c.tags.includes('tool-preference') || c.title.toLowerCase().includes('tool'),
    )
    expect(toolCandidate).toBeDefined()
    expect(toolCandidate!.type).toBe('instruction')
  })

  it('suggests MCP server instruction for consistent server usage', () => {
    const sources: PatternSources = {
      otel: makeOtel({
        totalSessions: 10,
        mcpServers: [
          { server: 'github-mcp', sessionCount: 7 },
          { server: 'db-mcp', sessionCount: 6 },
        ],
      }),
    }
    const result = extractInstructionSuggestions(sources)
    const mcpCandidate = result.find(
      (c) => c.tags.includes('mcp-preference') || c.title.toLowerCase().includes('mcp'),
    )
    expect(mcpCandidate).toBeDefined()
    expect(mcpCandidate!.type).toBe('instruction')
  })

  it('returns multiple candidates for different preference types', () => {
    const sources: PatternSources = {
      otel: makeOtel({
        totalSessions: 10,
        models: [{ model: 'claude-sonnet-4', totalCalls: 50, sessionCount: 8 }],
        topTools: [
          { tool: 'grep', totalUses: 40, avgDurationMs: 100 },
          { tool: 'view', totalUses: 35, avgDurationMs: 50 },
        ],
        mcpServers: [{ server: 'github-mcp', sessionCount: 7 }],
      }),
    }
    const result = extractInstructionSuggestions(sources)
    expect(result.length).toBeGreaterThanOrEqual(2)
    const types = result.map((c) => c.type)
    expect(types.every((t) => t === 'instruction')).toBe(true)
  })

  it('does not duplicate instruction suggestions', () => {
    const sources: PatternSources = {
      otel: makeOtel({
        totalSessions: 10,
        models: [{ model: 'claude-sonnet-4', totalCalls: 50, sessionCount: 9 }],
      }),
    }
    const result = extractInstructionSuggestions(sources)
    const titles = result.map((c) => c.title)
    expect(new Set(titles).size).toBe(titles.length)
  })

  it('ignores models with low session ratio (< 50%)', () => {
    const sources: PatternSources = {
      otel: makeOtel({
        totalSessions: 10,
        models: [
          { model: 'model-a', totalCalls: 20, sessionCount: 4 },
          { model: 'model-b', totalCalls: 15, sessionCount: 3 },
        ],
      }),
    }
    const result = extractInstructionSuggestions(sources)
    const modelCandidates = result.filter((c) => c.tags.includes('model-preference'))
    expect(modelCandidates.length).toBe(0)
  })

  it('ignores tools with low average usage per session', () => {
    const sources: PatternSources = {
      otel: makeOtel({
        totalSessions: 10,
        topTools: [
          { tool: 'grep', totalUses: 5, avgDurationMs: 100 },
          { tool: 'view', totalUses: 3, avgDurationMs: 50 },
        ],
      }),
    }
    const result = extractInstructionSuggestions(sources)
    const toolCandidates = result.filter((c) => c.tags.includes('tool-preference'))
    expect(toolCandidates.length).toBe(0)
  })
})
