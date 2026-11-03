'use client'

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  searchMemory,
  getMemoryStats,
  getMemoryFiles,
  getMemoryLessons,
  getArchivedEntries,
  getMemoryTiers,
  archiveMemoryEntry,
  getScopedLessons,
  type MemoryFile,
  type MemoryLesson,
  type ArchivedEntry,
  type TierSummary,
  type ScopedLesson,
} from '@/lib/api'

interface MemoryResult {
  chunkId?: number
  filePath?: string
  content?: string
  score?: number
  vectorScore?: number
  keywordScore?: number
  chunkIndex?: number
  [key: string]: unknown
}

type TabId = 'lessons' | 'scoped' | 'negative' | 'archive' | 'tiers' | 'search'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const tabStyle = (active: boolean) => ({
  padding: '0.5rem 1rem',
  border: 'none',
  borderBottom: active ? '2px solid var(--accent-solid, #0072c3)' : '2px solid transparent',
  backgroundColor: 'transparent',
  color: active ? 'var(--accent-11)' : 'inherit',
  cursor: 'pointer',
  fontWeight: active ? 600 : 400,
  fontSize: '0.9rem',
})

const cardStyle = {
  padding: '0.75rem',
  marginBottom: '0.5rem',
  borderRadius: '0.5rem',
  backgroundColor: 'var(--gray-a3)',
  border: '1px solid var(--gray-a5)',
}

const badgeStyle = (color: string) => ({
  display: 'inline-block',
  padding: '0.125rem 0.5rem',
  borderRadius: '999px',
  fontSize: '0.7rem',
  fontWeight: 600,
  backgroundColor: color,
  color: 'white',
})

// ── Lessons Tab ──────────────────────────────────────────────────

