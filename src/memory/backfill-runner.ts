/**
 * Embedding backfill runner — progressive, non-blocking.
 *
 * Processes chunks-without-embeddings in small batches, yielding the event
 * loop between each batch so the HTTP listener stays responsive during
 * cold-start backfill on large vaults (see Phase 13.9.4).
 */

import type Database from 'better-sqlite3'
import { setImmediate as setImmediatePromise } from 'node:timers/promises'
import { serializeEmbedding } from './embeddings.js'
import { withIndexingLock } from './indexing-lock.js'
import { logger } from '../shared/logger.js'

export type BackfillStatus = 'idle' | 'backfilling' | 'ready' | 'failed'

export interface BackfillProgress {
  readonly done: number
  readonly total: number
}

export interface BackfillState {
  readonly status: BackfillStatus
  readonly progress: BackfillProgress
  readonly errorMessage: string | null
  readonly startedAt: number | null
  readonly finishedAt: number | null
}

export interface BackfillRunnerOptions {
  readonly batchSize?: number
  readonly generateBatch?: (
    texts: readonly string[],
  ) => Promise<ReadonlyArray<{ readonly embedding: Float32Array }>>
}

export interface BackfillRunner {
  start(db: Database.Database): Promise<void>
  getState(): BackfillState
}

const DEFAULT_BATCH_SIZE = 32

function clampBatchSize(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_BATCH_SIZE
  const floored = Math.floor(raw)
  if (floored < 1) return 1
  if (floored > 256) return 256
  return floored
}

export function createBackfillRunner(options: BackfillRunnerOptions = {}): BackfillRunner {
  const batchSize = clampBatchSize(options.batchSize)
  const generateBatch = options.generateBatch

  let status: BackfillStatus = 'idle'
  let done = 0
  let total = 0
  let errorMessage: string | null = null
  let startedAt: number | null = null
  let finishedAt: number | null = null
  let running: Promise<void> | null = null

  async function resolveGenerator() {
    if (generateBatch) return generateBatch
    // Defer fastembed import to call-time so unit tests with injected
    // generateBatch never touch the native module.
    const mod = await import('./embeddings.js')
    return (texts: readonly string[]) => mod.generateEmbeddingsBatch(texts)
  }

  async function run(db: Database.Database): Promise<void> {
    status = 'backfilling'
    errorMessage = null
    startedAt = Date.now()
    finishedAt = null
    done = 0

    try {
      const rows = db
        .prepare(
          `SELECT c.id, c.content FROM chunks c
           WHERE c.id NOT IN (SELECT chunk_id FROM chunk_embeddings)
           ORDER BY c.id`,
        )
        .all() as Array<{ id: number; content: string }>

      total = rows.length

      if (total === 0) {
        status = 'ready'
        finishedAt = Date.now()
        return
      }

      const generate = await resolveGenerator()
      const insertEmb = db.prepare(
        'INSERT INTO chunk_embeddings (chunk_id, embedding) VALUES (?, ?)',
      )
      // The store path (#49) embeds its own file's chunks outside the indexing
      // lock, so a chunk from this run's initial SELECT may already be embedded
      // by the time its batch commits. vec0 throws on a duplicate rowid, which
      // would roll back the batch and fail the whole run — re-check inside the
      // transaction (authoritative: better-sqlite3 transactions are synchronous).
      const alreadyEmbedded = db.prepare('SELECT 1 FROM chunk_embeddings WHERE chunk_id = ?')

      for (let offset = 0; offset < rows.length; offset += batchSize) {
        const batch = rows.slice(offset, offset + batchSize)
        const texts = batch.map((r) => r.content)
        const embeddings = await generate(texts)

        const runInserts = db.transaction(() => {
          for (let i = 0; i < batch.length; i++) {
            const emb = embeddings[i]
            if (emb && !alreadyEmbedded.get(BigInt(batch[i]!.id))) {
              insertEmb.run(BigInt(batch[i]!.id), serializeEmbedding(emb.embedding))
            }
          }
        })
        runInserts()

        done += batch.length

        // Yield the event loop so the HTTP listener and other I/O can run
        // between CPU-heavy ONNX batches.
        await setImmediatePromise()
      }

      status = 'ready'
      finishedAt = Date.now()
      logger.info(
        { done, total, elapsedMs: finishedAt - (startedAt ?? finishedAt) },
        'Backfill runner completed',
      )
    } catch (err) {
      status = 'failed'
      errorMessage = err instanceof Error ? err.message : String(err)
      finishedAt = Date.now()
      logger.warn({ err }, 'Backfill runner failed')
    }
  }

  return {
    start(db: Database.Database): Promise<void> {
      if (running) return running
      running = withIndexingLock(() => run(db)).finally(() => {
        running = null
      })
      return running
    },
    getState(): BackfillState {
      return {
        status,
        progress: { done, total },
        errorMessage,
        startedAt,
        finishedAt,
      }
    },
  }
}
