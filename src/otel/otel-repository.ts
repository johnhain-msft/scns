/**
 * OTel repository — stores and queries OpenTelemetry spans and metrics.
 *
 * NOTE: OTel data is currently dashboard-only (read via /api/otel/* REST routes).
 * It is not yet integrated into the brain agent's decision loop, autonomy
 * evaluations, or suggestion pipeline. A future phase should feed OTel
 * insights (e.g. error-rate spikes, latency regressions, tool-usage patterns)
 * into the brain's observe→decide→act cycle so SCNS can proactively react
 * to telemetry signals.
 */

import type Database from 'better-sqlite3'
import type { SpanInput, MetricInput } from './jsonl-parser.js'

// ── Read types ───────────────────────────────────────────────

export interface OtelSpan {
  readonly trace_id: string
  readonly span_id: string
  readonly parent_span_id: string | null
  readonly name: string
  readonly kind: string | null
  readonly start_time: string
  readonly end_time: string | null
  readonly duration_ms: number | null
  readonly status: string | null
  readonly attributes_json: string
  readonly events_json: string
  readonly resource_json: string
  readonly session_id: string | null
  readonly created_at: string
}

export interface TraceSummary {
  readonly trace_id: string
  readonly root_span_name: string
  readonly span_count: number
  readonly start_time: string
  readonly duration_ms: number | null
  readonly status: string | null
  readonly total_tokens: number | null
}

export interface MetricsSummary {
  readonly total_spans: number
  readonly total_metrics: number
  readonly total_input_tokens: number
  readonly total_output_tokens: number
  readonly avg_duration_ms: number | null
  readonly top_tools: ReadonlyArray<{ name: string; count: number }>
  readonly model_distribution: ReadonlyArray<{ model: string; count: number }>
  readonly error_count: number
}

export interface TimeseriesBucket {
  readonly bucket: string
  readonly value: number
  readonly count: number
}

export interface FindTracesOptions {
  readonly limit?: number
  readonly offset?: number
  readonly startAfter?: string
  readonly startBefore?: string
  readonly name?: string
  readonly status?: string
}

export interface MetricsSummaryOptions {
  readonly since?: string
}

export interface TimeseriesOptions {
  readonly since?: string
  readonly interval?: 'hour' | 'day'
}

// ── Write operations ─────────────────────────────────────────

