'use client'

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getObservers, toggleObserver } from '@/lib/api'

// Keyed by observer name (unique), not type (can collide)
const OBSERVER_META: Record<string, { label: string; description: string }> = {
  'active-app': { label: 'Active App', description: 'Track which applications are in focus' },
  'file-change-observer': { label: 'File Changes', description: 'Monitor file system modifications' },
  'config-change-observer': { label: 'Config Changes', description: 'Detect changes to MCP, skill, and instruction config files' },
  'git-activity-observer': { label: 'Git Activity', description: 'Track git commits, branches, and merges' },
  'terminal-history': { label: 'Terminal History', description: 'Capture terminal command patterns' },
  'browser-tab': { label: 'Browser Tabs', description: 'Monitor browser tab activity' },
  'session-hook': { label: 'Session Hooks', description: 'Track coding session lifecycle events' },
  'session-store-poller': { label: 'Session Store', description: 'Poll local session store for activity' },
}

interface Observer {
  type: string
  name?: string
  state?: string
  enabled?: boolean
  metadata?: { name?: string; description?: string }
  health?: { healthy?: boolean; message?: string; details?: Record<string, unknown> }
  capabilities?: string[]
}

export default function ObserversPage() {
  const queryClient = useQueryClient()

  const { data: rawData, isLoading, isError } = useQuery({
    queryKey: ['observers'],
    queryFn: getObservers,
  })

  // getObservers returns Record<string, unknown> — extract observer list from 'plugins' key
  const observers: Observer[] = (() => {
    if (!rawData) return []
    if (Array.isArray(rawData)) return rawData as Observer[]
    if (typeof rawData === 'object') {
      const obj = rawData as Record<string, unknown>
      if ('plugins' in obj && Array.isArray(obj.plugins)) return obj.plugins as Observer[]
      if ('observers' in obj && Array.isArray(obj.observers)) return obj.observers as Observer[]
    }
    return []
  })()

  const toggleMutation = useMutation({
    mutationFn: (type: string) => toggleObserver(type),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['observers'] })
    },
  })

  if (isError) {
    return (
      <div>
        <h1>Observers</h1>
        <p>Observer system is not available</p>
      </div>
    )
  }

  return (
    <div>
      <h1>Observers</h1>

      {isLoading && <p>Loading observers…</p>}

      <div
        aria-live="polite"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          gap: '1rem',
          marginTop: '1rem',
        }}
      >
        {observers?.map((observer) => {
          const uniqueId = observer.name ?? observer.type
          const meta = OBSERVER_META[uniqueId] ?? {
            label: observer.metadata?.name ?? uniqueId,
            description: observer.metadata?.description ?? '',
          }
          const isActive = observer.state === 'running' || observer.state === 'idle' || observer.enabled === true
          const headingId = `observer-${uniqueId}`

          return (
            <section
              key={observer.name ?? observer.type}
              role="region"
              aria-labelledby={headingId}
              style={{
                padding: '1rem',
                borderRadius: '0.5rem',
                backgroundColor: 'var(--gray-a3)',
                border: '1px solid var(--gray-a5)',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <h2 id={headingId} style={{ margin: '0 0 0.25rem', fontSize: '0.95rem' }}>
                    {meta.label}
                  </h2>
                  <p style={{ margin: 0, fontSize: '0.8rem', opacity: 0.7 }}>{meta.description}</p>
                  {observer.state && (
                    <p style={{ margin: '0.25rem 0 0', fontSize: '0.75rem', opacity: 0.5 }}>
                      {observer.state}
                      {observer.health?.details ? ` • ${observer.health.message}` : ''}
                    </p>
                  )}
                </div>
                <button
                  role="switch"
                  aria-checked={isActive}
                  aria-label={`Toggle ${meta.label}`}
                  onClick={() => toggleMutation.mutate(observer.type)}
                  style={{
                    position: 'relative',
                    width: '44px',
                    height: '24px',
                    borderRadius: '12px',
                    border: 'none',
                    cursor: 'pointer',
                    backgroundColor: isActive
                      ? 'var(--accent-9, #3b82f6)'
                      : 'var(--gray-a5, rgba(128,128,128,0.3))',
                    transition: 'background-color 0.2s',
                    flexShrink: 0,
                  }}
                >
                  <span
                    style={{
                      position: 'absolute',
                      top: '2px',
                      left: isActive ? '22px' : '2px',
                      width: '20px',
                      height: '20px',
                      borderRadius: '50%',
                      backgroundColor: 'white',
                      transition: 'left 0.2s',
                    }}
                  />
                </button>
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}
