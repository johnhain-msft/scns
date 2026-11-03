import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openMemoryDb, closeMemoryDb } from '../../../src/memory/db.js'
import { semanticNeighborhood } from '../../../src/memory/semantic-neighborhood.js'
import type Database from 'better-sqlite3'

let seq = 0
function addChunk(db: Database.Database, content: string): number {
  const path = `f${seq}.md`
  db.prepare('INSERT INTO vault_files (path, mtime_ms, size_bytes) VALUES (?, ?, ?)').run(
    path,
    1000 + seq++,
    content.length,
  )
  return db
    .prepare(
      `INSERT INTO chunks (file_path, chunk_index, content, start_offset, end_offset, token_count)
       VALUES (?, 0, ?, 0, ?, 1)`,
    )
    .run(path, content, content.length).lastInsertRowid as number
}

function addSem(db: Database.Database, src: number, dst: number, weight: number): void {
  db.prepare(
    `INSERT INTO memory_edges (src_chunk, edge_type, dst_chunk, weight, source, confidence)
     VALUES (?, 'semantic', ?, ?, 'embedding', ?)`,
  ).run(src, dst, weight, weight)
}

describe('semanticNeighborhood (multi-hop associative read)', () => {
  let db: Database.Database
  let s: number, a: number, b: number, c: number, d: number, x: number

  beforeEach(() => {
    db = openMemoryDb(':memory:')
    seq = 0
    s = addChunk(db, 'seed')
    a = addChunk(db, 'alpha')
    b = addChunk(db, 'beta')
    c = addChunk(db, 'gamma') // 2-hop via a
    d = addChunk(db, 'delta') // 2-hop via b
    x = addChunk(db, 'xi') // reachable at hop1 (from s) AND hop2 (via a)
    addSem(db, s, a, 0.9)
    addSem(db, s, b, 0.8)
    addSem(db, s, x, 0.5)
    addSem(db, a, c, 0.7)
    addSem(db, a, x, 0.95) // would reach x at hop2, but x already hop1
    addSem(db, b, d, 0.6)
  })
  afterEach(() => closeMemoryDb(db))

  it('1-hop returns direct neighbors only, ordered by weight desc, seeds excluded', () => {
    const got = semanticNeighborhood(db, [s], { hops: 1 })
    expect(got.map((n) => n.chunkId)).toEqual([a, b, x]) // 0.9, 0.8, 0.5
    expect(got.every((n) => n.hop === 1)).toBe(true)
    expect(got.map((n) => n.chunkId)).not.toContain(s)
  })

  it('2-hop adds neighbor-of-neighbor the 1-hop set misses', () => {
    const got = semanticNeighborhood(db, [s], { hops: 2 })
    const byId = new Map(got.map((n) => [n.chunkId, n]))
    // hop-2 chunks present
    expect(byId.get(c)?.hop).toBe(2)
    expect(byId.get(d)?.hop).toBe(2)
    // hop-1 chunks keep hop 1
    expect(byId.get(a)?.hop).toBe(1)
    expect(byId.get(b)?.hop).toBe(1)
    // ordering: all hop-1 before all hop-2
    const hops = got.map((n) => n.hop)
    expect(hops).toEqual([...hops].sort((p, q) => p - q))
  })

  it('closer hop wins: a node reachable at hop1 and hop2 keeps hop1', () => {
    const got = semanticNeighborhood(db, [s], { hops: 2 })
    expect(got.find((n) => n.chunkId === x)?.hop).toBe(1)
  })

  it('limit caps the result (after hop/weight ordering)', () => {
    const got = semanticNeighborhood(db, [s], { hops: 2, limit: 2 })
    expect(got.map((n) => n.chunkId)).toEqual([a, b])
  })

  it('resolves chunk content/file for returned neighbors', () => {
    const got = semanticNeighborhood(db, [s], { hops: 1 })
    const alpha = got.find((n) => n.chunkId === a)
    expect(alpha?.content).toBe('alpha')
    expect(alpha?.filePath).toBe('f1.md')
  })

  it('returns [] for empty seeds, unknown seed, or a vault with no semantic edges', () => {
    expect(semanticNeighborhood(db, [], { hops: 2 })).toEqual([])
    expect(semanticNeighborhood(db, [99999], { hops: 2 })).toEqual([])
    const empty = openMemoryDb(':memory:')
    const lone = addChunkIn(empty, 'lonely')
    expect(semanticNeighborhood(empty, [lone], { hops: 2 })).toEqual([])
    closeMemoryDb(empty)
  })
})

let seq2 = 0
function addChunkIn(db: Database.Database, content: string): number {
  const path = `g${seq2}.md`
  db.prepare('INSERT INTO vault_files (path, mtime_ms, size_bytes) VALUES (?, ?, ?)').run(
    path,
    2000 + seq2++,
    content.length,
  )
  return db
    .prepare(
      `INSERT INTO chunks (file_path, chunk_index, content, start_offset, end_offset, token_count)
       VALUES (?, 0, ?, 0, ?, 1)`,
    )
    .run(path, content, content.length).lastInsertRowid as number
}
