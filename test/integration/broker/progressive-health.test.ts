/**
 * Integration test for `/api/health` + backfill runner wiring (Phase 13.9.4).
 *
 * Verifies the progressive readiness endpoint responds correctly as the
 * backfill moves through idle → backfilling → ready states, and that the
 * HTTP listener stays responsive during a batch-throttled backfill.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { openDatabase, closeDatabase } from '../../../src/broker/storage/db.js'
import { createEventLog } from '../../../src/broker/services/event-log.js'
import { createEventDispatcher } from '../../../src/broker/event-dispatcher.js'
import { createBrokerServer, type BrokerServer } from '../../../src/broker/server.js'
import { ShutdownManager } from '../../../src/broker/shutdown.js'
import { createBackfillRunner } from '../../../src/memory/backfill-runner.js'
import { openMemoryDb, closeMemoryDb } from '../../../src/memory/db.js'
import type Database from 'better-sqlite3'

describe('/api/health (integration)', () => {
  let db: Database.Database
  let broker: BrokerServer
  let server: Server
  let baseUrl: string

  beforeEach(async () => {
    db = openDatabase(':memory:')
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(db, dispatcher)
    const shutdownManager = new ShutdownManager()
    broker = createBrokerServer(db, eventLog, shutdownManager, dispatcher, { authToken: null })
    server = createServer(broker.app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterEach(async () => {
    await broker.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    closeDatabase(db)
  })

  it('returns ready with no backfill provider after starting window', async () => {
    // Wait past the 500ms starting window
    await new Promise((r) => setTimeout(r, 600))
    const res = await fetch(`${baseUrl}/api/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      status: string
      components: { embeddings: { status: string }; brain: { status: string }; db: { status: string } }
    }
    expect(body.components.db.status).toBe('ready')
    expect(body.components.embeddings.status).toBe('idle')
  })

  it('reports backfilling then ready when backfill runner is wired', async () => {
    const memDb = openMemoryDb(':memory:')
    try {
      // Seed 50 chunks needing embeddings
      const insertFile = memDb.prepare(
        `INSERT OR IGNORE INTO vault_files (path, mtime_ms, size_bytes) VALUES (?, ?, ?)`,
      )
      insertFile.run('seed.md', 1, 100)
      const insertChunk = memDb.prepare(
        `INSERT INTO chunks (file_path, chunk_index, content, start_offset, end_offset, token_count)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      for (let i = 0; i < 50; i++) {
        insertChunk.run('seed.md', i, `c${i}`, i * 10, i * 10 + 10, 5)
      }

      const runner = createBackfillRunner({
        batchSize: 8,
        generateBatch: async (texts) => {
          // Simulate ONNX latency — gives polling a chance to observe
          // intermediate 'backfilling' status.
          await new Promise((r) => setTimeout(r, 20))
          return texts.map(() => ({ embedding: new Float32Array(384) }))
        },
      })

      broker.setProgressiveHealthDeps({
        getEmbeddingBackfillState: () => {
          const s = runner.getState()
          return { status: s.status, progress: s.progress, errorMessage: s.errorMessage }
        },
        getBrainStatus: () => 'ready',
      })

      // Kick off backfill in background
      const backfillPromise = runner.start(memDb)

      // Poll /api/health until we see backfilling, then until ready
      let sawBackfilling = false
      let sawReady = false
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        const res = await fetch(`${baseUrl}/api/health`)
        const body = (await res.json()) as {
          status: string
          components: { embeddings: { status: string; progress: { done: number; total: number } | null } }
        }
        if (body.components.embeddings.status === 'backfilling') {
          sawBackfilling = true
          expect(body.status).toBe('degraded')
          expect(body.components.embeddings.progress).not.toBeNull()
        }
        if (body.components.embeddings.status === 'ready') {
          sawReady = true
          expect(body.status).toBe('ready')
          expect(body.components.embeddings.progress).toEqual({ done: 50, total: 50 })
          break
        }
        await new Promise((r) => setTimeout(r, 15))
      }

      await backfillPromise
      expect(sawBackfilling).toBe(true)
      expect(sawReady).toBe(true)
    } finally {
      closeMemoryDb(memDb)
    }
  })

  it('keeps HTTP listener responsive during batch-throttled backfill', async () => {
    const memDb = openMemoryDb(':memory:')
    try {
      const insertFile = memDb.prepare(
        `INSERT OR IGNORE INTO vault_files (path, mtime_ms, size_bytes) VALUES (?, ?, ?)`,
      )
      insertFile.run('seed.md', 1, 100)
      const insertChunk = memDb.prepare(
        `INSERT INTO chunks (file_path, chunk_index, content, start_offset, end_offset, token_count)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      for (let i = 0; i < 200; i++) {
        insertChunk.run('seed.md', i, `c${i}`, i * 10, i * 10 + 10, 5)
      }

      const runner = createBackfillRunner({
        batchSize: 16,
        generateBatch: async (texts) => {
          // Simulate a CPU-heavy batch that blocks for ~30ms (ONNX-ish).
          const end = Date.now() + 30
          while (Date.now() < end) {
            /* busy loop */
          }
          return texts.map(() => ({ embedding: new Float32Array(384) }))
        },
      })

      broker.setProgressiveHealthDeps({
        getEmbeddingBackfillState: () => {
          const s = runner.getState()
          return { status: s.status, progress: s.progress, errorMessage: s.errorMessage }
        },
      })

      const backfillPromise = runner.start(memDb)

      // While backfill is running, fire 5 health requests and assert each
      // responds within 500ms (would fail if batches blocked the loop).
      const latencies: number[] = []
      for (let i = 0; i < 5; i++) {
        const t0 = Date.now()
        const res = await fetch(`${baseUrl}/api/health`)
        const elapsed = Date.now() - t0
        latencies.push(elapsed)
        expect(res.status).toBe(200)
        await new Promise((r) => setTimeout(r, 5))
      }

      await backfillPromise

      for (const l of latencies) {
        expect(l).toBeLessThan(500)
      }
    } finally {
      closeMemoryDb(memDb)
    }
  })

  it('brain status flips from starting → ready when getBrainStatus returns ready', async () => {
    // Wait past the 500ms starting window so overall isn't 'starting'
    await new Promise((r) => setTimeout(r, 600))

    let brainReady = false
    broker.setProgressiveHealthDeps({
      getBrainStatus: () => (brainReady ? 'ready' : 'starting'),
    })

    let res = await fetch(`${baseUrl}/api/health`)
    let body = (await res.json()) as {
      status: string
      components: { brain: { status: string }; embeddings: { status: string } }
    }
    expect(body.components.brain.status).toBe('starting')
    expect(body.status).toBe('degraded')

    brainReady = true
    res = await fetch(`${baseUrl}/api/health`)
    body = (await res.json()) as {
      status: string
      components: { brain: { status: string }; embeddings: { status: string } }
    }
    expect(body.components.brain.status).toBe('ready')
    expect(body.components.embeddings.status).toBe('idle')
    expect(body.status).toBe('ready')
  })
})
