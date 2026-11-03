/**
 * Integration tests for the full hybrid search pipeline with real embeddings.
 * These tests use fastembed (BGE-small-en-v1.5) for actual vector search.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openMemoryDb, closeMemoryDb } from '../../../src/memory/db.js'
import { createVault } from '../../../src/memory/vault.js'
import { indexVault } from '../../../src/memory/indexer.js'
import { hybridSearch } from '../../../src/memory/search.js'
import { generateEmbedding, resetEmbeddingClient } from '../../../src/memory/embeddings.js'
import { compileEmbeddingWorker } from '../../helpers/embedding-worker.js'
import type Database from 'better-sqlite3'

describe('Hybrid search with real embeddings', () => {
  let rootDir: string
  let db: Database.Database
  let vault: ReturnType<typeof createVault>

  beforeAll(async () => {
    // Fork the REAL fastembed worker under vitest (compiled .mjs; see helper).
    process.env.SCNS_EMBED_WORKER_PATH = await compileEmbeddingWorker()
    await resetEmbeddingClient()

    rootDir = mkdtempSync(join(tmpdir(), 'scns-hybrid-test-'))
    vault = createVault({ rootDir })
    db = openMemoryDb(':memory:')

    // Seed vault with diverse content
    vault.write(
      'SOUL.md',
      'I am SCNS, the Second Central Nervous System. I observe user behavior and learn patterns.',
    )
    vault.write(
      'USER.md',
      'John is a full-stack developer. He uses TypeScript, React, and Node.js for web applications. Azure is his primary cloud provider.',
    )
    vault.write(
      'MEMORY.md',
      'Key decision: Use SQLite with sqlite-vec for vector search. Express 5 for the HTTP server. FastEmbed for local embeddings with 384 dimensions.',
    )
    vault.write(
      'daily/2026-04-04.md',
      '## 10:00:00\nStarted Phase 1 implementation. Built the memory vault with file-based storage and hybrid search combining vector similarity with keyword matching.',
    )

    // Index with real embeddings
    const stats = await indexVault(db, vault)
    expect(stats.embeddingsGenerated).toBeGreaterThan(0)
  }, 120_000) // first-time model load (forked worker)

  afterAll(async () => {
    closeMemoryDb(db)
    rmSync(rootDir, { recursive: true, force: true })
    await resetEmbeddingClient()
    delete process.env.SCNS_EMBED_WORKER_PATH
  })

  it('generates 384-dim embeddings', async () => {
    const result = await generateEmbedding('test query')
    expect(result.dimensions).toBe(384)
    expect(result.embedding).toBeInstanceOf(Float32Array)
    expect(result.embedding.length).toBe(384)
  })

  it('finds semantically similar content', async () => {
    const results = await hybridSearch(db, 'What programming languages are used?')
    expect(results.length).toBeGreaterThan(0)
    // Should rank the USER.md chunk (which mentions TypeScript, React, Node.js) highly
    const topContent = results.map((r) => r.content).join(' ')
    expect(topContent).toMatch(/TypeScript|React|Node/)
  })

  it('vector score contributes to hybrid ranking', async () => {
    const results = await hybridSearch(db, 'machine learning and AI observation')
    expect(results.length).toBeGreaterThan(0)
    // At least one result should have a non-zero vector score
    const hasVectorScore = results.some((r) => r.vectorScore > 0)
    expect(hasVectorScore).toBe(true)
  })

  it('keyword score contributes to hybrid ranking', async () => {
    const results = await hybridSearch(db, 'SQLite vector search')
    expect(results.length).toBeGreaterThan(0)
    // Should have keyword matches for SQLite/vector/search
    const hasKeywordScore = results.some((r) => r.keywordScore > 0)
    expect(hasKeywordScore).toBe(true)
  })

  it('respects limit parameter', async () => {
    const results = await hybridSearch(db, 'developer', { limit: 2 })
    expect(results.length).toBeLessThanOrEqual(2)
  })

  it('results include file path and chunk metadata', async () => {
    const results = await hybridSearch(db, 'TypeScript developer')
    expect(results.length).toBeGreaterThan(0)
    const first = results[0]!
    expect(first.filePath).toBeTruthy()
    expect(first.chunkId).toBeGreaterThan(0)
    expect(typeof first.chunkIndex).toBe('number')
    expect(first.score).toBeGreaterThan(0)
  })
})
