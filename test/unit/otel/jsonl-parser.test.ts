import { describe, it, expect } from 'vitest'
import {
  parseOtelLine,
  extractSpans,
  extractMetrics,
  nanoToIso,
  kvToObject,
  spanKindToString,
  statusCodeToString,
} from '../../../src/otel/jsonl-parser.js'
import type { OtelRecord, KeyValue } from '../../../src/otel/jsonl-parser.js'

describe('jsonl-parser', () => {
  // ── Sample data ──────────────────────────────────────────────

  const sampleTraceJsonl = JSON.stringify({
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'copilot-cli' } },
            { key: 'session.id', value: { stringValue: 'sess-abc-123' } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: 'copilot' },
            spans: [
              {
                traceId: 'trace-001',
                spanId: 'span-root',
                name: 'invoke_agent',
                kind: 2,
                startTimeUnixNano: '1700000000000000000',
                endTimeUnixNano: '1700000005000000000',
                status: { code: 1 },
                attributes: [
                  { key: 'gen_ai.usage.input_tokens', value: { intValue: '150' } },
                  { key: 'gen_ai.usage.output_tokens', value: { intValue: '300' } },
                ],
                events: [
                  {
                    name: 'tool_call',
                    timeUnixNano: '1700000002000000000',
                    attributes: [{ key: 'tool', value: { stringValue: 'grep' } }],
                  },
                ],
              },
              {
                traceId: 'trace-001',
                spanId: 'span-child',
                parentSpanId: 'span-root',
                name: 'chat openai/gpt-4',
                kind: 3,
                startTimeUnixNano: '1700000001000000000',
                endTimeUnixNano: '1700000003000000000',
                status: { code: 0 },
                attributes: [],
              },
            ],
          },
        ],
      },
    ],
  })

  const sampleMetricJsonl = JSON.stringify({
    resourceMetrics: [
      {
        resource: {
          attributes: [{ key: 'service.name', value: { stringValue: 'copilot-cli' } }],
        },
        scopeMetrics: [
          {
            scope: { name: 'copilot' },
            metrics: [
              {
                name: 'http.client.request.duration',
                histogram: {
                  dataPoints: [
                    {
                      timeUnixNano: '1700000010000000000',
                      count: '5',
                      sum: 12.5,
                      attributes: [{ key: 'http.method', value: { stringValue: 'POST' } }],
                    },
                  ],
                },
              },
              {
                name: 'gen_ai.client.token.usage',
                sum: {
                  dataPoints: [
                    {
                      timeUnixNano: '1700000010000000000',
                      asInt: '450',
                      attributes: [{ key: 'token_type', value: { stringValue: 'input' } }],
                    },
                  ],
                },
              },
              {
                name: 'active_sessions',
                gauge: {
                  dataPoints: [
                    {
                      timeUnixNano: '1700000010000000000',
                      asDouble: 3.0,
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  })

  // ── parseOtelLine ────────────────────────────────────────────

  describe('parseOtelLine', () => {
    it('parses valid trace JSONL and returns OtelRecord with resourceSpans', () => {
      const result = parseOtelLine(sampleTraceJsonl)
      expect(result).not.toBeNull()
      expect(result!.resourceSpans).toBeDefined()
      expect(result!.resourceSpans).toHaveLength(1)
    })

    it('parses valid metric JSONL and returns OtelRecord with resourceMetrics', () => {
      const result = parseOtelLine(sampleMetricJsonl)
      expect(result).not.toBeNull()
      expect(result!.resourceMetrics).toBeDefined()
      expect(result!.resourceMetrics).toHaveLength(1)
    })

    it('returns null for invalid JSON', () => {
      expect(parseOtelLine('not json {')).toBeNull()
    })

    it('returns null for empty line', () => {
      expect(parseOtelLine('')).toBeNull()
      expect(parseOtelLine('   ')).toBeNull()
    })
  })

  // ── extractSpans ─────────────────────────────────────────────

  describe('extractSpans', () => {
    it('extracts correct fields from resourceSpans', () => {
      const record = parseOtelLine(sampleTraceJsonl)!
      const spans = extractSpans(record)
      expect(spans).toHaveLength(2)

      const root = spans.find((s) => s.span_id === 'span-root')!
      expect(root.trace_id).toBe('trace-001')
      expect(root.name).toBe('invoke_agent')
      expect(root.parent_span_id).toBeNull()
      expect(root.status).toBe('OK')
    })

    it('converts nanos to ISO 8601', () => {
      const record = parseOtelLine(sampleTraceJsonl)!
      const spans = extractSpans(record)
      const root = spans.find((s) => s.span_id === 'span-root')!

      // 1700000000 seconds from epoch = 2023-11-14T22:13:20.000Z
      expect(root.start_time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
      expect(root.end_time).not.toBeNull()
    })

    it('calculates duration_ms correctly', () => {
      const record = parseOtelLine(sampleTraceJsonl)!
      const spans = extractSpans(record)
      const root = spans.find((s) => s.span_id === 'span-root')!
      expect(root.duration_ms).toBe(5000)
    })

    it('maps span kind numbers to strings', () => {
      const record = parseOtelLine(sampleTraceJsonl)!
      const spans = extractSpans(record)
      const root = spans.find((s) => s.span_id === 'span-root')!
      expect(root.kind).toBe('SERVER')

      const child = spans.find((s) => s.span_id === 'span-child')!
      expect(child.kind).toBe('CLIENT')
    })

    it('maps status codes to strings', () => {
      const record = parseOtelLine(sampleTraceJsonl)!
      const spans = extractSpans(record)
      const root = spans.find((s) => s.span_id === 'span-root')!
      expect(root.status).toBe('OK')

      const child = spans.find((s) => s.span_id === 'span-child')!
      expect(child.status).toBe('UNSET')
    })

    it('extracts session_id from resource attributes if present', () => {
      const record = parseOtelLine(sampleTraceJsonl)!
      const spans = extractSpans(record)
      const root = spans.find((s) => s.span_id === 'span-root')!
      expect(root.session_id).toBe('sess-abc-123')
    })

    it('handles missing optional fields gracefully', () => {
      const minimal = JSON.stringify({
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: 't1',
                    spanId: 's1',
                    name: 'test',
                    startTimeUnixNano: '1700000000000000000',
                  },
                ],
              },
            ],
          },
        ],
      })
      const record = parseOtelLine(minimal)!
      const spans = extractSpans(record)
      expect(spans).toHaveLength(1)
      expect(spans[0]!.parent_span_id).toBeNull()
      expect(spans[0]!.kind).toBeNull()
      expect(spans[0]!.end_time).toBeNull()
      expect(spans[0]!.duration_ms).toBeNull()
      expect(spans[0]!.status).toBe('UNSET')
      expect(spans[0]!.session_id).toBeNull()
    })

    it('returns empty array when no resourceSpans', () => {
      const record: OtelRecord = {}
      expect(extractSpans(record)).toHaveLength(0)
    })

    it('serializes attributes and events as JSON strings', () => {
      const record = parseOtelLine(sampleTraceJsonl)!
      const spans = extractSpans(record)
      const root = spans.find((s) => s.span_id === 'span-root')!

      const attrs = JSON.parse(root.attributes_json)
      expect(attrs['gen_ai.usage.input_tokens']).toBe(150)

      const events = JSON.parse(root.events_json)
      expect(events).toHaveLength(1)
      expect(events[0].name).toBe('tool_call')
    })
  })

  // ── extractMetrics ───────────────────────────────────────────

  describe('extractMetrics', () => {
    it('extracts histogram data points', () => {
      const record = parseOtelLine(sampleMetricJsonl)!
      const metrics = extractMetrics(record)
      const histogram = metrics.find((m) => m.name === 'http.client.request.duration')!
      expect(histogram.metric_type).toBe('histogram')
      expect(histogram.value).toBe(12.5)
    })

    it('extracts counter/sum data points', () => {
      const record = parseOtelLine(sampleMetricJsonl)!
      const metrics = extractMetrics(record)
      const sum = metrics.find((m) => m.name === 'gen_ai.client.token.usage')!
      expect(sum.metric_type).toBe('sum')
      expect(sum.value).toBe(450)
    })

    it('handles gauge data points', () => {
      const record = parseOtelLine(sampleMetricJsonl)!
      const metrics = extractMetrics(record)
      const gauge = metrics.find((m) => m.name === 'active_sessions')!
      expect(gauge.metric_type).toBe('gauge')
      expect(gauge.value).toBe(3.0)
    })

    it('returns empty array when no resourceMetrics', () => {
      const record: OtelRecord = {}
      expect(extractMetrics(record)).toHaveLength(0)
    })

    it('converts timestamps to ISO 8601', () => {
      const record = parseOtelLine(sampleMetricJsonl)!
      const metrics = extractMetrics(record)
      expect(metrics[0]!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    })
  })

  // ── nanoToIso ────────────────────────────────────────────────

  describe('nanoToIso', () => {
    it('converts Unix nanoseconds to ISO 8601', () => {
      const result = nanoToIso('1700000000000000000')
      expect(result).toBe('2023-11-14T22:13:20.000Z')
    })

    it('preserves millisecond precision', () => {
      const result = nanoToIso('1700000000123000000')
      expect(result).toBe('2023-11-14T22:13:20.123Z')
    })
  })

  // ── kvToObject ───────────────────────────────────────────────

  describe('kvToObject', () => {
    it('flattens KeyValue arrays to plain objects', () => {
      const attrs: ReadonlyArray<KeyValue> = [
        { key: 'str', value: { stringValue: 'hello' } },
        { key: 'num', value: { intValue: '42' } },
        { key: 'dbl', value: { doubleValue: 3.14 } },
        { key: 'bool', value: { boolValue: true } },
      ]
      const result = kvToObject(attrs)
      expect(result).toEqual({
        str: 'hello',
        num: 42,
        dbl: 3.14,
        bool: true,
      })
    })

    it('handles empty input', () => {
      expect(kvToObject([])).toEqual({})
      expect(kvToObject(undefined)).toEqual({})
    })
  })

  // ── spanKindToString ────────────────────────────────────────

  describe('spanKindToString', () => {
    it('maps known kinds', () => {
      expect(spanKindToString(1)).toBe('INTERNAL')
      expect(spanKindToString(2)).toBe('SERVER')
      expect(spanKindToString(3)).toBe('CLIENT')
    })

    it('returns null for unknown/undefined', () => {
      expect(spanKindToString(0)).toBeNull()
      expect(spanKindToString(undefined)).toBeNull()
      expect(spanKindToString(99)).toBeNull()
    })
  })

  // ── statusCodeToString ──────────────────────────────────────

  describe('statusCodeToString', () => {
    it('maps status codes', () => {
      expect(statusCodeToString(0)).toBe('UNSET')
      expect(statusCodeToString(1)).toBe('OK')
      expect(statusCodeToString(2)).toBe('ERROR')
    })

    it('defaults to UNSET for undefined', () => {
      expect(statusCodeToString(undefined)).toBe('UNSET')
    })
  })

  // ── Copilot CLI flat format ───────────────────────────────────

  describe('extractSpans (Copilot flat format)', () => {
    const flatSpan = {
      type: 'span',
      traceId: 'abc123',
      spanId: 'def456',
      parentSpanId: 'parent789',
      name: 'execute_tool bash',
      kind: 0,
      startTime: [1775681769, 521000000],
      endTime: [1775681769, 526030146],
      attributes: {
        'github.copilot.external_tool.name': 'bash',
        'github.copilot.external_tool.call_id': 'toolu_123',
      },
      status: { code: 0 },
      events: [],
      resource: {
        attributes: { 'service.name': 'github-copilot', 'service.version': '1.0.21' },
      },
    }

    it('extracts span from Copilot flat format', () => {
      const spans = extractSpans(flatSpan as unknown as OtelRecord)
      expect(spans).toHaveLength(1)
      expect(spans[0].trace_id).toBe('abc123')
      expect(spans[0].span_id).toBe('def456')
      expect(spans[0].parent_span_id).toBe('parent789')
      expect(spans[0].name).toBe('execute_tool bash')
    })

    it('converts [seconds, nanos] timestamp to ISO string', () => {
      const spans = extractSpans(flatSpan as unknown as OtelRecord)
      expect(spans[0].start_time).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      expect(spans[0].end_time).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })

    it('computes duration_ms from timestamps', () => {
      const spans = extractSpans(flatSpan as unknown as OtelRecord)
      expect(spans[0].duration_ms).toBeCloseTo(5.03, 0)
    })

    it('preserves flat attributes as JSON', () => {
      const spans = extractSpans(flatSpan as unknown as OtelRecord)
      const attrs = JSON.parse(spans[0].attributes_json)
      expect(attrs['github.copilot.external_tool.name']).toBe('bash')
    })

    it('returns empty for non-span records', () => {
      expect(extractSpans({ type: 'metric' } as unknown as OtelRecord)).toHaveLength(0)
    })
  })

  describe('extractMetrics (Copilot flat format)', () => {
    const flatMetric = {
      type: 'metric',
      name: 'gen_ai.client.operation.duration',
      dataPoints: [
        {
          attributes: { 'gen_ai.operation.name': 'chat', 'gen_ai.response.model': 'claude-opus-4.6' },
          startTime: [1775681771, 230000000],
          endTime: [1775681820, 806000000],
          value: { min: 3.1, max: 12.1, sum: 55.59, count: 8 },
        },
      ],
    }

    it('extracts metric from Copilot flat format', () => {
      const metrics = extractMetrics(flatMetric as unknown as OtelRecord)
      expect(metrics).toHaveLength(1)
      expect(metrics[0].name).toBe('gen_ai.client.operation.duration')
      expect(metrics[0].value).toBeCloseTo(55.59, 1)
      expect(metrics[0].metric_type).toBe('histogram')
    })

    it('converts [seconds, nanos] timestamp', () => {
      const metrics = extractMetrics(flatMetric as unknown as OtelRecord)
      expect(metrics[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })

    it('preserves attributes', () => {
      const metrics = extractMetrics(flatMetric as unknown as OtelRecord)
      const attrs = JSON.parse(metrics[0].attributes_json)
      expect(attrs['gen_ai.response.model']).toBe('claude-opus-4.6')
    })

    it('returns empty for non-metric records', () => {
      expect(extractMetrics({ type: 'span' } as unknown as OtelRecord)).toHaveLength(0)
    })
  })
})
