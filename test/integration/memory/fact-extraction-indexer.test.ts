/**
 * Integration test for the MAGMA node-model hook in indexVault (Eq.3 / App C.1).
 *
 * Uses the REAL fastembed worker (fact nodes need real embeddings to be useful) + an INJECTED
 * fake extractor (so the suite never spawns `copilot --acp`). Locks the two invariants the wedge
 * depends on:
 *   1. DEFAULT-OFF is byte-identical — with no extractor (or the null extractor) the indexer
 *      creates exactly the source chunks and zero derived facts.
 *   2. WITH an extractor, returned relational facts are stored as DERIVED chunks under their
 *      SOURCE file (facts-as-chunks), are searchable, and are reported via `factsExtracted`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openMemoryDb, closeMemoryDb } from '../../../src/memory/db.js'
import { createVault } from '../../../src/memory/vault.js'
import { indexVault } from '../../../src/memory/indexer.js'
import { hybridSearch } from '../../../src/memory/search.js'
import { resetEmbeddingClient } from '../../../src/memory/embeddings.js'
import { NULL_FACT_EXTRACTOR, type LlmFactExtractor } from '../../../src/memory/fact-extractor-provider.js'
import { compileEmbeddingWorker } from '../../helpers/embedding-worker.js'
import type Database from 'better-sqlite3'

function makeVault() {
  const rootDir = mkdtempSync(join(tmpdir(), 'scns-factidx-test-'))
  const vault = createVault({ rootDir })
  vault.write('chain_b.md', 'Every week, Melanie gives her time to the Riverdale Settlement House on the east side.')
  vault.write('chain_c.md', 'The Riverdale Settlement House houses an enormous century-old pipe organ in its main hall.')
  return { rootDir, vault }
}

/** Injected fake: emits one fused relational fact attached to chain_c. Stands in for the LLM. */
const FAKE_EXTRACTOR: LlmFactExtractor = {
  async extract({ chunks }) {
    const target = chunks.find((c) => c.path === 'chain_c.md')
    if (!target) return []
    return [
      {
        sourceId: target.id,
        content:
          'The place where Melanie volunteers each week, the Riverdale Settlement House, is notable for its century-old pipe organ.',
      },
    ]
  },
}

describe('indexVault — MAGMA fact-extraction hook', () => {
  beforeAll(async () => {
    process.env.SCNS_EMBED_WORKER_PATH = await compileEmbeddingWorker()
    await resetEmbeddingClient()
  }, 120_000)

  afterAll(async () => {
    await resetEmbeddingClient()
    delete process.env.SCNS_EMBED_WORKER_PATH
  })

  it('is byte-identical (no derived facts) when extraction is OFF', async () => {
    const { rootDir, vault } = makeVault()
    const db: Database.Database = openMemoryDb(':memory:')
    try {
      const stats = await indexVault(db, vault, undefined, undefined, {})
      expect(stats.factsExtracted).toBe(0)
      const sourceChunks = db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }
      // Two single-sentence files ⇒ two source chunks, no facts.
      expect(sourceChunks.n).toBe(2)
      const factRows = db
        .prepare('SELECT COUNT(*) AS n FROM chunks WHERE chunk_index >= 1000000')
        .get() as { n: number }
      expect(factRows.n).toBe(0)
    } finally {
      closeMemoryDb(db)
      rmSync(rootDir, { recursive: true, force: true })
    }
  }, 120_000)

  it('treats the null extractor as OFF (no facts)', async () => {
    const { rootDir, vault } = makeVault()
    const db: Database.Database = openMemoryDb(':memory:')
    try {
      const stats = await indexVault(db, vault, undefined, undefined, {
        extractFacts: true,
        factExtractor: NULL_FACT_EXTRACTOR,
      })
      expect(stats.factsExtracted).toBe(0)
    } finally {
      closeMemoryDb(db)
      rmSync(rootDir, { recursive: true, force: true })
    }
  }, 120_000)

  it('stores a returned fact as a derived chunk under its source file and makes it searchable', async () => {
    const { rootDir, vault } = makeVault()
    const db: Database.Database = openMemoryDb(':memory:')
    try {
      const stats = await indexVault(db, vault, undefined, undefined, {
        extractFacts: true,
        factExtractor: FAKE_EXTRACTOR,
      })
      expect(stats.factsExtracted).toBe(1)
      expect(stats.embeddingsGenerated).toBe(3) // 2 source + 1 fact

      // The fact node is attached to chain_c.md with a FACT_CHUNK_INDEX_BASE index.
      const factRow = db
        .prepare('SELECT file_path, chunk_index, content FROM chunks WHERE chunk_index >= 1000000')
        .get() as { file_path: string; chunk_index: number; content: string } | undefined
      expect(factRow).toBeDefined()
      expect(factRow!.file_path).toBe('chain_c.md')
      expect(factRow!.content).toContain('Melanie volunteers')
      expect(factRow!.content).toContain('pipe organ')

      // The relational node is now query-relevant by its own embedding — a query that shares
      // NO tokens with raw chain_c ("place where Melanie volunteers") retrieves the chain_c file.
      const results = await hybridSearch(db, 'what is notable about where Melanie volunteers', {
        limit: 3,
      })
      const files = results.map((r) => {
        const row = db.prepare('SELECT file_path FROM chunks WHERE id = ?').get(r.chunkId) as {
          file_path: string
        }
        return row.file_path
      })
      expect(files).toContain('chain_c.md')
    } finally {
      closeMemoryDb(db)
      rmSync(rootDir, { recursive: true, force: true })
    }
  }, 120_000)
})
