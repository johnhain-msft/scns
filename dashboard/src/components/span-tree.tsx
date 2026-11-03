'use client'

import { useState } from 'react'
import type { SpanNode } from '@/lib/api'

export function formatDuration(ms: number | null): string {
  if (ms == null) return '—'
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`
  return `${ms}ms`
}

function StatusBadge({ status }: { status: string | null }) {
  const label = status ?? 'UNSET'
  const styles: Record<string, { bg: string; color: string }> = {
    OK: { bg: 'var(--green-a3)', color: 'var(--green-11)' },
    ERROR: { bg: 'var(--red-a3)', color: 'var(--red-11)' },
    UNSET: { bg: 'var(--gray-a3)', color: 'var(--gray-11)' },
  }
  const s = styles[label] ?? styles.UNSET
  return (
    <span
      style={{
        padding: '0.125rem 0.5rem',
        borderRadius: '0.25rem',
        fontSize: '0.75rem',
        fontWeight: 600,
        backgroundColor: s.bg,
        color: s.color,
      }}
    >
      {label}
    </span>
  )
}

function SpanNodeRow({ node, depth = 0 }: { node: SpanNode; depth?: number }) {
  const [expanded, setExpanded] = useState(false)
  const hasChildren = node.children && node.children.length > 0

  return (
    <li role="treeitem" aria-expanded={hasChildren ? expanded : undefined}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          paddingLeft: `${depth * 1.5 + 0.5}rem`,
          paddingTop: '0.375rem',
          paddingBottom: '0.375rem',
          paddingRight: '0.5rem',
          borderBottom: '1px solid var(--gray-a3)',
        }}
      >
        {hasChildren ? (
          <button
            onClick={() => setExpanded(!expanded)}
            aria-label={expanded ? `Collapse ${node.span.name}` : `Expand ${node.span.name}`}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--gray-11)',
              padding: '0.125rem',
              fontSize: '0.75rem',
              lineHeight: 1,
            }}
          >
            {expanded ? '▼' : '▶'}
          </button>
        ) : (
          <span style={{ width: '1rem', display: 'inline-block' }} aria-hidden="true" />
        )}
        <span style={{ fontWeight: 500 }}>{node.span.name}</span>
        <span style={{ color: 'var(--gray-11)', fontSize: '0.875rem' }}>
          {formatDuration(node.span.duration_ms)}
        </span>
        <StatusBadge status={node.span.status} />
      </div>
      {expanded && hasChildren && (
        <ul role="group" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {node.children.map((child) => (
            <SpanNodeRow key={child.span.span_id} node={child} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  )
}

interface SpanTreeProps {
  spans: readonly SpanNode[]
}

export function SpanTree({ spans }: SpanTreeProps) {
  return (
    <ul role="tree" aria-label="Span tree" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {spans.map((span) => (
        <SpanNodeRow key={span.span.span_id} node={span} depth={0} />
      ))}
    </ul>
  )
}

export { StatusBadge }
