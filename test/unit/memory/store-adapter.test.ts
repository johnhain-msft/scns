/**
 * Regression for #49 — a newly stored memory is invisible to the injected
 * briefing until the next scheduled re-index (up to ~20 min).
 *
 * `scns_memory_store` ran `indexVaultSync`, which writes chunks + FTS rows
 * but cannot await the embedding worker — so the new chunk had NO vector
 * embedding. Keyword search found it immediately (masking the gap), but the
 * injected briefing ranks by vector similarity, so a chunk with no embedding
 * can never be briefed until the throttled `memory-reindex` task runs.
 *
 * The fix: the store path awaits a FILE-SCOPED embedding backfill. File-
 * scoped, not the vault-wide `backfillEmbeddings`, so a pre-existing
 * unembedded backlog can never turn a store into the 60–90s ONNX sweep the
 * re-index cooldown exists to prevent. Contract: if it stored, it's
 * briefable — and an embedding failure degrades to today's behavior
 * (stored + keyword-searchable, embedded on the next scheduled re-index)
 * instead of failing the store.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type Database from 'better-sqlite3'

vi.mock('../../../src/memory/embeddings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/memory/embeddings.js')>()
  return {
    ...actual,
    generateEmbeddingsBatch: vi.fn(async (texts: readonly string[]) =>
      texts.map(() => ({ embedding: new Float32Array(384).fill(0.1), dimensions: 384 })),
    ),
  }
})

import { generateEmbeddingsBatch } from '../../../src/memory/embeddings.js'
import { openMemoryDb, closeMemoryDb } from '../../../src/memory/db.js'
import { createVault } from '../../../src/memory/vault.js'
import { indexVaultSync } from '../../../src/memory/indexer.js'
import { createMemoryStore } from '../../../src/memory/store-adapter.js'

const mockBatch = vi.mocked(generateEmbeddingsBatch)

function embeddedChunkCounts(
  db: Database.Database,
  filePath: string,
): { chunks: number; embedded: number } {
  const chunks = (
    db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE file_path = ?').get(filePath) as {
      n: number
    }
  ).n
  const embedded = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM chunks c
         JOIN chunk_embeddings e ON e.chunk_id = c.id
         WHERE c.file_path = ?`,
      )
      .get(filePath) as { n: number }
  ).n
  return { chunks, embedded }
}

describe('memory store adapter — store → briefable contract (#49)', () => {
  let rootDir: string
  let db: Database.Database
  let vault: ReturnType<typeof createVault>
  let store: ReturnType<typeof createMemoryStore>['store']

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'scns-store-adapter-'))
    vault = createVault({ rootDir })
    db = openMemoryDb(':memory:')
    mockBatch.mockClear()
    ;({ store } = createMemoryStore({ db, vault, indexVaultSync }))
  })

  afterEach(() => {
    closeMemoryDb(db)
    rmSync(rootDir, { recursive: true, force: true })
  })

  it('a stored memory has its vector embedding immediately — briefable, not just searchable', async () => {
    const result = await store('gap-canary.md', 'type: finding\nThe verification code is Zarquon.')

    expect(result).toEqual({ stored: true, key: 'gap-canary.md' })
    const { chunks, embedded } = embeddedChunkCounts(db, 'gap-canary.md')
    expect(chunks).toBeGreaterThan(0)
    expect(embedded).toBe(chunks)
  })

  it('scopes the awaited backfill to the stored file — a pre-existing backlog is left to the scheduled re-index', async () => {
    // A file indexed without embeddings (exactly what indexVaultSync produces).
    vault.write('backlog.md', 'An older memory that never got its embedding.')
    indexVaultSync(db, vault)
    mockBatch.mockClear()

    await store('fresh.md', 'A brand new memory.')

    const fresh = embeddedChunkCounts(db, 'fresh.md')
    expect(fresh.embedded).toBe(fresh.chunks)
    const backlog = embeddedChunkCounts(db, 'backlog.md')
    expect(backlog.chunks).toBeGreaterThan(0)
    expect(backlog.embedded).toBe(0)
    // And the embedding worker only ever saw the fresh file's chunks.
    for (const call of mockBatch.mock.calls) {
      for (const text of call[0]) {
        expect(text).not.toContain('older memory')
      }
    }
  })

  it('an embedding failure degrades to stored-but-not-yet-briefable, never a failed store', async () => {
    mockBatch.mockRejectedValueOnce(new Error('embedding worker unavailable'))

    const result = await store('degraded.md', 'Stored while the worker is down.')

    expect(result).toEqual({ stored: true, key: 'degraded.md' })
    const { chunks, embedded } = embeddedChunkCounts(db, 'degraded.md')
    expect(chunks).toBeGreaterThan(0)
    expect(embedded).toBe(0)
  })

  it('canonicalizes a non-canonical key so the backfill still finds the indexed file', async () => {
    // The indexer records file_path as the canonical POSIX relative path, so
    // a verbatim `.\x.md` / `sub\x.md` / `a//b.md` key would index fine but
    // backfill nothing. Backslash keys are a real shape on native Windows.
    const dotted = await store('./dotted.md', 'Stored under a dotted relative key.')
    expect(dotted).toEqual({ stored: true, key: 'dotted.md' })
    const dottedCounts = embeddedChunkCounts(db, 'dotted.md')
    expect(dottedCounts.chunks).toBeGreaterThan(0)
    expect(dottedCounts.embedded).toBe(dottedCounts.chunks)

    const backslashed = await store('nested\\win.md', 'Stored under a backslashed key.')
    expect(backslashed).toEqual({ stored: true, key: 'nested/win.md' })
    const nestedCounts = embeddedChunkCounts(db, 'nested/win.md')
    expect(nestedCounts.chunks).toBeGreaterThan(0)
    expect(nestedCounts.embedded).toBe(nestedCounts.chunks)
  })

  it('a store to an index-excluded prefix (daily/) succeeds with nothing to embed', async () => {
    const result = await store('daily/2026-09-11.md', '**[telemetry]** excluded from the index.')

    expect(result).toEqual({ stored: true, key: 'daily/2026-09-11.md' })
    const { chunks, embedded } = embeddedChunkCounts(db, 'daily/2026-09-11.md')
    expect(chunks).toBe(0)
    expect(embedded).toBe(0)
  })

  it('is idempotent — re-storing the same key does not duplicate embedding rows', async () => {
    await store('twice.md', 'First version.')
    await store('twice.md', 'Second version, slightly longer than the first.')

    const { chunks, embedded } = embeddedChunkCounts(db, 'twice.md')
    expect(embedded).toBe(chunks)
  })
})
