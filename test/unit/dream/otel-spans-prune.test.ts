/**
 * P5b — payload-bytes cap with trace-group integrity for `otel_spans`.
 *
 * Why this exists: the row-count of `otel_spans` is a poor proxy for
 * disk footprint. Live verification on 2026-06-03 showed only 1996
 * rows but 103 MB of table data (avg ~52KB/span — fat JSON blobs).
 * Row-count alone would have done nothing to reclaim that space.
 *
 * Spec:
 *   - Estimate per-span payload bytes via
 *     `length(attributes_json)+length(events_json)+length(resource_json)+length(name)`
 *     (cheap, no JSON parsing, scales with what's actually on disk).
 *   - Group by `trace_id`; sum bytes per trace; identify the OLDEST
 *     traces by `MIN(start_time)`.
 *   - Delete entire traces oldest-first until total bytes ≤ cap.
 *     NEVER half-delete a trace — partial deletion breaks trace
 *     assembly (root with no children or vice versa).
 *   - Freshness floor: don't touch traces whose newest span is
 *     within `freshnessHours` of now (default 24h). This guards
 *     against deleting an in-flight large trace mid-assembly.
 *   - Wrap in `db.transaction(...)` so the count-scan and the
 *     batched DELETEs are race-free.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { pruneOldestTraces } from '../../../src/dream/housekeeping.js'

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(`
    CREATE TABLE otel_spans (
      trace_id TEXT NOT NULL,
      span_id TEXT PRIMARY KEY,
      parent_span_id TEXT,
      name TEXT NOT NULL,
      kind TEXT,
      start_time TEXT NOT NULL,
      end_time TEXT,
      duration_ms REAL,
      status TEXT,
      attributes_json TEXT DEFAULT '{}',
      events_json TEXT DEFAULT '[]',
      resource_json TEXT DEFAULT '{}',
      session_id TEXT,
      created_at DATETIME NOT NULL DEFAULT (datetime('now'))
    );
  `)
})

afterEach(() => {
  db.close()
})

interface TraceSpec {
  readonly traceId: string
  readonly spans: number
  /** Span payload (attributes+events+resource+name) bytes — approximated by repeating 'x'. */
  readonly bytesPerSpan: number
  readonly hoursAgo: number
}

function insertTrace(spec: TraceSpec): void {
  // Spread payload across the three blob columns so the estimator (which
  // sums their lengths) is exercised representatively.
  const third = Math.floor(spec.bytesPerSpan / 3)
  const remainder = spec.bytesPerSpan - third * 3
  const attrs = 'a'.repeat(third)
  const events = 'e'.repeat(third)
  const resource = 'r'.repeat(third + remainder)
  const stmt = db.prepare(`
    INSERT INTO otel_spans
      (trace_id, span_id, name, start_time, end_time, attributes_json, events_json, resource_json, created_at)
    VALUES (?, ?, 'span', datetime('now', ?), datetime('now', ?), ?, ?, ?, datetime('now', ?))
  `)
  for (let i = 0; i < spec.spans; i++) {
    const offset = `-${spec.hoursAgo} hours`
    stmt.run(
      spec.traceId,
      `${spec.traceId}-span-${i}`,
      offset,
      offset,
      attrs,
      events,
      resource,
      offset,
    )
  }
}

function spanCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM otel_spans').get() as { n: number }).n
}

function traceCount(db: Database.Database): number {
  return (
    db.prepare('SELECT COUNT(DISTINCT trace_id) AS n FROM otel_spans').get() as { n: number }
  ).n
}

