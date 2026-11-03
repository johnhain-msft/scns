'use client'

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getSuggestions,
  approveSuggestion,
  rejectSuggestion,
  retrySuggestion,
  deleteSuggestion,
  repromoteSuggestion,
} from '@/lib/api'
import { ConfidenceBar } from '@/components/confidence-bar'
import { SUGGESTION_TYPES, labelForType } from '@/lib/suggestion-types'

interface EvidenceItem {
  source: string
  detail: string
  observedAt: string
  weight: number
}

interface BlockedMetadata {
  requiredLevel: number
  blockedAt?: string
}

interface TagProposalPayload {
  tagName: string
  scope: 'global' | 'project' | 'agent'
  project?: string
  agent?: string
  candidateLessonIds: string[]
  rationale?: string
}

interface Suggestion {
  id: string
  title: string
  description?: string
  type?: string
  confidence?: number
  status: string
  evidence?: Array<EvidenceItem | string>
  blockedMetadata?: BlockedMetadata
  /** Phase 13.12.9 */
  attemptCount?: number
  lastError?: string | null
  lastAttemptAt?: string | null
  nextRetryAt?: string | null
  /** Phase 13.12.12 — tag-proposal payload (flattened on backend, rebuilt here). */
  tagProposal?: TagProposalPayload
  tagProposalName?: string
  tagProposalScope?: 'global' | 'project' | 'agent'
  tagProposalProject?: string
  tagProposalAgent?: string
  tagProposalLessons?: string[]
  tagProposalRationale?: string
}

function renderEvidenceItem(e: EvidenceItem | string, i: number) {
  if (typeof e === 'string') {
    return <li key={i}>{e}</li>
  }
  if (e && typeof e === 'object' && 'source' in e && 'detail' in e) {
    return (
      <li key={i}>
        <strong>{e.source}</strong>: {e.detail}{' '}
        {typeof e.weight === 'number' && (
          <span style={{ opacity: 0.6 }}>(weight: {e.weight.toFixed(2)})</span>
        )}
      </li>
    )
  }
  return null
}

function asSuggestion(record: Record<string, unknown>): Suggestion {
  const s = record as unknown as Suggestion
  // Phase 13.12.12 — backend serializes the tag-proposal payload as flat
  // fields (`tagProposalName`, `tagProposalScope`, `tagProposalLessons`, ...).
  // If the nested `tagProposal` field isn't present but the flat ones are,
  // reassemble into the nested shape the UI expects.
  if (!s.tagProposal && s.tagProposalName) {
    s.tagProposal = {
      tagName: s.tagProposalName,
      scope: s.tagProposalScope ?? 'global',
      ...(s.tagProposalProject ? { project: s.tagProposalProject } : {}),
      ...(s.tagProposalAgent ? { agent: s.tagProposalAgent } : {}),
      candidateLessonIds: s.tagProposalLessons ?? [],
      ...(s.tagProposalRationale ? { rationale: s.tagProposalRationale } : {}),
    }
  }
  return s
}

const TYPE_ICONS: Record<string, string> = {
  skill: '⚡',
  workflow: '🔄',
  automation: '🤖',
  agent: '🧠',
  mcp: '🔌',
  'tag-proposal': '🏷️',
}

const TABS = [
  'pending',
  'approved',
  'blocked-autonomy',
  'failed',
  'needs-human',
  'rejected',
  'implemented',
] as const

const TAB_LABELS: Record<(typeof TABS)[number], string> = {
  pending: 'Pending',
  approved: 'Approved',
  'blocked-autonomy': 'Blocked',
  failed: 'Failed',
  'needs-human': 'Needs Human',
  rejected: 'Rejected',
  implemented: 'Implemented',
}

