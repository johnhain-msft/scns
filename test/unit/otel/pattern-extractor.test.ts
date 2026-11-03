import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SessionSummary } from '../../../src/otel/session-extractor.js'
import {
  extractPatterns,
  patternsToMemoryEntries,
  type ExtractedPatterns,
} from '../../../src/otel/pattern-extractor.js'

// ── Helpers ──────────────────────────────────────────────────

function makeSummary(overrides?: Partial<SessionSummary>): SessionSummary {
  return {
    sessionId: 'session-001',
    startTime: '2024-06-15T14:00:00.000Z', // Saturday 14:00 UTC
    endTime: '2024-06-15T15:00:00.000Z',
    durationMs: 3_600_000,
    models: [{ model: 'claude-sonnet-4', callCount: 10 }],
    tools: [
      { tool: 'edit', callCount: 5, avgDurationMs: 100 },
      { tool: 'bash', callCount: 3, avgDurationMs: 200 },
    ],
    mcpServers: ['github-mcp'],
    skills: ['code-review'],
    totalInputTokens: 50_000,
    totalOutputTokens: 20_000,
    errorCount: 0,
    spanCount: 50,
    traceIds: ['trace-001'],
    ...overrides,
  }
}

// ── Setup ────────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2024-07-01T12:00:00.000Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

// ── extractPatterns ──────────────────────────────────────────