export function insertSpans(db: Database.Database, spans: ReadonlyArray<SpanInput>): number {
  if (spans.length === 0) return 0

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO otel_spans
      (trace_id, span_id, parent_span_id, name, kind, start_time, end_time,
       duration_ms, status, attributes_json, events_json, resource_json, session_id)
    VALUES
      (@trace_id, @span_id, @parent_span_id, @name, @kind, @start_time, @end_time,
       @duration_ms, @status, @attributes_json, @events_json, @resource_json, @session_id)
  `)

  let count = 0
  const tx = db.transaction(() => {
    for (const span of spans) {
      const result = stmt.run(span)
      count += result.changes
    }
  })
  tx()
  return count
}

export function insertMetrics(db: Database.Database, metrics: ReadonlyArray<MetricInput>): number {
  if (metrics.length === 0) return 0

  const stmt = db.prepare(`
    INSERT INTO otel_metrics
      (name, metric_type, value, attributes_json, resource_json, timestamp)
    VALUES
      (@name, @metric_type, @value, @attributes_json, @resource_json, @timestamp)
  `)

  let count = 0
  const tx = db.transaction(() => {
    for (const metric of metrics) {
      const result = stmt.run(metric)
      count += result.changes
    }
  })
  tx()
  return count
}

// ── Read operations ──────────────────────────────────────────

export function findTraces(
  db: Database.Database,
  options?: FindTracesOptions,
): ReadonlyArray<TraceSummary> {
  const conditions: string[] = []
  const params: unknown[] = []

  if (options?.startAfter) {
    conditions.push('s.start_time > ?')
    params.push(options.startAfter)
  }
  if (options?.startBefore) {
    conditions.push('s.start_time < ?')
    params.push(options.startBefore)
  }
  if (options?.name) {
    conditions.push('s.name LIKE ?')
    params.push(`%${options.name}%`)
  }
  if (options?.status) {
    conditions.push('s.status = ?')
    params.push(options.status)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const limit = options?.limit ?? 50
  const offset = options?.offset ?? 0

  const sql = `
    WITH trace_data AS (
      SELECT
        s.trace_id,
        s.name,
        s.parent_span_id,
        s.start_time,
        s.duration_ms,
        s.status,
        s.attributes_json,
        ROW_NUMBER() OVER (PARTITION BY s.trace_id ORDER BY s.start_time ASC) AS rn
      FROM otel_spans s
      ${where}
    )
    SELECT
      t.trace_id,
      (SELECT td2.name FROM trace_data td2
       WHERE td2.trace_id = t.trace_id AND (td2.parent_span_id IS NULL OR td2.rn = 1)
       ORDER BY td2.parent_span_id IS NULL DESC, td2.rn ASC LIMIT 1
      ) AS root_span_name,
      COUNT(*) AS span_count,
      MIN(t.start_time) AS start_time,
      MAX(t.duration_ms) AS duration_ms,
      (SELECT td3.status FROM trace_data td3
       WHERE td3.trace_id = t.trace_id AND (td3.parent_span_id IS NULL OR td3.rn = 1)
       ORDER BY td3.parent_span_id IS NULL DESC, td3.rn ASC LIMIT 1
      ) AS status,
      NULL AS total_tokens
    FROM trace_data t
    GROUP BY t.trace_id
    ORDER BY start_time DESC
    LIMIT ? OFFSET ?
  `

  params.push(limit, offset)
  const rows = db.prepare(sql).all(...params) as TraceSummary[]
  return rows.map((row) => ({ ...row }))
}

export function findSpansByTraceId(
  db: Database.Database,
  traceId: string,
): ReadonlyArray<OtelSpan> {
  const rows = db
    .prepare('SELECT * FROM otel_spans WHERE trace_id = ? ORDER BY start_time ASC')
    .all(traceId) as OtelSpan[]
  return rows.map((row) => ({ ...row }))
}

export function getMetricsSummary(
  db: Database.Database,
  options?: MetricsSummaryOptions,
): MetricsSummary {
  const sinceClause = options?.since ? 'WHERE start_time > ?' : ''
  const sinceParams = options?.since ? [options.since] : []

  const metricSinceClause = options?.since ? 'WHERE timestamp > ?' : ''

  // Total spans and metrics
  const spanRow = db
    .prepare(`SELECT COUNT(*) AS cnt FROM otel_spans ${sinceClause}`)
    .get(...sinceParams) as { cnt: number }

  const metricRow = db
    .prepare(`SELECT COUNT(*) AS cnt FROM otel_metrics ${metricSinceClause}`)
    .get(...sinceParams) as { cnt: number }

  // Token totals from span attributes
  const spanRows = db
    .prepare(`SELECT attributes_json FROM otel_spans ${sinceClause}`)
    .all(...sinceParams) as Array<{ attributes_json: string }>

  let totalInputTokens = 0
  let totalOutputTokens = 0
  for (const row of spanRows) {
    try {
      const attrs = JSON.parse(row.attributes_json) as Record<string, unknown>
      const inp = attrs['gen_ai.usage.input_tokens']
      const out = attrs['gen_ai.usage.output_tokens']
      if (typeof inp === 'number') totalInputTokens += inp
      if (typeof out === 'number') totalOutputTokens += out
    } catch {
      // skip invalid JSON
    }
  }

  // Average duration
  const avgRow = db
    .prepare(`SELECT AVG(duration_ms) AS avg_dur FROM otel_spans ${sinceClause}`)
    .get(...sinceParams) as { avg_dur: number | null }

  // Top tools: span names like 'execute_tool <tool_name>'
  const toolRows = db
    .prepare(
      `SELECT SUBSTR(name, 14) AS tool_name, COUNT(*) AS cnt
       FROM otel_spans
       ${sinceClause ? sinceClause + " AND name LIKE 'execute_tool %'" : "WHERE name LIKE 'execute_tool %'"}
       GROUP BY tool_name
       ORDER BY cnt DESC
       LIMIT 10`,
    )
    .all(...sinceParams) as Array<{ tool_name: string; cnt: number }>

  // Model distribution: span names like 'chat <model>'
  const modelRows = db
    .prepare(
      `SELECT SUBSTR(name, 6) AS model_name, COUNT(*) AS cnt
       FROM otel_spans
       ${sinceClause ? sinceClause + " AND name LIKE 'chat %'" : "WHERE name LIKE 'chat %'"}
       GROUP BY model_name
       ORDER BY cnt DESC
       LIMIT 10`,
    )
    .all(...sinceParams) as Array<{ model_name: string; cnt: number }>

  // Error count
  const errorRow = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM otel_spans ${sinceClause ? sinceClause + " AND status = 'ERROR'" : "WHERE status = 'ERROR'"}`,
    )
    .get(...sinceParams) as { cnt: number }

  return {
    total_spans: spanRow.cnt,
    total_metrics: metricRow.cnt,
    total_input_tokens: totalInputTokens,
    total_output_tokens: totalOutputTokens,
    avg_duration_ms: avgRow.avg_dur,
    top_tools: toolRows.map((r) => ({ name: r.tool_name, count: r.cnt })),
    model_distribution: modelRows.map((r) => ({
      model: r.model_name,
      count: r.cnt,
    })),
    error_count: errorRow.cnt,
  }
}

export function getMetricsTimeseries(
  db: Database.Database,
  metricName: string,
  options?: TimeseriesOptions,
): ReadonlyArray<TimeseriesBucket> {
  const interval = options?.interval ?? 'hour'
  const truncFormat = interval === 'day' ? '%Y-%m-%dT00:00:00.000Z' : '%Y-%m-%dT%H:00:00.000Z'

  const conditions: string[] = ['name = ?']
  const params: unknown[] = [metricName]

  if (options?.since) {
    conditions.push('timestamp > ?')
    params.push(options.since)
  }

  const where = conditions.join(' AND ')

  const sql = `
    SELECT
      strftime('${truncFormat}', timestamp) AS bucket,
      SUM(value) AS value,
      COUNT(*) AS count
    FROM otel_metrics
    WHERE ${where}
    GROUP BY bucket
    ORDER BY bucket ASC
  `

  const rows = db.prepare(sql).all(...params) as TimeseriesBucket[]
  return rows.map((r) => ({ ...r }))
}

export function cleanupOlderThan(
  db: Database.Database,
  beforeDate: string,
): { spansDeleted: number; metricsDeleted: number } {
  const spanResult = db.prepare('DELETE FROM otel_spans WHERE start_time < ?').run(beforeDate)
  const metricResult = db.prepare('DELETE FROM otel_metrics WHERE timestamp < ?').run(beforeDate)

  return {
    spansDeleted: spanResult.changes,
    metricsDeleted: metricResult.changes,
  }
}

export function getSpanCount(db: Database.Database): number {
  const row = db.prepare('SELECT COUNT(*) AS cnt FROM otel_spans').get() as {
    cnt: number
  }
  return row.cnt
}

export function getMetricCount(db: Database.Database): number {
  const row = db.prepare('SELECT COUNT(*) AS cnt FROM otel_metrics').get() as { cnt: number }
  return row.cnt
}
