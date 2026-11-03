import { describe, it, expect, beforeEach } from 'vitest'
import {
  serializeEmbedding,
  deserializeEmbedding,
  getEmbeddingStatus,
  resetEmbeddingClient,
} from '../../../src/memory/embeddings.js'
import { EMBEDDING_DIMENSIONS } from '../../../src/memory/db.js'

describe('getEmbeddingStatus', () => {
  beforeEach(() => {
    resetEmbeddingClient()
  })

  it('returns pending initially', () => {
    expect(getEmbeddingStatus()).toBe('pending')
  })

  it('returns pending after resetEmbeddingClient', () => {
    // Even if something changed the status, reset brings it back
    resetEmbeddingClient()
    expect(getEmbeddingStatus()).toBe('pending')
  })
})

describe('serializeEmbedding', () => {
  it('converts Float32Array to Buffer', () => {
    const embedding = new Float32Array([0.1, 0.2, 0.3])
    const buf = serializeEmbedding(embedding)
    expect(buf).toBeInstanceOf(Buffer)
    expect(buf.byteLength).toBe(3 * 4) // 3 floats * 4 bytes each
  })

  it('roundtrips correctly', () => {
    const original = new Float32Array(EMBEDDING_DIMENSIONS)
    for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) {
      original[i] = Math.random() * 2 - 1
    }
    const buf = serializeEmbedding(original)
    const restored = deserializeEmbedding(buf)
    expect(restored.length).toBe(EMBEDDING_DIMENSIONS)
    for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) {
      expect(restored[i]).toBeCloseTo(original[i]!, 5)
    }
  })
})

describe('deserializeEmbedding', () => {
  it('converts Buffer back to Float32Array', () => {
    const original = new Float32Array([0.5, -0.5, 1.0, -1.0])
    const buf = serializeEmbedding(original)
    const restored = deserializeEmbedding(buf)
    expect(restored).toBeInstanceOf(Float32Array)
    expect(restored.length).toBe(4)
    expect(restored[0]).toBeCloseTo(0.5)
    expect(restored[1]).toBeCloseTo(-0.5)
  })
})

describe('EMBEDDING_DIMENSIONS', () => {
  it('is 384 for BGE-small-en-v1.5', () => {
    expect(EMBEDDING_DIMENSIONS).toBe(384)
  })
})
