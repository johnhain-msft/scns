'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getOtelMetricsSummary } from '@/lib/api'
import type { MetricsSummary } from '@/lib/api'
import { TimeRangeSelector, rangeToSince } from '@/components/time-range-selector'
import { HorizontalBar } from '@/components/horizontal-bar'

export default function MetricsPage() {
  const [timeRange, setTimeRange] = useState('1h')

  const metricsQuery = useQuery({
    queryKey: ['metrics', timeRange],
    queryFn: () => getOtelMetricsSummary(rangeToSince(timeRange)),
  })

  const data = metricsQuery.data as MetricsSummary | undefined
  const totalTokens = (data?.total_input_tokens ?? 0) + (data?.total_output_tokens ?? 0)
  const errorRate = data && data.total_spans > 0
    ? (data.error_count / data.total_spans) * 100
    : 0
  const isEmpty =
    data &&
    data.total_spans === 0 &&
    totalTokens === 0

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
        <h1 style={{ fontSize: '1.5rem', fontWeight: 700, margin: 0 }}>Metrics</h1>
        <TimeRangeSelector
          value={timeRange}
          onChange={setTimeRange}
          ranges={['1h', '6h', '24h', '7d', '30d']}
        />
      </div>

      {metricsQuery.isLoading && <p>Loading metrics…</p>}

      {isEmpty && (
        <p style={{ color: 'var(--gray-11)' }}>No data available for the selected time range.</p>
      )}

      {data && !isEmpty && (
        <>
          {/* Summary Cards */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(4, 1fr)',
              gap: '1rem',
              marginBottom: '2rem',
            }}
          >
            <SummaryCard label="Total Spans" value={data.total_spans.toLocaleString()} />
            <SummaryCard label="Total Tokens" value={totalTokens.toLocaleString()} />
            <SummaryCard
              label="Avg Duration"
              value={`${data.avg_duration_ms?.toFixed(1) ?? '0'}ms`}
            />
            <SummaryCard
              label="Error Rate"
              value={`${errorRate.toFixed(1)}%`}
            />
          </div>

          {/* Token Usage */}
          <section aria-labelledby="token-usage-heading" style={{ marginBottom: '2rem' }}>
            <h2 id="token-usage-heading" style={{ fontSize: '1.125rem', fontWeight: 600, marginBottom: '0.75rem' }}>
              Token Usage
            </h2>
            <HorizontalBar
              label="Input Tokens"
              value={data.total_input_tokens}
              max={Math.max(data.total_input_tokens, data.total_output_tokens)}
            />
            <HorizontalBar
              label="Output Tokens"
              value={data.total_output_tokens}
              max={Math.max(data.total_input_tokens, data.total_output_tokens)}
            />
          </section>

          {/* Top Tools */}
          {data.top_tools && data.top_tools.length > 0 && (
            <section aria-labelledby="top-tools-heading" style={{ marginBottom: '2rem' }}>
              <h2 id="top-tools-heading" style={{ fontSize: '1.125rem', fontWeight: 600, marginBottom: '0.75rem' }}>
                Top Tools
              </h2>
              {data.top_tools.map((tool) => (
                <HorizontalBar
                  key={tool.name}
                  label={tool.name}
                  value={tool.count}
                  max={data.top_tools[0].count}
                />
              ))}
            </section>
          )}

          {/* Model Distribution */}
          {data.model_distribution && data.model_distribution.length > 0 && (
            <section aria-labelledby="model-dist-heading" style={{ marginBottom: '2rem' }}>
              <h2 id="model-dist-heading" style={{ fontSize: '1.125rem', fontWeight: 600, marginBottom: '0.75rem' }}>
                Model Distribution
              </h2>
              {data.model_distribution.map((m) => (
                <HorizontalBar
                  key={m.model}
                  label={m.model}
                  value={m.count}
                  max={data.model_distribution[0].count}
                />
              ))}
            </section>
          )}

          {/* Screen-reader accessible data table */}
          <table
            aria-label="Metrics data"
            style={{
              position: 'absolute',
              width: '1px',
              height: '1px',
              padding: 0,
              margin: '-1px',
              overflow: 'hidden',
              clip: 'rect(0, 0, 0, 0)',
              whiteSpace: 'nowrap',
              borderWidth: 0,
            }}
          >
            <thead>
              <tr>
                <th scope="col">Metric</th>
                <th scope="col">Value</th>
              </tr>
            </thead>
            <tbody>
              <tr><td>Total Spans</td><td>{data.total_spans.toLocaleString()}</td></tr>
              <tr><td>Total Tokens</td><td>{totalTokens.toLocaleString()}</td></tr>
              <tr><td>Average Duration</td><td>{data.avg_duration_ms?.toFixed(1)}ms</td></tr>
              <tr><td>Error Rate</td><td>{errorRate.toFixed(1)}%</td></tr>
              <tr><td>Input Tokens</td><td>{data.total_input_tokens.toLocaleString()}</td></tr>
              <tr><td>Output Tokens</td><td>{data.total_output_tokens.toLocaleString()}</td></tr>
              {data.top_tools?.map((t) => (
                <tr key={t.name}><td>{t.name}</td><td>{t.count.toLocaleString()}</td></tr>
              ))}
              {data.model_distribution?.map((m) => (
                <tr key={m.model}><td>{m.model}</td><td>{m.count.toLocaleString()}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        padding: '1rem',
        borderRadius: '0.5rem',
        border: '1px solid var(--gray-a5)',
        backgroundColor: 'var(--gray-a2)',
      }}
    >
      <div style={{ fontSize: '0.75rem', color: '#b0b4ba', marginBottom: '0.25rem' }}>
        {label}
      </div>
      <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{value}</div>
    </div>
  )
}
