import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createArchiveStore,
  type ArchivedEntry,
} from '../../../src/memory/archive-store.js'

describe('archive-store', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scns-archive-test-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  function makeEntry(overrides: Partial<ArchivedEntry> = {}): ArchivedEntry {
    return {
      id: 'entry-1',
      name: 'Test Lesson',
      type: 'feedback',
      content: 'Always write tests first',
      source: 'daily-log:2026-04-15',
      createdAt: '2026-04-15T10:00:00Z',
      archivedAt: '2026-04-20T06:00:00Z',
      archiveReason: 'superseded',
      ...overrides,
    }
  }

  it('stores an entry as a markdown file', () => {
    const store = createArchiveStore({ rootDir: tempDir })
    store.archive(makeEntry())

    const files = readdirSync(tempDir)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/\.md$/)
  })

  it('stored file contains frontmatter with metadata', () => {
    const store = createArchiveStore({ rootDir: tempDir })
    store.archive(makeEntry({ id: 'entry-meta' }))

    const files = readdirSync(tempDir)
    const content = readFileSync(join(tempDir, files[0]!), 'utf-8')
    expect(content).toContain('id: entry-meta')
    expect(content).toContain('name: Test Lesson')
    expect(content).toContain('type: feedback')
    expect(content).toContain('archiveReason: superseded')
    expect(content).toContain('Always write tests first')
  })

  it('lists all archived entries', () => {
    const store = createArchiveStore({ rootDir: tempDir })
    store.archive(makeEntry({ id: 'a1', name: 'First' }))
    store.archive(makeEntry({ id: 'a2', name: 'Second' }))

    const entries = store.list()
    expect(entries).toHaveLength(2)
    expect(entries.map((e) => e.name).sort()).toEqual(['First', 'Second'])
  })

  it('searches archive entries by keyword', () => {
    const store = createArchiveStore({ rootDir: tempDir })
    store.archive(makeEntry({ id: 's1', content: 'Use Pino for logging' }))
    store.archive(makeEntry({ id: 's2', content: 'Always write unit tests' }))
    store.archive(makeEntry({ id: 's3', content: 'Prefer Zod for validation' }))

    const results = store.search('logging')
    expect(results).toHaveLength(1)
    expect(results[0]!.content).toContain('Pino')
  })

  it('search is case-insensitive', () => {
    const store = createArchiveStore({ rootDir: tempDir })
    store.archive(makeEntry({ id: 'ci1', content: 'Use ESM modules always' }))

    const results = store.search('esm')
    expect(results).toHaveLength(1)
  })

  it('search matches across name and content', () => {
    const store = createArchiveStore({ rootDir: tempDir })
    store.archive(makeEntry({ id: 'nc1', name: 'JWT Authentication', content: 'Use bcrypt' }))

    expect(store.search('JWT')).toHaveLength(1)
    expect(store.search('bcrypt')).toHaveLength(1)
  })

  it('returns empty array for no matches', () => {
    const store = createArchiveStore({ rootDir: tempDir })
    store.archive(makeEntry())

    expect(store.search('nonexistent-term')).toHaveLength(0)
  })

  it('handles empty archive directory', () => {
    const store = createArchiveStore({ rootDir: tempDir })
    expect(store.list()).toHaveLength(0)
    expect(store.search('anything')).toHaveLength(0)
  })

  it('creates directory if it does not exist', () => {
    const nestedDir = join(tempDir, 'nested', 'archive')
    const store = createArchiveStore({ rootDir: nestedDir })
    store.archive(makeEntry())

    const files = readdirSync(nestedDir)
    expect(files).toHaveLength(1)
  })

  it('count returns number of archived entries', () => {
    const store = createArchiveStore({ rootDir: tempDir })
    expect(store.count()).toBe(0)
    store.archive(makeEntry({ id: 'c1' }))
    store.archive(makeEntry({ id: 'c2' }))
    expect(store.count()).toBe(2)
  })

  it('supports user-rejected archive reason with rejection note', () => {
    const store = createArchiveStore({ rootDir: tempDir })
    store.archive(
      makeEntry({
        id: 'rejected-1',
        archiveReason: 'user-rejected',
        rejectionNote: 'I disagree with this lesson — it does not apply to my workflow',
      }),
    )

    const entries = store.list()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.archiveReason).toBe('user-rejected')
    expect(entries[0]!.rejectionNote).toBe(
      'I disagree with this lesson — it does not apply to my workflow',
    )
  })

  it('supports deprioritized archive reason', () => {
    const store = createArchiveStore({ rootDir: tempDir })
    store.archive(
      makeEntry({
        id: 'depri-1',
        archiveReason: 'deprioritized',
        rejectionNote: 'Not important right now',
      }),
    )

    const entries = store.list()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.archiveReason).toBe('deprioritized')
    expect(entries[0]!.rejectionNote).toBe('Not important right now')
  })

  it('handles rejection note with special characters', () => {
    const store = createArchiveStore({ rootDir: tempDir })
    store.archive(
      makeEntry({
        id: 'special-1',
        archiveReason: 'user-rejected',
        rejectionNote: "This has: colons, and\nmultiline content",
      }),
    )

    const entries = store.list()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.rejectionNote).toBe("This has: colons, and\nmultiline content")
  })

  it('omits rejectionNote from frontmatter when not provided', () => {
    const store = createArchiveStore({ rootDir: tempDir })
    store.archive(makeEntry({ id: 'no-note' }))

    const files = readdirSync(tempDir)
    const content = readFileSync(join(tempDir, files[0]!), 'utf-8')
    expect(content).not.toContain('rejectionNote')

    const entries = store.list()
    expect(entries[0]!.rejectionNote).toBeUndefined()
  })
})