describe('extractPatterns', () => {
  describe('empty summaries', () => {
    it('returns sensible defaults for empty input', () => {
      const result = extractPatterns([])

      expect(result.totalSessions).toBe(0)
      expect(result.analyzedFrom).toBe('')
      expect(result.analyzedTo).toBe('')
      expect(result.extractedAt).toBe('2024-07-01T12:00:00.000Z')

      expect(result.schedule.activeHours).toEqual([])
      expect(result.schedule.activeDays).toEqual([])
      expect(result.schedule.avgSessionDuration).toBeNull()
      expect(result.schedule.avgTokensPerSession).toEqual({ input: 0, output: 0 })

      expect(result.tools.topTools).toEqual([])
      expect(result.tools.mcpServers).toEqual([])
      expect(result.tools.skills).toEqual([])

      expect(result.models.models).toEqual([])
      expect(result.models.primaryModel).toBeNull()
    })
  })

  describe('work schedule', () => {
    it('extracts correct hour distribution', () => {
      const summaries = [
        makeSummary({ sessionId: 's1', startTime: '2024-06-15T14:00:00.000Z' }),
        makeSummary({ sessionId: 's2', startTime: '2024-06-16T14:30:00.000Z' }),
        makeSummary({ sessionId: 's3', startTime: '2024-06-17T09:00:00.000Z' }),
      ]

      const result = extractPatterns(summaries)

      expect(result.schedule.activeHours).toContainEqual({ hour: 14, sessionCount: 2 })
      expect(result.schedule.activeHours).toContainEqual({ hour: 9, sessionCount: 1 })
      // Hour 14 should be first (most sessions)
      expect(result.schedule.activeHours[0]).toEqual({ hour: 14, sessionCount: 2 })
    })

    it('extracts correct day-of-week distribution', () => {
      const summaries = [
        makeSummary({ sessionId: 's1', startTime: '2024-06-10T10:00:00.000Z' }), // Monday
        makeSummary({ sessionId: 's2', startTime: '2024-06-11T10:00:00.000Z' }), // Tuesday
        makeSummary({ sessionId: 's3', startTime: '2024-06-17T10:00:00.000Z' }), // Monday
      ]

      const result = extractPatterns(summaries)

      expect(result.schedule.activeDays).toContainEqual({ day: 'Monday', sessionCount: 2 })
      expect(result.schedule.activeDays).toContainEqual({ day: 'Tuesday', sessionCount: 1 })
      expect(result.schedule.activeDays[0]).toEqual({ day: 'Monday', sessionCount: 2 })
    })
  })

  describe('average session duration', () => {
    it('calculates average of valid durations', () => {
      const summaries = [
        makeSummary({ sessionId: 's1', durationMs: 1_000 }),
        makeSummary({ sessionId: 's2', durationMs: 3_000 }),
      ]

      const result = extractPatterns(summaries)
      expect(result.schedule.avgSessionDuration).toBe(2_000)
    })

    it('ignores null durations in average', () => {
      const summaries = [
        makeSummary({ sessionId: 's1', durationMs: 1_000 }),
        makeSummary({ sessionId: 's2', durationMs: null }),
        makeSummary({ sessionId: 's3', durationMs: 3_000 }),
      ]

      const result = extractPatterns(summaries)
      expect(result.schedule.avgSessionDuration).toBe(2_000)
    })

    it('returns null when all durations are null', () => {
      const summaries = [
        makeSummary({ sessionId: 's1', durationMs: null }),
        makeSummary({ sessionId: 's2', durationMs: null }),
      ]

      const result = extractPatterns(summaries)
      expect(result.schedule.avgSessionDuration).toBeNull()
    })
  })

  describe('token averages', () => {
    it('calculates average tokens per session', () => {
      const summaries = [
        makeSummary({
          sessionId: 's1',
          totalInputTokens: 10_000,
          totalOutputTokens: 5_000,
        }),
        makeSummary({
          sessionId: 's2',
          totalInputTokens: 20_000,
          totalOutputTokens: 15_000,
        }),
      ]

      const result = extractPatterns(summaries)
      expect(result.schedule.avgTokensPerSession).toEqual({
        input: 15_000,
        output: 10_000,
      })
    })

    it('rounds token averages', () => {
      const summaries = [
        makeSummary({ sessionId: 's1', totalInputTokens: 10, totalOutputTokens: 7 }),
        makeSummary({ sessionId: 's2', totalInputTokens: 11, totalOutputTokens: 8 }),
        makeSummary({ sessionId: 's3', totalInputTokens: 12, totalOutputTokens: 9 }),
      ]

      const result = extractPatterns(summaries)
      expect(result.schedule.avgTokensPerSession).toEqual({
        input: 11,
        output: 8,
      })
    })
  })

  describe('tool preferences', () => {
    it('aggregates tool usage across sessions', () => {
      const summaries = [
        makeSummary({
          sessionId: 's1',
          tools: [
            { tool: 'edit', callCount: 5, avgDurationMs: 100 },
            { tool: 'bash', callCount: 3, avgDurationMs: 200 },
          ],
        }),
        makeSummary({
          sessionId: 's2',
          tools: [
            { tool: 'edit', callCount: 10, avgDurationMs: 150 },
            { tool: 'grep', callCount: 2, avgDurationMs: 50 },
          ],
        }),
      ]

      const result = extractPatterns(summaries)
      const editTool = result.tools.topTools.find((t) => t.tool === 'edit')
      expect(editTool).toBeDefined()
      expect(editTool!.totalUses).toBe(15)
      // Weighted avg: (5*100 + 10*150) / (5+10) = 2000/15 ≈ 133
      expect(editTool!.avgDurationMs).toBe(133)
    })

    it('sorts tools by total uses descending', () => {
      const summaries = [
        makeSummary({
          sessionId: 's1',
          tools: [
            { tool: 'bash', callCount: 1, avgDurationMs: null },
            { tool: 'edit', callCount: 10, avgDurationMs: null },
          ],
        }),
      ]

      const result = extractPatterns(summaries)
      expect(result.tools.topTools[0]!.tool).toBe('edit')
      expect(result.tools.topTools[1]!.tool).toBe('bash')
    })

    it('handles tools with null avgDurationMs', () => {
      const summaries = [
        makeSummary({
          sessionId: 's1',
          tools: [{ tool: 'edit', callCount: 5, avgDurationMs: null }],
        }),
      ]

      const result = extractPatterns(summaries)
      expect(result.tools.topTools[0]!.avgDurationMs).toBeNull()
    })
  })

  describe('MCP server frequency', () => {
    it('counts MCP servers by session, not by use', () => {
      const summaries = [
        makeSummary({ sessionId: 's1', mcpServers: ['github-mcp', 'jira-mcp'] }),
        makeSummary({ sessionId: 's2', mcpServers: ['github-mcp'] }),
        makeSummary({ sessionId: 's3', mcpServers: ['jira-mcp'] }),
      ]

      const result = extractPatterns(summaries)
      expect(result.tools.mcpServers).toContainEqual({ server: 'github-mcp', sessionCount: 2 })
      expect(result.tools.mcpServers).toContainEqual({ server: 'jira-mcp', sessionCount: 2 })
    })

    it('sorts MCP servers by session count descending', () => {
      const summaries = [
        makeSummary({ sessionId: 's1', mcpServers: ['rare-mcp', 'common-mcp'] }),
        makeSummary({ sessionId: 's2', mcpServers: ['common-mcp'] }),
        makeSummary({ sessionId: 's3', mcpServers: ['common-mcp'] }),
      ]

      const result = extractPatterns(summaries)
      expect(result.tools.mcpServers[0]!.server).toBe('common-mcp')
    })
  })

  describe('skill frequency', () => {
    it('counts skills by session', () => {
      const summaries = [
        makeSummary({ sessionId: 's1', skills: ['code-review', 'deploy'] }),
        makeSummary({ sessionId: 's2', skills: ['code-review'] }),
      ]

      const result = extractPatterns(summaries)
      expect(result.tools.skills).toContainEqual({ skill: 'code-review', sessionCount: 2 })
      expect(result.tools.skills).toContainEqual({ skill: 'deploy', sessionCount: 1 })
    })

    it('sorts skills by session count descending', () => {
      const summaries = [
        makeSummary({ sessionId: 's1', skills: ['rare-skill', 'common-skill'] }),
        makeSummary({ sessionId: 's2', skills: ['common-skill'] }),
        makeSummary({ sessionId: 's3', skills: ['common-skill'] }),
      ]

      const result = extractPatterns(summaries)
      expect(result.tools.skills[0]!.skill).toBe('common-skill')
    })
  })

  describe('model preferences', () => {
    it('aggregates model usage across sessions', () => {
      const summaries = [
        makeSummary({
          sessionId: 's1',
          models: [
            { model: 'claude-sonnet-4', callCount: 10 },
            { model: 'claude-haiku-3.5', callCount: 5 },
          ],
        }),
        makeSummary({
          sessionId: 's2',
          models: [{ model: 'claude-sonnet-4', callCount: 8 }],
        }),
      ]

      const result = extractPatterns(summaries)

      const sonnet = result.models.models.find((m) => m.model === 'claude-sonnet-4')
      expect(sonnet).toBeDefined()
      expect(sonnet!.totalCalls).toBe(18)
      expect(sonnet!.sessionCount).toBe(2)

      const haiku = result.models.models.find((m) => m.model === 'claude-haiku-3.5')
      expect(haiku).toBeDefined()
      expect(haiku!.totalCalls).toBe(5)
      expect(haiku!.sessionCount).toBe(1)
    })

    it('identifies primary model as the one with most total calls', () => {
      const summaries = [
        makeSummary({
          sessionId: 's1',
          models: [
            { model: 'claude-sonnet-4', callCount: 20 },
            { model: 'gpt-4', callCount: 5 },
          ],
        }),
      ]

      const result = extractPatterns(summaries)
      expect(result.models.primaryModel).toBe('claude-sonnet-4')
    })

    it('returns null primary model for empty models', () => {
      const summaries = [makeSummary({ sessionId: 's1', models: [] })]

      const result = extractPatterns(summaries)
      expect(result.models.primaryModel).toBeNull()
    })
  })

  describe('metadata', () => {
    it('calculates date range from session start times', () => {
      const summaries = [
        makeSummary({ sessionId: 's1', startTime: '2024-06-10T10:00:00.000Z' }),
        makeSummary({ sessionId: 's2', startTime: '2024-06-20T10:00:00.000Z' }),
        makeSummary({ sessionId: 's3', startTime: '2024-06-15T10:00:00.000Z' }),
      ]

      const result = extractPatterns(summaries)
      expect(result.analyzedFrom).toBe('2024-06-10T10:00:00.000Z')
      expect(result.analyzedTo).toBe('2024-06-20T10:00:00.000Z')
    })

    it('sets extractedAt to current time', () => {
      const result = extractPatterns([makeSummary()])
      expect(result.extractedAt).toBe('2024-07-01T12:00:00.000Z')
    })

    it('sets totalSessions correctly', () => {
      const summaries = [
        makeSummary({ sessionId: 's1' }),
        makeSummary({ sessionId: 's2' }),
        makeSummary({ sessionId: 's3' }),
      ]

      const result = extractPatterns(summaries)
      expect(result.totalSessions).toBe(3)
    })
  })

  describe('edge cases', () => {
    it('handles single session', () => {
      const result = extractPatterns([makeSummary()])

      expect(result.totalSessions).toBe(1)
      expect(result.schedule.activeHours).toHaveLength(1)
      expect(result.schedule.activeDays).toHaveLength(1)
      expect(result.analyzedFrom).toBe(result.analyzedTo)
    })

    it('handles session without tools', () => {
      const result = extractPatterns([makeSummary({ tools: [] })])

      expect(result.tools.topTools).toEqual([])
    })

    it('handles session without models', () => {
      const result = extractPatterns([makeSummary({ models: [] })])

      expect(result.models.models).toEqual([])
      expect(result.models.primaryModel).toBeNull()
    })

    it('handles session without MCP servers', () => {
      const result = extractPatterns([makeSummary({ mcpServers: [] })])

      expect(result.tools.mcpServers).toEqual([])
    })

    it('handles session without skills', () => {
      const result = extractPatterns([makeSummary({ skills: [] })])

      expect(result.tools.skills).toEqual([])
    })

    it('handles sessions with all empty arrays', () => {
      const summary = makeSummary({
        tools: [],
        models: [],
        mcpServers: [],
        skills: [],
        traceIds: [],
      })
      const result = extractPatterns([summary])

      expect(result.totalSessions).toBe(1)
      expect(result.tools.topTools).toEqual([])
      expect(result.models.models).toEqual([])
      expect(result.models.primaryModel).toBeNull()
      expect(result.tools.mcpServers).toEqual([])
      expect(result.tools.skills).toEqual([])
    })
  })
})