function formatCountdown(targetIso: string, nowMs: number): string {
  const targetMs = new Date(targetIso).getTime()
  if (!Number.isFinite(targetMs)) return targetIso
  const diffMs = targetMs - nowMs
  if (diffMs <= 0) return 'ready now'
  const seconds = Math.floor(diffMs / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h`
}

function SuggestionCard({
  suggestion,
  showActions,
  onApprove,
  onReject,
  onRetry,
  onDelete,
  onRepromote,
  nowMs,
}: {
  suggestion: Suggestion
  showActions: boolean
  onApprove: () => void
  onReject: () => void
  onRetry: () => void
  onDelete: () => void
  onRepromote: () => void
  nowMs: number
}) {
  const icon = TYPE_ICONS[suggestion.type || ''] || '📋'
  const isFailed = suggestion.status === 'failed'
  const isNeedsHuman = suggestion.status === 'needs-human'
  const isNonPending = !showActions // `showActions` is only true on the pending tab
  const attemptCount = suggestion.attemptCount ?? 0
  const hasActiveBackoff =
    !!suggestion.nextRetryAt &&
    new Date(suggestion.nextRetryAt).getTime() > nowMs

  // Delete button used by all non-pending rows; confirms before firing.
  const confirmedDelete = () => {
    if (
      typeof window !== 'undefined' &&
      window.confirm(`Delete suggestion "${suggestion.title}"? This removes the file.`)
    ) {
      onDelete()
    }
  }

  return (
    <div
      style={{
        border: '1px solid var(--gray-a5, #333)',
        borderRadius: '0.5rem',
        padding: '1rem',
        marginBottom: '0.75rem',
        backgroundColor: 'var(--gray-a2, #111)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
        <span style={{ fontSize: '1.5rem' }} aria-hidden="true">
          {icon}
        </span>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
            <h2 style={{ fontSize: '1rem', fontWeight: 600, margin: 0 }}>{suggestion.title}</h2>
            {suggestion.type && (
              <span
                style={{
                  display: 'inline-block',
                  padding: '0.125rem 0.5rem',
                  borderRadius: '9999px',
                  fontSize: '0.7rem',
                  fontWeight: 500,
                  backgroundColor: 'var(--gray-a3, #222)',
                  color: 'var(--gray-11, #aaa)',
                }}
              >
                {suggestion.type}
              </span>
            )}
            {suggestion.status === 'blocked-autonomy' && suggestion.blockedMetadata && (
              <span
                aria-label={`Needs autonomy level ${suggestion.blockedMetadata.requiredLevel}`}
                title={
                  suggestion.blockedMetadata.blockedAt
                    ? `Blocked at ${suggestion.blockedMetadata.blockedAt}; will auto-reset when autonomy reaches L${suggestion.blockedMetadata.requiredLevel}.`
                    : `Will auto-reset when autonomy reaches L${suggestion.blockedMetadata.requiredLevel}.`
                }
                style={{
                  display: 'inline-block',
                  padding: '0.125rem 0.5rem',
                  borderRadius: '9999px',
                  fontSize: '0.7rem',
                  fontWeight: 600,
                  backgroundColor: 'var(--amber-a4, #4a3a10)',
                  color: 'var(--amber-11, #f5b042)',
                  border: '1px solid var(--amber-a7, #8a6a20)',
                }}
              >
                Needs L{suggestion.blockedMetadata.requiredLevel}
              </span>
            )}
          </div>

          {suggestion.description && (
            <p style={{ fontSize: '0.85rem', opacity: 0.8, margin: '0.25rem 0 0.5rem' }}>
              {suggestion.description}
            </p>
          )}

          {suggestion.confidence !== undefined && (
            <div style={{ maxWidth: '200px', marginBottom: '0.5rem' }}>
              <ConfidenceBar value={suggestion.confidence} />
            </div>
          )}

          {suggestion.type === 'tag-proposal' && suggestion.tagProposal && (
            <div
              data-testid="tag-proposal-preview"
              style={{
                margin: '0.5rem 0',
                padding: '0.5rem 0.75rem',
                borderRadius: '0.375rem',
                border: '1px solid var(--violet-a7, #6a4aa8)',
                backgroundColor: 'var(--violet-a2, #1a1028)',
                fontSize: '0.8rem',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.35rem' }}>
                <span
                  data-testid="tag-proposal-chip"
                  style={{
                    display: 'inline-block',
                    padding: '0.125rem 0.5rem',
                    borderRadius: '9999px',
                    fontSize: '0.7rem',
                    fontWeight: 600,
                    backgroundColor: 'var(--violet-a4, #3a2468)',
                    color: 'var(--violet-11, #b29aee)',
                    border: '1px solid var(--violet-a7, #6a4aa8)',
                  }}
                >
                  🏷️ {suggestion.tagProposal.tagName}
                </span>
                <span style={{ opacity: 0.7, fontSize: '0.75rem' }}>
                  scope: {suggestion.tagProposal.scope}
                  {suggestion.tagProposal.project ? ` · ${suggestion.tagProposal.project}` : ''}
                  {suggestion.tagProposal.agent ? ` · ${suggestion.tagProposal.agent}` : ''}
                </span>
              </div>
              <div style={{ opacity: 0.8, fontSize: '0.75rem', marginBottom: '0.25rem' }}>
                Would apply to {suggestion.tagProposal.candidateLessonIds.length} lesson(s):
              </div>
              <ul
                data-testid="tag-proposal-lessons"
                style={{ margin: 0, paddingLeft: '1.25rem', fontSize: '0.75rem', opacity: 0.85 }}
              >
                {suggestion.tagProposal.candidateLessonIds.slice(0, 10).map((id) => (
                  <li key={id} style={{ fontFamily: 'var(--code-font, monospace)' }}>
                    {id}
                  </li>
                ))}
                {suggestion.tagProposal.candidateLessonIds.length > 10 && (
                  <li style={{ opacity: 0.6 }}>
                    + {suggestion.tagProposal.candidateLessonIds.length - 10} more
                  </li>
                )}
              </ul>
            </div>
          )}

          {suggestion.evidence && suggestion.evidence.length > 0 && (
            <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.25rem', fontSize: '0.8rem', opacity: 0.7 }}>
              {suggestion.evidence.map((e, i) => renderEvidenceItem(e, i))}
            </ul>
          )}

          {attemptCount > 0 && (
            <div
              data-testid="suggestion-failure-info"
              style={{
                marginTop: '0.5rem',
                padding: '0.5rem 0.75rem',
                borderRadius: '0.375rem',
                border: `1px solid ${isFailed ? 'var(--red-a7, #a13a3a)' : 'var(--amber-a7, #8a6a20)'}`,
                backgroundColor: isFailed ? 'var(--red-a3, #2a1010)' : 'var(--amber-a2, #2a2210)',
                fontSize: '0.75rem',
              }}
            >
              <div>
                <strong>Attempts:</strong> <span data-testid="attempt-count">{attemptCount}</span>
                {hasActiveBackoff && suggestion.nextRetryAt && !isFailed && (
                  <span data-testid="retry-countdown" style={{ marginLeft: '0.75rem', opacity: 0.8 }}>
                    next retry in {formatCountdown(suggestion.nextRetryAt, nowMs)}
                  </span>
                )}
              </div>
              {suggestion.lastError && (
                <div
                  data-testid="last-error"
                  style={{ marginTop: '0.25rem', opacity: 0.85, wordBreak: 'break-word' }}
                >
                  <strong>Last error:</strong> {suggestion.lastError}
                </div>
              )}
            </div>
          )}

          {showActions && (
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
              <button
                onClick={onApprove}
                aria-label={`Approve ${suggestion.title}`}
                style={{
                  padding: '0.375rem 1rem',
                  borderRadius: '0.375rem',
                  border: 'none',
                  backgroundColor: '#1b7a4a',
                  color: 'white',
                  cursor: 'pointer',
                  fontSize: '0.8rem',
                  fontWeight: 500,
                }}
              >
                Approve
              </button>
              <button
                onClick={onReject}
                aria-label={`Reject ${suggestion.title}`}
                style={{
                  padding: '0.375rem 1rem',
                  borderRadius: '0.375rem',
                  border: '1px solid var(--red-9, #e5484d)',
                  backgroundColor: 'transparent',
                  color: 'var(--red-11, #f27474)',
                  cursor: 'pointer',
                  fontSize: '0.8rem',
                  fontWeight: 500,
                }}
              >
                Reject
              </button>
            </div>
          )}

          {isNonPending && (
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
              {isFailed && (
                <button
                  onClick={onRetry}
                  aria-label={`Retry ${suggestion.title}`}
                  data-testid="retry-button"
                  style={{
                    padding: '0.375rem 1rem',
                    borderRadius: '0.375rem',
                    border: 'none',
                    backgroundColor: '#3e63dd',
                    color: 'white',
                    cursor: 'pointer',
                    fontSize: '0.8rem',
                    fontWeight: 500,
                  }}
                >
                  🔄 Retry
                </button>
              )}
              {isNeedsHuman && (
                <button
                  onClick={onRepromote}
                  aria-label={`Repromote ${suggestion.title}`}
                  data-testid="repromote-button"
                  style={{
                    padding: '0.375rem 1rem',
                    borderRadius: '0.375rem',
                    border: 'none',
                    backgroundColor: '#8a5cf6',
                    color: 'white',
                    cursor: 'pointer',
                    fontSize: '0.8rem',
                    fontWeight: 500,
                  }}
                >
                  👤→🔄 Repromote
                </button>
              )}
              <button
                onClick={confirmedDelete}
                aria-label={`Delete ${suggestion.title}`}
                data-testid="delete-button"
                style={{
                  padding: '0.375rem 1rem',
                  borderRadius: '0.375rem',
                  border: '1px solid var(--red-9, #e5484d)',
                  backgroundColor: 'transparent',
                  color: 'var(--red-11, #f27474)',
                  cursor: 'pointer',
                  fontSize: '0.8rem',
                  fontWeight: 500,
                }}
              >
                🗑 Delete
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default function SuggestionsPage() {
  const queryClient = useQueryClient()
  const [activeTab, setActiveTab] = useState<string>('pending')
  const [typeFilter, setTypeFilter] = useState<string>('all')

  const { data: suggestions, isLoading, isError } = useQuery({
    queryKey: ['suggestions', activeTab],
    queryFn: () => getSuggestions(activeTab),
  })

  const approveMutation = useMutation({
    mutationFn: (id: string) => approveSuggestion(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['suggestions'] })
    },
  })

  const rejectMutation = useMutation({
    mutationFn: (id: string) => rejectSuggestion(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['suggestions'] })
    },
  })

  const retryMutation = useMutation({
    mutationFn: (id: string) => retrySuggestion(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['suggestions'] })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteSuggestion(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['suggestions'] })
    },
  })

  const repromoteMutation = useMutation({
    mutationFn: (id: string) => repromoteSuggestion(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['suggestions'] })
    },
  })

  const nowMs = Date.now()

  if (isError) {
    return (
      <div>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '1.5rem' }}>Suggestions</h1>
        <p>Suggestion system is not available. Please try again later.</p>
      </div>
    )
  }

  const allSuggestions = suggestions?.map(asSuggestion)
  const filteredSuggestions =
    typeFilter === 'all'
      ? allSuggestions
      : allSuggestions?.filter((s) => s.type === typeFilter)

  const showActions = activeTab === 'pending'

  return (
    <div>
      <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '1.5rem' }}>Suggestions</h1>

      <div aria-live="polite" className="sr-only" />

      <div
        role="tablist"
        aria-label="Suggestion status tabs"
        style={{
          display: 'flex',
          gap: '0',
          borderBottom: '1px solid var(--gray-a5, #333)',
          marginBottom: '1rem',
        }}
      >
        {TABS.map((tab) => (
          <button
            key={tab}
            role="tab"
            id={`tab-${tab}`}
            aria-selected={activeTab === tab}
            aria-controls={`tabpanel-${tab}`}
            onClick={() => setActiveTab(tab)}
            style={{
              padding: '0.5rem 1rem',
              border: 'none',
              borderBottom: activeTab === tab
                ? '2px solid var(--accent-9, #3e63dd)'
                : '2px solid transparent',
              backgroundColor: 'transparent',
              color: activeTab === tab
                ? 'var(--accent-11, #5b7aef)'
                : 'var(--gray-11, #aaa)',
              cursor: 'pointer',
              fontSize: '0.875rem',
              fontWeight: activeTab === tab ? 600 : 400,
              textTransform: 'capitalize',
            }}
          >
            {TAB_LABELS[tab]}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
        <label htmlFor="type-filter" style={{ fontSize: '0.85rem' }}>
          Filter by type
        </label>
        <select
          id="type-filter"
          aria-label="Filter by type"
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          style={{
            padding: '0.375rem 0.75rem',
            borderRadius: '0.375rem',
            border: '1px solid var(--gray-a5, #444)',
            backgroundColor: 'var(--gray-a2, #111)',
            color: 'inherit',
            fontSize: '0.85rem',
          }}
        >
          <option value="all">All types</option>
          {SUGGESTION_TYPES.map((t) => (
            <option key={t} value={t}>
              {labelForType(t)}
            </option>
          ))}
        </select>
      </div>

      <div
        role="tabpanel"
        id={`tabpanel-${activeTab}`}
        aria-labelledby={`tab-${activeTab}`}
      >
        {isLoading ? (
          <p>Loading...</p>
        ) : filteredSuggestions && filteredSuggestions.length > 0 ? (
          filteredSuggestions.map((suggestion) => (
            <SuggestionCard
              key={suggestion.id}
              suggestion={suggestion}
              showActions={showActions}
              onApprove={() => approveMutation.mutate(suggestion.id)}
              onReject={() => rejectMutation.mutate(suggestion.id)}
              onRetry={() => retryMutation.mutate(suggestion.id)}
              onDelete={() => deleteMutation.mutate(suggestion.id)}
              onRepromote={() => repromoteMutation.mutate(suggestion.id)}
              nowMs={nowMs}
            />
          ))
        ) : (
          <p style={{ textAlign: 'center', opacity: 0.6, padding: '2rem 0' }}>
            No {TAB_LABELS[activeTab as (typeof TABS)[number]]?.toLowerCase() ?? activeTab} suggestions
          </p>
        )}
      </div>
    </div>
  )
}
