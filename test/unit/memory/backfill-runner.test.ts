import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openMemoryDb, closeMemoryDb } from '../../../src/memory/db.js'
import { createBackfillRunner } from '../../../src/memory/backfill-runner.js'
import type Database from 'better-sqlite3'

function seedChunks(db: Database.Database, n: number): void {
  const insert = db.prepare(
    `INSERT INTO chunks (file_path, chunk_index, content, start_offset, end_offset, token_count)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
  const insertFile = db.prepare(
    `INSERT OR IGNORE INTO vault_files (path, mtime_ms, size_bytes) VALUES (?, ?, ?)`,
  )
  insertFile.run('seed.md', 1, 100)
  for (let i = 0; i < n; i++) {
    insert.run('seed.md', i, `chunk content ${i}`, i * 10, i * 10 + 10, 5)
  }
}

function fakeEmbeddings(count: number): ReadonlyArray<{ embedding: Float32Array }> {
  const arr: Array<{ embedding: Float32Array }> = []
  for (let i = 0; i < count; i++) {
    const f = new Float32Array(384)
    f[0] = i
    arr.push({ embedding: f })
  }
  return arr
}

describe('createBackfillRunner', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb(':memory:')
  })

  afterEach(() => {
    closeMemoryDb(db)
  })

  it('starts in idle state with zero progress', () => {
    const runner = createBackfillRunner()
    const state = runner.getState()
    expect(state.status).toBe('idle')
    expect(state.progress.done).toBe(0)
    expect(state.progress.total).toBe(0)
  })

  it('completes with status=ready when no chunks need backfilling', async () => {
    const runner = createBackfillRunner({
      generateBatch: async (texts) => fakeEmbeddings(texts.length),
    })
    await runner.start(db)
    const state = runner.getState()
    expect(state.status).toBe('ready')
    expect(state.progress.total).toBe(0)
    expect(state.progress.done).toBe(0)
  })

  it('processes chunks in batches and yields between them', async () => {
    seedChunks(db, 100)

    const batchTimestamps: number[] = []
    const runner = createBackfillRunner({
      batchSize: 16,
      generateBatch: async (texts) => {
        batchTimestamps.push(Date.now())
        return fakeEmbeddings(texts.length)
      },
    })

    // Observe intermediate state: run backfill, concurrently poll state.
    const states: number[] = []
    const poll = (async () => {
      while (runner.getState().status !== 'ready' && runner.getState().status !== 'failed') {
        states.push(runner.getState().progress.done)
        await new Promise((r) => setImmediate(r))
      }
    })()
    await runner.start(db)
    await poll

    expect(batchTimestamps.length).toBe(Math.ceil(100 / 16))
    const state = runner.getState()
    expect(state.status).toBe('ready')
    expect(state.progress.total).toBe(100)
    expect(state.progress.done).toBe(100)

    const embCount = (
      db.prepare('SELECT COUNT(*) as c FROM chunk_embeddings').get() as { c: number }
    ).c
    expect(embCount).toBe(100)

    // Progress should have been observable mid-run (not jump 0→100)
    const intermediateProgress = states.filter((d) => d > 0 && d < 100)
    expect(intermediateProgress.length).toBeGreaterThan(0)
  })

  it('transitions to failed on generator error', async () => {
    seedChunks(db, 10)
    const runner = createBackfillRunner({
      batchSize: 4,
      generateBatch: async () => {
        throw new Error('embed blew up')
      },
    })

    await runner.start(db)
    const state = runner.getState()
    expect(state.status).toBe('failed')
    expect(state.errorMessage).toContain('embed blew up')
  })

  it('returns same promise if start called while running', async () => {
    seedChunks(db, 20)
    let batches = 0
    const runner = createBackfillRunner({
      batchSize: 5,
      generateBatch: async (texts) => {
        batches++
        await new Promise((r) => setImmediate(r))
        return fakeEmbeddings(texts.length)
      },
    })

    const p1 = runner.start(db)
    const p2 = runner.start(db)
    await Promise.all([p1, p2])

    expect(batches).toBe(4)
    expect(runner.getState().progress.done).toBe(20)
  })

  it('clamps batch size to 1 minimum', async () => {
    seedChunks(db, 3)
    const sizes: number[] = []
    const runner = createBackfillRunner({
      batchSize: 0,
      generateBatch: async (texts) => {
        sizes.push(texts.length)
        return fakeEmbeddings(texts.length)
      },
    })
    await runner.start(db)
    expect(sizes).toEqual([1, 1, 1])
  })
})
