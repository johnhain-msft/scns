/**
 * Stress: OTel ingestion — 10k spans, batch insert, query, cleanup.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { applyOtelSchema } from '../../src/otel/db.js'
import { parseOtelLine, extractSpans, type SpanInput } from '../../src/otel/jsonl-parser.js'
import {
  insertSpans,
  findTraces,
  getMetricsSummary,
  cleanupOlderThan,
  getSpanCount,
} from '../../src/otel/otel-repository.js'

const SPAN_COUNT = 10_000

function generateSyntheticOtelLine(index: number): string {
  const traceId = randomUUID().replace(/-/g, '')
  const spanId = randomUUID().replace(/-/g, '').slice(0, 16)
  const parentSpanId = index % 3 === 0 ? null : randomUUID().replace(/-/g, '').slice(0, 16)

  const spanNames = [
    'execute_tool read_file',
    'execute_tool write_file',
    'execute_tool bash',
    'chat claude-sonnet-4-20250514',
    'chat claude-haiku-4-20250514',
    'http.request',
    'db.query',
    'custom_span',
  ]
  const name = spanNames[index % spanNames.length]!
  const statusCodes = [0, 1, 2] // UNSET, OK, ERROR
  const statusCode = statusCodes[index % statusCodes.length]!

  // Spread spans across time: start from 2025-01-01 and spread over 30 days
  const baseTimeMs = new Date('2025-01-01T00:00:00Z').getTime()
  const offsetMs = (index / SPAN_COUNT) * 30 * 24 * 60 * 60 * 1000
  const startTimeNano = BigInt(Math.floor(baseTimeMs + offsetMs)) * BigInt(1_000_000)
  const durationNano = BigInt(Math.floor(Math.random() * 5000 + 10)) * BigInt(1_000_000)
  const endTimeNano = startTimeNano + durationNano

  const record = {
    resourceSpans: [
      {
        resource: {
          attributes: [
            {
              key: 'session.id',
              value: { stringValue: `session-${index % 10}` },
            },
          ],
        },
        scopeSpans: [
          {
            scope: { name: 'scns' },
            spans: [
              {
                traceId,
                spanId,
                ...(parentSpanId ? { parentSpanId } : {}),
                name,
                kind: (index % 5) + 1,
                startTimeUnixNano: startTimeNano.toString(),
                endTimeUnixNano: endTimeNano.toString(),
                status: { code: statusCode },
                attributes: [
                  {
                    key: 'gen_ai.usage.input_tokens',
                    value: { intValue: String(Math.floor(Math.random() * 1000)) },
                  },
                  {
                    key: 'gen_ai.usage.output_tokens',
                    value: { intValue: String(Math.floor(Math.random() * 2000)) },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  }

  return JSON.stringify(record)
}

describe('OTel Ingestion Stress Test', { timeout: 60_000 }, () => {
  let db: Database.Database

  beforeAll(() => {
    db = new Database(':memory:')
    db.pragma('synchronous = NORMAL')
    db.pragma('foreign_keys = ON')
    applyOtelSchema(db)
  })

  afterAll(() => {
    db.close()
  })

  it(`parses and extracts ${SPAN_COUNT} spans from JSONL`, () => {
    const start = performance.now()
    const allSpans: SpanInput[] = []

    for (let i = 0; i < SPAN_COUNT; i++) {
      const line = generateSyntheticOtelLine(i)
      const record = parseOtelLine(line)
      expect(record).not.toBeNull()
      const spans = extractSpans(record!)
      allSpans.push(...(spans as SpanInput[]))
    }

    const elapsed = performance.now() - start
    console.log(
      `Parsed ${SPAN_COUNT} JSONL lines → ${allSpans.length} spans in ${elapsed.toFixed(1)}ms (${(allSpans.length / (elapsed / 1000)).toFixed(0)} spans/sec)`,
    )

    expect(allSpans.length).toBe(SPAN_COUNT)

    // Verify span structure
    const sample = allSpans[0]!
    expect(sample.trace_id).toBeDefined()
    expect(sample.span_id).toBeDefined()
    expect(sample.name).toBeDefined()
    expect(sample.start_time).toBeDefined()
    expect(sample.end_time).toBeDefined()
    expect(sample.duration_ms).toBeGreaterThan(0)
  })

  it(`inserts ${SPAN_COUNT} spans in batches`, () => {
    const allSpans: SpanInput[] = []
    for (let i = 0; i < SPAN_COUNT; i++) {
      const line = generateSyntheticOtelLine(i)
      const record = parseOtelLine(line)!
      allSpans.push(...(extractSpans(record) as SpanInput[]))
    }

    const start = performance.now()
    const BATCH_SIZE = 1000
    let totalInserted = 0

    for (let i = 0; i < allSpans.length; i += BATCH_SIZE) {
      const batch = allSpans.slice(i, i + BATCH_SIZE)
      totalInserted += insertSpans(db, batch)
    }

    const elapsed = performance.now() - start
    console.log(
      `Inserted ${totalInserted} spans in ${elapsed.toFixed(1)}ms (${(totalInserted / (elapsed / 1000)).toFixed(0)} spans/sec)`,
    )

    expect(totalInserted).toBe(SPAN_COUNT)
    expect(getSpanCount(db)).toBe(SPAN_COUNT)
  })

  it('queries traces across all inserted spans', () => {
    const start = performance.now()

    const traces = findTraces(db, { limit: 100 })
    const elapsed = performance.now() - start

    console.log(`Found ${traces.length} traces in ${elapsed.toFixed(1)}ms`)

    expect(traces.length).toBeGreaterThan(0)
    expect(traces.length).toBeLessThanOrEqual(100)

    // Each trace summary should have valid fields
    for (const trace of traces) {
      expect(trace.trace_id).toBeDefined()
      expect(trace.root_span_name).toBeDefined()
      expect(trace.span_count).toBeGreaterThan(0)
      expect(trace.start_time).toBeDefined()
    }
  })

  it('queries with filters work correctly', () => {
    // Filter by name
    const toolTraces = findTraces(db, { name: 'execute_tool', limit: 50 })
    expect(toolTraces.length).toBeGreaterThan(0)
    for (const trace of toolTraces) {
      expect(trace.root_span_name).toContain('execute_tool')
    }

    // Filter by status
    const errorTraces = findTraces(db, { status: 'ERROR', limit: 50 })
    expect(errorTraces.length).toBeGreaterThan(0)

    // Filter by time range
    const recentTraces = findTraces(db, {
      startAfter: '2025-01-15T00:00:00.000Z',
      startBefore: '2025-01-20T00:00:00.000Z',
      limit: 100,
    })
    expect(recentTraces.length).toBeGreaterThan(0)
  })

  it('metrics summary aggregates correctly', () => {
    const start = performance.now()
    const summary = getMetricsSummary(db)
    const elapsed = performance.now() - start

    console.log(
      `Metrics summary computed in ${elapsed.toFixed(1)}ms: ${summary.total_spans} spans, ${summary.error_count} errors`,
    )

    expect(summary.total_spans).toBe(SPAN_COUNT)
    expect(summary.total_input_tokens).toBeGreaterThan(0)
    expect(summary.total_output_tokens).toBeGreaterThan(0)
    expect(summary.avg_duration_ms).toBeGreaterThan(0)
    expect(summary.error_count).toBeGreaterThan(0)

    // Top tools should include execute_tool spans
    expect(summary.top_tools.length).toBeGreaterThan(0)
    const toolNames = summary.top_tools.map((t) => t.name)
    expect(toolNames).toEqual(expect.arrayContaining(['read_file']))

    // Model distribution should include chat models
    expect(summary.model_distribution.length).toBeGreaterThan(0)
  })

  it('concurrent reads during writes do not corrupt data', () => {
    // Generate another batch of spans
    const newSpans: SpanInput[] = []
    for (let i = SPAN_COUNT; i < SPAN_COUNT + 1000; i++) {
      const line = generateSyntheticOtelLine(i)
      const record = parseOtelLine(line)!
      newSpans.push(...(extractSpans(record) as SpanInput[]))
    }

    // Simulate interleaved reads and writes
    const readResults: number[] = []

    // Insert in batches, reading between each batch
    for (let i = 0; i < newSpans.length; i += 100) {
      const batch = newSpans.slice(i, i + 100)
      insertSpans(db, batch)
      readResults.push(getSpanCount(db))
    }

    // Each successive read should show monotonically increasing count
    for (let i = 1; i < readResults.length; i++) {
      expect(readResults[i]!).toBeGreaterThanOrEqual(readResults[i - 1]!)
    }

    // Final count should include all new spans
    expect(getSpanCount(db)).toBe(SPAN_COUNT + 1000)
  })

  it('cleanupOlderThan removes old spans under load', () => {
    const beforeCount = getSpanCount(db)
    expect(beforeCount).toBeGreaterThan(0)

    const start = performance.now()
    // Clean up spans before midpoint (Jan 15)
    const result = cleanupOlderThan(db, '2025-01-15T00:00:00.000Z')
    const elapsed = performance.now() - start

    console.log(`Cleanup deleted ${result.spansDeleted} spans in ${elapsed.toFixed(1)}ms`)

    expect(result.spansDeleted).toBeGreaterThan(0)
    expect(getSpanCount(db)).toBe(beforeCount - result.spansDeleted)

    // All remaining spans should be after the cutoff
    const remaining = findTraces(db, { limit: 1000 })
    for (const trace of remaining) {
      expect(trace.start_time >= '2025-01-15T00:00:00.000Z').toBe(true)
    }
  })
})
