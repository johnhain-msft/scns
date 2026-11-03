// ── OTel JSONL Types ──────────────────────────────────────────

export interface OtelRecord {
  readonly resourceSpans?: ReadonlyArray<ResourceSpans>
  readonly resourceMetrics?: ReadonlyArray<ResourceMetrics>
}

export interface ResourceSpans {
  readonly resource?: { readonly attributes?: ReadonlyArray<KeyValue> }
  readonly scopeSpans?: ReadonlyArray<{
    readonly scope?: { readonly name?: string }
    readonly spans?: ReadonlyArray<RawSpan>
  }>
}

export interface RawSpan {
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId?: string
  readonly name: string
  readonly kind?: number
  readonly startTimeUnixNano: string
  readonly endTimeUnixNano?: string
  readonly status?: { readonly code?: number; readonly message?: string }
  readonly attributes?: ReadonlyArray<KeyValue>
  readonly events?: ReadonlyArray<SpanEvent>
}

export interface KeyValue {
  readonly key: string
  readonly value: {
    readonly stringValue?: string
    readonly intValue?: string
    readonly doubleValue?: number
    readonly boolValue?: boolean
  }
}

export interface SpanEvent {
  readonly name: string
  readonly timeUnixNano: string
  readonly attributes?: ReadonlyArray<KeyValue>
}

export interface ResourceMetrics {
  readonly resource?: { readonly attributes?: ReadonlyArray<KeyValue> }
  readonly scopeMetrics?: ReadonlyArray<{
    readonly scope?: { readonly name?: string }
    readonly metrics?: ReadonlyArray<RawMetric>
  }>
}

export interface RawMetric {
  readonly name: string
  readonly histogram?: { readonly dataPoints?: ReadonlyArray<DataPoint> }
  readonly sum?: { readonly dataPoints?: ReadonlyArray<DataPoint> }
  readonly gauge?: { readonly dataPoints?: ReadonlyArray<DataPoint> }
}

export interface DataPoint {
  readonly timeUnixNano: string
  readonly asDouble?: number
  readonly asInt?: string
  readonly count?: string
  readonly sum?: number
  readonly attributes?: ReadonlyArray<KeyValue>
}

// ── Output types for DB insertion ────────────────────────────

export interface SpanInput {
  readonly trace_id: string
  readonly span_id: string
  readonly parent_span_id: string | null
  readonly name: string
  readonly kind: string | null
  readonly start_time: string
  readonly end_time: string | null
  readonly duration_ms: number | null
  readonly status: 'OK' | 'ERROR' | 'UNSET'
  readonly attributes_json: string
  readonly events_json: string
  readonly resource_json: string
  readonly session_id: string | null
}

export interface MetricInput {
  readonly name: string
  readonly metric_type: 'histogram' | 'counter' | 'gauge' | 'sum'
  readonly value: number
  readonly attributes_json: string
  readonly resource_json: string
  readonly timestamp: string
}

// ── Conversion helpers ───────────────────────────────────────

export function nanoToIso(nanos: string): string {
  const ms = BigInt(nanos) / BigInt(1_000_000)
  return new Date(Number(ms)).toISOString()
}

const SPAN_KIND_MAP: Record<number, string> = {
  1: 'INTERNAL',
  2: 'SERVER',
  3: 'CLIENT',
  4: 'PRODUCER',
  5: 'CONSUMER',
}

export function spanKindToString(kind?: number): string | null {
  if (kind === undefined || kind === null) return null
  return SPAN_KIND_MAP[kind] ?? null
}

export function statusCodeToString(code?: number): 'OK' | 'ERROR' | 'UNSET' {
  if (code === 1) return 'OK'
  if (code === 2) return 'ERROR'
  return 'UNSET'
}

export function kvToObject(attrs?: ReadonlyArray<KeyValue>): Record<string, unknown> {
  if (!attrs || attrs.length === 0) return {}
  const result: Record<string, unknown> = {}
  for (const kv of attrs) {
    const v = kv.value
    if (v.stringValue !== undefined) {
      result[kv.key] = v.stringValue
    } else if (v.intValue !== undefined) {
      result[kv.key] = Number(v.intValue)
    } else if (v.doubleValue !== undefined) {
      result[kv.key] = v.doubleValue
    } else if (v.boolValue !== undefined) {
      result[kv.key] = v.boolValue
    }
  }
  return result
}

// ── Parsing functions ────────────────────────────────────────

export function parseOtelLine(line: string): OtelRecord | null {
  const trimmed = line.trim()
  if (trimmed.length === 0) return null
  try {
    return JSON.parse(trimmed) as OtelRecord
  } catch {
    return null
  }
}

