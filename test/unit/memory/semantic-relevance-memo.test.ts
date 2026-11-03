/**
 * RED-first proof of two defects found while measuring the exploration challenger arm (2026-07-27).
 *
 * ## Defect 1 — the query-bound scorer re-embeds its ONE query on EVERY call
 * `makeSemanticRelevanceScorer(db, query)` is bound to a single query string, but each invocation
 * calls `scoreSemanticRelevance` → `generateEmbedding(query)` again. The process-wide content-keyed
 * memo in `embeddings.ts` is OPT-IN and deliberately OFF in prod (`SCNS_EMBED_MEMO`, kept off so the
 * broker stays memory-bounded), so in production every call is a real embedding-worker IPC roundtrip.
 * The worker caps at ~10 texts/s, i.e. ~100ms per redundant call.
 *
 * MEASURED on the live briefing path (isolated broker, copy of the production vault, the broker's own
 * `stage_timings`): semanticMs is 92-96% of TOTAL retrieval latency on BOTH arms, and scales linearly
 * with `semanticCalls` — magma 4-6 calls / 751ms, multihop-iter 15-23 calls / 1931ms.
 *
 * The vector is a pure function of the text (deterministic BGE), so caching it for the lifetime of ONE
 * query-bound scorer cannot change any ranking — it only stops recomputing an identical vector. This is
 * NOT the global memo: scope is a single request, so the broker stays memory-bounded.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { openMemoryDb, closeMemoryDb, EMBEDDING_DIMENSIONS } from '../../../src/memory/db.js'

vi.mock('../../../src/memory/embeddings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/memory/embeddings.js')>()
  return { ...actual, generateEmbedding: vi.fn() }
})

import { makeSemanticRelevanceScorer } from '../../../src/memory/semantic-relevance.js'
import { generateEmbedding, serializeEmbedding } from '../../../src/memory/embeddings.js'
import type Database from 'better-sqlite3'

const mockGen = vi.mocked(generateEmbedding)

function vec(...entries: Array<[number, number]>): Float32Array {
  const v = new Float32Array(EMBEDDING_DIMENSIONS)
  for (const [i, val] of entries) v[i] = val
  return v
}

describe('makeSemanticRelevanceScorer — per-request query-embedding reuse', () => {
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
    mockGen.mockResolvedValue({ embedding: vec([0, 1]) } as never)
  })
  afterEach(() => closeMemoryDb(db))

  it('embeds its bound query ONCE across many calls (kills the redundant IPC roundtrip)', async () => {
    const a = addChunkEmbedding(vec([0, 1]))
    const b = addChunkEmbedding(vec([1, 1]))
    const scorer = makeSemanticRelevanceScorer(db, 'the same bound query')

    // A multi-hop request drives the SAME scorer many times (once per round per traversal stage).
    await scorer([a])
    await scorer([b])
    await scorer([a, b])
    await scorer([a])

    expect(mockGen).toHaveBeenCalledTimes(1)
  })

  it('returns identical scores on repeat calls (caching changes no ranking)', async () => {
    const a = addChunkEmbedding(vec([0, 1]))
    const scorer = makeSemanticRelevanceScorer(db, 'q')
    const first = await scorer([a])
    const second = await scorer([a])
    expect(second.get(a)).toBeCloseTo(first.get(a)!, 12)
    expect(first.get(a)).toBeCloseTo(1, 6)
  })

  it('still costs NOTHING for an empty candidate set (no embed on a no-op)', async () => {
    const scorer = makeSemanticRelevanceScorer(db, 'q')
    const out = await scorer([])
    expect(out.size).toBe(0)
    expect(mockGen).not.toHaveBeenCalled()
  })

  it('does not share its cache across DIFFERENT bound queries', async () => {
    const a = addChunkEmbedding(vec([0, 1]))
    await makeSemanticRelevanceScorer(db, 'query one')([a])
    await makeSemanticRelevanceScorer(db, 'query two')([a])
    expect(mockGen).toHaveBeenCalledTimes(2)
    expect(mockGen).toHaveBeenNthCalledWith(1, 'query one')
    expect(mockGen).toHaveBeenNthCalledWith(2, 'query two')
  })

  it('propagates a cold-worker failure instead of caching it (a failed embed is not a result)', async () => {
    const a = addChunkEmbedding(vec([0, 1]))
    const scorer = makeSemanticRelevanceScorer(db, 'q')
    mockGen.mockRejectedValueOnce(new Error('embedding worker exited'))
    await expect(scorer([a])).rejects.toThrow('embedding worker exited')

    // A later call must RETRY the embed rather than serve a poisoned/empty cache entry.
    mockGen.mockResolvedValue({ embedding: vec([0, 1]) } as never)
    const out = await scorer([a])
    expect(out.get(a)).toBeCloseTo(1, 6)
  })
})
