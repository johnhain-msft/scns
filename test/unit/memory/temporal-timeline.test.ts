import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openMemoryDb, closeMemoryDb } from '../../../src/memory/db.js'
import { temporalTimeline } from '../../../src/memory/temporal-timeline.js'
import type { SearchResult } from '../../../src/memory/search.js'
import type Database from 'better-sqlite3'

function addChunk(db: Database.Database, path: string, mtimeMs: number, content: string): number {
  db.prepare('INSERT INTO vault_files (path, mtime_ms, size_bytes) VALUES (?, ?, ?)').run(
    path,
    mtimeMs,
    content.length,
  )
  return db
    .prepare(
      `INSERT INTO chunks (file_path, chunk_index, content, start_offset, end_offset, token_count)
       VALUES (?, 0, ?, 0, ?, 1)`,
    )
    .run(path, content, content.length).lastInsertRowid as number
}

function sr(chunkId: number): SearchResult {
  return { chunkId, filePath: '', content: '', score: 0.5, vectorScore: 0.5, keywordScore: 0, chunkIndex: 0 }
}

describe('temporalTimeline', () => {
  let db: Database.Database
  let a: number, b: number, c: number, d: number

  beforeEach(() => {
    db = openMemoryDb(':memory:')
    a = addChunk(db, 'a.md', 1000, 'oldest')
    b = addChunk(db, 'b.md', 2000, 'older')
    c = addChunk(db, 'c.md', 3000, 'newer')
    d = addChunk(db, 'd.md', 4000, 'newest')
  })
  afterEach(() => closeMemoryDb(db))

  it('re-orders the relevance pool CHRONOLOGICALLY (oldest-first), ignoring base order', async () => {
    // base returns them in an arbitrary relevance order
    const base = async () => [sr(c), sr(a), sr(d), sr(b)]
    const out = await temporalTimeline(db, 'q', base, { limit: 4 })
    expect(out.map((r) => r.chunkId)).toEqual([a, b, c, d]) // mtime ascending
    expect(out.map((r) => r.mtimeMs)).toEqual([1000, 2000, 3000, 4000])
  })

  it('keeps the most-recent `limit` then returns them oldest-first', async () => {
    const base = async () => [sr(a), sr(b), sr(c), sr(d)]
    const out = await temporalTimeline(db, 'q', base, { limit: 2 })
    expect(out.map((r) => r.chunkId)).toEqual([c, d]) // newest 2 (c,d), chronological
  })

  it('applies the `since` cutoff (inclusive)', async () => {
    const base = async () => [sr(a), sr(b), sr(c), sr(d)]
    const out = await temporalTimeline(db, 'q', base, { limit: 10, since: 2500 })
    expect(out.map((r) => r.chunkId)).toEqual([c, d]) // only mtime >= 2500
  })

  it('returns [] when the query has no relevance candidates', async () => {
    const base = async () => []
    expect(await temporalTimeline(db, 'q', base, { limit: 5 })).toEqual([])
  })

  it('skips non-positive / synthetic candidate ids', async () => {
    const base = async () => [sr(-1), sr(0), sr(d)]
    const out = await temporalTimeline(db, 'q', base, { limit: 5 })
    expect(out.map((r) => r.chunkId)).toEqual([d])
  })
})
