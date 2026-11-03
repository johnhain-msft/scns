'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  getOrchestratorOverview,
  type OrchestratorEvent,
  type OrchestratorMessage,
  type OrchestratorTeam,
  type OrchestratorTeamMember,
  type ScalingDecision,
} from '@/lib/api'

const POLL_MS = 3000

const TIME_WINDOWS = [
  { value: '1h', label: 'Last hour' },
  { value: '24h', label: 'Last 24h' },
  { value: '7d', label: 'Last 7d' },
  { value: 'all', label: 'All time' },
] as const

type TimeWindow = (typeof TIME_WINDOWS)[number]['value']

function formatAge(iso: string | null | undefined): string {
  if (!iso) return '—'
  const stamp = iso.includes('Z') || /[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`
  const t = Date.parse(stamp)
  if (Number.isNaN(t)) return iso
  const ageSec = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (ageSec < 60) return `${ageSec}s ago`
  if (ageSec < 3600) return `${Math.round(ageSec / 60)}m ago`
  if (ageSec < 86400) return `${Math.round(ageSec / 3600)}h ago`
  return `${Math.round(ageSec / 86400)}d ago`
}

function parsePayload(raw: string): Record<string, unknown> {
  try {
    const obj = JSON.parse(raw) as unknown
    return obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function Panel({
  title,
  count,
  children,
}: {
  title: string
  count: number | string
  children: React.ReactNode
}) {
  return (
    <section
      aria-labelledby={`${title.toLowerCase().replace(/\s+/g, '-')}-heading`}
      style={{
        border: '1px solid var(--gray-a5, #333)',
        borderRadius: '0.5rem',
        backgroundColor: 'var(--gray-a2, #0e0e0e)',
        padding: '1rem',
        minHeight: '240px',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '0.75rem',
        }}
      >
        <h2
          id={`${title.toLowerCase().replace(/\s+/g, '-')}-heading`}
          style={{ fontSize: '1rem', fontWeight: 600, margin: 0 }}
        >
          {title}
        </h2>
        <span
          style={{
            fontSize: '0.75rem',
            padding: '0.125rem 0.5rem',
            borderRadius: '9999px',
            backgroundColor: 'var(--gray-a3, #222)',
            color: 'var(--gray-11, #aaa)',
          }}
        >
          {count}
        </span>
      </header>
      {children}
    </section>
  )
}

function TeamsPanel({ teams }: { teams: OrchestratorTeam[] }) {
  if (teams.length === 0) {
    return <p style={{ opacity: 0.6, fontSize: '0.85rem' }}>No active teams</p>
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      {teams.map((team) => (
        <div
          key={team.id}
          style={{
            border: '1px solid var(--gray-a4, #2a2a2a)',
            borderRadius: '0.375rem',
            padding: '0.6rem',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              marginBottom: '0.4rem',
            }}
          >
            <strong style={{ fontSize: '0.9rem' }}>{team.name}</strong>
            <span
              style={{
                fontSize: '0.7rem',
                padding: '0.05rem 0.45rem',
                borderRadius: '9999px',
                backgroundColor:
                  (team.status ?? 'active') === 'active'
                    ? 'var(--green-a3, rgba(0,180,0,0.15))'
                    : 'var(--gray-a3, #222)',
                color:
                  (team.status ?? 'active') === 'active'
                    ? 'var(--green-11, #4ade80)'
                    : 'var(--gray-11, #aaa)',
              }}
            >
              {team.status ?? 'active'}
            </span>
            <span style={{ fontSize: '0.7rem', opacity: 0.6 }}>
              {team.members.length} member{team.members.length === 1 ? '' : 's'}
            </span>
          </div>
          {team.members.length === 0 ? (
            <p style={{ fontSize: '0.75rem', opacity: 0.5, margin: 0 }}>No members</p>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: '0.75rem' }}>
              {team.members.map((m: OrchestratorTeamMember) => (
                <li
                  key={m.session_id}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: '0.5rem',
                    padding: '0.2rem 0',
                    borderBottom: '1px dashed var(--gray-a3, #222)',
                  }}
                >
                  <span style={{ fontFamily: 'monospace' }}>
                    {m.name}{' '}
                    <span style={{ opacity: 0.5 }}>
                      [{m.role}
                      {m.agent_type ? ` · ${m.agent_type}` : ''}]
                    </span>
                  </span>
                  <span style={{ opacity: 0.7 }}>
                    {m.session_status ?? m.status} · ♥ {formatAge(m.last_heartbeat)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  )
}

function SuggestionsPanel({ items }: { items: Array<Record<string, unknown>> }) {
  if (items.length === 0) {
    return <p style={{ opacity: 0.6, fontSize: '0.85rem' }}>No suggestions in-flight</p>
  }
  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {items.map((s) => {
        const title = String(s['title'] ?? s['id'] ?? 'Unnamed suggestion')
        const type = String(s['type'] ?? '')
        const status = String(s['status'] ?? 'pending')
        const conf = typeof s['confidence'] === 'number' ? (s['confidence'] as number) : null
        const id = String(s['id'] ?? '')
        const statusColor =
          status === 'approved'
            ? 'var(--blue-a3, rgba(0,120,220,0.15))'
            : status === 'implemented'
              ? 'var(--green-a3, rgba(0,180,0,0.15))'
              : status === 'rejected'
                ? 'var(--red-a3, rgba(220,40,40,0.15))'
                : 'var(--amber-a3, rgba(220,170,0,0.15))'
        return (
          <li
            key={id}
            style={{
              padding: '0.4rem 0',
              borderBottom: '1px solid var(--gray-a3, #222)',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.15rem',
            }}
          >
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'baseline' }}>
              <span style={{ fontSize: '0.85rem', fontWeight: 500 }}>{title}</span>
              {type && (
                <span style={{ fontSize: '0.7rem', opacity: 0.6 }}>· {type}</span>
              )}
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', fontSize: '0.7rem', opacity: 0.75 }}>
              <span
                style={{
                  padding: '0.05rem 0.4rem',
                  borderRadius: '9999px',
                  backgroundColor: statusColor,
                }}
              >
                {status}
              </span>
              {conf !== null && <span>confidence {(conf * 100).toFixed(0)}%</span>}
            </div>
          </li>
        )
      })}
    </ul>
  )
}

function VerdictsPanel({ events }: { events: OrchestratorEvent[] }) {
  if (events.length === 0) {
    return <p style={{ opacity: 0.6, fontSize: '0.85rem' }}>No quality gate verdicts yet</p>
  }
  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {events.map((ev) => {
        const payload = parsePayload(ev.payload)
        const verdict = String(payload['verdict'] ?? payload['outcome'] ?? 'unknown')
        const reason = String(payload['reason'] ?? payload['summary'] ?? '')
        const teamId = String(payload['teamId'] ?? payload['team_id'] ?? ev.session_id ?? '')
        const pass = verdict.toLowerCase().includes('pass') || verdict === 'approved'
        return (
          <li
            key={ev.id}
            style={{
              padding: '0.4rem 0',
              borderBottom: '1px solid var(--gray-a3, #222)',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.15rem',
            }}
          >
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'baseline' }}>
              <span
                style={{
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  padding: '0.05rem 0.45rem',
                  borderRadius: '9999px',
                  backgroundColor: pass
                    ? 'var(--green-a3, rgba(0,180,0,0.15))'
                    : 'var(--red-a3, rgba(220,40,40,0.15))',
                  color: pass ? 'var(--green-11, #4ade80)' : 'var(--red-11, #f87171)',
                }}
              >
                {pass ? 'PASS' : 'FAIL'}
              </span>
              {teamId && (
                <span style={{ fontSize: '0.75rem', fontFamily: 'monospace' }}>{teamId}</span>
              )}
              <span style={{ fontSize: '0.7rem', opacity: 0.55, marginLeft: 'auto' }}>
                {formatAge(ev.created_at)}
              </span>
            </div>
            {reason && (
              <p style={{ fontSize: '0.75rem', margin: 0, opacity: 0.75 }}>{reason}</p>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function CompletionsPanel({ events }: { events: OrchestratorEvent[] }) {
  if (events.length === 0) {
    return <p style={{ opacity: 0.6, fontSize: '0.85rem' }}>No team completions yet</p>
  }
  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {events.map((ev) => {
        const payload = parsePayload(ev.payload)
        const teamId = String(payload['teamId'] ?? payload['team_id'] ?? '')
        const diff = String(
          payload['stagedDiff'] ?? payload['staged_diff'] ?? payload['summary'] ?? '',
        )
        const preview = diff.length > 160 ? `${diff.slice(0, 160)}…` : diff
        const outcome = String(payload['outcome'] ?? payload['status'] ?? 'completed')
        return (
          <li
            key={ev.id}
            style={{
              padding: '0.4rem 0',
              borderBottom: '1px solid var(--gray-a3, #222)',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.15rem',
            }}
          >
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'baseline' }}>
              <span style={{ fontSize: '0.75rem', fontFamily: 'monospace' }}>
                {teamId || '—'}
              </span>
              <span style={{ fontSize: '0.7rem', opacity: 0.7 }}>· {outcome}</span>
              <span style={{ fontSize: '0.7rem', opacity: 0.55, marginLeft: 'auto' }}>
                {formatAge(ev.created_at)}
              </span>
            </div>
            {preview && (
              <pre
                style={{
                  fontSize: '0.7rem',
                  margin: 0,
                  padding: '0.3rem 0.5rem',
                  backgroundColor: 'var(--gray-a3, #1a1a1a)',
                  borderRadius: '0.25rem',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  opacity: 0.8,
                }}
              >
                {preview}
              </pre>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function MessagesPanel({ messages }: { messages: OrchestratorMessage[] }) {
  if (messages.length === 0) {
    return <p style={{ opacity: 0.6, fontSize: '0.85rem' }}>No recent messages</p>
  }
  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {messages.map((m) => (
        <li
          key={m.id}
          style={{
            padding: '0.35rem 0',
            borderBottom: '1px solid var(--gray-a3, #222)',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.1rem',
          }}
        >
          <div
            style={{
              display: 'flex',
              gap: '0.4rem',
              fontSize: '0.7rem',
              opacity: 0.65,
              fontFamily: 'monospace',
            }}
          >
            <span>{m.sender_id ?? '·'}</span>
            <span>→</span>
            <span>{m.receiver_id ?? (m.team_id ? `team:${m.team_id}` : 'broadcast')}</span>
            <span style={{ marginLeft: 'auto' }}>{formatAge(m.created_at)}</span>
          </div>
          <p style={{ margin: 0, fontSize: '0.8rem', whiteSpace: 'pre-wrap' }}>
            {m.content.length > 180 ? `${m.content.slice(0, 180)}…` : m.content}
          </p>
        </li>
      ))}
    </ul>
  )
}

function ScalingDecisionsPanel({ decisions }: { decisions: ScalingDecision[] }) {
  if (decisions.length === 0) {
    return <p style={{ opacity: 0.6, fontSize: '0.85rem' }}>No scaling decisions recorded yet</p>
  }
  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {decisions.map((d) => {
        const overridden = d.hint_shape !== d.chosen_shape
        const shapeColor = d.chosen_shape === 'team'
          ? 'var(--blue-a3, rgba(0,120,220,0.2))'
          : 'var(--green-a3, rgba(0,180,0,0.2))'
        const outcomeLabel =
          d.outcome_success == null
            ? null
            : d.outcome_success === 1
              ? `✓ pass${d.outcome_quality != null ? ` (${d.outcome_quality.toFixed(2)})` : ''}`
              : '✗ fail'
        return (
          <li
            key={d.id}
            data-testid="scaling-decision-row"
            style={{
              padding: '0.5rem 0',
              borderBottom: '1px solid var(--gray-a3, #222)',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.25rem',
            }}
          >
            <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <span
                style={{
                  fontSize: '0.7rem',
                  padding: '0.1rem 0.45rem',
                  borderRadius: '9999px',
                  backgroundColor: shapeColor,
                  fontFamily: 'monospace',
                }}
              >
                {d.chosen_shape}
              </span>
              {overridden && (
                <span
                  style={{
                    fontSize: '0.65rem',
                    padding: '0.1rem 0.4rem',
                    borderRadius: '9999px',
                    backgroundColor: 'var(--amber-a3, rgba(220,170,0,0.2))',
                    color: 'var(--amber-11, #f5b041)',
                  }}
                  title={`Extractor suggested ${d.hint_shape}; policy overrode to ${d.chosen_shape}`}
                >
                  overrode hint: {d.hint_shape}
                </span>
              )}
              {outcomeLabel && (
                <span
                  style={{
                    fontSize: '0.65rem',
                    padding: '0.1rem 0.4rem',
                    borderRadius: '9999px',
                    backgroundColor:
                      d.outcome_success === 1
                        ? 'var(--green-a3, rgba(0,180,0,0.2))'
                        : 'var(--red-a3, rgba(220,40,40,0.2))',
                  }}
                >
                  {outcomeLabel}
                </span>
              )}
              <span style={{ fontSize: '0.7rem', opacity: 0.6, marginLeft: 'auto' }}>
                {formatAge(d.created_at)}
              </span>
            </div>
            <p
              style={{
                margin: 0,
                fontSize: '0.85rem',
                fontWeight: 500,
                whiteSpace: 'pre-wrap',
              }}
            >
              {d.task_snippet}
            </p>
            <p
              style={{
                margin: 0,
                fontSize: '0.75rem',
                opacity: 0.75,
                fontStyle: 'italic',
                whiteSpace: 'pre-wrap',
              }}
            >
              {d.reasoning}
            </p>
            {d.roles.length > 0 && (
              <div style={{ fontSize: '0.7rem', opacity: 0.6, fontFamily: 'monospace' }}>
                roles: {d.roles.join(', ')}
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

export default function OrchestratorPage() {
  const [sinceWindow, setSinceWindow] = useState<TimeWindow>('24h')
  const { data, isLoading, error, dataUpdatedAt } = useQuery({
    queryKey: ['orchestrator-overview', sinceWindow],
    queryFn: () => getOrchestratorOverview(sinceWindow),
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
  })

  return (
    <div>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '1rem',
        }}
      >
        <div>
          <h1 style={{ margin: 0 }}>Orchestrator</h1>
          <p style={{ margin: '0.25rem 0 0', opacity: 0.6, fontSize: '0.85rem' }}>
            Live view of the brain’s autonomy loop — teams, suggestions, quality gate, and
            completions.
          </p>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.35rem' }}>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
              fontSize: '0.75rem',
              opacity: 0.85,
            }}
          >
            <span>Window:</span>
            <select
              aria-label="Time window"
              data-testid="orchestrator-time-window"
              value={sinceWindow}
              onChange={(e) => setSinceWindow(e.target.value as TimeWindow)}
              style={{
                fontSize: '0.75rem',
                padding: '0.15rem 0.4rem',
                borderRadius: '0.25rem',
                backgroundColor: 'var(--gray-a2, #111)',
                color: 'inherit',
                border: '1px solid var(--gray-a5, #333)',
              }}
            >
              {TIME_WINDOWS.map((w) => (
                <option key={w.value} value={w.value}>
                  {w.label}
                </option>
              ))}
            </select>
          </label>
          <span style={{ fontSize: '0.75rem', opacity: 0.6 }}>
            Polling every {POLL_MS / 1000}s ·{' '}
            {dataUpdatedAt ? `updated ${formatAge(new Date(dataUpdatedAt).toISOString())}` : '—'}
          </span>
        </div>
      </header>

      {error && (
        <div
          role="alert"
          style={{
            border: '1px solid var(--red-a5, #7a2a2a)',
            backgroundColor: 'var(--red-a2, rgba(220,40,40,0.08))',
            color: 'var(--red-11, #f87171)',
            padding: '0.75rem',
            borderRadius: '0.375rem',
            marginBottom: '1rem',
            fontSize: '0.85rem',
          }}
        >
          Failed to load orchestrator overview: {(error as Error).message}
        </div>
      )}

      {isLoading && !data && <p>Loading orchestrator…</p>}

      {data && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
            gap: '1rem',
          }}
        >
          <Panel title="Active Teams" count={data.teams.length}>
            <TeamsPanel teams={data.teams} />
          </Panel>

          <Panel title="Suggestions In-Flight" count={data.suggestions.length}>
            <SuggestionsPanel items={data.suggestions} />
          </Panel>

          <Panel title="Quality Gate Verdicts" count={data.verdicts.length}>
            <VerdictsPanel events={data.verdicts} />
          </Panel>

          <Panel title="Team Completions" count={data.completions.length}>
            <CompletionsPanel events={data.completions} />
          </Panel>

          <Panel title="Recent Messages" count={data.messages.length}>
            <MessagesPanel messages={data.messages} />
          </Panel>

          <Panel
            title="Scaling Decisions"
            count={data.scalingDecisions?.length ?? 0}
          >
            <ScalingDecisionsPanel decisions={data.scalingDecisions ?? []} />
          </Panel>
        </div>
      )}
    </div>
  )
}
