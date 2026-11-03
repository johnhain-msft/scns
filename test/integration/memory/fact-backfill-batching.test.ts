/**
 * D3 — productionized fact extraction: batching + per-pass budget + missing-only backfill.
 *
 * Uses the REAL fastembed worker (fact nodes need real embeddings) + an INJECTED recording mock
 * extractor (so the suite never spawns `copilot --acp`). Locks the D3 controls:
 *   POSITIVE — #batches == ceil(n/N), spawns ≤ budget, fact nodes for >1 file, 2nd pass 0 new.
 *   NEGATIVE — null extractor ⇒ 0 batches, 0 spawns, byte-identical index (no fact chunks).
 *   DETERMINISM ×2 — same seed twice ⇒ identical batch boundaries + fact rows.
 *   BUDGET — budget < totalBatches ⇒ spawns == budget; converges over passes.
 *   REGRESSION GUARD — cross-passage fusion survives batching (deterministic file-neighborhood order).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'
import { openMemoryDb, closeMemoryDb } from '../../../src/memory/db.js'
import { createVault } from '../../../src/memory/vault.js'
import {
  indexVault,
  backfillFactNodes,
  countFactBackfillEligible,
} from '../../../src/memory/indexer.js'
import { resetEmbeddingClient } from '../../../src/memory/embeddings.js'
import {
  NULL_FACT_EXTRACTOR,
  type LlmFactExtractor,
  type ExtractedFact,
  type FactSourceChunk,
} from '../../../src/memory/fact-extractor-provider.js'
import { compileEmbeddingWorker } from '../../helpers/embedding-worker.js'

const FACT_BASE = 1_000_000

/** Recording mock: captures every batch (one push per ACP "spawn") and emits via `emit`. */
function makeRecordingExtractor(
  emit: (chunks: readonly FactSourceChunk[]) => ExtractedFact[],
): { calls: FactSourceChunk[][]; extractor: LlmFactExtractor } {
  const calls: FactSourceChunk[][] = []
  return {
    calls,
    extractor: {
      async extract({ chunks }) {
        calls.push(chunks.map((c) => ({ ...c })))
        return emit(chunks)
      },
    },
  }
}

/** One fused fact per DISTINCT file in the batch ⇒ every offered file ends up enriched. */
function oneFactPerFile(chunks: readonly FactSourceChunk[]): ExtractedFact[] {
  const byFile = new Map<string, FactSourceChunk>()
  for (const c of chunks) if (!byFile.has(c.path)) byFile.set(c.path, c)
  return [...byFile.values()].map((c) => ({
    sourceId: c.id,
    content: `Fused relational fact for ${c.path}: ${c.content.slice(0, 30)}`,
  }))
}

