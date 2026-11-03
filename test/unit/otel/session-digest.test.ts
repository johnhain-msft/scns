import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SessionSummary } from '../../../src/otel/session-extractor.js'
import {
  generateSessionDigest,
  storeSessionDigest,
  generateBatchDigests,
} from '../../../src/otel/session-digest.js'

// ── Test data helpers ────────────────────────────────────────

function makeSummary(overrides?: Partial<SessionSummary>): SessionSummary {
  return {
    sessionId: 'abc12345-def6-7890-ghij-klmnopqrstuv',
    startTime: '2024-06-15T10:00:00.000Z',
    endTime: '2024-06-15T10:30:00.000Z',
    durationMs: 1_800_000,
    models: [
      { model: 'claude-sonnet-4-20250514', callCount: 12 },
      { model: 'claude-haiku-3.5', callCount: 3 },
    ],
    tools: [
      { tool: 'read_file', callCount: 25, avgDurationMs: 50 },
      { tool: 'edit_file', callCount: 15, avgDurationMs: 120 },
      { tool: 'bash', callCount: 8, avgDurationMs: 3500 },
      { tool: 'grep', callCount: 6, avgDurationMs: 30 },
      { tool: 'glob', callCount: 5, avgDurationMs: 20 },
      { tool: 'view', callCount: 3, avgDurationMs: 10 },
    ],
    mcpServers: ['github-mcp-server', 'filesystem-mcp-server'],
    skills: ['code-review', 'research'],
    totalInputTokens: 45_000,
    totalOutputTokens: 12_000,
    errorCount: 2,
    spanCount: 150,
    traceIds: ['trace-001', 'trace-002', 'trace-003'],
    ...overrides,
  }
}

// ── Tests ────────────────────────────────────────────────────

