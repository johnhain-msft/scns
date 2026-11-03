'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getOtelTraces, getOtelTraceDetail } from '@/lib/api'
import type { TraceSummary, SpanNode } from '@/lib/api'
import { TimeRangeSelector, rangeToSince } from '@/components/time-range-selector'
import { SpanTree, formatDuration } from '@/components/span-tree'
import { StatusBadge } from '@/components/span-tree'

export default function TracesPage() {
  const [timeRange, setTimeRange] = useState('1h')
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null)

  const tracesQuery = useQuery({
    queryKey: ['traces', timeRange],
    queryFn: () => getOtelTraces({ start_after: rangeToSince(timeRange) }),
  })

  const detailQuery = useQuery({
    queryKey: ['trace', selectedTraceId],
    queryFn: () => getOtelTraceDetail(selectedTraceId!),
    enabled: !!selectedTraceId,
  })

  if (selectedTraceId) {
    return (
      <TraceDetailView
        traceId={selectedTraceId}
        tree={detailQuery.data?.tree ?? null}
        isLoading={detailQuery.isLoading}
        onBack={() => setSelectedTraceId(null)}
      />
    )
  }

  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '1.5rem',
        }}
      >
        <h1 style={{ fontSize: '1.5rem', fontWeight: 700, margin: 0 }}>Traces</h1>
        <TimeRangeSelector value={timeRange} onChange={setTimeRange} />
      </div>

      {tracesQuery.isLoading && <p>Loading traces…</p>}

      {tracesQuery.data && tracesQuery.data.length === 0 && (
        <p style={{ color: 'var(--gray-11)' }}>No traces found for the selected time range.</p>
      )}

      {tracesQuery.data && tracesQuery.data.length > 0 && (
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: '0.875rem',
          }}
        >
          <thead>
            <tr>
              <th scope="col" style={thStyle}>Trace ID</th>
              <th scope="col" style={thStyle}>Root Span</th>
              <th scope="col" style={thStyle}>Duration</th>
              <th scope="col" style={thStyle}>Spans</th>
              <th scope="col" style={thStyle}>Status</th>
              <th scope="col" style={thStyle}>Time</th>
            </tr>
          </thead>
          <tbody>
            {tracesQuery.data.map((trace: TraceSummary) => (
              <tr
                key={trace.trace_id}
                onClick={() => setSelectedTraceId(trace.trace_id)}
                style={{
                  cursor: 'pointer',
                  borderBottom: '1px solid var(--gray-a3)',
                }}
                tabIndex={0}
                role="button"
                aria-label={`View trace ${trace.trace_id.slice(0, 8)}`}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setSelectedTraceId(trace.trace_id)
                  }
                }}
              >
                <td style={tdStyle}>
                  <code>{trace.trace_id.slice(0, 8)}</code>
                </td>
                <td style={tdStyle}>{trace.root_span_name}</td>
                <td style={tdStyle}>{formatDuration(trace.duration_ms)}</td>
                <td style={tdStyle}>{trace.span_count}</td>
                <td style={tdStyle}>
                  <StatusBadge status={trace.status} />
                </td>
                <td style={tdStyle}>
                  {new Date(trace.start_time).toLocaleTimeString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function TraceDetailView({
  traceId,
  tree,
  isLoading,
  onBack,
}: {
  traceId: string
  tree: readonly SpanNode[] | null
  isLoading: boolean
  onBack: () => void
}) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1.5rem' }}>
        <button
          onClick={onBack}
          aria-label="Back to traces list"
          style={{
            background: 'none',
            border: '1px solid var(--gray-a5)',
            borderRadius: '0.375rem',
            padding: '0.375rem 0.75rem',
            cursor: 'pointer',
            color: 'var(--gray-11)',
            fontSize: '0.875rem',
          }}
        >
          ← Back
        </button>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 700, margin: 0 }}>
          Trace <code style={{ fontSize: '1rem' }}>{traceId.slice(0, 16)}…</code>
        </h1>
      </div>

      {isLoading && <p>Loading trace details…</p>}

      {tree && tree.length > 0 && <SpanTree spans={tree} />}

      {tree && tree.length === 0 && (
        <p style={{ color: 'var(--gray-11)' }}>No spans found for this trace.</p>
      )}
    </div>
  )
}

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '0.5rem 0.75rem',
  borderBottom: '2px solid var(--gray-a5)',
  fontWeight: 600,
  color: 'var(--gray-11)',
}

const tdStyle: React.CSSProperties = {
  padding: '0.5rem 0.75rem',
  verticalAlign: 'middle',
}
