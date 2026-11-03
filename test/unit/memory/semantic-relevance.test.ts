import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { openMemoryDb, closeMemoryDb, EMBEDDING_DIMENSIONS } from '../../../src/memory/db.js'

// Mock ONLY generateEmbedding (the query embed); keep serialize/deserialize real so the stored
// candidate vectors round-trip through the real codec.
vi.mock('../../../src/memory/embeddings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/memory/embeddings.js')>()
  return { ...actual, generateEmbedding: vi.fn() }
})

import {
  cosineSimilarity,
  scoreSemanticRelevance,
} from '../../../src/memory/semantic-relevance.js'
import { generateEmbedding, serializeEmbedding } from '../../../src/memory/embeddings.js'
import type Database from 'better-sqlite3'

const mockGen = vi.mocked(generateEmbedding)

/** A 384-dim vector with the given (index,value) entries set, rest zero. */
function vec(...entries: Array<[number, number]>): Float32Array {
  const v = new Float32Array(EMBEDDING_DIMENSIONS)
  for (const [i, val] of entries) v[i] = val
  return v
}

describe('cosineSimilarity', () => {
  it('is 1 for identical vectors', () => {
    expect(cosineSimilarity(vec([0, 1], [1, 2]), vec([0, 1], [1, 2]))).toBeCloseTo(1, 10)
  })
  it('is 0 for orthogonal vectors', () => {
    expect(cosineSimilarity(vec([0, 1]), vec([1, 1]))).toBeCloseTo(0, 10)
  })
  it('is -1 for opposed vectors', () => {
    expect(cosineSimilarity(vec([0, 1]), vec([0, -1]))).toBeCloseTo(-1, 10)
  })
  it('is invariant to magnitude (direction only)', () => {
    expect(cosineSimilarity(vec([0, 1]), vec([0, 7]))).toBeCloseTo(1, 10)
  })
  it('is 0 for a zero vector (no poison)', () => {
    expect(cosineSimilarity(vec(), vec([0, 1]))).toBe(0)
  })
  it('is 0 for mismatched lengths', () => {
    expect(cosineSimilarity(new Float32Array(3), new Float32Array(4))).toBe(0)
  })
})

describe('scoreSemanticRelevance', () => {
  let db: Database.Database
  let seq = 0

  function addChunkEmbedding(vector: Float32Array): number {
    const path = `c${seq}.md`
    db.prepare('INSERT OR IGNORE INTO vault_files (path, mtime_ms, size_bytes) VALUES (?, ?, 1)').run(
      path,
      1000 + seq++,
    )
    const id = db
      .prepare(
        `INSERT INTO chunks (file_path, chunk_index, content, start_offset, end_offset, token_count)
         VALUES (?, 0, 'x', 0, 1, 1)`,
      )
      .run(path).lastInsertRowid as number
    db.prepare('INSERT INTO chunk_embeddings (chunk_id, embedding) VALUES (?, ?)').run(
      BigInt(id),
      serializeEmbedding(vector),
    )
    return id
  }

  beforeEach(() => {
    db = openMemoryDb(':memory:')
    seq = 0
    mockGen.mockReset()
  })
  afterEach(() => closeMemoryDb(db))

  it('ranks candidates by cosine to the query embedding (identical > 45° > orthogonal)', async () => {
    // query points along dim 0
    mockGen.mockResolvedValue({ embedding: vec([0, 1]), dimensions: EMBEDDING_DIMENSIONS })
    const identical = addChunkEmbedding(vec([0, 1])) // cos 1
    const fortyFive = addChunkEmbedding(vec([0, 1], [1, 1])) // cos ~0.707
    const orthogonal = addChunkEmbedding(vec([1, 1])) // cos 0

    const scores = await scoreSemanticRelevance(db, 'q', [identical, fortyFive, orthogonal])
    expect(scores.get(identical)!).toBeCloseTo(1, 6)
    expect(scores.get(fortyFive)!).toBeCloseTo(1 / Math.sqrt(2), 6)
    expect(scores.get(orthogonal)!).toBeCloseTo(0, 6)
    // ranking is strict
    expect(scores.get(identical)!).toBeGreaterThan(scores.get(fortyFive)!)
    expect(scores.get(fortyFive)!).toBeGreaterThan(scores.get(orthogonal)!)
  })

  it('omits candidates that have no stored embedding', async () => {
    mockGen.mockResolvedValue({ embedding: vec([0, 1]), dimensions: EMBEDDING_DIMENSIONS })
    const real = addChunkEmbedding(vec([0, 1]))
    const scores = await scoreSemanticRelevance(db, 'q', [real, 999999])
    expect(scores.has(real)).toBe(true)
    expect(scores.has(999999)).toBe(false)
  })

  it('embeds nothing and returns an empty map for an empty candidate set', async () => {
    const scores = await scoreSemanticRelevance(db, 'q', [])
    expect(scores.size).toBe(0)
    expect(mockGen).not.toHaveBeenCalled()
  })

  it('embeds the query exactly once regardless of candidate count', async () => {
    mockGen.mockResolvedValue({ embedding: vec([0, 1]), dimensions: EMBEDDING_DIMENSIONS })
    const a = addChunkEmbedding(vec([0, 1]))
    const b = addChunkEmbedding(vec([0, 1], [1, 1]))
    await scoreSemanticRelevance(db, 'q', [a, b])
    expect(mockGen).toHaveBeenCalledTimes(1)
  })
})
