import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { TestDb } from '../../helpers/db-harness.js'
import { createOtelTestDb } from '../../helpers/otel-db-harness.js'
import { insertSpans } from '../../../src/otel/otel-repository.js'
import type { SpanInput } from '../../../src/otel/jsonl-parser.js'
import {
  extractSessionSummaries,
  extractSessionSummary,
} from '../../../src/otel/session-extractor.js'

describe('session-extractor', () => {
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

  beforeEach(() => {
    spanCounter = 0
  })

  // ── Empty DB ─────────────────────────────────────────────────

  describe('empty database', () => {
    it('returns empty array when no spans exist', () => {
      const result = extractSessionSummaries(testDb.db)
      expect(result).toEqual([])
    })

    it('extractSessionSummary returns undefined for unknown session', () => {
      const result = extractSessionSummary(testDb.db, 'nonexistent')
      expect(result).toBeUndefined()
    })
  })

  // ── Single session ───────────────────────────────────────────

  describe('single session with multiple spans', () => {
    it('groups spans into a single session summary', () => {
      insertSpans(testDb.db, [
        makeSpan({
          trace_id: 'trace-A',
          session_id: 'session-1',
          name: 'invoke_agent',
          start_time: '2024-01-15T10:00:00.000Z',
          end_time: '2024-01-15T10:00:05.000Z',
          duration_ms: 5000,
        }),
        makeSpan({
          trace_id: 'trace-A',
          session_id: 'session-1',
          name: 'chat openai/gpt-4',
          start_time: '2024-01-15T10:00:01.000Z',
          end_time: '2024-01-15T10:00:03.000Z',
          duration_ms: 2000,
          attributes_json: JSON.stringify({
            'gen_ai.usage.input_tokens': 100,
            'gen_ai.usage.output_tokens': 200,
          }),
        }),
        makeSpan({
          trace_id: 'trace-A',
          session_id: 'session-1',
          name: 'execute_tool grep',
          start_time: '2024-01-15T10:00:03.000Z',
          end_time: '2024-01-15T10:00:04.000Z',
          duration_ms: 1000,
        }),
      ])

      const results = extractSessionSummaries(testDb.db)
      expect(results).toHaveLength(1)

      const session = results[0]!
      expect(session.sessionId).toBe('session-1')
      expect(session.startTime).toBe('2024-01-15T10:00:00.000Z')
      expect(session.endTime).toBe('2024-01-15T10:00:05.000Z')
      expect(session.durationMs).toBe(5000)
      expect(session.spanCount).toBe(3)
      expect(session.traceIds).toEqual(['trace-A'])
    })
  })

  // ── Multiple sessions ────────────────────────────────────────

  describe('multiple sessions grouped correctly', () => {
    it('groups spans by session_id', () => {
      insertSpans(testDb.db, [
        makeSpan({
          trace_id: 'trace-A',
          session_id: 'session-1',
          name: 'invoke_agent',
          start_time: '2024-01-15T10:00:00.000Z',
        }),
        makeSpan({
          trace_id: 'trace-A',
          session_id: 'session-1',
          name: 'chat openai/gpt-4',
          start_time: '2024-01-15T10:00:01.000Z',
          attributes_json: JSON.stringify({
            'gen_ai.usage.input_tokens': 50,
            'gen_ai.usage.output_tokens': 100,
          }),
        }),
        makeSpan({
          trace_id: 'trace-B',
          session_id: 'session-2',
          name: 'invoke_agent',
          start_time: '2024-01-15T11:00:00.000Z',
        }),
        makeSpan({
          trace_id: 'trace-B',
          session_id: 'session-2',
          name: 'chat anthropic/claude-3',
          start_time: '2024-01-15T11:00:01.000Z',
          attributes_json: JSON.stringify({
            'gen_ai.usage.input_tokens': 200,
            'gen_ai.usage.output_tokens': 400,
          }),
        }),
      ])

      const results = extractSessionSummaries(testDb.db)
      expect(results).toHaveLength(2)

      // Most recent first
      const session2 = results[0]!
      expect(session2.sessionId).toBe('session-2')
      expect(session2.totalInputTokens).toBe(200)
      expect(session2.totalOutputTokens).toBe(400)

      const session1 = results[1]!
      expect(session1.sessionId).toBe('session-1')
      expect(session1.totalInputTokens).toBe(50)
      expect(session1.totalOutputTokens).toBe(100)
    })

    it('handles multiple traces within one session', () => {
      insertSpans(testDb.db, [
        makeSpan({
          trace_id: 'trace-A',
          session_id: 'session-1',
          name: 'invoke_agent',
          start_time: '2024-01-15T10:00:00.000Z',
          end_time: '2024-01-15T10:00:05.000Z',
        }),
        makeSpan({
          trace_id: 'trace-B',
          session_id: 'session-1',
          name: 'invoke_agent',
          start_time: '2024-01-15T10:05:00.000Z',
          end_time: '2024-01-15T10:05:03.000Z',
        }),
      ])

      const results = extractSessionSummaries(testDb.db)
      expect(results).toHaveLength(1)

      const session = results[0]!
      expect(session.sessionId).toBe('session-1')
      expect(session.traceIds).toEqual(['trace-A', 'trace-B'])
      expect(session.spanCount).toBe(2)
      expect(session.startTime).toBe('2024-01-15T10:00:00.000Z')
      expect(session.endTime).toBe('2024-01-15T10:05:03.000Z')
    })
  })

  // ── Token counting ───────────────────────────────────────────

  describe('token counting from attributes', () => {
    it('sums tokens only from chat spans', () => {
      insertSpans(testDb.db, [
        makeSpan({
          trace_id: 'trace-A',
          session_id: 'session-1',
          name: 'invoke_agent',
          attributes_json: JSON.stringify({
            'gen_ai.usage.input_tokens': 500,
            'gen_ai.usage.output_tokens': 1000,
          }),
        }),
        makeSpan({
          trace_id: 'trace-A',
          session_id: 'session-1',
          name: 'chat openai/gpt-4',
          attributes_json: JSON.stringify({
            'gen_ai.usage.input_tokens': 100,
            'gen_ai.usage.output_tokens': 200,
          }),
        }),
        makeSpan({
          trace_id: 'trace-A',
          session_id: 'session-1',
          name: 'chat openai/gpt-4',
          attributes_json: JSON.stringify({
            'gen_ai.usage.input_tokens': 150,
            'gen_ai.usage.output_tokens': 300,
          }),
        }),
      ])

      const results = extractSessionSummaries(testDb.db)
      const session = results[0]!
      // Only chat spans counted, not invoke_agent
      expect(session.totalInputTokens).toBe(250)
      expect(session.totalOutputTokens).toBe(500)
    })

    it('handles missing token attributes gracefully', () => {
      insertSpans(testDb.db, [
        makeSpan({
          trace_id: 'trace-A',
          session_id: 'session-1',
          name: 'chat openai/gpt-4',
          attributes_json: '{}',
        }),
      ])

      const results = extractSessionSummaries(testDb.db)
      const session = results[0]!
      expect(session.totalInputTokens).toBe(0)
      expect(session.totalOutputTokens).toBe(0)
    })

    it('handles invalid JSON in attributes gracefully', () => {
      insertSpans(testDb.db, [
        makeSpan({
          trace_id: 'trace-A',
          session_id: 'session-1',
          name: 'chat openai/gpt-4',
          attributes_json: '{invalid-json',
        }),
      ])

      const results = extractSessionSummaries(testDb.db)
      const session = results[0]!
      expect(session.totalInputTokens).toBe(0)
      expect(session.totalOutputTokens).toBe(0)
    })
  })

  // ── Model extraction ─────────────────────────────────────────

  describe('model extraction from chat spans', () => {
    it('extracts models with call counts', () => {
      insertSpans(testDb.db, [
        makeSpan({
          trace_id: 'trace-A',
          session_id: 'session-1',
          name: 'chat openai/gpt-4',
          attributes_json: JSON.stringify({
            'gen_ai.usage.input_tokens': 10,
            'gen_ai.usage.output_tokens': 20,
          }),
        }),
        makeSpan({
          trace_id: 'trace-A',
          session_id: 'session-1',
          name: 'chat openai/gpt-4',
          attributes_json: JSON.stringify({
            'gen_ai.usage.input_tokens': 10,
            'gen_ai.usage.output_tokens': 20,
          }),
        }),
        makeSpan({
          trace_id: 'trace-A',
          session_id: 'session-1',
          name: 'chat anthropic/claude-3',
          attributes_json: JSON.stringify({
            'gen_ai.usage.input_tokens': 10,
            'gen_ai.usage.output_tokens': 20,
          }),
        }),
      ])

      const results = extractSessionSummaries(testDb.db)
      const session = results[0]!
      expect(session.models).toHaveLength(2)
      // Sorted by count desc
      expect(session.models[0]).toEqual({ model: 'openai/gpt-4', callCount: 2 })
      expect(session.models[1]).toEqual({ model: 'anthropic/claude-3', callCount: 1 })
    })

    it('ignores non-chat spans for model extraction', () => {
      insertSpans(testDb.db, [
        makeSpan({
          trace_id: 'trace-A',
          session_id: 'session-1',
          name: 'invoke_agent',
        }),
        makeSpan({
          trace_id: 'trace-A',
          session_id: 'session-1',
          name: 'execute_tool grep',
        }),
      ])

      const results = extractSessionSummaries(testDb.db)
      const session = results[0]!
      expect(session.models).toEqual([])
    })
  })

  // ── Tool extraction ──────────────────────────────────────────

  describe('tool extraction from execute_tool spans', () => {
    it('extracts tools with call counts and avg duration', () => {
      insertSpans(testDb.db, [
        makeSpan({
          trace_id: 'trace-A',
          session_id: 'session-1',
          name: 'execute_tool grep',
          duration_ms: 100,
        }),
        makeSpan({
          trace_id: 'trace-A',
          session_id: 'session-1',
          name: 'execute_tool grep',
          duration_ms: 200,
        }),
        makeSpan({
          trace_id: 'trace-A',
          session_id: 'session-1',
          name: 'execute_tool view',
          duration_ms: 50,
        }),
      ])

      const results = extractSessionSummaries(testDb.db)
      const session = results[0]!
      expect(session.tools).toHaveLength(2)

      const grep = session.tools.find((t) => t.tool === 'grep')!
      expect(grep.callCount).toBe(2)
      expect(grep.avgDurationMs).toBe(150)

      const view = session.tools.find((t) => t.tool === 'view')!
      expect(view.callCount).toBe(1)
      expect(view.avgDurationMs).toBe(50)
    })

    it('handles null duration_ms', () => {
      insertSpans(testDb.db, [
        makeSpan({
          trace_id: 'trace-A',
          session_id: 'session-1',
          name: 'execute_tool grep',
          duration_ms: null,
          end_time: null,
        }),
      ])

      const results = extractSessionSummaries(testDb.db)
      const session = results[0]!
      const grep = session.tools.find((t) => t.tool === 'grep')!
      expect(grep.callCount).toBe(1)
      expect(grep.avgDurationMs).toBeNull()
    })
  })

  // ── MCP server detection ─────────────────────────────────────

  describe('MCP server detection', () => {
    it('extracts MCP server from tool name pattern', () => {
      insertSpans(testDb.db, [
        makeSpan({
          trace_id: 'trace-A',
          session_id: 'session-1',
          name: 'execute_tool github-mcp-server-search_code',
        }),
        makeSpan({
          trace_id: 'trace-A',
          session_id: 'session-1',
          name: 'execute_tool github-mcp-server-list_issues',
        }),
      ])

      const results = extractSessionSummaries(testDb.db)
      const session = results[0]!
      expect(session.mcpServers).toEqual(['github-mcp-server'])
    })

    it('extracts MCP server from attributes', () => {
      insertSpans(testDb.db, [
        makeSpan({
          trace_id: 'trace-A',
          session_id: 'session-1',
          name: 'execute_tool some_tool',
          attributes_json: JSON.stringify({ 'mcp.server': 'custom-server' }),
        }),
      ])

      const results = extractSessionSummaries(testDb.db)
      const session = results[0]!
      expect(session.mcpServers).toEqual(['custom-server'])
    })

    it('prefers attribute over name pattern', () => {
      insertSpans(testDb.db, [
        makeSpan({
          trace_id: 'trace-A',
          session_id: 'session-1',
          name: 'execute_tool github-mcp-server-search_code',
          attributes_json: JSON.stringify({ 'mcp.server': 'gh-server' }),
        }),
      ])

      const results = extractSessionSummaries(testDb.db)
      const session = results[0]!
      expect(session.mcpServers).toEqual(['gh-server'])
    })

    it('deduplicates MCP servers', () => {
      insertSpans(testDb.db, [
        makeSpan({
          trace_id: 'trace-A',
          session_id: 'session-1',
          name: 'execute_tool github-mcp-server-search_code',
        }),
        makeSpan({
          trace_id: 'trace-A',
          session_id: 'session-1',
          name: 'execute_tool github-mcp-server-list_issues',
        }),
        makeSpan({
          trace_id: 'trace-A',
          session_id: 'session-1',
          name: 'execute_tool filesystem-mcp-server-read',
        }),
      ])

      const results = extractSessionSummaries(testDb.db)
      const session = results[0]!
      expect(session.mcpServers).toEqual(['filesystem-mcp-server', 'github-mcp-server'])
    })
  })

  // ── Skill extraction ─────────────────────────────────────────

  describe('skill extraction', () => {
    it('extracts skills from attributes', () => {
      insertSpans(testDb.db, [
        makeSpan({
          trace_id: 'trace-A',
          session_id: 'session-1',
          name: 'execute_tool skill',
          attributes_json: JSON.stringify({ skill: 'pdf' }),
        }),
      ])

      const results = extractSessionSummaries(testDb.db)
      const session = results[0]!
      expect(session.skills).toEqual(['pdf'])
    })

    it('extracts skills from skill.name attribute', () => {
      insertSpans(testDb.db, [
        makeSpan({
          trace_id: 'trace-A',
          session_id: 'session-1',
          name: 'invoke_agent',
          attributes_json: JSON.stringify({ 'skill.name': 'research' }),
        }),
      ])

      const results = extractSessionSummaries(testDb.db)
      const session = results[0]!
      expect(session.skills).toEqual(['research'])
    })

    it('deduplicates skills', () => {
      insertSpans(testDb.db, [
        makeSpan({
          trace_id: 'trace-A',
          session_id: 'session-1',
          name: 'span-1',
          attributes_json: JSON.stringify({ skill: 'pdf' }),
        }),
        makeSpan({
          trace_id: 'trace-A',
          session_id: 'session-1',
          name: 'span-2',
          attributes_json: JSON.stringify({ skill: 'pdf' }),
        }),
      ])

      const results = extractSessionSummaries(testDb.db)
      const session = results[0]!
      expect(session.skills).toEqual(['pdf'])
    })
  })

  // ── Error counting ───────────────────────────────────────────

  describe('error counting', () => {
    it('counts spans with ERROR status', () => {
      insertSpans(testDb.db, [
        makeSpan({
          trace_id: 'trace-A',
          session_id: 'session-1',
          name: 'invoke_agent',
          status: 'OK',
        }),
        makeSpan({
          trace_id: 'trace-A',
          session_id: 'session-1',
          name: 'chat openai/gpt-4',
          status: 'ERROR',
          attributes_json: JSON.stringify({
            'gen_ai.usage.input_tokens': 10,
            'gen_ai.usage.output_tokens': 20,
          }),
        }),
        makeSpan({
          trace_id: 'trace-A',
          session_id: 'session-1',
          name: 'execute_tool grep',
          status: 'ERROR',
        }),
        makeSpan({
          trace_id: 'trace-A',
          session_id: 'session-1',
          name: 'execute_tool view',
          status: 'UNSET',
        }),
      ])

      const results = extractSessionSummaries(testDb.db)
      const session = results[0]!
      expect(session.errorCount).toBe(2)
    })
  })

  // ── since filter ─────────────────────────────────────────────

  describe('since filter', () => {
    it('only returns sessions with spans after the since timestamp', () => {
      insertSpans(testDb.db, [
        makeSpan({
          trace_id: 'trace-old',
          session_id: 'session-old',
          start_time: '2024-01-10T00:00:00.000Z',
          end_time: '2024-01-10T00:01:00.000Z',
        }),
        makeSpan({
          trace_id: 'trace-new',
          session_id: 'session-new',
          start_time: '2024-01-20T00:00:00.000Z',
          end_time: '2024-01-20T00:01:00.000Z',
        }),
      ])

      const results = extractSessionSummaries(testDb.db, {
        since: '2024-01-15T00:00:00.000Z',
      })
      expect(results).toHaveLength(1)
      expect(results[0]!.sessionId).toBe('session-new')
    })
  })

  // ── sessionId filter ─────────────────────────────────────────

  describe('sessionId filter', () => {
    it('returns only the specified session', () => {
      insertSpans(testDb.db, [
        makeSpan({
          trace_id: 'trace-A',
          session_id: 'session-1',
          start_time: '2024-01-15T10:00:00.000Z',
        }),
        makeSpan({
          trace_id: 'trace-B',
          session_id: 'session-2',
          start_time: '2024-01-15T11:00:00.000Z',
        }),
      ])

      const results = extractSessionSummaries(testDb.db, { sessionId: 'session-1' })
      expect(results).toHaveLength(1)
      expect(results[0]!.sessionId).toBe('session-1')
    })

    it('returns empty array for unknown sessionId', () => {
      insertSpans(testDb.db, [
        makeSpan({
          trace_id: 'trace-A',
          session_id: 'session-1',
        }),
      ])

      const results = extractSessionSummaries(testDb.db, { sessionId: 'nonexistent' })
      expect(results).toEqual([])
    })
  })

  // ── extractSessionSummary convenience wrapper ────────────────

  describe('extractSessionSummary', () => {
    it('returns a single session summary', () => {
      insertSpans(testDb.db, [
        makeSpan({
          trace_id: 'trace-A',
          session_id: 'session-1',
          name: 'chat openai/gpt-4',
          attributes_json: JSON.stringify({
            'gen_ai.usage.input_tokens': 100,
            'gen_ai.usage.output_tokens': 200,
          }),
        }),
      ])

      const result = extractSessionSummary(testDb.db, 'session-1')
      expect(result).toBeDefined()
      expect(result!.sessionId).toBe('session-1')
      expect(result!.totalInputTokens).toBe(100)
    })
  })

  // ── Fallback to trace_id ─────────────────────────────────────

  describe('session_id fallback to trace_id', () => {
    it('uses trace_id when session_id is null', () => {
      insertSpans(testDb.db, [
        makeSpan({
          trace_id: 'trace-no-session',
          session_id: null,
          name: 'invoke_agent',
          start_time: '2024-01-15T10:00:00.000Z',
          end_time: '2024-01-15T10:00:05.000Z',
        }),
        makeSpan({
          trace_id: 'trace-no-session',
          session_id: null,
          name: 'chat openai/gpt-4',
          start_time: '2024-01-15T10:00:01.000Z',
          end_time: '2024-01-15T10:00:03.000Z',
          attributes_json: JSON.stringify({
            'gen_ai.usage.input_tokens': 100,
            'gen_ai.usage.output_tokens': 200,
          }),
        }),
      ])

      const results = extractSessionSummaries(testDb.db)
      expect(results).toHaveLength(1)

      const session = results[0]!
      expect(session.sessionId).toBe('trace-no-session')
      expect(session.traceIds).toEqual(['trace-no-session'])
      expect(session.totalInputTokens).toBe(100)
    })

    it('uses session_id from any span in the trace for the whole trace', () => {
      // One span in the trace has session_id, another doesn't
      // Both should be grouped under the session_id
      insertSpans(testDb.db, [
        makeSpan({
          trace_id: 'trace-mixed',
          session_id: 'session-X',
          name: 'invoke_agent',
          start_time: '2024-01-15T10:00:00.000Z',
          end_time: '2024-01-15T10:00:05.000Z',
        }),
        makeSpan({
          trace_id: 'trace-mixed',
          session_id: null,
          name: 'chat openai/gpt-4',
          start_time: '2024-01-15T10:00:01.000Z',
          end_time: '2024-01-15T10:00:03.000Z',
          attributes_json: JSON.stringify({
            'gen_ai.usage.input_tokens': 100,
            'gen_ai.usage.output_tokens': 200,
          }),
        }),
      ])

      const results = extractSessionSummaries(testDb.db)
      expect(results).toHaveLength(1)

      const session = results[0]!
      expect(session.sessionId).toBe('session-X')
      expect(session.spanCount).toBe(2)
      expect(session.totalInputTokens).toBe(100)
    })

    it('keeps null-session trace separate from session-id trace', () => {
      insertSpans(testDb.db, [
        makeSpan({
          trace_id: 'trace-with-session',
          session_id: 'session-1',
          name: 'invoke_agent',
          start_time: '2024-01-15T10:00:00.000Z',
        }),
        makeSpan({
          trace_id: 'trace-without-session',
          session_id: null,
          name: 'invoke_agent',
          start_time: '2024-01-15T11:00:00.000Z',
        }),
      ])

      const results = extractSessionSummaries(testDb.db)
      expect(results).toHaveLength(2)

      const sessionIds = results.map((r) => r.sessionId).sort()
      expect(sessionIds).toEqual(['session-1', 'trace-without-session'])
    })
  })

  // ── Limit ────────────────────────────────────────────────────

  describe('limit option', () => {
    it('respects limit parameter', () => {
      insertSpans(testDb.db, [
        makeSpan({
          trace_id: 'trace-A',
          session_id: 'session-1',
          start_time: '2024-01-15T10:00:00.000Z',
        }),
        makeSpan({
          trace_id: 'trace-B',
          session_id: 'session-2',
          start_time: '2024-01-15T11:00:00.000Z',
        }),
        makeSpan({
          trace_id: 'trace-C',
          session_id: 'session-3',
          start_time: '2024-01-15T12:00:00.000Z',
        }),
      ])

      const results = extractSessionSummaries(testDb.db, { limit: 2 })
      expect(results).toHaveLength(2)
      // Most recent first
      expect(results[0]!.sessionId).toBe('session-3')
      expect(results[1]!.sessionId).toBe('session-2')
    })
  })

  // ── Duration computation ─────────────────────────────────────

  describe('duration computation', () => {
    it('computes duration from start to end', () => {
      insertSpans(testDb.db, [
        makeSpan({
          trace_id: 'trace-A',
          session_id: 'session-1',
          start_time: '2024-01-15T10:00:00.000Z',
          end_time: '2024-01-15T10:00:30.000Z',
        }),
      ])

      const results = extractSessionSummaries(testDb.db)
      expect(results[0]!.durationMs).toBe(30000)
    })

    it('returns null duration when no end_time', () => {
      insertSpans(testDb.db, [
        makeSpan({
          trace_id: 'trace-A',
          session_id: 'session-1',
          start_time: '2024-01-15T10:00:00.000Z',
          end_time: null,
        }),
      ])

      const results = extractSessionSummaries(testDb.db)
      expect(results[0]!.durationMs).toBeNull()
      expect(results[0]!.endTime).toBeNull()
    })
  })
})