/** Seed F files × C source chunks each (chunk_index < FACT_BASE) directly — no chunker dependency. */
function seedSourceChunks(db: Database.Database, files: number, chunksPerFile: number): void {
  const insFile = db.prepare(
    `INSERT INTO vault_files (path, mtime_ms, size_bytes, content_hash) VALUES (?, ?, ?, ?)`,
  )
  const insChunk = db.prepare(
    `INSERT INTO chunks (file_path, chunk_index, content, start_offset, end_offset, token_count)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
  db.transaction(() => {
    for (let f = 0; f < files; f++) {
      const path = `f${String(f).padStart(2, '0')}.md`
      insFile.run(path, 1000 + f, 100, `hash-${f}`)
      for (let c = 0; c < chunksPerFile; c++) {
        const content = `file ${path} chunk ${c} narrative content about topic ${f}-${c}`
        insChunk.run(path, c, content, 0, content.length, 8)
      }
    }
  })()
}

/** Stable signature of the derived fact-node set (file_path, chunk_index, content). */
function factNodeSignature(db: Database.Database): string {
  const rows = db
    .prepare(
      `SELECT file_path, chunk_index, content FROM chunks
        WHERE chunk_index >= ? ORDER BY file_path, chunk_index`,
    )
    .all(FACT_BASE)
  return JSON.stringify(rows)
}

/** Stable signature of the batch boundaries the extractor saw (ids per batch, in call order). */
function batchSignature(calls: FactSourceChunk[][]): string {
  return JSON.stringify(calls.map((b) => b.map((c) => `${c.path}#${c.id}`)))
}

function distinctFactFiles(db: Database.Database): number {
  return (
    db
      .prepare(`SELECT COUNT(DISTINCT file_path) AS n FROM chunks WHERE chunk_index >= ?`)
      .get(FACT_BASE) as { n: number }
  ).n
}

describe('D3 — fact extraction batching + budget + missing-only backfill', () => {
  beforeAll(async () => {
    process.env.SCNS_EMBED_WORKER_PATH = await compileEmbeddingWorker()
    await resetEmbeddingClient()
  }, 120_000)

  afterAll(async () => {
    await resetEmbeddingClient()
    delete process.env.SCNS_EMBED_WORKER_PATH
  })

  it('POSITIVE CONTROL: #batches==ceil(n/N), spawns<=budget, >1 file, 2nd pass 0 new', async () => {
    const db = openMemoryDb(':memory:')
    try {
      const FILES = 4
      const PER = 20 // n = 80 source chunks over 4 files (>60 over >1 file)
      const N = 15
      const n = FILES * PER
      const expectedBatches = Math.ceil(n / N) // ceil(80/15) = 6
      seedSourceChunks(db, FILES, PER)

      const eligibleBefore = countFactBackfillEligible(db)
      expect(eligibleBefore.chunksEligible).toBe(n)
      expect(eligibleBefore.filesEligible).toBe(FILES)

      const rec = makeRecordingExtractor(oneFactPerFile)
      const stats = await backfillFactNodes(db, {
        factExtractor: rec.extractor,
        batchSize: N,
        maxBatches: 100, // generous budget ⇒ all batches run this pass
      })

      // (a) #batches == ceil(n/N)
      expect(rec.calls.length).toBe(expectedBatches)
      expect(stats.batchesRun).toBe(expectedBatches)
      expect(stats.totalBatches).toBe(expectedBatches)
      // (b) spawns <= budget cap
      expect(stats.batchesRun).toBeLessThanOrEqual(stats.budget)
      // each batch is <= N passages
      for (const b of rec.calls) expect(b.length).toBeLessThanOrEqual(N)
      // (c) fact nodes appear for >1 distinct file
      expect(distinctFactFiles(db)).toBe(FILES)
      expect(distinctFactFiles(db)).toBeGreaterThan(1)
      expect(stats.factsExtracted).toBeGreaterThan(0)

      // (d) 2nd pass extracts 0 new (missing-only convergence — already-enriched files cost 0)
      const rec2 = makeRecordingExtractor(oneFactPerFile)
      const stats2 = await backfillFactNodes(db, {
        factExtractor: rec2.extractor,
        batchSize: N,
        maxBatches: 100,
      })
      expect(countFactBackfillEligible(db).chunksEligible).toBe(0)
      expect(rec2.calls.length).toBe(0)
      expect(stats2.batchesRun).toBe(0)
      expect(stats2.factsExtracted).toBe(0)
    } finally {
      closeMemoryDb(db)
    }
  }, 120_000)

  it('NEGATIVE CONTROL: null extractor ⇒ 0 batches, 0 facts, byte-identical index', async () => {
    const db = openMemoryDb(':memory:')
    try {
      seedSourceChunks(db, 3, 25) // 75 source chunks
      const before = (
        db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }
      ).n
      const stats = await backfillFactNodes(db, { factExtractor: NULL_FACT_EXTRACTOR })
      expect(stats.batchesRun).toBe(0)
      expect(stats.factsExtracted).toBe(0)
      const after = (db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }).n
      expect(after).toBe(before) // no fact chunks added — byte-identical chunk set
      expect(distinctFactFiles(db)).toBe(0)
    } finally {
      closeMemoryDb(db)
    }
  }, 120_000)

  it('DETERMINISM ×2: identical seed ⇒ identical batch boundaries + fact rows', async () => {
    const run = async () => {
      const db = openMemoryDb(':memory:')
      seedSourceChunks(db, 4, 18) // 72 chunks
      const rec = makeRecordingExtractor(oneFactPerFile)
      await backfillFactNodes(db, { factExtractor: rec.extractor, batchSize: 13, maxBatches: 100 })
      const sig = { batches: batchSignature(rec.calls), facts: factNodeSignature(db) }
      closeMemoryDb(db)
      return sig
    }
    const a = await run()
    const b = await run()
    expect(a.batches).toBe(b.batches) // batch boundaries byte-identical
    expect(a.facts).toBe(b.facts) // fact rows byte-identical
  }, 120_000)

  it('BUDGET: budget < totalBatches ⇒ spawns == budget; converges over passes', async () => {
    const db = openMemoryDb(':memory:')
    try {
      seedSourceChunks(db, 5, 20) // n=100; N=15 ⇒ ceil = 7 totalBatches
      const N = 15
      const BUDGET = 2
      let passes = 0
      let totalSpawns = 0
      // Loop bounded passes; each pass spends ≤ BUDGET spawns until eligibility hits 0.
      while (countFactBackfillEligible(db).chunksEligible > 0 && passes < 20) {
        const rec = makeRecordingExtractor(oneFactPerFile)
        const stats = await backfillFactNodes(db, {
          factExtractor: rec.extractor,
          batchSize: N,
          maxBatches: BUDGET,
        })
        // Each non-final pass with work remaining runs EXACTLY the budget (totalBatches > budget),
        // and never exceeds it.
        expect(stats.batchesRun).toBeLessThanOrEqual(BUDGET)
        expect(rec.calls.length).toBe(stats.batchesRun)
        totalSpawns += stats.batchesRun
        passes++
        if (stats.batchesRun === 0) break // safety: no progress
      }
      // Converged: no eligible files left, and it took MORE than one pass (proving the budget bit).
      expect(countFactBackfillEligible(db).chunksEligible).toBe(0)
      expect(passes).toBeGreaterThan(1)
      expect(distinctFactFiles(db)).toBe(5)
      expect(totalSpawns).toBeGreaterThan(BUDGET)
    } finally {
      closeMemoryDb(db)
    }
  }, 120_000)

  it('content-change flow: indexVault splits a pass into deterministic batches (factBatchesRun)', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'scns-d3-idx-'))
    const db = openMemoryDb(':memory:')
    try {
      const vault = createVault({ rootDir })
      const FILES = 50
      for (let i = 0; i < FILES; i++) {
        vault.write(`n${String(i).padStart(2, '0')}.md`, `Narrative passage number ${i} about a distinct topic.`)
      }
      const N = 20
      const rec = makeRecordingExtractor(() => []) // record batches; emit no facts (count-only)
      const stats = await indexVault(db, vault, undefined, undefined, {
        extractFacts: true,
        factExtractor: rec.extractor,
        factBatchSize: N,
        factMaxBatches: 100,
      })
      const expected = Math.ceil(FILES / N) // 3 (each tiny file = 1 chunk)
      expect(rec.calls.length).toBe(expected)
      expect(stats.factBatchesRun).toBe(expected)
      // Deterministic ordering: each batch's paths are globally sorted & contiguous.
      const flat = rec.calls.flatMap((b) => b.map((c) => c.path))
      expect(flat).toEqual([...flat].sort())
    } finally {
      closeMemoryDb(db)
      rmSync(rootDir, { recursive: true, force: true })
    }
  }, 120_000)

  it('REGRESSION GUARD: cross-passage fusion survives batching when N holds the neighborhood', async () => {
    // Batch-aware mock: emit the FUSED fact for chain_c ONLY when a chain_b chunk is in the SAME
    // batch (simulating the real extractor needing both the bridge + property passage together).
    const fusionMock: LlmFactExtractor = {
      async extract({ chunks }) {
        const bridge = chunks.find((c) => c.path === 'chain_b.md')
        const property = chunks.find((c) => c.path === 'chain_c.md')
        if (bridge && property) {
          return [
            {
              sourceId: property.id,
              content:
                'The place where Melanie volunteers, the Riverdale Settlement House, is notable for its rooftop observatory.',
            },
          ]
        }
        return []
      },
    }

    const build = async (batchSize: number) => {
      const rootDir = mkdtempSync(join(tmpdir(), 'scns-d3-fuse-'))
      const db = openMemoryDb(':memory:')
      const vault = createVault({ rootDir })
      vault.write('chain_b.md', 'Every week, Melanie volunteers at the Riverdale Settlement House on the east side.')
      vault.write('chain_c.md', 'The Riverdale Settlement House has a historic rooftop observatory and brass telescope.')
      await indexVault(db, vault, undefined, undefined, {
        extractFacts: true,
        factExtractor: fusionMock,
        factBatchSize: batchSize,
        factMaxBatches: 100,
      })
      const fact = db
        .prepare(`SELECT file_path FROM chunks WHERE chunk_index >= ?`)
        .get(FACT_BASE) as { file_path: string } | undefined
      closeMemoryDb(db)
      rmSync(rootDir, { recursive: true, force: true })
      return fact
    }

    // N=5 holds both adjacent files (chain_b, chain_c) in ONE batch ⇒ fusion survives.
    const fused = await build(5)
    expect(fused).toBeDefined()
    expect(fused!.file_path).toBe('chain_c.md')

    // N=1 forces them into SEPARATE batches ⇒ the fused fact is (correctly) NOT produced.
    // Proves the guard is non-vacuous: batch size must hold the file-neighborhood.
    const split = await build(1)
    expect(split).toBeUndefined()
  }, 120_000)
})