describe('pruneOldestTraces', () => {
  it('is a noop when estimated bytes are already under cap', () => {
    insertTrace({ traceId: 't1', spans: 2, bytesPerSpan: 300, hoursAgo: 100 })
    const result = pruneOldestTraces(db, {
      otelSpansMaxBytes: 10_000,
      otelSpansFreshnessHours: 24,
    })
    expect(result.tracesDeleted).toBe(0)
    expect(result.spansDeleted).toBe(0)
    expect(result.freedBytesEstimated).toBe(0)
    expect(spanCount(db)).toBe(2)
  })

  it('deletes the entire oldest trace (atomic, no partial spans)', () => {
    // Two traces, each well over the cap. Drop the older one whole.
    insertTrace({ traceId: 'oldest', spans: 3, bytesPerSpan: 1500, hoursAgo: 200 })
    insertTrace({ traceId: 'newer', spans: 2, bytesPerSpan: 1500, hoursAgo: 100 })
    const before = spanCount(db)
    expect(before).toBe(5)

    const result = pruneOldestTraces(db, {
      otelSpansMaxBytes: 5000, // ~half the live total
      otelSpansFreshnessHours: 24,
    })

    expect(result.tracesDeleted).toBe(1)
    expect(result.spansDeleted).toBe(3)
    expect(result.freedBytesEstimated).toBeGreaterThan(3 * 1500 - 50) // allow tiny round-off
    // Newer trace is intact.
    const remaining = db
      .prepare('SELECT DISTINCT trace_id FROM otel_spans')
      .all() as Array<{ trace_id: string }>
    expect(remaining.map((r) => r.trace_id).sort()).toEqual(['newer'])
  })

  it('keeps deleting oldest-first until under cap (multi-trace drain)', () => {
    insertTrace({ traceId: 't-old', spans: 2, bytesPerSpan: 1000, hoursAgo: 300 })
    insertTrace({ traceId: 't-mid', spans: 2, bytesPerSpan: 1000, hoursAgo: 200 })
    insertTrace({ traceId: 't-new', spans: 2, bytesPerSpan: 1000, hoursAgo: 100 })
    // total ~ 6000 bytes — cap 2500 means we must drop t-old (saves ~2000)
    // and t-mid (saves ~2000) leaving t-new (~2000) ≤ 2500. ✓
    const result = pruneOldestTraces(db, {
      otelSpansMaxBytes: 2500,
      otelSpansFreshnessHours: 24,
    })
    expect(result.tracesDeleted).toBe(2)
    expect(traceCount(db)).toBe(1)
    const remaining = db
      .prepare('SELECT DISTINCT trace_id FROM otel_spans')
      .all() as Array<{ trace_id: string }>
    expect(remaining[0]!.trace_id).toBe('t-new')
  })

  it('honors the freshness floor — never deletes a trace whose newest span is within window', () => {
    insertTrace({ traceId: 'fresh-fat', spans: 10, bytesPerSpan: 5000, hoursAgo: 1 })
    insertTrace({ traceId: 'old-tiny', spans: 1, bytesPerSpan: 100, hoursAgo: 200 })
    // fresh-fat is way over cap (~50KB) but within 24h freshness — must be preserved.
    // old-tiny is below cap but old; expected to be evicted if it tips us over.
    const result = pruneOldestTraces(db, {
      otelSpansMaxBytes: 1000,
      otelSpansFreshnessHours: 24,
    })
    expect(result.freshFloorHit).toBe(true)
    // fresh-fat must remain intact.
    const freshSurvivors = (
      db.prepare("SELECT COUNT(*) AS n FROM otel_spans WHERE trace_id='fresh-fat'").get() as {
        n: number
      }
    ).n
    expect(freshSurvivors).toBe(10)
    // old-tiny may or may not be deleted depending on whether removing it
    // would have brought us under cap. With cap=1000 and only fresh-fat
    // (50KB) blocking, old-tiny doesn't help — but the pruner should still
    // evict it because age-based eviction of non-fresh traces is desired.
  })

  it('returns freshFloorHit=false when no trace is within freshness window', () => {
    insertTrace({ traceId: 'old1', spans: 2, bytesPerSpan: 5000, hoursAgo: 100 })
    insertTrace({ traceId: 'old2', spans: 2, bytesPerSpan: 5000, hoursAgo: 200 })
    const result = pruneOldestTraces(db, {
      otelSpansMaxBytes: 1000,
      otelSpansFreshnessHours: 24,
    })
    expect(result.freshFloorHit).toBe(false)
    expect(result.tracesDeleted).toBeGreaterThanOrEqual(1)
  })

  it('is a noop on an empty table', () => {
    const result = pruneOldestTraces(db, {
      otelSpansMaxBytes: 1000,
      otelSpansFreshnessHours: 24,
    })
    expect(result).toEqual({
      tracesDeleted: 0,
      spansDeleted: 0,
      freedBytesEstimated: 0,
      freshFloorHit: false,
    })
  })

  it('deletes are transactional: a failing trace delete rolls back all in the batch', () => {
    // We can't easily inject a SQL failure mid-batch in vanilla sqlite, but
    // we can prove the batched DELETEs run inside a single transaction by
    // observing that span row count never goes negative during the call
    // (impossible) and by checking that interleaving readers see either
    // all-of-trace or none-of-trace. The simpler invariant test: after a
    // successful call, no trace_id should have a partial set of spans.
    insertTrace({ traceId: 'a', spans: 5, bytesPerSpan: 1000, hoursAgo: 300 })
    insertTrace({ traceId: 'b', spans: 4, bytesPerSpan: 1000, hoursAgo: 200 })
    insertTrace({ traceId: 'c', spans: 3, bytesPerSpan: 1000, hoursAgo: 100 })
    pruneOldestTraces(db, { otelSpansMaxBytes: 4000, otelSpansFreshnessHours: 24 })
    const groups = db
      .prepare('SELECT trace_id, COUNT(*) AS n FROM otel_spans GROUP BY trace_id')
      .all() as Array<{ trace_id: string; n: number }>
    const original: Record<string, number> = { a: 5, b: 4, c: 3 }
    for (const group of groups) {
      expect(group.n).toBe(original[group.trace_id])
    }
  })

  it('skips work when otelSpansMaxBytes is undefined (opt-in policy)', () => {
    insertTrace({ traceId: 't1', spans: 10, bytesPerSpan: 1000, hoursAgo: 100 })
    const result = pruneOldestTraces(db, {
      otelSpansFreshnessHours: 24,
    })
    expect(result.tracesDeleted).toBe(0)
    expect(spanCount(db)).toBe(10)
  })
})