function LessonsTab({ lessons }: { lessons: MemoryLesson[] }) {
  const queryClient = useQueryClient()
  const [archivingId, setArchivingId] = useState<string | null>(null)
  const [reason, setReason] = useState('user-rejected')
  const [note, setNote] = useState('')

  const archiveMutation = useMutation({
    mutationFn: ({ entryId, r, n }: { entryId: string; r: string; n?: string }) =>
      archiveMemoryEntry(entryId, r, n),
    onSuccess: () => {
      setArchivingId(null)
      setNote('')
      queryClient.invalidateQueries({ queryKey: ['memory-lessons'] })
      queryClient.invalidateQueries({ queryKey: ['memory-archive'] })
      queryClient.invalidateQueries({ queryKey: ['memory-tiers'] })
    },
  })

  if (lessons.length === 0) {
    return <p style={{ opacity: 0.6 }}>No lessons in MEMORY.md yet</p>
  }

  const typeColors: Record<string, string> = {
    feedback: '#2563eb',
    prohibition: '#dc2626',
    user: '#7c3aed',
    project: '#059669',
    reference: '#d97706',
  }

  return (
    <ul role="list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {lessons.map((lesson, i) => {
        const isArchiving = archivingId === (lesson.id ?? `idx-${i}`)
        return (
          <li key={lesson.id ?? i} style={cardStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.25rem' }}>
                  <span style={badgeStyle(typeColors[lesson.type] ?? '#6b7280')}>{lesson.type}</span>
                  <strong style={{ fontSize: '0.9rem' }}>{lesson.name}</strong>
                </div>
                <p style={{ margin: '0.25rem 0', fontSize: '0.85rem', opacity: 0.85 }}>{lesson.content}</p>
                {lesson.source && (
                  <p style={{ margin: 0, fontSize: '0.7rem', opacity: 0.5, fontFamily: 'monospace' }}>
                    {lesson.source} · {lesson.createdAt ? new Date(lesson.createdAt).toLocaleDateString() : ''}
                  </p>
                )}
              </div>
              {lesson.id && !isArchiving && (
                <button
                  onClick={() => setArchivingId(lesson.id!)}
                  style={{
                    padding: '0.25rem 0.5rem',
                    borderRadius: '0.25rem',
                    border: '1px solid var(--gray-a5)',
                    backgroundColor: 'transparent',
                    color: 'inherit',
                    cursor: 'pointer',
                    fontSize: '0.75rem',
                    whiteSpace: 'nowrap',
                  }}
                >
                  📦 Archive
                </button>
              )}
            </div>
            {isArchiving && (
              <div style={{ marginTop: '0.5rem', padding: '0.5rem', backgroundColor: 'var(--gray-a2)', borderRadius: '0.375rem' }}>
                <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.375rem' }}>
                  <select
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    style={{
                      padding: '0.25rem 0.5rem',
                      borderRadius: '0.25rem',
                      border: '1px solid var(--gray-a5)',
                      backgroundColor: 'var(--gray-a2)',
                      color: 'inherit',
                      fontSize: '0.8rem',
                    }}
                  >
                    <option value="user-rejected">I disagree with this</option>
                    <option value="deprioritized">Not important right now</option>
                    <option value="superseded">Replaced by something better</option>
                    <option value="low-value">Low value</option>
                  </select>
                </div>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Optional: why are you archiving this?"
                  rows={2}
                  style={{
                    width: '100%',
                    padding: '0.375rem',
                    borderRadius: '0.25rem',
                    border: '1px solid var(--gray-a5)',
                    backgroundColor: 'var(--gray-a2)',
                    color: 'inherit',
                    fontSize: '0.8rem',
                    resize: 'vertical',
                    boxSizing: 'border-box',
                  }}
                />
                <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.375rem' }}>
                  <button
                    onClick={() => archiveMutation.mutate({ entryId: lesson.id!, r: reason, n: note || undefined })}
                    disabled={archiveMutation.isPending}
                    style={{
                      padding: '0.25rem 0.75rem',
                      borderRadius: '0.25rem',
                      border: 'none',
                      backgroundColor: '#dc2626',
                      color: 'white',
                      cursor: 'pointer',
                      fontSize: '0.8rem',
                    }}
                  >
                    {archiveMutation.isPending ? 'Archiving…' : 'Confirm Archive'}
                  </button>
                  <button
                    onClick={() => { setArchivingId(null); setNote('') }}
                    style={{
                      padding: '0.25rem 0.75rem',
                      borderRadius: '0.25rem',
                      border: '1px solid var(--gray-a5)',
                      backgroundColor: 'transparent',
                      color: 'inherit',
                      cursor: 'pointer',
                      fontSize: '0.8rem',
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

// ── Archive Tab ──────────────────────────────────────────────────

function ArchiveTab({ entries }: { entries: ArchivedEntry[] }) {
  if (entries.length === 0) {
    return <p style={{ opacity: 0.6 }}>No archived entries yet</p>
  }

  return (
    <ul role="list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {entries.map((entry) => (
        <li key={entry.id} style={cardStyle}>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.25rem' }}>
            <span style={badgeStyle('#6b7280')}>{entry.archiveReason}</span>
            <strong style={{ fontSize: '0.9rem' }}>{entry.name}</strong>
          </div>
          <p style={{ margin: '0.25rem 0', fontSize: '0.85rem', opacity: 0.85 }}>{entry.content}</p>
          {entry.rejectionNote && (
            <p style={{ margin: '0.25rem 0', fontSize: '0.8rem', fontStyle: 'italic', color: 'var(--accent-11)' }}>
              💬 {entry.rejectionNote}
            </p>
          )}
          <p style={{ margin: 0, fontSize: '0.7rem', opacity: 0.5, fontFamily: 'monospace' }}>
            Archived: {new Date(entry.archivedAt).toLocaleDateString()} · From: {entry.source}
          </p>
        </li>
      ))}
    </ul>
  )
}

// ── Tiers Tab ───────────────────────────────────────────────────

function TiersTab({ tiers }: { tiers: TierSummary | undefined }) {
  if (!tiers) {
    return <p style={{ opacity: 0.6 }}>Loading tier information…</p>
  }

  const tierData = [
    { name: 'Daily Logs', icon: '📅', ...tiers.daily },
    { name: 'Weekly Summaries', icon: '📊', ...tiers.weekly },
    { name: 'Monthly Patterns', icon: '📈', ...tiers.monthly },
    { name: 'Archive', icon: '📦', ...tiers.archive },
  ]

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem', marginBottom: '1.5rem' }}>
        {tierData.map((tier) => (
          <div key={tier.name} style={{ ...cardStyle, textAlign: 'center' }}>
            <div style={{ fontSize: '1.5rem' }}>{tier.icon}</div>
            <div style={{ fontSize: '0.85rem', fontWeight: 600 }}>{tier.name}</div>
            <div style={{ fontSize: '1.25rem', fontWeight: 700 }}>{tier.count}</div>
            <div style={{ fontSize: '0.75rem', opacity: 0.6 }}>{formatBytes(tier.totalBytes)}</div>
          </div>
        ))}
      </div>

      <div style={cardStyle}>
        <h3 style={{ margin: '0 0 0.5rem', fontSize: '0.9rem' }}>🧠 Embedding Status</h3>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
          <span style={badgeStyle(tiers.embeddingStatus.ready ? '#059669' : '#d97706')}>
            {tiers.embeddingStatus.ready ? 'Ready' : 'Pending'}
          </span>
          <span style={{ fontSize: '0.85rem' }}>
            {tiers.embeddingStatus.embeddedChunks} / {tiers.embeddingStatus.totalChunks} chunks embedded
          </span>
        </div>
        {tiers.embeddingStatus.embeddedChunks > 0 && (
          <div style={{ marginTop: '0.5rem' }}>
            <div style={{
              height: '6px',
              borderRadius: '3px',
              backgroundColor: 'var(--gray-a4)',
              overflow: 'hidden',
            }}>
              <div style={{
                height: '100%',
                width: `${Math.round((tiers.embeddingStatus.embeddedChunks / Math.max(tiers.embeddingStatus.totalChunks, 1)) * 100)}%`,
                backgroundColor: 'var(--accent-solid, #0072c3)',
                borderRadius: '3px',
              }} />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Search Tab ──────────────────────────────────────────────────

function SearchTab({ files }: { files: MemoryFile[] }) {
  const [query, setQuery] = useState('')
  const [searchDone, setSearchDone] = useState(false)

  const searchMutation = useMutation({
    mutationFn: (q: string) => searchMemory(q) as Promise<MemoryResult[]>,
    onSuccess: () => setSearchDone(true),
  })

  const handleSearch = () => {
    if (query.trim()) searchMutation.mutate(query.trim())
  }

  const results = searchMutation.data ?? []

  return (
    <div>
      <div style={{ marginBottom: '1.5rem' }}>
        <label htmlFor="memory-search" style={{ display: 'block', marginBottom: '0.375rem', fontWeight: 500 }}>
          Search Memories
        </label>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <input
            id="memory-search"
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSearch() }}
            placeholder="Enter search query…"
            style={{
              flex: 1,
              padding: '0.5rem 0.75rem',
              borderRadius: '0.375rem',
              border: '1px solid var(--gray-a5)',
              backgroundColor: 'var(--gray-a2)',
              color: 'inherit',
            }}
          />
          <button
            onClick={handleSearch}
            disabled={searchMutation.isPending}
            style={{
              padding: '0.5rem 1rem',
              borderRadius: '0.375rem',
              border: 'none',
              backgroundColor: 'var(--accent-solid, #0072c3)',
              color: 'white',
              cursor: 'pointer',
              fontWeight: 500,
            }}
          >
            Search
          </button>
        </div>
      </div>

      {searchMutation.isPending && <p>Searching…</p>}
      {searchDone && results.length === 0 && <p>No results found</p>}

      {results.length > 0 && (
        <div style={{ marginBottom: '1.5rem' }}>
          <h2 style={{ fontSize: '1rem' }}>Search Results ({results.length})</h2>
          <ul role="list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {results.map((result, i) => (
              <li key={String(result.chunkId ?? i)} style={cardStyle}>
                {result.filePath && (
                  <p style={{ fontFamily: 'monospace', fontSize: '0.8rem', margin: '0 0 0.25rem', color: 'var(--accent-11)' }}>
                    {String(result.filePath)}
                  </p>
                )}
                <p style={{ margin: '0 0 0.25rem' }}>{String(result.content ?? '')}</p>
                <p style={{ fontSize: '0.75rem', margin: 0, opacity: 0.7 }}>
                  Score: {typeof result.score === 'number' ? result.score.toFixed(4) : result.score}
                  {result.vectorScore != null && ` (vector: ${typeof result.vectorScore === 'number' ? result.vectorScore.toFixed(4) : result.vectorScore}`}
                  {result.keywordScore != null && `, keyword: ${typeof result.keywordScore === 'number' ? result.keywordScore.toFixed(4) : result.keywordScore})`}
                  {result.vectorScore != null && result.keywordScore == null && ')'}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <h2 style={{ fontSize: '1rem' }}>Vault Files</h2>
        <FileList files={files} />
      </div>
    </div>
  )
}

function FileList({ files }: { files: MemoryFile[] }) {
  const [expanded, setExpanded] = useState<string | null>(null)

  if (files.length === 0) {
    return <p style={{ opacity: 0.6 }}>No memory files in vault</p>
  }

  const grouped: Record<string, MemoryFile[]> = {}
  for (const f of files) {
    const dir = f.path.includes('/') ? f.path.split('/').slice(0, -1).join('/') : '(root)'
    if (!grouped[dir]) grouped[dir] = []
    grouped[dir].push(f)
  }

  return (
    <div>
      {Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b)).map(([dir, dirFiles]) => (
        <div key={dir} style={{ marginBottom: '1rem' }}>
          <h3 style={{ fontSize: '0.85rem', fontFamily: 'monospace', margin: '0 0 0.5rem', color: 'var(--accent-11)' }}>
            📁 {dir}
          </h3>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {dirFiles.map((f) => {
              const fileName = f.path.split('/').pop() ?? f.path
              const isExpanded = expanded === f.path
              return (
                <li
                  key={f.path}
                  style={{
                    padding: '0.5rem 0.75rem',
                    marginBottom: '0.25rem',
                    borderRadius: '0.375rem',
                    backgroundColor: isExpanded ? 'var(--gray-a4)' : 'var(--gray-a2)',
                    border: '1px solid var(--gray-a4)',
                    cursor: 'pointer',
                  }}
                  onClick={() => setExpanded(isExpanded ? null : f.path)}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>📄 {fileName}</span>
                    <span style={{ fontSize: '0.75rem', opacity: 0.6 }}>
                      {formatBytes(f.sizeBytes)} · {new Date(f.modifiedAt).toLocaleDateString()}
                    </span>
                  </div>
                  {isExpanded && f.preview && (
                    <pre style={{
                      marginTop: '0.5rem',
                      padding: '0.5rem',
                      backgroundColor: 'var(--gray-a3)',
                      borderRadius: '0.25rem',
                      fontSize: '0.8rem',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      maxHeight: '200px',
                      overflow: 'auto',
                    }}>
                      {f.preview}{f.preview.length >= 200 ? '…' : ''}
                    </pre>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </div>
  )
}

// ── Scoped Lessons Tab (Phase 13.12.11) ──────────────────────────

function ScopedLessonsTab() {
  const [tagFilter, setTagFilter] = useState('')
  const [scopeFilter, setScopeFilter] = useState<'all' | 'global' | 'project' | 'agent'>('all')
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({})

  const { data, isLoading, error } = useQuery({
    queryKey: ['scoped-lessons'],
    queryFn: () => getScopedLessons(),
  })

  if (isLoading) return <p>Loading scoped lessons…</p>
  if (error) return <p>Error loading scoped lessons: {String(error)}</p>
  if (!data || !data.available) {
    return <p>Scoped lessons not available (lesson store not initialized).</p>
  }

  const allLessons = data.lessons ?? []
  const tagMatch = (l: ScopedLesson) =>
    !tagFilter || l.frontmatter.tags.some((t) => t.toLowerCase().includes(tagFilter.toLowerCase()))
  const scopeMatch = (l: ScopedLesson) => scopeFilter === 'all' || l.frontmatter.scope === scopeFilter
  const visible = allLessons.filter((l) => tagMatch(l) && scopeMatch(l))

  // Rebuild groups from visible
  const groups: Record<string, ScopedLesson[]> = {}
  for (const l of visible) {
    const key =
      l.frontmatter.scope === 'global'
        ? 'Global'
        : l.frontmatter.scope === 'project'
          ? `Project: ${l.frontmatter.project}`
          : `Agent: ${l.frontmatter.agent}`
    ;(groups[key] ??= []).push(l)
  }
  const orderedKeys = Object.keys(groups).sort((a, b) => {
    if (a === 'Global') return -1
    if (b === 'Global') return 1
    return a.localeCompare(b)
  })

  return (
    <div>
      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', alignItems: 'center' }}>
        <input
          type="text"
          placeholder="Filter by tag…"
          value={tagFilter}
          onChange={(e) => setTagFilter(e.target.value)}
          aria-label="Filter by tag"
          style={{
            flex: 1,
            padding: '0.4rem 0.6rem',
            borderRadius: '0.25rem',
            border: '1px solid var(--gray-a5)',
            backgroundColor: 'var(--gray-a2)',
          }}
        />
        <select
          aria-label="Scope filter"
          value={scopeFilter}
          onChange={(e) => setScopeFilter(e.target.value as typeof scopeFilter)}
          style={{
            padding: '0.4rem 0.6rem',
            borderRadius: '0.25rem',
            border: '1px solid var(--gray-a5)',
            backgroundColor: 'var(--gray-a2)',
          }}
        >
          <option value="all">All scopes</option>
          <option value="global">Global only</option>
          <option value="project">Project only</option>
          <option value="agent">Agent only</option>
        </select>
        <span style={{ fontSize: '0.8rem', opacity: 0.7 }}>
          {visible.length} / {allLessons.length}
        </span>
      </div>

      {orderedKeys.length === 0 && <p>No lessons match the current filters.</p>}

      {orderedKeys.map((key) => {
        const isOpen = openGroups[key] !== false
        const ls = groups[key]!
        return (
          <div key={key} style={{ ...cardStyle, padding: '0.5rem 0.75rem' }}>
            <button
              onClick={() => setOpenGroups((prev) => ({ ...prev, [key]: !isOpen }))}
              aria-expanded={isOpen}
              aria-label={`Toggle ${key}`}
              style={{
                display: 'flex',
                width: '100%',
                justifyContent: 'space-between',
                alignItems: 'center',
                background: 'none',
                border: 'none',
                padding: '0.25rem 0',
                cursor: 'pointer',
                color: 'inherit',
                fontSize: '0.95rem',
                fontWeight: 600,
              }}
            >
              <span>
                {isOpen ? '▼' : '▶'} {key} ({ls.length})
              </span>
            </button>
            {isOpen && (
              <div style={{ marginTop: '0.5rem' }}>
                {ls.map((l) => (
                  <div
                    key={l.path}
                    style={{
                      padding: '0.5rem',
                      borderRadius: '0.25rem',
                      backgroundColor: 'var(--gray-a2)',
                      marginBottom: '0.4rem',
                    }}
                  >
                    <div style={{ fontWeight: 600, fontSize: '0.85rem' }}>{l.frontmatter.id}</div>
                    {l.frontmatter.tags.length > 0 && (
                      <div style={{ marginTop: '0.25rem', display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>
                        {l.frontmatter.tags.map((t) => (
                          <span
                            key={t}
                            data-testid="tag-chip"
                            style={{
                              display: 'inline-block',
                              padding: '0.1rem 0.45rem',
                              borderRadius: '999px',
                              fontSize: '0.65rem',
                              backgroundColor: 'var(--accent-a4)',
                              color: 'var(--accent-11)',
                            }}
                          >
                            {t}
                          </span>
                        ))}
                      </div>
                    )}
                    <p style={{ margin: '0.4rem 0 0 0', fontSize: '0.8rem', opacity: 0.85, whiteSpace: 'pre-wrap' }}>
                      {l.body.length > 280 ? `${l.body.slice(0, 280)}…` : l.body}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Main Page ────────────────────────────────────────────────────

export default function MemoryPage() {
  const [activeTab, setActiveTab] = useState<TabId>('lessons')

  const { data: stats, isError: statsError } = useQuery({
    queryKey: ['memory-stats'],
    queryFn: getMemoryStats,
  })

  const { data: files } = useQuery({
    queryKey: ['memory-files'],
    queryFn: getMemoryFiles,
  })

  const { data: lessons } = useQuery({
    queryKey: ['memory-lessons'],
    queryFn: getMemoryLessons,
  })

  const { data: archived } = useQuery({
    queryKey: ['memory-archive'],
    queryFn: getArchivedEntries,
  })

  const { data: tiers } = useQuery({
    queryKey: ['memory-tiers'],
    queryFn: getMemoryTiers,
  })

  if (statsError) {
    return (
      <div>
        <h1>Memory</h1>
        <p>Memory system is not available</p>
      </div>
    )
  }

  return (
    <div>
      <h1>Memory</h1>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: '1.5rem' }}>
        <div>
          {/* Tab Bar */}
          <div style={{ display: 'flex', borderBottom: '1px solid var(--gray-a4)', marginBottom: '1rem' }}>
            <button style={tabStyle(activeTab === 'lessons')} onClick={() => setActiveTab('lessons')}>
              📝 Lessons {lessons ? `(${lessons.length})` : ''}
            </button>
            <button style={tabStyle(activeTab === 'scoped')} onClick={() => setActiveTab('scoped')}>
              🎯 Scoped
            </button>
            <button style={tabStyle(activeTab === 'archive')} onClick={() => setActiveTab('archive')}>
              📦 Archive {archived ? `(${archived.length})` : ''}
            </button>
            <button style={tabStyle(activeTab === 'tiers')} onClick={() => setActiveTab('tiers')}>
              📊 Tiers
            </button>
            <button style={tabStyle(activeTab === 'search')} onClick={() => setActiveTab('search')}>
              🔍 Search
            </button>
          </div>

          {/* Tab Content */}
          {activeTab === 'lessons' && <LessonsTab lessons={lessons ?? []} />}
          {activeTab === 'scoped' && <ScopedLessonsTab />}
          {activeTab === 'archive' && <ArchiveTab entries={archived ?? []} />}
          {activeTab === 'tiers' && <TiersTab tiers={tiers} />}
          {activeTab === 'search' && <SearchTab files={files ?? []} />}
        </div>

        <aside>
          <section aria-labelledby="stats-heading">
            <h2 id="stats-heading" style={{ fontSize: '1rem', marginTop: 0 }}>Vault Stats</h2>
            {stats && (
              <dl style={{ margin: 0 }}>
                <div style={{ marginBottom: '0.5rem' }}>
                  <dt style={{ fontSize: '0.75rem', opacity: 0.6 }}>Files</dt>
                  <dd style={{ margin: 0, fontWeight: 600, fontSize: '1.25rem' }}>
                    {String((stats as Record<string, unknown>).totalFiles ?? 0)}
                  </dd>
                </div>
                <div style={{ marginBottom: '0.5rem' }}>
                  <dt style={{ fontSize: '0.75rem', opacity: 0.6 }}>Indexed Chunks</dt>
                  <dd style={{ margin: 0, fontWeight: 600 }}>
                    {String((stats as Record<string, unknown>).indexedChunks ?? 0)}
                  </dd>
                </div>
                <div style={{ marginBottom: '0.5rem' }}>
                  <dt style={{ fontSize: '0.75rem', opacity: 0.6 }}>Root Directory</dt>
                  <dd style={{ margin: 0, fontSize: '0.8rem', fontFamily: 'monospace', wordBreak: 'break-all' }}>
                    {String((stats as Record<string, unknown>).rootDir ?? '')}
                  </dd>
                </div>
              </dl>
            )}
          </section>
        </aside>
      </div>
    </div>
  )
}