describe('session-digest', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2024-06-15T12:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('generateSessionDigest', () => {
    it('generates a digest with all fields populated', () => {
      const summary = makeSummary()
      const digest = generateSessionDigest(summary)

      expect(digest.sessionId).toBe(summary.sessionId)
      expect(digest.sessionDate).toBe('2024-06-15')
      expect(digest.generatedAt).toBe('2024-06-15T12:00:00.000Z')
      expect(digest.markdown).toContain('Session Digest')
      expect(digest.memoryEntries.length).toBeGreaterThan(0)
    })

    it('sets sessionDate from startTime', () => {
      const digest = generateSessionDigest(makeSummary({ startTime: '2025-01-20T08:00:00.000Z' }))
      expect(digest.sessionDate).toBe('2025-01-20')
    })
  })

  describe('markdown content', () => {
    it('includes header with truncated session ID', () => {
      const digest = generateSessionDigest(makeSummary())
      expect(digest.markdown).toContain('# Session Digest: abc12345')
    })

    it('includes date and duration', () => {
      const digest = generateSessionDigest(makeSummary())
      expect(digest.markdown).toContain('**Date:** 2024-06-15')
      expect(digest.markdown).toContain('**Duration:** 30m 0s')
    })

    it('includes models table', () => {
      const digest = generateSessionDigest(makeSummary())
      expect(digest.markdown).toContain('## Models')
      expect(digest.markdown).toContain('claude-sonnet-4-20250514')
      expect(digest.markdown).toContain('claude-haiku-3.5')
    })

    it('includes tools table with top entries', () => {
      const digest = generateSessionDigest(makeSummary())
      expect(digest.markdown).toContain('## Tools')
      expect(digest.markdown).toContain('read_file')
      expect(digest.markdown).toContain('edit_file')
    })

    it('limits tools to top 10 and shows overflow', () => {
      const manyTools = Array.from({ length: 15 }, (_, i) => ({
        tool: `tool-${i}`,
        callCount: 15 - i,
        avgDurationMs: 100,
      }))
      const digest = generateSessionDigest(makeSummary({ tools: manyTools }))
      expect(digest.markdown).toContain('tool-0')
      expect(digest.markdown).toContain('tool-9')
      expect(digest.markdown).not.toContain('tool-10')
      expect(digest.markdown).toContain('5 more tools')
    })

    it('includes MCP servers', () => {
      const digest = generateSessionDigest(makeSummary())
      expect(digest.markdown).toContain('## MCP Servers')
      expect(digest.markdown).toContain('github-mcp-server')
      expect(digest.markdown).toContain('filesystem-mcp-server')
    })

    it('includes skills', () => {
      const digest = generateSessionDigest(makeSummary())
      expect(digest.markdown).toContain('## Skills')
      expect(digest.markdown).toContain('code-review')
      expect(digest.markdown).toContain('research')
    })

    it('includes token usage', () => {
      const digest = generateSessionDigest(makeSummary())
      expect(digest.markdown).toContain('## Token Usage')
      expect(digest.markdown).toContain('45,000')
      expect(digest.markdown).toContain('12,000')
      expect(digest.markdown).toContain('57,000')
    })

    it('includes error section when errors present', () => {
      const digest = generateSessionDigest(makeSummary({ errorCount: 5 }))
      expect(digest.markdown).toContain('## Errors')
      expect(digest.markdown).toContain('5 error(s)')
    })

    it('omits error section when no errors', () => {
      const digest = generateSessionDigest(makeSummary({ errorCount: 0 }))
      expect(digest.markdown).not.toContain('## Errors')
    })

    it('omits MCP servers section when none', () => {
      const digest = generateSessionDigest(makeSummary({ mcpServers: [] }))
      expect(digest.markdown).not.toContain('## MCP Servers')
    })

    it('omits skills section when none', () => {
      const digest = generateSessionDigest(makeSummary({ skills: [] }))
      expect(digest.markdown).not.toContain('## Skills')
    })

    it('includes span count and trace count', () => {
      const digest = generateSessionDigest(makeSummary())
      expect(digest.markdown).toContain('**Spans:** 150')
      expect(digest.markdown).toContain('**Traces:** 3')
    })

    it('shows "No model usage" for empty models', () => {
      const digest = generateSessionDigest(makeSummary({ models: [] }))
      expect(digest.markdown).toContain('No model usage recorded.')
    })

    it('shows "No tool usage" for empty tools', () => {
      const digest = generateSessionDigest(makeSummary({ tools: [] }))
      expect(digest.markdown).toContain('No tool usage recorded.')
    })

    it('handles null duration', () => {
      const digest = generateSessionDigest(makeSummary({ durationMs: null }))
      expect(digest.markdown).toContain('**Duration:** Unknown')
    })

    it('formats short durations in seconds', () => {
      const digest = generateSessionDigest(makeSummary({ durationMs: 45_000 }))
      expect(digest.markdown).toContain('**Duration:** 45s')
    })

    it('formats long durations with hours', () => {
      const digest = generateSessionDigest(makeSummary({ durationMs: 7_500_000 }))
      expect(digest.markdown).toContain('**Duration:** 2h 5m')
    })

    it('formats sub-second durations in milliseconds', () => {
      const digest = generateSessionDigest(makeSummary({ durationMs: 500 }))
      expect(digest.markdown).toContain('**Duration:** 500ms')
    })
  })

  describe('memory entries', () => {
    it('always includes session-summary and model-usage entries', () => {
      const digest = generateSessionDigest(makeSummary())
      const types = digest.memoryEntries.map((e) => e.name)
      expect(types).toContain(`session-${makeSummary().sessionId}`)
      expect(types).toContain(`model-usage-${makeSummary().sessionId}`)
    })

    it('session-summary entry has correct structure', () => {
      const summary = makeSummary()
      const digest = generateSessionDigest(summary)
      const entry = digest.memoryEntries.find((e) => e.name.startsWith('session-'))!

      expect(entry.type).toBe('project')
      expect(entry.source).toBe('session-digest')
      expect(entry.createdAt).toBe(summary.endTime)
      expect(entry.description).toContain('30m 0s')
      expect(entry.content).toContain('Tokens')
    })

    it('model-usage entry has correct structure', () => {
      const summary = makeSummary()
      const digest = generateSessionDigest(summary)
      const entry = digest.memoryEntries.find((e) => e.name.startsWith('model-usage-'))!

      expect(entry.type).toBe('project')
      expect(entry.source).toBe('session-digest')
      expect(entry.content).toContain('claude-sonnet-4-20250514')
    })

    it('generates tool-preference entries for high-frequency tools', () => {
      const digest = generateSessionDigest(makeSummary())
      const toolPrefs = digest.memoryEntries.filter((e) => e.name.startsWith('tool-pref-'))

      // Tools with >= 5 calls: read_file(25), edit_file(15), bash(8), grep(6), glob(5)
      expect(toolPrefs).toHaveLength(5)
      expect(toolPrefs[0]!.name).toBe('tool-pref-read_file')
      expect(toolPrefs[0]!.type).toBe('project')
    })

    it('skips tool-preference for low-frequency tools', () => {
      const digest = generateSessionDigest(makeSummary())
      const toolPrefs = digest.memoryEntries.filter((e) => e.name.startsWith('tool-pref-'))
      const names = toolPrefs.map((e) => e.name)

      // view only has 3 calls, below threshold
      expect(names).not.toContain('tool-pref-view')
    })

    it('limits tool-preference entries to top 5', () => {
      const manyTools = Array.from({ length: 10 }, (_, i) => ({
        tool: `tool-${i}`,
        callCount: 100 - i,
        avgDurationMs: 50,
      }))
      const digest = generateSessionDigest(makeSummary({ tools: manyTools }))
      const toolPrefs = digest.memoryEntries.filter((e) => e.name.startsWith('tool-pref-'))

      expect(toolPrefs).toHaveLength(5)
    })

    it('generates error-summary entry when errors present', () => {
      const digest = generateSessionDigest(makeSummary({ errorCount: 3 }))
      const errorEntry = digest.memoryEntries.find((e) => e.name.startsWith('error-summary-'))

      expect(errorEntry).toBeDefined()
      expect(errorEntry!.type).toBe('feedback')
      expect(errorEntry!.description).toContain('3 error(s)')
    })

    it('omits error entry when no errors', () => {
      const digest = generateSessionDigest(makeSummary({ errorCount: 0 }))
      const errorEntry = digest.memoryEntries.find((e) => e.name.startsWith('error-summary-'))

      expect(errorEntry).toBeUndefined()
    })

    it('sets createdAt from endTime when available', () => {
      const summary = makeSummary({ endTime: '2024-06-15T11:00:00.000Z' })
      const digest = generateSessionDigest(summary)

      for (const entry of digest.memoryEntries) {
        expect(entry.createdAt).toBe('2024-06-15T11:00:00.000Z')
      }
    })

    it('falls back to startTime when endTime is null', () => {
      const summary = makeSummary({ endTime: null })
      const digest = generateSessionDigest(summary)

      for (const entry of digest.memoryEntries) {
        expect(entry.createdAt).toBe(summary.startTime)
      }
    })

    it('all entries have source set to session-digest', () => {
      const digest = generateSessionDigest(makeSummary())
      for (const entry of digest.memoryEntries) {
        expect(entry.source).toBe('session-digest')
      }
    })
  })

  describe('minimal sessions', () => {
    it('handles session with no tools, models, servers, or skills', () => {
      const minimal = makeSummary({
        models: [],
        tools: [],
        mcpServers: [],
        skills: [],
        totalInputTokens: 0,
        totalOutputTokens: 0,
        errorCount: 0,
        spanCount: 1,
        traceIds: ['trace-1'],
      })
      const digest = generateSessionDigest(minimal)

      expect(digest.markdown).toContain('No model usage recorded.')
      expect(digest.markdown).toContain('No tool usage recorded.')
      expect(digest.markdown).not.toContain('## MCP Servers')
      expect(digest.markdown).not.toContain('## Skills')
      expect(digest.markdown).not.toContain('## Errors')

      // Should still have session-summary and model-usage entries
      expect(digest.memoryEntries).toHaveLength(2)
    })

    it('handles session with null endTime and durationMs', () => {
      const digest = generateSessionDigest(makeSummary({ endTime: null, durationMs: null }))
      expect(digest.markdown).toContain('**Duration:** Unknown')
      expect(digest.memoryEntries.length).toBeGreaterThan(0)
    })
  })

  describe('storeSessionDigest', () => {
    it('writes digest to correct vault path', () => {
      const mockVault = {
        write: vi.fn().mockReturnValue({ path: '', content: '', mtimeMs: 0, sizeBytes: 0 }),
        read: vi.fn(),
        append: vi.fn(),
        remove: vi.fn(),
        appendDailyLog: vi.fn(),
        listFiles: vi.fn(),
        ensureDirs: vi.fn(),
        rootDir: '/vault',
      }

      const digest = generateSessionDigest(makeSummary())
      const path = storeSessionDigest(mockVault, digest)

      expect(path).toBe('sessions/2024-06-15/abc12345-def6-7890-ghij-klmnopqrstuv.md')
      expect(mockVault.write).toHaveBeenCalledWith(path, digest.markdown)
    })

    it('sanitizes session ID in filename', () => {
      const mockVault = {
        write: vi.fn().mockReturnValue({ path: '', content: '', mtimeMs: 0, sizeBytes: 0 }),
        read: vi.fn(),
        append: vi.fn(),
        remove: vi.fn(),
        appendDailyLog: vi.fn(),
        listFiles: vi.fn(),
        ensureDirs: vi.fn(),
        rootDir: '/vault',
      }

      const summary = makeSummary({ sessionId: 'bad/path/../traversal' })
      const digest = generateSessionDigest(summary)
      const path = storeSessionDigest(mockVault, digest)

      expect(path).toBe('sessions/2024-06-15/bad_path____traversal.md')
      expect(path).not.toContain('..')
      expect(path).not.toContain('//')
    })
  })

  describe('generateBatchDigests', () => {
    it('returns empty array for empty input', () => {
      const result = generateBatchDigests([])
      expect(result).toEqual([])
    })

    it('generates digests for all summaries', () => {
      const summaries = [
        makeSummary({ sessionId: 'session-1' }),
        makeSummary({ sessionId: 'session-2' }),
        makeSummary({ sessionId: 'session-3' }),
      ]
      const digests = generateBatchDigests(summaries)

      expect(digests).toHaveLength(3)
      expect(digests[0]!.sessionId).toBe('session-1')
      expect(digests[1]!.sessionId).toBe('session-2')
      expect(digests[2]!.sessionId).toBe('session-3')
    })

    it('each digest has its own generatedAt timestamp', () => {
      const summaries = [makeSummary({ sessionId: 's1' }), makeSummary({ sessionId: 's2' })]
      const digests = generateBatchDigests(summaries)

      // With fake timers, all should be the same, but they should be valid ISO strings
      for (const d of digests) {
        expect(d.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      }
    })

    it('preserves independent memory entries per digest', () => {
      const summaries = [
        makeSummary({ sessionId: 's1', errorCount: 0 }),
        makeSummary({ sessionId: 's2', errorCount: 5 }),
      ]
      const digests = generateBatchDigests(summaries)

      const s1Errors = digests[0]!.memoryEntries.filter((e) => e.name.startsWith('error-summary-'))
      const s2Errors = digests[1]!.memoryEntries.filter((e) => e.name.startsWith('error-summary-'))

      expect(s1Errors).toHaveLength(0)
      expect(s2Errors).toHaveLength(1)
    })
  })
})
