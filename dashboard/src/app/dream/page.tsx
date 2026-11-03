'use client'

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getDreamStatus, triggerDream } from '@/lib/api'

interface DreamStatus {
  running?: boolean
  lastRunAt?: string | null
  last_run?: string
  memories_consolidated?: number
  totalRuns?: number
  total_runs?: number
  duration_ms?: number
  sessionsSinceLastRun?: number
  gateCheck?: { canRun: boolean; failedGate?: string }
  gates?: { name: string; passed: boolean }[]
  [key: string]: unknown
}

export default function DreamPage() {
  const queryClient = useQueryClient()
  const [showConfirm, setShowConfirm] = useState(false)

  const { data, isLoading, isError } = useQuery({
    queryKey: ['dream-status'],
    queryFn: () => getDreamStatus() as Promise<DreamStatus>,
  })

  const forceRunMutation = useMutation({
    mutationFn: () => triggerDream(true),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dream-status'] })
      setShowConfirm(false)
    },
  })

  const status = data as DreamStatus | undefined

  if (isLoading) {
    return (
      <div>
        <h1>Dream</h1>
        <p>Loading dream status…</p>
      </div>
    )
  }

  if (isError) {
    return (
      <div>
        <h1>Dream</h1>
        <p>Dream daemon is not available</p>
      </div>
    )
  }

  const lastRun = status?.lastRunAt ?? status?.last_run
  const totalRuns = status?.totalRuns ?? status?.total_runs ?? 0
  const sessionsSince = status?.sessionsSinceLastRun ?? 0

  // Convert gateCheck to displayable gates
  const gates: { name: string; passed: boolean }[] = status?.gates ?? []
  if (gates.length === 0 && status?.gateCheck) {
    const gc = status.gateCheck
    gates.push(
      { name: 'Time since last run', passed: gc.failedGate !== 'time' },
      { name: 'Sessions since last run', passed: gc.failedGate !== 'count' },
      { name: 'Lock not stale', passed: gc.failedGate !== 'lock' },
    )
  }

  return (
    <div>
      <h1>Dream</h1>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem', marginBottom: '1.5rem' }}>
        <section aria-labelledby="dream-status-heading">
          <h2 id="dream-status-heading">Status</h2>
          <dl style={{ margin: 0 }}>
            <div style={{ marginBottom: '0.75rem' }}>
              <dt style={{ fontSize: '0.75rem', opacity: 0.6 }}>Last Run</dt>
              <dd style={{ margin: 0, fontWeight: 600 }}>
                {lastRun ? new Date(lastRun).toLocaleString() : 'Never'}
              </dd>
            </div>
            <div style={{ marginBottom: '0.75rem' }}>
              <dt style={{ fontSize: '0.75rem', opacity: 0.6 }}>Total Runs</dt>
              <dd style={{ margin: 0, fontWeight: 600 }}>{totalRuns}</dd>
            </div>
            <div style={{ marginBottom: '0.75rem' }}>
              <dt style={{ fontSize: '0.75rem', opacity: 0.6 }}>Sessions Since Last Run</dt>
              <dd style={{ margin: 0, fontWeight: 600 }}>{sessionsSince}</dd>
            </div>
            {status?.duration_ms != null && (
              <div style={{ marginBottom: '0.75rem' }}>
                <dt style={{ fontSize: '0.75rem', opacity: 0.6 }}>Duration</dt>
                <dd style={{ margin: 0, fontWeight: 600 }}>{(status.duration_ms / 1000).toFixed(1)}s</dd>
              </div>
            )}
            <div style={{ marginBottom: '0.75rem' }}>
              <dt style={{ fontSize: '0.75rem', opacity: 0.6 }}>Memories Consolidated</dt>
              <dd style={{ margin: 0, fontWeight: 600 }}>{status?.memories_consolidated ?? 0}</dd>
            </div>
            <div style={{ marginBottom: '0.75rem' }}>
              <dt style={{ fontSize: '0.75rem', opacity: 0.6 }}>Next Run</dt>
              <dd style={{ margin: 0, fontWeight: 600, color: status?.gateCheck?.canRun ? 'var(--green-11, #4ade80)' : 'var(--yellow-11, #facc15)' }}>
                {status?.gateCheck?.canRun ? 'Ready' : `Waiting (${status?.gateCheck?.failedGate ?? 'unknown'} gate)`}
              </dd>
            </div>
          </dl>
        </section>

        <section aria-labelledby="dream-gates-heading">
          <h2 id="dream-gates-heading">Gate Status</h2>
          {gates.length > 0 ? (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {gates.map((gate) => (
                <li
                  key={gate.name}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '0.5rem 0.75rem',
                    marginBottom: '0.375rem',
                    borderRadius: '0.375rem',
                    backgroundColor: gate.passed
                      ? 'var(--green-a3, rgba(0,180,0,0.1))'
                      : 'var(--red-a3, rgba(255,0,0,0.1))',
                  }}
                >
                  <span>{gate.name}</span>
                  <span
                    style={{
                      fontWeight: 600,
                      fontSize: '0.8rem',
                      color: gate.passed
                        ? 'var(--green-11, #4ade80)'
                        : 'var(--red-11, #f87171)',
                    }}
                  >
                    {gate.passed ? 'Pass' : 'Fail'}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p style={{ opacity: 0.6 }}>No gate data available</p>
          )}
        </section>
      </div>

      <button
        onClick={() => setShowConfirm(true)}
        style={{
          padding: '0.5rem 1.25rem',
          borderRadius: '0.375rem',
          border: 'none',
          backgroundColor: 'var(--accent-solid, #0072c3)',
          color: 'white',
          cursor: 'pointer',
          fontWeight: 500,
        }}
      >
        Force Run
      </button>

      {showConfirm && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="confirm-title"
          aria-describedby="confirm-desc"
          style={{
            position: 'fixed',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'rgba(0,0,0,0.6)',
            zIndex: 1000,
          }}
        >
          <div
            style={{
              backgroundColor: 'var(--color-panel, #1a1a2e)',
              padding: '1.5rem',
              borderRadius: '0.75rem',
              maxWidth: '400px',
              width: '100%',
              border: '1px solid var(--gray-a5)',
            }}
          >
            <h3 id="confirm-title" style={{ marginTop: 0 }}>Confirm Force Run</h3>
            <p id="confirm-desc">
              This will force a dream consolidation run, bypassing gate checks. Are you sure?
            </p>
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <button
                onClick={() => setShowConfirm(false)}
                style={{
                  padding: '0.375rem 1rem',
                  borderRadius: '0.375rem',
                  border: '1px solid var(--gray-a5)',
                  backgroundColor: 'transparent',
                  color: 'inherit',
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => forceRunMutation.mutate()}
                disabled={forceRunMutation.isPending}
                style={{
                  padding: '0.375rem 1rem',
                  borderRadius: '0.375rem',
                  border: 'none',
                  backgroundColor: 'var(--red-9, #ef4444)',
                  color: 'white',
                  cursor: 'pointer',
                  fontWeight: 500,
                }}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
