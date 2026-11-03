import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { TestDb } from '../../helpers/db-harness.js'
import { createOtelTestDb } from '../../helpers/otel-db-harness.js'
import {
  insertSpans,
  insertMetrics,
  findTraces,
  findSpansByTraceId,
  getMetricsSummary,
  getMetricsTimeseries,
  cleanupOlderThan,
  getSpanCount,
  getMetricCount,
} from '../../../src/otel/otel-repository.js'
import type { SpanInput, MetricInput } from '../../../src/otel/jsonl-parser.js'

describe('otel-repository', () => {
  let testDb: TestDb

  beforeEach(() => {
    testDb = createOtelTestDb()
  })

  afterEach(() => {
    testDb.close()
  })

  // ── Test data helpers ────────────────────────────────────────

  function makeSpan(overrides?: Partial<SpanInput>): SpanInput {
    return {
      trace_id: 'trace-001',
      span_id: `span-${Math.random().toString(36).slice(2, 8)}`,
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

  function makeMetric(overrides?: Partial<MetricInput>): MetricInput {
    return {
      name: 'test.metric',
      metric_type: 'counter',
      value: 1.0,
      attributes_json: '{}',
      resource_json: '{}',
      timestamp: '2024-01-15T10:00:00.000Z',
      ...overrides,
    }
  }

  // ── insertSpans ──────────────────────────────────────────────

  describe('insertSpans', () => {
    it('inserts spans and returns count', () => {
      const spans = [makeSpan({ span_id: 's1' }), makeSpan({ span_id: 's2' })]
      const count = insertSpans(testDb.db, spans)
      expect(count).toBe(2)
      expect(getSpanCount(testDb.db)).toBe(2)
    })

    it('skips duplicates (same span_id)', () => {
      const span = makeSpan({ span_id: 'dup-1' })
      insertSpans(testDb.db, [span])
      const count = insertSpans(testDb.db, [span])
      expect(count).toBe(0)
      expect(getSpanCount(testDb.db)).toBe(1)
    })

    it('returns 0 for empty array', () => {
      expect(insertSpans(testDb.db, [])).toBe(0)
    })
  })

  // ── insertMetrics ────────────────────────────────────────────

  describe('insertMetrics', () => {
    it('inserts metrics and returns count', () => {
      const metrics = [makeMetric(), makeMetric({ name: 'other.metric' })]
      const count = insertMetrics(testDb.db, metrics)
      expect(count).toBe(2)
      expect(getMetricCount(testDb.db)).toBe(2)
    })
  })

  // ── findTraces ───────────────────────────────────────────────

  describe('findTraces', () => {
    it('returns trace summaries grouped by trace_id', () => {
      insertSpans(testDb.db, [
        makeSpan({ trace_id: 'trace-A', span_id: 'sA1', parent_span_id: null, name: 'root-A' }),
        makeSpan({ trace_id: 'trace-A', span_id: 'sA2', parent_span_id: 'sA1', name: 'child-A' }),
        makeSpan({ trace_id: 'trace-B', span_id: 'sB1', parent_span_id: null, name: 'root-B' }),
      ])

      const traces = findTraces(testDb.db)
      expect(traces).toHaveLength(2)

      const traceA = traces.find((t) => t.trace_id === 'trace-A')!
      expect(traceA.span_count).toBe(2)
      expect(traceA.root_span_name).toBe('root-A')
    })

    it('filters by time range', () => {
      insertSpans(testDb.db, [
        makeSpan({ trace_id: 't1', span_id: 's1', start_time: '2024-01-10T00:00:00.000Z' }),
        makeSpan({ trace_id: 't2', span_id: 's2', start_time: '2024-01-20T00:00:00.000Z' }),
      ])

      const traces = findTraces(testDb.db, { startAfter: '2024-01-15T00:00:00.000Z' })
      expect(traces).toHaveLength(1)
      expect(traces[0]!.trace_id).toBe('t2')
    })

    it('filters by name', () => {
      insertSpans(testDb.db, [
        makeSpan({ trace_id: 't1', span_id: 's1', name: 'invoke_agent' }),
        makeSpan({ trace_id: 't2', span_id: 's2', name: 'chat openai/gpt-4' }),
      ])

      const traces = findTraces(testDb.db, { name: 'invoke_agent' })
      expect(traces).toHaveLength(1)
      expect(traces[0]!.trace_id).toBe('t1')
    })

    it('filters by status', () => {
      insertSpans(testDb.db, [
        makeSpan({ trace_id: 't1', span_id: 's1', status: 'OK' }),
        makeSpan({ trace_id: 't2', span_id: 's2', status: 'ERROR' }),
      ])

      const traces = findTraces(testDb.db, { status: 'ERROR' })
      expect(traces).toHaveLength(1)
      expect(traces[0]!.trace_id).toBe('t2')
    })

    it('supports limit/offset pagination', () => {
      insertSpans(testDb.db, [
        makeSpan({ trace_id: 't1', span_id: 's1', start_time: '2024-01-01T00:00:00.000Z' }),
        makeSpan({ trace_id: 't2', span_id: 's2', start_time: '2024-01-02T00:00:00.000Z' }),
        makeSpan({ trace_id: 't3', span_id: 's3', start_time: '2024-01-03T00:00:00.000Z' }),
      ])

      const page1 = findTraces(testDb.db, { limit: 2 })
      expect(page1).toHaveLength(2)

      const page2 = findTraces(testDb.db, { limit: 2, offset: 2 })
      expect(page2).toHaveLength(1)
    })
  })

  // ── findSpansByTraceId ───────────────────────────────────────

  describe('findSpansByTraceId', () => {
    it('returns all spans for a trace ordered by start_time', () => {
      insertSpans(testDb.db, [
        makeSpan({
          trace_id: 'trace-X',
          span_id: 'sX2',
          start_time: '2024-01-15T10:00:02.000Z',
          name: 'child',
          parent_span_id: 'sX1',
        }),
        makeSpan({
          trace_id: 'trace-X',
          span_id: 'sX1',
          start_time: '2024-01-15T10:00:00.000Z',
          name: 'root',
        }),
      ])

      const spans = findSpansByTraceId(testDb.db, 'trace-X')
      expect(spans).toHaveLength(2)
      expect(spans[0]!.span_id).toBe('sX1')
      expect(spans[1]!.span_id).toBe('sX2')
    })

    it('returns empty array for unknown trace', () => {
      expect(findSpansByTraceId(testDb.db, 'nonexistent')).toHaveLength(0)
    })
  })

  // ── getMetricsSummary ────────────────────────────────────────

  describe('getMetricsSummary', () => {
    it('aggregates totals correctly', () => {
      insertSpans(testDb.db, [
        makeSpan({
          span_id: 's1',
          name: 'invoke_agent',
          attributes_json: JSON.stringify({
            'gen_ai.usage.input_tokens': 100,
            'gen_ai.usage.output_tokens': 200,
          }),
          duration_ms: 1000,
        }),
        makeSpan({
          span_id: 's2',
          name: 'chat openai/gpt-4',
          attributes_json: JSON.stringify({
            'gen_ai.usage.input_tokens': 50,
            'gen_ai.usage.output_tokens': 150,
          }),
          duration_ms: 2000,
        }),
      ])
      insertMetrics(testDb.db, [makeMetric(), makeMetric()])

      const summary = getMetricsSummary(testDb.db)
      expect(summary.total_spans).toBe(2)
      expect(summary.total_metrics).toBe(2)
      expect(summary.total_input_tokens).toBe(150)
      expect(summary.total_output_tokens).toBe(350)
      expect(summary.avg_duration_ms).toBe(1500)
    })

    it('counts top tools from span names starting with execute_tool', () => {
      insertSpans(testDb.db, [
        makeSpan({ span_id: 's1', name: 'execute_tool grep' }),
        makeSpan({ span_id: 's2', name: 'execute_tool grep' }),
        makeSpan({ span_id: 's3', name: 'execute_tool view' }),
        makeSpan({ span_id: 's4', name: 'chat openai/gpt-4' }),
      ])

      const summary = getMetricsSummary(testDb.db)
      expect(summary.top_tools).toHaveLength(2)
      expect(summary.top_tools[0]!.name).toBe('grep')
      expect(summary.top_tools[0]!.count).toBe(2)
      expect(summary.top_tools[1]!.name).toBe('view')
    })

    it('counts model distribution from chat span names', () => {
      insertSpans(testDb.db, [
        makeSpan({ span_id: 's1', name: 'chat openai/gpt-4' }),
        makeSpan({ span_id: 's2', name: 'chat openai/gpt-4' }),
        makeSpan({ span_id: 's3', name: 'chat anthropic/claude-3' }),
      ])

      const summary = getMetricsSummary(testDb.db)
      expect(summary.model_distribution).toHaveLength(2)
      const gpt4 = summary.model_distribution.find((m) => m.model === 'openai/gpt-4')!
      expect(gpt4.count).toBe(2)
    })

    it('counts errors', () => {
      insertSpans(testDb.db, [
        makeSpan({ span_id: 's1', status: 'ERROR' }),
        makeSpan({ span_id: 's2', status: 'OK' }),
        makeSpan({ span_id: 's3', status: 'ERROR' }),
      ])

      const summary = getMetricsSummary(testDb.db)
      expect(summary.error_count).toBe(2)
    })

    it('filters by since', () => {
      insertSpans(testDb.db, [
        makeSpan({ span_id: 's1', start_time: '2024-01-10T00:00:00.000Z' }),
        makeSpan({ span_id: 's2', start_time: '2024-01-20T00:00:00.000Z' }),
      ])

      const summary = getMetricsSummary(testDb.db, { since: '2024-01-15T00:00:00.000Z' })
      expect(summary.total_spans).toBe(1)
    })
  })

  // ── getMetricsTimeseries ─────────────────────────────────────

  describe('getMetricsTimeseries', () => {
    it('buckets by hour', () => {
      insertMetrics(testDb.db, [
        makeMetric({ name: 'req.count', value: 10, timestamp: '2024-01-15T10:05:00.000Z' }),
        makeMetric({ name: 'req.count', value: 20, timestamp: '2024-01-15T10:30:00.000Z' }),
        makeMetric({ name: 'req.count', value: 5, timestamp: '2024-01-15T11:05:00.000Z' }),
      ])

      const ts = getMetricsTimeseries(testDb.db, 'req.count')
      expect(ts).toHaveLength(2)
      expect(ts[0]!.count).toBe(2)
      expect(ts[0]!.value).toBe(30) // 10 + 20
      expect(ts[1]!.count).toBe(1)
    })

    it('supports custom interval', () => {
      insertMetrics(testDb.db, [
        makeMetric({ name: 'req.count', value: 10, timestamp: '2024-01-15T10:05:00.000Z' }),
        makeMetric({ name: 'req.count', value: 20, timestamp: '2024-01-16T10:05:00.000Z' }),
      ])

      const ts = getMetricsTimeseries(testDb.db, 'req.count', { interval: 'day' })
      expect(ts).toHaveLength(2)
    })
  })

  // ── cleanupOlderThan ─────────────────────────────────────────

  describe('cleanupOlderThan', () => {
    it('deletes old spans and metrics', () => {
      insertSpans(testDb.db, [
        makeSpan({ span_id: 'old', start_time: '2023-01-01T00:00:00.000Z' }),
        makeSpan({ span_id: 'new', start_time: '2024-12-01T00:00:00.000Z' }),
      ])
      insertMetrics(testDb.db, [
        makeMetric({ timestamp: '2023-01-01T00:00:00.000Z' }),
        makeMetric({ timestamp: '2024-12-01T00:00:00.000Z' }),
      ])

      const result = cleanupOlderThan(testDb.db, '2024-01-01T00:00:00.000Z')
      expect(result.spansDeleted).toBe(1)
      expect(result.metricsDeleted).toBe(1)
    })

    it('preserves recent data', () => {
      insertSpans(testDb.db, [
        makeSpan({ span_id: 'recent', start_time: '2024-12-01T00:00:00.000Z' }),
      ])

      const result = cleanupOlderThan(testDb.db, '2024-01-01T00:00:00.000Z')
      expect(result.spansDeleted).toBe(0)
      expect(getSpanCount(testDb.db)).toBe(1)
    })
  })

  // ── getSpanCount / getMetricCount ───────────────────────────

  describe('getSpanCount', () => {
    it('returns total count', () => {
      expect(getSpanCount(testDb.db)).toBe(0)
      insertSpans(testDb.db, [makeSpan({ span_id: 's1' }), makeSpan({ span_id: 's2' })])
      expect(getSpanCount(testDb.db)).toBe(2)
    })
  })

  describe('getMetricCount', () => {
    it('returns total count', () => {
      expect(getMetricCount(testDb.db)).toBe(0)
      insertMetrics(testDb.db, [makeMetric()])
      expect(getMetricCount(testDb.db)).toBe(1)
    })
  })
})
