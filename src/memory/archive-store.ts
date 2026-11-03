/**
 * Archive store ("Drunk Memories") — filesystem-based archive for weeded-out memory entries.
 *
 * Low-value, superseded, or old entries get moved here during consolidation.
 * NOT indexed in hybrid search. Only searchable on explicit request.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

// ── Types ──────────────────────────────────────────────────────────

export interface ArchivedEntry {
  readonly id: string
  readonly name: string
  readonly type: string
  readonly content: string
  readonly source: string
  readonly createdAt: string
  readonly archivedAt: string
  readonly archiveReason:
    | 'superseded'
    | 'low-value'
    | 'old'
    | 'duplicate'
    | 'pruned'
    | 'user-rejected'
    | 'deprioritized'
  readonly rejectionNote?: string
}

export interface ArchiveStoreOptions {
  readonly rootDir: string
}

// ── Frontmatter helpers ────────────────────────────────────────────

function toFrontmatter(entry: ArchivedEntry): string {
  const lines = [
    '---',
    `id: ${entry.id}`,
    `name: ${entry.name}`,
    `type: ${entry.type}`,
    `source: ${entry.source}`,
    `createdAt: ${entry.createdAt}`,
    `archivedAt: ${entry.archivedAt}`,
    `archiveReason: ${entry.archiveReason}`,
  ]
  if (entry.rejectionNote) {
    // Escape newlines for safe frontmatter serialization
    lines.push(`rejectionNote: ${entry.rejectionNote.replace(/\n/g, '\\n')}`)
  }
  lines.push('---', '', entry.content, '')
  return lines.join('\n')
}

function parseFrontmatter(raw: string): ArchivedEntry | null {
  const match = /^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/.exec(raw)
  if (!match) return null

  const meta = match[1]!
  const content = match[2]!.trim()

  function field(name: string): string {
    const re = new RegExp(`^${name}:\\s*(.+)$`, 'm')
    const m = re.exec(meta)
    return m?.[1]?.trim() ?? ''
  }

  return {
    id: field('id'),
    name: field('name'),
    type: field('type'),
    content,
    source: field('source'),
    createdAt: field('createdAt'),
    archivedAt: field('archivedAt'),
    archiveReason: field('archiveReason') as ArchivedEntry['archiveReason'],
    ...(field('rejectionNote')
      ? { rejectionNote: field('rejectionNote').replace(/\\n/g, '\n') }
      : {}),
  }
}

// ── Store factory ──────────────────────────────────────────────────

export function createArchiveStore(options: ArchiveStoreOptions) {
  const { rootDir } = options

  function ensureDir(): void {
    mkdirSync(rootDir, { recursive: true })
  }

  function safePath(filename: string): string {
    const sanitized = basename(filename)
    const full = resolve(rootDir, sanitized)
    if (!full.startsWith(resolve(rootDir))) {
      throw new Error('Path traversal detected in archive store')
    }
    return full
  }

  function archive(entry: ArchivedEntry): void {
    ensureDir()
    const filename = `${entry.id || randomUUID()}.md`
    writeFileSync(safePath(filename), toFrontmatter(entry), 'utf-8')
  }

  function readAll(): ArchivedEntry[] {
    ensureDir()
    const files = readdirSync(rootDir).filter((f) => f.endsWith('.md'))
    const entries: ArchivedEntry[] = []

    for (const file of files) {
      const raw = readFileSync(join(rootDir, file), 'utf-8')
      const parsed = parseFrontmatter(raw)
      if (parsed) entries.push(parsed)
    }

    return entries
  }

  function list(): ArchivedEntry[] {
    return readAll()
  }

  function search(query: string): ArchivedEntry[] {
    const lower = query.toLowerCase()
    return readAll().filter(
      (e) => e.name.toLowerCase().includes(lower) || e.content.toLowerCase().includes(lower),
    )
  }

  function count(): number {
    ensureDir()
    return readdirSync(rootDir).filter((f) => f.endsWith('.md')).length
  }

  return { archive, list, search, count }
}