export function extractSpans(record: OtelRecord): ReadonlyArray<SpanInput> {
  // Format 1: OTLP export format — { resourceSpans: [...] }
  if (record.resourceSpans) {
    return extractOtlpSpans(record)
  }

  // Format 2: Copilot CLI flat format — { type: "span", traceId, spanId, ... }
  const flat = record as Record<string, unknown>
  if (flat['type'] === 'span' && typeof flat['traceId'] === 'string' && typeof flat['spanId'] === 'string') {
    return extractFlatSpan(flat)
  }

  return []
}

function extractFlatSpan(raw: Record<string, unknown>): ReadonlyArray<SpanInput> {
  const traceId = raw['traceId'] as string
  const spanId = raw['spanId'] as string
  const parentSpanId = (raw['parentSpanId'] as string) ?? null
  const name = (raw['name'] as string) ?? 'unknown'
  const kind = typeof raw['kind'] === 'number' ? raw['kind'] as number : undefined

  // startTime can be [seconds, nanoseconds] array or nanosecond string
  const startTimeRaw = raw['startTime']
  const endTimeRaw = raw['endTime']

  let startTime: string
  let endTime: string | null = null
  let durationMs: number | null = null

  if (Array.isArray(startTimeRaw)) {
    const startMs = startTimeRaw[0] * 1000 + startTimeRaw[1] / 1_000_000
    startTime = new Date(startMs).toISOString()
    if (Array.isArray(endTimeRaw)) {
      const endMs = endTimeRaw[0] * 1000 + endTimeRaw[1] / 1_000_000
      endTime = new Date(endMs).toISOString()
      durationMs = endMs - startMs
    }
  } else if (typeof startTimeRaw === 'string') {
    startTime = nanoToIso(startTimeRaw)
    if (typeof endTimeRaw === 'string') {
      endTime = nanoToIso(endTimeRaw)
      durationMs = Number(BigInt(endTimeRaw) - BigInt(startTimeRaw)) / 1_000_000
    }
  } else {
    startTime = new Date().toISOString()
  }

  // Attributes are a flat object in Copilot format (not KeyValue array)
  const rawAttrs = raw['attributes'] as Record<string, unknown> | undefined
  const attributes = rawAttrs ?? {}

  // Status: { code: number }
  const rawStatus = raw['status'] as { code?: number } | undefined
  const status = statusCodeToString(rawStatus?.code)

  // Events
  const rawEvents = raw['events'] as Array<Record<string, unknown>> | undefined
  const events = (rawEvents ?? []).map((e) => ({
    name: (e['name'] as string) ?? '',
    timeUnixNano: String(e['timeUnixNano'] ?? '0'),
    attributes: (e['attributes'] as Record<string, unknown>) ?? {},
  }))

  // Resource
  const rawResource = raw['resource'] as { attributes?: Record<string, unknown> } | undefined
  const resourceAttrs = rawResource?.attributes ?? {}
  const sessionId = (attributes['session.id'] as string) ?? null

  return [{
    trace_id: traceId,
    span_id: spanId,
    parent_span_id: parentSpanId,
    name,
    kind: spanKindToString(kind),
    start_time: startTime,
    end_time: endTime,
    duration_ms: durationMs,
    status,
    attributes_json: JSON.stringify(attributes),
    events_json: JSON.stringify(events),
    resource_json: JSON.stringify(resourceAttrs),
    session_id: sessionId,
  }]
}

function extractOtlpSpans(record: OtelRecord): ReadonlyArray<SpanInput> {
  const spans: SpanInput[] = []

  for (const rs of record.resourceSpans!) {
    const resourceAttrs = kvToObject(rs.resource?.attributes)
    const resourceJson = JSON.stringify(resourceAttrs)
    const sessionId = (resourceAttrs['session.id'] as string | undefined) ?? null

    for (const ss of rs.scopeSpans ?? []) {
      for (const raw of ss.spans ?? []) {
        const startTime = nanoToIso(raw.startTimeUnixNano)
        const endTime = raw.endTimeUnixNano ? nanoToIso(raw.endTimeUnixNano) : null

        let durationMs: number | null = null
        if (raw.endTimeUnixNano) {
          const startNs = BigInt(raw.startTimeUnixNano)
          const endNs = BigInt(raw.endTimeUnixNano)
          durationMs = Number(endNs - startNs) / 1_000_000
        }

        const attributes = kvToObject(raw.attributes)
        const events = (raw.events ?? []).map((e) => ({
          name: e.name,
          timeUnixNano: e.timeUnixNano,
          attributes: kvToObject(e.attributes),
        }))

        spans.push({
          trace_id: raw.traceId,
          span_id: raw.spanId,
          parent_span_id: raw.parentSpanId ?? null,
          name: raw.name,
          kind: spanKindToString(raw.kind),
          start_time: startTime,
          end_time: endTime,
          duration_ms: durationMs,
          status: statusCodeToString(raw.status?.code),
          attributes_json: JSON.stringify(attributes),
          events_json: JSON.stringify(events),
          resource_json: resourceJson,
          session_id: sessionId,
        })
      }
    }
  }

  return spans
}