// ── patternsToMemoryEntries ──────────────────────────────────

describe('patternsToMemoryEntries', () => {
  function makePatterns(overrides?: Partial<ExtractedPatterns>): ExtractedPatterns {
    return {
      schedule: {
        activeHours: [
          { hour: 14, sessionCount: 5 },
          { hour: 9, sessionCount: 3 },
        ],
        activeDays: [
          { day: 'Monday', sessionCount: 4 },
          { day: 'Tuesday', sessionCount: 3 },
        ],
        avgSessionDuration: 3_600_000,
        avgTokensPerSession: { input: 50_000, output: 20_000 },
      },
      tools: {
        topTools: [
          { tool: 'edit', totalUses: 100, avgDurationMs: 120 },
          { tool: 'bash', totalUses: 50, avgDurationMs: 300 },
        ],
        mcpServers: [{ server: 'github-mcp', sessionCount: 10 }],
        skills: [{ skill: 'code-review', sessionCount: 5 }],
      },
      models: {
        models: [
          { model: 'claude-sonnet-4', totalCalls: 200, sessionCount: 15 },
          { model: 'claude-haiku-3.5', totalCalls: 50, sessionCount: 8 },
        ],
        primaryModel: 'claude-sonnet-4',
      },
      totalSessions: 20,
      analyzedFrom: '2024-06-01T00:00:00.000Z',
      analyzedTo: '2024-06-30T23:59:59.000Z',
      extractedAt: '2024-07-01T12:00:00.000Z',
      ...overrides,
    }
  }

  it('generates three memory entries', () => {
    const entries = patternsToMemoryEntries(makePatterns())
    expect(entries).toHaveLength(3)
  })

  it('all entries have type project and source pattern-extractor', () => {
    const entries = patternsToMemoryEntries(makePatterns())
    for (const entry of entries) {
      expect(entry.type).toBe('project')
      expect(entry.source).toBe('pattern-extractor')
    }
  })

  it('generates work-schedule entry with correct name', () => {
    const entries = patternsToMemoryEntries(makePatterns())
    const schedule = entries.find((e) => e.name === 'work-schedule')
    expect(schedule).toBeDefined()
    expect(schedule!.description).toContain('work schedule')
  })

  it('work-schedule content includes active hours and days', () => {
    const entries = patternsToMemoryEntries(makePatterns())
    const schedule = entries.find((e) => e.name === 'work-schedule')!
    expect(schedule.content).toContain('14:00')
    expect(schedule.content).toContain('Monday')
    expect(schedule.content).toContain('20 sessions')
  })

  it('work-schedule content includes duration and tokens', () => {
    const entries = patternsToMemoryEntries(makePatterns())
    const schedule = entries.find((e) => e.name === 'work-schedule')!
    expect(schedule.content).toContain('60 minutes')
    expect(schedule.content).toContain('50000 input')
    expect(schedule.content).toContain('20000 output')
  })

  it('generates tool-preferences entry', () => {
    const entries = patternsToMemoryEntries(makePatterns())
    const tools = entries.find((e) => e.name === 'tool-preferences')
    expect(tools).toBeDefined()
    expect(tools!.content).toContain('edit (100 uses)')
    expect(tools!.content).toContain('github-mcp')
    expect(tools!.content).toContain('code-review')
  })

  it('generates model-preferences entry', () => {
    const entries = patternsToMemoryEntries(makePatterns())
    const models = entries.find((e) => e.name === 'model-preferences')
    expect(models).toBeDefined()
    expect(models!.content).toContain('Primary model: claude-sonnet-4')
    expect(models!.content).toContain('200 calls across 15 sessions')
  })

  it('handles patterns with no data gracefully', () => {
    const emptyPatterns = extractPatterns([])
    const entries = patternsToMemoryEntries(emptyPatterns)

    expect(entries).toHaveLength(3)

    const schedule = entries.find((e) => e.name === 'work-schedule')!
    expect(schedule.content).toContain('No active hours data.')
    expect(schedule.content).toContain('No active days data.')
    expect(schedule.content).toContain('unknown')

    const tools = entries.find((e) => e.name === 'tool-preferences')!
    expect(tools.content).toContain('No tool usage data.')
    expect(tools.content).toContain('No MCP server data.')
    expect(tools.content).toContain('No skill data.')

    const models = entries.find((e) => e.name === 'model-preferences')!
    expect(models.content).toContain('No primary model identified.')
    expect(models.content).toContain('No model usage data.')
  })

  it('handles null avgSessionDuration in memory entry', () => {
    const patterns = makePatterns({
      schedule: {
        activeHours: [{ hour: 10, sessionCount: 1 }],
        activeDays: [{ day: 'Monday', sessionCount: 1 }],
        avgSessionDuration: null,
        avgTokensPerSession: { input: 100, output: 50 },
      },
    })

    const entries = patternsToMemoryEntries(patterns)
    const schedule = entries.find((e) => e.name === 'work-schedule')!
    expect(schedule.content).toContain('Average session duration: unknown')
  })

  it('handles null primary model in memory entry', () => {
    const patterns = makePatterns({
      models: { models: [], primaryModel: null },
    })

    const entries = patternsToMemoryEntries(patterns)
    const models = entries.find((e) => e.name === 'model-preferences')!
    expect(models.content).toContain('No primary model identified.')
  })
})
