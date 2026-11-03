'use client'

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getAutonomy, promoteAutonomy, demoteAutonomy, type AutonomyState } from '@/lib/api'

const LEVEL_DESCRIPTIONS: Record<number, string> = {
  0: 'Observe only. No suggestions, no actions.',
  1: 'Can generate suggestions. No auto-execution.',
  2: 'Can auto-execute approved suggestions. No direct commands.',
  3: 'Full autonomy. Can execute commands and make decisions.',
}

const LEVEL_LABELS: Record<number, string> = {
  0: 'Observer',
  1: 'Advisor',
  2: 'Assistant',
  3: 'Autonomous',
}

export default function AutonomyPage() {
  const queryClient = useQueryClient()

  const { data: autonomy, isLoading } = useQuery({
    queryKey: ['autonomy'],
    queryFn: getAutonomy,
  })

  const promoteMutation = useMutation({
    mutationFn: promoteAutonomy,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['autonomy'] })
    },
  })

  const demoteMutation = useMutation({
    mutationFn: demoteAutonomy,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['autonomy'] })
    },
  })

  if (isLoading) {
    return (
      <div>
        <h1>Autonomy</h1>
        <p>Loading autonomy status…</p>
      </div>
    )
  }

  const level = autonomy?.level ?? 0
  const label = LEVEL_LABELS[level] ?? 'Unknown'
  const canPromote = level < 3
  const canDemote = level > 0

  return (
    <div>
      <h1>Autonomy</h1>

      <div role="status" aria-live="polite" style={{ marginBottom: '1.5rem' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '1rem',
            marginBottom: '0.75rem',
          }}
        >
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '48px',
              height: '48px',
              borderRadius: '50%',
              backgroundColor: 'var(--accent-solid, #0072c3)',
              color: 'white',
              fontWeight: 700,
              fontSize: '1.1rem',
            }}
          >
            L{level}
          </span>
          <div>
            <p style={{ margin: 0, fontSize: '1.25rem', fontWeight: 600 }}>{label}</p>
            <p style={{ margin: '0.125rem 0 0', opacity: 0.7, fontSize: '0.875rem' }}>
              {LEVEL_DESCRIPTIONS[level] ?? ''}
            </p>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.5rem' }}>
        {[0, 1, 2, 3].map((l) => (
          <div
            key={l}
            style={{
              flex: 1,
              padding: '0.75rem',
              borderRadius: '0.5rem',
              textAlign: 'center',
              backgroundColor: l === level
                ? 'var(--accent-a4, rgba(59,130,246,0.2))'
                : 'var(--gray-a3)',
              border: l === level
                ? '2px solid var(--accent-9, #3b82f6)'
                : '1px solid var(--gray-a5)',
              opacity: l <= level ? 1 : 0.5,
            }}
          >
            <p style={{ margin: 0, fontWeight: 700 }}>L{l}</p>
            <p style={{ margin: '0.125rem 0 0', fontSize: '0.75rem' }}>
              {LEVEL_LABELS[l]}
            </p>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
        <button
          onClick={() => demoteMutation.mutate()}
          disabled={!canDemote || demoteMutation.isPending}
          style={{
            padding: '0.5rem 1.25rem',
            borderRadius: '0.375rem',
            border: '1px solid var(--gray-a5)',
            backgroundColor: 'transparent',
            color: 'inherit',
            cursor: canDemote ? 'pointer' : 'not-allowed',
            fontWeight: 500,
            opacity: canDemote ? 1 : 0.5,
          }}
        >
          Demote Level
        </button>
        <button
          onClick={() => promoteMutation.mutate()}
          disabled={!canPromote || promoteMutation.isPending}
          style={{
            padding: '0.5rem 1.25rem',
            borderRadius: '0.375rem',
            border: 'none',
            backgroundColor: canPromote
              ? 'var(--accent-solid, #0072c3)'
              : 'var(--gray-a5)',
            color: 'white',
            cursor: canPromote ? 'pointer' : 'not-allowed',
            fontWeight: 500,
            opacity: canPromote ? 1 : 0.5,
          }}
        >
          Promote Level
        </button>
      </div>

      {autonomy?.changedAt && (
        <p style={{ marginTop: '1rem', fontSize: '0.8rem', opacity: 0.6 }}>
          Last changed: {new Date(autonomy.changedAt).toLocaleString()}
        </p>
      )}
    </div>
  )
}