export function extractMetrics(record: OtelRecord): ReadonlyArray<MetricInput> {
  // Format 1: OTLP export format — { resourceMetrics: [...] }
  if (record.resourceMetrics) {
    return extractOtlpMetrics(record)
  }

  // Format 2: Copilot CLI flat format — { type: "metric", name, dataPoints }
  const flat = record as Record<string, unknown>
  if (flat['type'] === 'metric' && typeof flat['name'] === 'string') {
    return extractFlatMetric(flat)
  }

  return []
}

function extractFlatMetric(raw: Record<string, unknown>): ReadonlyArray<MetricInput> {
  const name = raw['name'] as string
  const dataPoints = raw['dataPoints'] as Array<Record<string, unknown>> | undefined
  if (!dataPoints || dataPoints.length === 0) return []

  const metrics: MetricInput[] = []
  const resourceJson = JSON.stringify(raw['resource'] ?? {})

  for (const dp of dataPoints) {
    const attrs = dp['attributes'] as Record<string, unknown> | undefined

    // Determine timestamp
    let timestamp: string
    const endTimeRaw = dp['endTime'] ?? dp['startTime']
    if (Array.isArray(endTimeRaw)) {
      const ms = (endTimeRaw[0] as number) * 1000 + (endTimeRaw[1] as number) / 1_000_000
      timestamp = new Date(ms).toISOString()
    } else if (typeof endTimeRaw === 'string') {
      timestamp = nanoToIso(endTimeRaw)
    } else {
      timestamp = new Date().toISOString()
    }

    // Extract value — Copilot uses { value: { sum, min, max, count, ... } } for histograms
    const valueObj = dp['value'] as Record<string, unknown> | undefined
    let value = 0
    let metricType: MetricInput['metric_type'] = 'gauge'

    if (valueObj && typeof valueObj === 'object') {
      if ('sum' in valueObj && typeof valueObj['sum'] === 'number') {
        value = valueObj['sum']
        metricType = 'histogram'
      } else if ('value' in valueObj && typeof valueObj['value'] === 'number') {
        value = valueObj['value']
      }
    } else if (typeof dp['value'] === 'number') {
      value = dp['value']
    } else if (typeof dp['asDouble'] === 'number') {
      value = dp['asDouble']
    } else if (typeof dp['asInt'] === 'number') {
      value = dp['asInt']
    }

    metrics.push({
      name,
      metric_type: metricType,
      value,
      attributes_json: JSON.stringify(attrs ?? {}),
      resource_json: resourceJson,
      timestamp,
    })
  }

  return metrics
}

function extractOtlpMetrics(record: OtelRecord): ReadonlyArray<MetricInput> {
  const metrics: MetricInput[] = []

  for (const rm of record.resourceMetrics!) {
    const resourceJson = JSON.stringify(kvToObject(rm.resource?.attributes))

    for (const sm of rm.scopeMetrics ?? []) {
      for (const raw of sm.metrics ?? []) {
        const processDataPoints = (
          dataPoints: ReadonlyArray<DataPoint> | undefined,
          metricType: MetricInput['metric_type'],
        ): void => {
          for (const dp of dataPoints ?? []) {
            let value: number
            if (dp.sum !== undefined) {
              value = dp.sum
            } else if (dp.asDouble !== undefined) {
              value = dp.asDouble
            } else if (dp.asInt !== undefined) {
              value = Number(dp.asInt)
            } else {
              value = 0
            }

            metrics.push({
              name: raw.name,
              metric_type: metricType,
              value,
              attributes_json: JSON.stringify(kvToObject(dp.attributes)),
              resource_json: resourceJson,
              timestamp: nanoToIso(dp.timeUnixNano),
            })
          }
        }

        if (raw.histogram?.dataPoints) {
          processDataPoints(raw.histogram.dataPoints, 'histogram')
        }
        if (raw.sum?.dataPoints) {
          processDataPoints(raw.sum.dataPoints, 'sum')
        }
        if (raw.gauge?.dataPoints) {
          processDataPoints(raw.gauge.dataPoints, 'gauge')
        }
      }
    }
  }

  return metrics
}
