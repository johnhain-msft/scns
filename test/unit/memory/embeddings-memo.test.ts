import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'

// Mock the embedding CLIENT so no real fastembed worker is forked — these tests exercise ONLY the
// opt-in memo wrapper in embeddings.ts (SCNS_EMBED_MEMO), which must be prod-inert by default and a
// pure, order-preserving cache when enabled. embedSpy is the single source of "worker calls".
const { embedSpy } = vi.hoisted(() => ({ embedSpy: vi.fn() }))
vi.mock('../../../src/memory/embedding-client.js', () => ({
  createEmbeddingClient: () => ({
    embed: embedSpy,
    shutdown: () => {},
  }),
}))

import {
  generateEmbedding,
  generateEmbeddingsBatch,
  resetEmbeddingClient,
} from '../../../src/memory/embeddings.js'

/** Deterministic per-text fake vector so identical text ⇒ identical vector, distinct text ⇒ distinct. */
function makeVec(t: string): Float32Array {
  let h = 0
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0
  return new Float32Array([h % 100000, t.length])
}

beforeEach(async () => {
  delete process.env.SCNS_EMBED_MEMO
  embedSpy.mockReset()
  embedSpy.mockImplementation(async (texts: readonly string[]) => texts.map(makeVec))
  await resetEmbeddingClient() // clears client + memo between tests
})

afterAll(() => {
  delete process.env.SCNS_EMBED_MEMO
})

describe('embeddings memo — (a) default OFF is prod-inert', () => {
  it('generateEmbedding re-calls the worker every time when the flag is unset', async () => {
    const r1 = await generateEmbedding('hello')
    const r2 = await generateEmbedding('hello')
    expect(embedSpy).toHaveBeenCalledTimes(2) // no caching
    expect(Array.from(r1.embedding)).toEqual(Array.from(makeVec('hello')))
    expect(Array.from(r2.embedding)).toEqual(Array.from(makeVec('hello')))
    expect(r2).not.toBe(r1) // distinct result objects (no memo)
  })

  it('generateEmbeddingsBatch re-calls the worker every time when the flag is unset', async () => {
    await generateEmbeddingsBatch(['a', 'b'])
    await generateEmbeddingsBatch(['a', 'b'])
    expect(embedSpy).toHaveBeenCalledTimes(2)
  })
})

describe('embeddings memo — (b) ON returns identical vectors and a hit avoids a 2nd worker call', () => {
  it('caches by content: 2nd identical call is a hit (worker called once) and returns the SAME object', async () => {
    process.env.SCNS_EMBED_MEMO = '1'
    const r1 = await generateEmbedding('world')
    const r2 = await generateEmbedding('world')
    expect(embedSpy).toHaveBeenCalledTimes(1) // second call served from memo
    expect(r2).toBe(r1) // same cached object
  })

  it('memo-ON vectors are byte-identical to memo-OFF (pure cache, no result change)', async () => {
    // OFF reference
    const off = await generateEmbedding('parity-check')
    // ON
    process.env.SCNS_EMBED_MEMO = '1'
    await resetEmbeddingClient()
    const on1 = await generateEmbedding('parity-check')
    const on2 = await generateEmbedding('parity-check')
    expect(Array.from(on1.embedding)).toEqual(Array.from(off.embedding))
    expect(Array.from(on2.embedding)).toEqual(Array.from(off.embedding))
    expect(on1.dimensions).toBe(off.dimensions)
  })
})

describe('embeddings memo — (c) batch reassembles in ORIGINAL order with mixed hits/misses', () => {
  it('embeds only the misses, in order, and reassembles the full result by original index', async () => {
    process.env.SCNS_EMBED_MEMO = '1'
    await generateEmbedding('b') // prime the cache for "b"
    embedSpy.mockClear()

    const res = await generateEmbeddingsBatch(['a', 'b', 'c'])
    // only the misses were embedded, preserving their relative order
    expect(embedSpy).toHaveBeenCalledTimes(1)
    expect(embedSpy).toHaveBeenCalledWith(['a', 'c'])
    // full result is reassembled in ORIGINAL order (a, b, c)
    expect(Array.from(res[0]!.embedding)).toEqual(Array.from(makeVec('a')))
    expect(Array.from(res[1]!.embedding)).toEqual(Array.from(makeVec('b')))
    expect(Array.from(res[2]!.embedding)).toEqual(Array.from(makeVec('c')))
  })

  it('an all-hit batch does not call the worker at all', async () => {
    process.env.SCNS_EMBED_MEMO = '1'
    await generateEmbeddingsBatch(['x', 'y'])
    embedSpy.mockClear()
    const res = await generateEmbeddingsBatch(['x', 'y'])
    expect(embedSpy).not.toHaveBeenCalled()
    expect(Array.from(res[1]!.embedding)).toEqual(Array.from(makeVec('y')))
  })
})

describe('embeddings memo — (d) resetEmbeddingClient clears the memo', () => {
  it('re-embeds an identical text after a reset', async () => {
    process.env.SCNS_EMBED_MEMO = '1'
    await generateEmbedding('z')
    expect(embedSpy).toHaveBeenCalledTimes(1)
    await resetEmbeddingClient() // must clear the memo
    await generateEmbedding('z')
    expect(embedSpy).toHaveBeenCalledTimes(2) // cache was cleared ⇒ re-embedded
  })
})
