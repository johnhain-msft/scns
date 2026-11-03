import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openMemoryDb, closeMemoryDb, EMBEDDING_DIMENSIONS } from '../../../src/memory/db.js'
import { serializeEmbedding } from '../../../src/memory/embeddings.js'
import { buildSemanticEdges } from '../../../src/memory/semantic-edges.js'
import { rebuildMemoryEdges } from '../../../src/memory/entities/edges.js'
import type Database from 'better-sqlite3'

function count(db: Database.Database, sql: string, ...p: unknown[]): number {
  return (db.prepare(sql).get(...p) as { n: number }).n
}

/** A 384-dim vector with the given (index,value) entries set, rest zero. */
function vec(...entries: Array<[number, number]>): Float32Array {
  const v = new Float32Array(EMBEDDING_DIMENSIONS)
  for (const [i, val] of entries) v[i] = val
  return v
}

let fileSeq = 0
function addChunk(db: Database.Database, path: string, content: string, vector?: Float32Array): number {
  db.prepare('INSERT OR IGNORE INTO vault_files (path, mtime_ms, size_bytes) VALUES (?, ?, ?)').run(
    path,
    1000 + fileSeq++,
    content.length,
  )
  const idx = count(db, 'SELECT COUNT(*) n FROM chunks WHERE file_path = ?', path)
  const id = db
    .prepare(
      `INSERT INTO chunks (file_path, chunk_index, content, start_offset, end_offset, token_count)
       VALUES (?, ?, ?, 0, ?, 1)`,
    )
    .run(path, idx, content, content.length).lastInsertRowid as number
  if (vector) {
    db.prepare('INSERT INTO chunk_embeddings (chunk_id, embedding) VALUES (?, ?)').run(
      BigInt(id),
      serializeEmbedding(vector),
    )
  }
  return id
}

