import { describe, it, expect } from 'vitest'
import { extractAgenticWorkflowSuggestions } from '../../../../src/suggest/extractors/agentic-workflow-extractor.js'
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

describe('extractAgenticWorkflowSuggestions', () => {
  it('returns empty array when sources are empty', () => {
    const result = extractAgenticWorkflowSuggestions({})
    expect(result).toEqual([])
  })

  it('returns empty array when otel data is missing', () => {
    const result = extractAgenticWorkflowSuggestions({ observations: undefined })
    expect(result).toEqual([])
  })

  it('returns empty array when sessions below threshold (< 3)', () => {
    const sources: PatternSources = {
      otel: makeOtel({
        totalSessions: 2,
        topTools: [
          { tool: 'grep', totalUses: 10, avgDurationMs: 100 },
          { tool: 'view', totalUses: 8, avgDurationMs: 50 },
        ],
      }),
    }
    const result = extractAgenticWorkflowSuggestions(sources)
    expect(result).toEqual([])
  })

  it('suggests workflow for repeated tool combinations', () => {
    const sources: PatternSources = {
      otel: makeOtel({
        totalSessions: 5,
        topTools: [
          { tool: 'grep', totalUses: 25, avgDurationMs: 100 },
          { tool: 'view', totalUses: 20, avgDurationMs: 50 },
          { tool: 'edit', totalUses: 15, avgDurationMs: 200 },
        ],
      }),
    }
    const result = extractAgenticWorkflowSuggestions(sources)
    expect(result.length).toBeGreaterThanOrEqual(1)
    const candidate = result[0]!
    expect(candidate.type).toBe('agentic-workflow')
    expect(candidate.tags).toContain('tool-combo')
    expect(candidate.evidence.length).toBeGreaterThan(0)
    expect(candidate.evidence[0]!.source).toBe('otel-tools')
  })

  it('suggests automation for repetitive skill usage', () => {
    const sources: PatternSources = {
      otel: makeOtel({
        totalSessions: 6,
        skills: [
          { skill: 'code-review', sessionCount: 4 },
          { skill: 'deploy', sessionCount: 3 },
        ],
      }),
    }
    const result = extractAgenticWorkflowSuggestions(sources)
    const skillCandidate = result.find((c) => c.tags.includes('skill-automation'))
    expect(skillCandidate).toBeDefined()
    expect(skillCandidate!.type).toBe('agentic-workflow')
    expect(
      skillCandidate!.title.toLowerCase().includes('code-review') ||
        skillCandidate!.description.toLowerCase().includes('code-review'),
    ).toBe(true)
  })

  it('returns multiple candidates for different tool combos and skills', () => {
    const sources: PatternSources = {
      otel: makeOtel({
        totalSessions: 5,
        topTools: [
          { tool: 'grep', totalUses: 30, avgDurationMs: 100 },
          { tool: 'view', totalUses: 25, avgDurationMs: 50 },
          { tool: 'edit', totalUses: 20, avgDurationMs: 200 },
        ],
        skills: [{ skill: 'deploy', sessionCount: 4 }],
      }),
    }
    const result = extractAgenticWorkflowSuggestions(sources)
    expect(result.length).toBeGreaterThanOrEqual(2)
  })

  it('does not suggest skill automation below threshold (< 3 sessions)', () => {
    const sources: PatternSources = {
      otel: makeOtel({
        totalSessions: 5,
        skills: [
          { skill: 'code-review', sessionCount: 2 },
          { skill: 'deploy', sessionCount: 1 },
        ],
      }),
    }
    const result = extractAgenticWorkflowSuggestions(sources)
    const skillCandidates = result.filter((c) => c.tags.includes('skill-automation'))
    expect(skillCandidates.length).toBe(0)
  })

  it('does not duplicate workflow suggestions', () => {
    const sources: PatternSources = {
      otel: makeOtel({
        totalSessions: 8,
        topTools: [
          { tool: 'grep', totalUses: 40, avgDurationMs: 100 },
          { tool: 'view', totalUses: 30, avgDurationMs: 50 },
        ],
      }),
    }
    const result = extractAgenticWorkflowSuggestions(sources)
    const titles = result.map((c) => c.title)
    expect(new Set(titles).size).toBe(titles.length)
  })
})
