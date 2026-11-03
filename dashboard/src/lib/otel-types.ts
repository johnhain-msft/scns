// Re-export actual types from api.ts for convenience.
// These match the real backend contracts.
export type {
  TraceSummary,
  OtelSpan,
  SpanNode,
  MetricsSummary,
  OtelIngestionConfig,
} from './api'

import type { OtelSpan, SpanNode, OtelIngestionConfig } from './api'

// View-model aliases used by page components
export type TraceListItem = {
  trace_id: string
  root_span_name: string
  span_count: number
  start_time: string
  duration_ms: number | null
  status: string | null
  total_tokens: number | null
}

export type TraceDetail = {
  trace_id: string
  spans: OtelSpan[]
  tree: SpanNode[]
}

export type OtelConfig = OtelIngestionConfig & {
  content_capture?: boolean
}
