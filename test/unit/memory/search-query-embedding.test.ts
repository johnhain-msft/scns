/**
 * T023 [US2] (specs/001-learning-memory-loop) — surface the query embedding the hybrid path ALREADY
 * computes, so the live experience logger can persist it at zero extra cost (gate #9: never a
 * synchronous embed just to log). `onQueryEmbedding` is an observe-only callback: absent ⇒
 * byte-identical results; present ⇒ fires once with the exact vector vectorSearch used; a throwing
 * observer never breaks the search.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const { embedSpy } = vi.hoisted(() => ({ embedSpy: vi.fn() }))
vi.mock('../../../src/memory/embedding-client.js', () => ({
  createEmbeddingClient: () => ({
    embed: embedSpy,
    shutdown: () => {},
  }),
}))

import { openMemoryDb, closeMemoryDb, EMBEDDING_DIMENSIONS } from '../../../src/memory/db.js'
import { resetEmbeddingClient, serializeEmbedding } from '../../../src/memory/embeddings.js'
import { hybridSearch } from '../../../src/memory/search.js'
import type Database from 'better-sqlite3'

/** Deterministic 384-dim fake vector per text. */
function makeVec(t: string): Float32Array {
  const v = new Float32Array(EMBEDDING_DIMENSIONS)
  let h = 7
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0
  for (let i = 0; i < v.length; i++) v[i] = ((h + i) % 100) / 100
  return v
}

describe('T023 — hybridSearch onQueryEmbedding (observe-only, zero-cost capture)', () => {
  let db: Database.Database

  beforeEach(async () => {
    embedSpy.mockReset()
    embedSpy.mockImplementation(async (texts: readonly string[]) => texts.map(makeVec))
    await resetEmbeddingClient()
    db = openMemoryDb(':memory:')
    db.prepare(
      "INSERT INTO vault_files (path, mtime_ms, size_bytes) VALUES ('m.md', 1000, 20)",
    ).run()
    const chunkId = db
      .prepare(
        `INSERT INTO chunks (file_path, chunk_index, content, start_offset, end_offset, token_count)
         VALUES ('m.md', 0, 'the broker port decision', 0, 24, 4)`,
      )
      .run().lastInsertRowid
    db.prepare('INSERT INTO chunk_embeddings (chunk_id, embedding) VALUES (?, ?)').run(
      BigInt(chunkId as number),
      Buffer.from(serializeEmbedding(makeVec('the broker port decision'))),
    )
    return () => closeMemoryDb(db)
  })

  it('POSITIVE: the callback fires exactly once with the vector the search embedded', async () => {
    const seen: Float32Array[] = []
    await hybridSearch(db, 'broker port', { limit: 3, onQueryEmbedding: (v) => seen.push(v) })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.length).toBe(EMBEDDING_DIMENSIONS)
    expect(Array.from(seen[0]!)).toEqual(Array.from(makeVec('broker port')))
  })

  it('NEGATIVE: without the callback the results are byte-identical (observe-only)', async () => {
    const withCb = await hybridSearch(db, 'broker port', {
      limit: 3,
      onQueryEmbedding: () => {},
    })
    const withoutCb = await hybridSearch(db, 'broker port', { limit: 3 })
    expect(withCb).toEqual(withoutCb)
  })

  it('NEGATIVE (fail-safe): a throwing observer never breaks the search', async () => {
    const results = await hybridSearch(db, 'broker port', {
      limit: 3,
      onQueryEmbedding: () => {
        throw new Error('observer exploded')
      },
    })
    expect(results.length).toBeGreaterThan(0)
  })
})
