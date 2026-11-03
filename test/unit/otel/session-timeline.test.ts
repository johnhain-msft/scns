import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { TestDb } from '../../helpers/db-harness.js'
import { createOtelTestDb } from '../../helpers/otel-db-harness.js'
import { insertSpans } from '../../../src/otel/otel-repository.js'
import type { SpanInput } from '../../../src/otel/jsonl-parser.js'
import type { Observation } from '../../../src/observe/types.js'
import { buildSessionTimeline, buildRecentTimelines } from '../../../src/otel/session-timeline.js'

describe('session-timeline', () => {
  let testDb: TestDb

  beforeEach(() => {
    testDb = createOtelTestDb()
  })

  afterEach(() => {
    testDb.close()
  })

  // ── Test data helpers ────────────────────────────────────────

  let spanCounter = 0

  function makeSpan(overrides?: Partial<SpanInput>): SpanInput {
    spanCounter++
    return {
      trace_id: 'trace-001',
      span_id: `span-${spanCounter}`,
      parent_span_id: null,
      name: 'test-span',
      kind: 'INTERNAL',
      start_time: '2024-01-15T10:00:00.000Z',
      end_time: '2024-01-15T10:00:01.000Z',
      duration_ms: 1000,
      status: 'OK',
      attributes_json: '{}',
      events_json: '[]',
      resource_json: '{}',
      session_id: null,
      ...overrides,
    }
  }

  function makeObservation(overrides?: Partial<Observation>): Observation {
    return {
      id: crypto.randomUUID(),
      type: 'session-hook',
      timestamp: '2024-01-15T10:00:00.000Z',
      source: 'session-start',
      content: 'Session test-session started',
      tags: ['session-hook', 'session-start', 'session-id:test-session'],
      metadata: undefined,
      ...overrides,
    }
  }

  beforeEach(() => {
    spanCounter = 0
  })

  // ── Empty session ───────────────────────────────────────────

  describe('empty session', () => {
    it('returns empty timeline when no spans or observations exist', () => {
      const timeline = buildSessionTimeline({
        db: testDb.db,
        sessionId: 'nonexistent',
      })

      expect(timeline.sessionId).toBe('nonexistent')
      expect(timeline.entries).toEqual([])
      expect(timeline.summary).toBeNull()
      expect(timeline.startTime).toBe('')
      expect(timeline.endTime).toBeNull()
      expect(timeline.durationMs).toBeNull()
    })

    it('returns empty timeline when observations do not match session', () => {
      const obs = makeObservation({
        tags: ['session-hook', 'session-id:other-session'],
      })

      const timeline = buildSessionTimeline({
        db: testDb.db,
        sessionId: 'test-session',
        observations: [obs],
      })

      expect(timeline.entries).toEqual([])
    })
  })

  // ── Spans to entries ────────────────────────────────────────

  describe('spans converted to timeline entries', () => {
    it('converts chat spans with token info', () => {
      insertSpans(testDb.db, [
        makeSpan({
          trace_id: 'trace-A',
          session_id: 'session-1',
          name: 'chat claude-sonnet-4',
          start_time: '2024-01-15T10:00:00.000Z',
          end_time: '2024-01-15T10:00:02.000Z',
          duration_ms: 2000,
          attributes_json: JSON.stringify({
            'gen_ai.usage.input_tokens': 500,
            'gen_ai.usage.output_tokens': 200,
          }),
        }),
      ])

      const timeline = buildSessionTimeline({
        db: testDb.db,
        sessionId: 'session-1',
      })

      expect(timeline.entries).toHaveLength(1)
      const entry = timeline.entries[0]!
      expect(entry.type).toBe('span')
      expect(entry.event).toBe('chat claude-sonnet-4')
      expect(entry.details).toContain('LLM call to claude-sonnet-4')
      expect(entry.details).toContain('500')
      expect(entry.details).toContain('200')
      expect(entry.durationMs).toBe(2000)
      expect(entry.metadata?.model).toBe('claude-sonnet-4')
    })

    it('converts tool execution spans', () => {
      insertSpans(testDb.db, [
        makeSpan({
          trace_id: 'trace-A',
          session_id: 'session-1',
          name: 'execute_tool bash',
          start_time: '2024-01-15T10:00:00.000Z',
          end_time: '2024-01-15T10:00:03.000Z',
          duration_ms: 3000,
        }),
      ])

      const timeline = buildSessionTimeline({
        db: testDb.db,
        sessionId: 'session-1',
      })

      expect(timeline.entries).toHaveLength(1)
      const entry = timeline.entries[0]!
      expect(entry.type).toBe('span')
      expect(entry.event).toBe('execute_tool bash')
      expect(entry.details).toContain('Tool execution: bash')
      expect(entry.details).toContain('3000ms')
      expect(entry.durationMs).toBe(3000)
      expect(entry.metadata?.tool).toBe('bash')
    })

    it('converts generic spans', () => {
      insertSpans(testDb.db, [
        makeSpan({
          trace_id: 'trace-A',
          session_id: 'session-1',
          name: 'invoke_agent',
          start_time: '2024-01-15T10:00:00.000Z',
          duration_ms: 5000,
        }),
      ])

      const timeline = buildSessionTimeline({
        db: testDb.db,
        sessionId: 'session-1',
      })

      expect(timeline.entries).toHaveLength(1)
      const entry = timeline.entries[0]!
      expect(entry.type).toBe('span')
      expect(entry.event).toBe('invoke_agent')
      expect(entry.details).toBe('invoke_agent')
    })

    it('marks error spans in metadata', () => {
      insertSpans(testDb.db, [
        makeSpan({
          trace_id: 'trace-A',
          session_id: 'session-1',
          name: 'execute_tool bash',
          status: 'ERROR',
        }),
      ])

      const timeline = buildSessionTimeline({
        db: testDb.db,
        sessionId: 'session-1',
      })

      expect(timeline.entries[0]!.metadata?.error).toBe(true)
    })
  })

  // ── Observations merged and sorted ──────────────────────────

  describe('observations merged and sorted chronologically', () => {
    it('merges hook observations into timeline sorted by timestamp', () => {
      insertSpans(testDb.db, [
        makeSpan({
          trace_id: 'trace-A',
          session_id: 'session-1',
          name: 'chat claude-sonnet-4',
          start_time: '2024-01-15T10:01:00.000Z',
          duration_ms: 1000,
        }),
      ])

      const obs = makeObservation({
        timestamp: '2024-01-15T10:00:30.000Z',
        source: 'session-start',
        content: 'Session session-1 started',
        tags: ['session-hook', 'session-start', 'session-id:session-1'],
      })

      const timeline = buildSessionTimeline({
        db: testDb.db,
        sessionId: 'session-1',
        observations: [obs],
      })

      expect(timeline.entries).toHaveLength(2)
      // Hook observation should come first (earlier timestamp)
      expect(timeline.entries[0]!.type).toBe('hook')
      expect(timeline.entries[0]!.event).toBe('session-start')
      expect(timeline.entries[1]!.type).toBe('span')
    })

    it('converts session-hook observations to hook type entries', () => {
      const obs = makeObservation({
        type: 'session-hook',
        source: 'tool-use',
        content: 'Tool used: bash',
        tags: ['session-hook', 'tool-use', 'session-id:session-1', 'tool:bash'],
        timestamp: '2024-01-15T10:00:00.000Z',
      })

      const timeline = buildSessionTimeline({
        db: testDb.db,
        sessionId: 'session-1',
        observations: [obs],
      })

      expect(timeline.entries).toHaveLength(1)
      const entry = timeline.entries[0]!
      expect(entry.type).toBe('hook')
      expect(entry.event).toBe('tool-use')
      expect(entry.details).toBe('Tool used: bash')
      expect(entry.metadata?.tool).toBe('bash')
    })

    it('converts non-hook observations to observation type entries', () => {
      const obs: Observation = {
        id: crypto.randomUUID(),
        type: 'git-activity',
        timestamp: '2024-01-15T10:00:00.000Z',
        source: 'my-project',
        content: 'Git commit: fix bug',
        tags: ['git-activity', 'session-id:session-1'],
      }

      const timeline = buildSessionTimeline({
        db: testDb.db,
        sessionId: 'session-1',
        observations: [obs],
      })

      expect(timeline.entries).toHaveLength(1)
      const entry = timeline.entries[0]!
      expect(entry.type).toBe('observation')
      expect(entry.event).toBe('my-project')
      expect(entry.details).toBe('Git commit: fix bug')
    })
  })

  // ── Hook observation filtering ──────────────────────────────

  describe('hook observations filtered by session-id tag', () => {
    it('includes observations matching session-id tag', () => {
      const matching = makeObservation({
        tags: ['session-hook', 'session-id:session-1'],
        content: 'Session session-1 started',
      })
      const nonMatching = makeObservation({
        tags: ['session-hook', 'session-id:session-2'],
        content: 'Session session-2 started',
      })

      const timeline = buildSessionTimeline({
        db: testDb.db,
        sessionId: 'session-1',
        observations: [matching, nonMatching],
      })

      expect(timeline.entries).toHaveLength(1)
      expect(timeline.entries[0]!.details).toBe('Session session-1 started')
    })

    it('includes observations matching trace tag from OTel summary', () => {
      // Insert spans with a trace ID for session-1
      insertSpans(testDb.db, [
        makeSpan({
          trace_id: 'trace-X',
          session_id: 'session-1',
          name: 'chat model',
          start_time: '2024-01-15T10:00:00.000Z',
        }),
      ])

      // Observation with trace tag (no session-id tag)
      const obs = makeObservation({
        tags: ['session-hook', 'tool-use', 'trace:trace-X'],
        content: 'Tool used: bash',
        timestamp: '2024-01-15T10:00:30.000Z',
      })

      const timeline = buildSessionTimeline({
        db: testDb.db,
        sessionId: 'session-1',
        observations: [obs],
      })

      // Should have the span entry + the observation matched by trace
      expect(timeline.entries).toHaveLength(2)
      expect(timeline.entries.some((e) => e.type === 'hook')).toBe(true)
    })

    it('extracts tag metadata from observations', () => {
      const obs = makeObservation({
        tags: [
          'session-hook',
          'session-id:session-1',
          'tool:edit',
          'model:claude-sonnet-4',
          'mcp:github-mcp-server',
          'skill:code-review',
        ],
        content: 'MCP tool used: github-mcp-server/edit',
      })

      const timeline = buildSessionTimeline({
        db: testDb.db,
        sessionId: 'session-1',
        observations: [obs],
      })

      const entry = timeline.entries[0]!
      expect(entry.metadata?.tool).toBe('edit')
      expect(entry.metadata?.model).toBe('claude-sonnet-4')
      expect(entry.metadata?.mcpServer).toBe('github-mcp-server')
      expect(entry.metadata?.skill).toBe('code-review')
    })
  })

  // ── Multiple sessions ───────────────────────────────────────

  describe('multiple sessions built correctly', () => {
    it('builds timelines for multiple OTel sessions', () => {
      insertSpans(testDb.db, [
        makeSpan({
          trace_id: 'trace-A',
          session_id: 'session-1',
          name: 'chat model-a',
          start_time: '2024-01-15T10:00:00.000Z',
          end_time: '2024-01-15T10:01:00.000Z',
          duration_ms: 60000,
        }),
        makeSpan({
          trace_id: 'trace-B',
          session_id: 'session-2',
          name: 'chat model-b',
          start_time: '2024-01-15T11:00:00.000Z',
          end_time: '2024-01-15T11:01:00.000Z',
          duration_ms: 60000,
        }),
      ])

      const timelines = buildRecentTimelines({ db: testDb.db })

      expect(timelines).toHaveLength(2)
      // Most recent first
      expect(timelines[0]!.sessionId).toBe('session-2')
      expect(timelines[1]!.sessionId).toBe('session-1')
    })

    it('discovers observation-only sessions not in OTel data', () => {
      // Only insert spans for session-1
      insertSpans(testDb.db, [
        makeSpan({
          trace_id: 'trace-A',
          session_id: 'session-1',
          name: 'chat model',
          start_time: '2024-01-15T10:00:00.000Z',
        }),
      ])

      // Observation for session-2 (no OTel data)
      const obs = makeObservation({
        tags: ['session-hook', 'session-id:session-2'],
        content: 'Session session-2 started',
        timestamp: '2024-01-15T11:00:00.000Z',
      })

      const timelines = buildRecentTimelines({
        db: testDb.db,
        observations: [obs],
      })

      expect(timelines).toHaveLength(2)
      const sessionIds = timelines.map((t) => t.sessionId)
      expect(sessionIds).toContain('session-1')
      expect(sessionIds).toContain('session-2')
    })

    it('respects limit parameter', () => {
      insertSpans(testDb.db, [
        makeSpan({
          trace_id: 'trace-A',
          session_id: 'session-1',
          name: 'chat model',
          start_time: '2024-01-15T10:00:00.000Z',
        }),
        makeSpan({
          trace_id: 'trace-B',
          session_id: 'session-2',
          name: 'chat model',
          start_time: '2024-01-15T11:00:00.000Z',
        }),
        makeSpan({
          trace_id: 'trace-C',
          session_id: 'session-3',
          name: 'chat model',
          start_time: '2024-01-15T12:00:00.000Z',
        }),
      ])

      const timelines = buildRecentTimelines({ db: testDb.db, limit: 2 })
      expect(timelines).toHaveLength(2)
      // Most recent first
      expect(timelines[0]!.sessionId).toBe('session-3')
      expect(timelines[1]!.sessionId).toBe('session-2')
    })
  })

  // ── Duration calculation ────────────────────────────────────

  describe('duration calculated from entries', () => {
    it('calculates duration from first to last entry', () => {
      insertSpans(testDb.db, [
        makeSpan({
          trace_id: 'trace-A',
          session_id: 'session-1',
          name: 'invoke_agent',
          start_time: '2024-01-15T10:00:00.000Z',
          duration_ms: 1000,
        }),
        makeSpan({
          trace_id: 'trace-A',
          session_id: 'session-1',
          name: 'chat model',
          start_time: '2024-01-15T10:05:00.000Z',
          duration_ms: 2000,
        }),
      ])

      const timeline = buildSessionTimeline({
        db: testDb.db,
        sessionId: 'session-1',
      })

      expect(timeline.startTime).toBe('2024-01-15T10:00:00.000Z')
      expect(timeline.endTime).toBe('2024-01-15T10:05:00.000Z')
      expect(timeline.durationMs).toBe(5 * 60 * 1000) // 5 minutes
    })

    it('includes observation timestamps in duration calculation', () => {
      insertSpans(testDb.db, [
        makeSpan({
          trace_id: 'trace-A',
          session_id: 'session-1',
          name: 'chat model',
          start_time: '2024-01-15T10:01:00.000Z',
          duration_ms: 1000,
        }),
      ])

      const obs = makeObservation({
        timestamp: '2024-01-15T10:00:00.000Z',
        tags: ['session-hook', 'session-start', 'session-id:session-1'],
        content: 'Session session-1 started',
      })

      const endObs = makeObservation({
        timestamp: '2024-01-15T10:10:00.000Z',
        source: 'session-end',
        tags: ['session-hook', 'session-end', 'session-id:session-1'],
        content: 'Session session-1 ended',
      })

      const timeline = buildSessionTimeline({
        db: testDb.db,
        sessionId: 'session-1',
        observations: [obs, endObs],
      })

      expect(timeline.startTime).toBe('2024-01-15T10:00:00.000Z')
      expect(timeline.endTime).toBe('2024-01-15T10:10:00.000Z')
      expect(timeline.durationMs).toBe(10 * 60 * 1000) // 10 minutes
    })

    it('returns null duration for single entry', () => {
      insertSpans(testDb.db, [
        makeSpan({
          trace_id: 'trace-A',
          session_id: 'session-1',
          name: 'chat model',
          start_time: '2024-01-15T10:00:00.000Z',
        }),
      ])

      const timeline = buildSessionTimeline({
        db: testDb.db,
        sessionId: 'session-1',
      })

      expect(timeline.entries).toHaveLength(1)
      expect(timeline.endTime).toBeNull()
      expect(timeline.durationMs).toBeNull()
    })
  })

  // ── Summary attached ────────────────────────────────────────

  describe('OTel summary attached', () => {
    it('includes OTel session summary when spans exist', () => {
      insertSpans(testDb.db, [
        makeSpan({
          trace_id: 'trace-A',
          session_id: 'session-1',
          name: 'chat claude-sonnet-4',
          start_time: '2024-01-15T10:00:00.000Z',
          end_time: '2024-01-15T10:01:00.000Z',
          duration_ms: 60000,
          attributes_json: JSON.stringify({
            'gen_ai.usage.input_tokens': 1000,
            'gen_ai.usage.output_tokens': 500,
          }),
        }),
      ])

      const timeline = buildSessionTimeline({
        db: testDb.db,
        sessionId: 'session-1',
      })

      expect(timeline.summary).not.toBeNull()
      expect(timeline.summary!.sessionId).toBe('session-1')
      expect(timeline.summary!.totalInputTokens).toBe(1000)
      expect(timeline.summary!.totalOutputTokens).toBe(500)
    })

    it('returns null summary for observation-only sessions', () => {
      const obs = makeObservation({
        tags: ['session-hook', 'session-id:obs-only'],
        content: 'Session obs-only started',
      })

      const timeline = buildSessionTimeline({
        db: testDb.db,
        sessionId: 'obs-only',
        observations: [obs],
      })

      expect(timeline.summary).toBeNull()
      expect(timeline.entries).toHaveLength(1)
    })
  })
})
