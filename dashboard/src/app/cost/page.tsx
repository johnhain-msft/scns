'use client'

import { useQuery } from '@tanstack/react-query'
import { getCostSummary, type CostSummary } from '@/lib/api'

function formatTokens(n: number): string {
  return n.toLocaleString('en-US')
}

function formatUSD(n: number): string {
  return `$${n.toFixed(4)}`
}

export default function CostPage() {
  const { data: cost, isLoading } = useQuery({
    queryKey: ['cost-summary'],
    queryFn: getCostSummary,
  })

  if (isLoading) {
    return (
      <div>
        <h1>Cost</h1>
        <p>Loading cost data…</p>
      </div>
    )
  }

  const breakdown = cost?.perSession ?? []

  return (
    <div>
      <h1>Cost</h1>

      <div style={{ display: 'flex', gap: '1.5rem', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
        <div
          style={{
            padding: '1rem 1.5rem',
            borderRadius: '0.5rem',
            backgroundColor: 'var(--gray-a3)',
            border: '1px solid var(--gray-a5)',
            minWidth: '160px',
          }}
        >
          <p style={{ margin: 0, fontSize: '0.75rem', opacity: 0.6 }}>Total Cost</p>
          <p style={{ margin: '0.25rem 0 0', fontSize: '1.5rem', fontWeight: 700 }}>
            {cost ? formatUSD(cost.estimatedTotalCostUSD) : '$0.0000'}
          </p>
        </div>

        {cost && (
          <div
            style={{
              padding: '1rem 1.5rem',
              borderRadius: '0.5rem',
              backgroundColor: 'var(--gray-a3)',
              border: '1px solid var(--gray-a5)',
              minWidth: '160px',
            }}
          >
            <p style={{ margin: 0, fontSize: '0.75rem', opacity: 0.6 }}>Input Tokens</p>
            <p style={{ margin: '0.25rem 0 0', fontSize: '1.5rem', fontWeight: 700 }}>
              {formatTokens(cost.totalInputTokens)}
            </p>
          </div>
        )}

        {cost && (
          <div
            style={{
              padding: '1rem 1.5rem',
              borderRadius: '0.5rem',
              backgroundColor: 'var(--gray-a3)',
              border: '1px solid var(--gray-a5)',
              minWidth: '160px',
            }}
          >
            <p style={{ margin: 0, fontSize: '0.75rem', opacity: 0.6 }}>Output Tokens</p>
            <p style={{ margin: '0.25rem 0 0', fontSize: '1.5rem', fontWeight: 700 }}>
              {formatTokens(cost.totalOutputTokens)}
            </p>
          </div>
        )}
      </div>

      {breakdown.length === 0 && <p>No session data available</p>}

      {breakdown.length > 0 && (
        <table>
          <thead>
            <tr>
              <th scope="col">Session</th>
              <th scope="col">Input Tokens</th>
              <th scope="col">Output Tokens</th>
              <th scope="col">Total</th>
              <th scope="col">Cost</th>
            </tr>
          </thead>
          <tbody>
            {breakdown.map((session) => (
              <tr key={session.sessionId}>
                <td>{session.sessionId}</td>
                <td>{formatTokens(session.inputTokens)}</td>
                <td>{formatTokens(session.outputTokens)}</td>
                <td>{formatTokens(session.totalTokens)}</td>
                <td>{formatUSD(session.estimatedCostUSD)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
