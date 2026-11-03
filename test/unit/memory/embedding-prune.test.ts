import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openMemoryDb, closeMemoryDb, EMBEDDING_DIMENSIONS } from '../../../src/memory/db.js'
import { serializeEmbedding } from '../../../src/memory/embeddings.js'
import { pruneOrphanedEmbeddings } from '../../../src/memory/indexer.js'
import type Database from 'better-sqlite3'

function count(db: Database.Database, sql: string, ...p: unknown[]): number {
  return (db.prepare(sql).get(...p) as { n: number }).n
}

function addChunk(db: Database.Database, path: string, content: string): number {
  db.prepare('INSERT INTO vault_files (path, mtime_ms, size_bytes) VALUES (?, 1000, ?)').run(
    path,
    content.length,
  )
  return db
    .prepare(
      `INSERT INTO chunks (file_path, chunk_index, content, start_offset, end_offset, token_count)
       VALUES (?, 0, ?, 0, ?, 1)`,
    )
    .run(path, content, content.length).lastInsertRowid as number
}

/** Insert a (zeroed) embedding for an arbitrary chunk_id — orphan if no such chunk exists. */
function addEmbedding(db: Database.Database, chunkId: number): void {
  const vec = serializeEmbedding(new Float32Array(EMBEDDING_DIMENSIONS).fill(0.1))
  db.prepare('INSERT INTO chunk_embeddings (chunk_id, embedding) VALUES (?, ?)').run(
    BigInt(chunkId),
    vec,
  )
}

describe('pruneOrphanedEmbeddings (vec0 orphan reclamation)', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb(':memory:')
  })
  afterEach(() => closeMemoryDb(db))

  it('removes embeddings whose chunk no longer exists, keeps live ones, returns the count', () => {
    const c1 = addChunk(db, 'a.md', 'live chunk one')
    const c2 = addChunk(db, 'b.md', 'live chunk two')
    addEmbedding(db, c1)
    addEmbedding(db, c2)
    // three orphans: chunk_ids that were never (or no longer are) in chunks
    addEmbedding(db, 99999)
    addEmbedding(db, 88888)
    addEmbedding(db, 77777)
    expect(count(db, 'SELECT COUNT(*) n FROM chunk_embeddings')).toBe(5)

    const pruned = pruneOrphanedEmbeddings(db)

    expect(pruned).toBe(3)
    expect(count(db, 'SELECT COUNT(*) n FROM chunk_embeddings')).toBe(2)
    // the two live embeddings survive
    expect(count(db, 'SELECT COUNT(*) n FROM chunk_embeddings WHERE chunk_id IN (?, ?)', c1, c2)).toBe(
      2,
    )
  })

  it('reclaims the orphan left behind when a chunk is deleted (the real accumulation path)', () => {
    const c1 = addChunk(db, 'a.md', 'one')
    const c2 = addChunk(db, 'b.md', 'two')
    addEmbedding(db, c1)
    addEmbedding(db, c2)
    // vec0 has no FK/trigger, so deleting the chunk leaves the embedding orphaned
    db.prepare('DELETE FROM chunks WHERE id = ?').run(c1)
    expect(count(db, 'SELECT COUNT(*) n FROM chunk_embeddings')).toBe(2)

    expect(pruneOrphanedEmbeddings(db)).toBe(1)
    expect(count(db, 'SELECT COUNT(*) n FROM chunk_embeddings')).toBe(1)
    // the surviving embedding is c2's (the live chunk), not the deleted c1's
    expect(count(db, 'SELECT COUNT(*) n FROM chunk_embeddings WHERE chunk_id = ?', c2)).toBe(1)
    expect(count(db, 'SELECT COUNT(*) n FROM chunk_embeddings WHERE chunk_id = ?', c1)).toBe(0)
  })

  it('is idempotent and returns 0 when there are no orphans', () => {
    const c1 = addChunk(db, 'a.md', 'x')
    addEmbedding(db, c1)
    expect(pruneOrphanedEmbeddings(db)).toBe(0)
    expect(pruneOrphanedEmbeddings(db)).toBe(0)
    expect(count(db, 'SELECT COUNT(*) n FROM chunk_embeddings')).toBe(1)
  })

  it('returns 0 on an empty embedding table', () => {
    expect(pruneOrphanedEmbeddings(db)).toBe(0)
  })
})