describe('buildSemanticEdges (deterministic embedding-similarity tier)', () => {
  let db: Database.Database
  beforeEach(() => {
    db = openMemoryDb(':memory:')
    fileSeq = 0
  })
  afterEach(() => closeMemoryDb(db))

  // A clean 1-D layout: distances along dim 1 are exactly the value gaps.
  // c0=[1,0]  c1=[1,0.2]  c2=[1,0.5]  far=[1,0,5]
  //   d(c0,c1)=0.2  d(c0,c2)=0.5  d(c1,c2)=0.3  d(*,far)≈5
  function seedLayout(): { c0: number; c1: number; c2: number; far: number } {
    const c0 = addChunk(db, 'a.md', 'chunk zero', vec([0, 1]))
    const c1 = addChunk(db, 'b.md', 'chunk one', vec([0, 1], [1, 0.2]))
    const c2 = addChunk(db, 'c.md', 'chunk two', vec([0, 1], [1, 0.5]))
    const far = addChunk(db, 'd.md', 'far chunk', vec([0, 1], [2, 5]))
    return { c0, c1, c2, far }
  }

  it('links nearest cross-chunk neighbors as edge_type=semantic with similarity weight', () => {
    const { c0, c1, c2, far } = seedLayout()
    const stats = buildSemanticEdges(db, { topN: 5, maxDistance: 1.0 })

    expect(stats.chunksProcessed).toBe(4)
    expect(stats.semanticEdges).toBeGreaterThan(0)
    // every inserted edge is semantic, weight in (0,1], src/dst are live chunks
    expect(count(db, "SELECT COUNT(*) n FROM memory_edges WHERE edge_type != 'semantic'")).toBe(0)
    expect(
      count(db, "SELECT COUNT(*) n FROM memory_edges WHERE edge_type='semantic' AND (weight<=0 OR weight>1)"),
    ).toBe(0)
    // c0's neighbors within 1.0 are c1 (0.2) and c2 (0.5); `far` (≈5) is excluded.
    const c0dst = db
      .prepare("SELECT dst_chunk d FROM memory_edges WHERE edge_type='semantic' AND src_chunk=? ORDER BY weight DESC")
      .all(c0)
      .map((r) => (r as { d: number }).d)
    expect(c0dst).toEqual([c1, c2])
    // `far` has no neighbor within maxDistance.
    expect(count(db, "SELECT COUNT(*) n FROM memory_edges WHERE edge_type='semantic' AND src_chunk=?", far)).toBe(0)
    // no self-edges
    expect(count(db, "SELECT COUNT(*) n FROM memory_edges WHERE edge_type='semantic' AND src_chunk=dst_chunk")).toBe(0)
    expect(c2).toBeGreaterThan(0)
  })

  it('respects maxDistance', () => {
    const { c0, c1, c2 } = seedLayout()
    buildSemanticEdges(db, { topN: 5, maxDistance: 0.4 }) // excludes the 0.5 edge
    const c0dst = db
      .prepare("SELECT dst_chunk d FROM memory_edges WHERE edge_type='semantic' AND src_chunk=?")
      .all(c0)
      .map((r) => (r as { d: number }).d)
    expect(c0dst).toEqual([c1]) // c2 at 0.5 is now excluded
    expect(c2).toBeGreaterThan(c1)
  })

  it('respects topN', () => {
    const c0 = addChunk(db, 'hub.md', 'hub', vec([0, 1]))
    // five near neighbors of c0 at increasing distance
    for (let i = 1; i <= 5; i++) addChunk(db, `n${i}.md`, `n${i}`, vec([0, 1], [1, 0.1 * i]))
    buildSemanticEdges(db, { topN: 2, maxDistance: 1.0 })
    expect(count(db, "SELECT COUNT(*) n FROM memory_edges WHERE edge_type='semantic' AND src_chunk=?", c0)).toBe(2)
  })

  it('excludeSameFile drops same-file neighbors', () => {
    const a0 = addChunk(db, 'same.md', 'a0', vec([0, 1]))
    const a1 = addChunk(db, 'same.md', 'a1', vec([0, 1], [1, 0.1])) // same file, very close
    const b0 = addChunk(db, 'other.md', 'b0', vec([0, 1], [1, 0.2])) // different file
    buildSemanticEdges(db, { topN: 5, maxDistance: 1.0, excludeSameFile: true })
    const a0dst = db
      .prepare("SELECT dst_chunk d FROM memory_edges WHERE edge_type='semantic' AND src_chunk=?")
      .all(a0)
      .map((r) => (r as { d: number }).d)
    expect(a0dst).toContain(b0)
    expect(a0dst).not.toContain(a1) // same-file neighbor excluded
  })

  it('is idempotent and clears only its own edge_type (entity/temporal survive)', () => {
    seedLayout()
    // seed an unrelated entity edge that must be preserved
    const ent = db.prepare("INSERT INTO memory_entities (name, kind) VALUES ('x','concept')").run()
      .lastInsertRowid as number
    const someChunk = count(db, 'SELECT MIN(id) n FROM chunks')
    db.prepare(
      "INSERT INTO memory_edges (src_chunk, edge_type, dst_entity, source) VALUES (?, 'entity', ?, 'gazetteer')",
    ).run(someChunk, ent)

    const first = buildSemanticEdges(db, { topN: 5, maxDistance: 1.0 })
    const second = buildSemanticEdges(db, { topN: 5, maxDistance: 1.0 })
    expect(second.semanticEdges).toBe(first.semanticEdges) // no duplication
    expect(count(db, "SELECT COUNT(*) n FROM memory_edges WHERE edge_type='entity'")).toBe(1) // survived
  })

  it('coexists with rebuildMemoryEdges in either order (scoped deletes do not clobber)', () => {
    seedLayout()
    buildSemanticEdges(db, { topN: 5, maxDistance: 1.0 })
    const semBefore = count(db, "SELECT COUNT(*) n FROM memory_edges WHERE edge_type='semantic'")
    expect(semBefore).toBeGreaterThan(0)
    // an entity rebuild must NOT wipe semantic edges
    rebuildMemoryEdges(db)
    expect(count(db, "SELECT COUNT(*) n FROM memory_edges WHERE edge_type='semantic'")).toBe(semBefore)
  })

  it('returns zero on a vault with no embeddings', () => {
    addChunk(db, 'noemb.md', 'no embedding here') // no vector
    const stats = buildSemanticEdges(db, { topN: 5 })
    expect(stats).toEqual({ chunksProcessed: 0, semanticEdges: 0 })
    expect(count(db, "SELECT COUNT(*) n FROM memory_edges WHERE edge_type='semantic'")).toBe(0)
  })

  it('is FK-safe: an orphaned vec0 embedding never becomes an edge endpoint', () => {
    const c0 = addChunk(db, 'a.md', 'a', vec([0, 1]))
    const c1 = addChunk(db, 'b.md', 'b', vec([0, 1], [1, 0.2]))
    // orphan embedding: chunk_id 99999 has no row in chunks
    db.prepare('INSERT INTO chunk_embeddings (chunk_id, embedding) VALUES (?, ?)').run(
      BigInt(99999),
      serializeEmbedding(vec([0, 1], [1, 0.1])), // very close to c0/c1
    )
    expect(() => buildSemanticEdges(db, { topN: 5, maxDistance: 1.0 })).not.toThrow()
    // no edge references the orphan, edges only among live chunks
    expect(count(db, 'SELECT COUNT(*) n FROM memory_edges WHERE src_chunk=99999 OR dst_chunk=99999')).toBe(0)
    expect(count(db, "SELECT COUNT(*) n FROM memory_edges WHERE edge_type='semantic'")).toBeGreaterThan(0)
    expect([c0, c1].every((x) => x > 0)).toBe(true)
  })
})
