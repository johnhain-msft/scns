/**
 * Broker-side embedding client.
 *
 * Generating embeddings loads `fastembed`/`onnxruntime`, which carries a
 * ~1.3 GB native (mmap arena) footprint that `InferenceSession.release()`
 * does NOT reclaim (measured 2026-06-02). Keeping that in the long-lived
 * broker process made RSS ratchet up to >1.5 GB. This client moves all
 * embedding work into a **disposable child process** that the OS fully
 * reclaims when it exits, keeping the broker bounded.
 *
 * Design (see rubber-duck critique 2026-06-02):
 *  - One worker at a time, single-flight spawn (`startPromise`).
 *  - Requests are split into bounded sub-batches and dispatched one at a
 *    time (FIFO) so a giant reindex batch can't wedge the channel.
 *  - Startup + per-request timeouts; on timeout or worker exit, every
 *    in-flight/queued request is rejected (callers degrade to keyword search
 *    or mark the reindex failed — never crash the broker).
 *  - Idle TTL: after the queue drains the worker is killed so the 1.3 GB is
 *    released; the next request transparently respawns it.
 *  - The worker transport is dependency-injected (`spawnWorker`) so unit
 *    tests drive a fake worker and never touch the native model.
 */

import { EMBEDDING_DIMENSIONS } from './db.js'
import {
  type WorkerInbound,
  type WorkerOutbound,
} from './embedding-protocol.js'

/** Handle to a single worker child, abstracted for testability. */
export interface WorkerHandle {
  send(msg: WorkerInbound): void
  onMessage(cb: (msg: WorkerOutbound) => void): void
  onExit(cb: (code: number | null) => void): void
  kill(): void
}

export type EmbeddingClientState = 'idle' | 'starting' | 'ready'

export interface EmbeddingClientOptions {
  /** Spawn a fresh worker child. Injected so tests use a fake transport. */
  readonly spawnWorker: () => WorkerHandle
  /** Expected vector length; mismatches reject the request. */
  readonly dimensions?: number
  /** Max texts per worker request. Default 32. */
  readonly subBatchSize?: number
  /** Reject startup if the worker doesn't signal `ready` in time. Default 30s. */
  readonly startupTimeoutMs?: number
  /** Reject a request if the worker doesn't answer in time. Default 120s. */
  readonly requestTimeoutMs?: number
  /** Kill the idle worker after this long with an empty queue. 0 disables. Default 90s. */
  readonly idleMs?: number
}

export interface EmbeddingClient {
  /** Embed texts, transparently spawning/reusing the worker. */
  embed(texts: readonly string[]): Promise<Float32Array[]>
  /** Current lifecycle state (mostly for tests/health). */
  state(): EmbeddingClientState
  /** Whether a worker is currently alive. */
  isWorkerAlive(): boolean
  /** Idempotently kill the worker and reject anything in flight. */
  shutdown(): void
}

interface PendingRequest {
  readonly id: number
  readonly texts: readonly string[]
  resolve(vectors: readonly (readonly number[])[]): void
  reject(err: Error): void
}

const DEFAULT_SUB_BATCH = 32
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000
const DEFAULT_IDLE_MS = 90_000

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size))
  }
  return out
}

export function createEmbeddingClient(options: EmbeddingClientOptions): EmbeddingClient {
  const dimensions = options.dimensions ?? EMBEDDING_DIMENSIONS
  const subBatchSize = Math.max(1, options.subBatchSize ?? DEFAULT_SUB_BATCH)
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS

  let worker: WorkerHandle | null = null
  let state: EmbeddingClientState = 'idle'
  let startPromise: Promise<void> | null = null
  let resolveStart: (() => void) | null = null
  let rejectStart: ((err: Error) => void) | null = null
  let startupTimer: ReturnType<typeof setTimeout> | null = null
  let idleTimer: ReturnType<typeof setTimeout> | null = null

  let nextId = 1
  const queue: PendingRequest[] = []
  let inFlight: { req: PendingRequest; timer: ReturnType<typeof setTimeout> } | null = null

  function clearIdleTimer(): void {
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }

  function armIdleTimer(): void {
    clearIdleTimer()
    if (idleMs > 0 && state === 'ready' && !inFlight && queue.length === 0) {
      idleTimer = setTimeout(() => {
        idleTimer = null
        // Graceful shutdown of an idle worker: nothing is pending, so we
        // just drop it and let the next request respawn.
        teardown(null)
      }, idleMs)
    }
  }

  /**
   * Tear the worker down. When `err` is non-null every in-flight and queued
   * request is rejected with it (failure path). When `err` is null it is a
   * clean idle shutdown and there is nothing pending to reject.
   */
  function teardown(err: Error | null): void {
    if (startupTimer) {
      clearTimeout(startupTimer)
      startupTimer = null
    }
    clearIdleTimer()

    const current = worker
    worker = null
    state = 'idle'
    startPromise = null

    if (inFlight) {
      clearTimeout(inFlight.timer)
      const { req } = inFlight
      inFlight = null
      if (err) req.reject(err)
    }
    if (err) {
      while (queue.length > 0) {
        queue.shift()!.reject(err)
      }
    }

    if (rejectStart && err) rejectStart(err)
    resolveStart = null
    rejectStart = null

    if (current) {
      try {
        current.kill()
      } catch {
        // best-effort
      }
    }
  }

  function handleMessage(msg: WorkerOutbound): void {
    if (msg.kind === 'ready') {
      if (startupTimer) {
        clearTimeout(startupTimer)
        startupTimer = null
      }
      state = 'ready'
      const r = resolveStart
      resolveStart = null
      rejectStart = null
      if (r) r()
      pump()
      return
    }

    // result | error must match the in-flight request id.
    if (!inFlight || inFlight.req.id !== msg.id) {
      // Stale or unknown id (e.g. answer after a timeout). Ignore.
      return
    }
    clearTimeout(inFlight.timer)
    const { req } = inFlight
    inFlight = null

    if (msg.kind === 'error') {
      req.reject(new Error(msg.message))
    } else {
      req.resolve(msg.vectors)
    }
    pump()
  }

  function handleExit(code: number | null): void {
    // Unexpected exit while we believed the worker was usable.
    if (worker === null && state === 'idle' && !inFlight && startPromise === null) {
      return // already torn down
    }
    teardown(new Error(`embedding worker exited (code ${code ?? 'null'})`))
  }

  function ensureStarted(): Promise<void> {
    if (state === 'ready') return Promise.resolve()
    if (startPromise) return startPromise

    state = 'starting'
    startPromise = new Promise<void>((resolve, reject) => {
      resolveStart = resolve
      rejectStart = reject
    })
    // The start promise is an internal gate; real errors are surfaced to
    // callers through the per-request queue rejections. Attach a no-op
    // handler so a startup failure can never become an unhandled rejection.
    startPromise.catch(() => {})

    try {
      worker = options.spawnWorker()
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      // spawn threw synchronously: teardown rejects the queued requests and
      // the start promise so callers (Promise.all below) don't hang.
      const pending = startPromise
      teardown(e)
      return pending ?? Promise.reject(e)
    }

    worker.onMessage(handleMessage)
    worker.onExit(handleExit)

    startupTimer = setTimeout(() => {
      startupTimer = null
      teardown(new Error('embedding worker startup timed out'))
    }, startupTimeoutMs)

    return startPromise
  }

  function pump(): void {
    if (state !== 'ready' || inFlight || queue.length === 0) {
      armIdleTimer()
      return
    }
    clearIdleTimer()
    const req = queue.shift()!
    const timer = setTimeout(() => {
      teardown(new Error('embedding request timed out'))
    }, requestTimeoutMs)
    inFlight = { req, timer }
    try {
      worker!.send({ kind: 'embed', id: req.id, texts: req.texts })
    } catch (err) {
      teardown(err instanceof Error ? err : new Error(String(err)))
    }
  }

  function enqueue(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    return new Promise((resolve, reject) => {
      queue.push({ id: nextId++, texts, resolve, reject })
    })
  }

  async function embed(texts: readonly string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return []

    const subBatches = chunk(texts, subBatchSize)
    const pending = subBatches.map((sb) => enqueue(sb))

    // Kick the worker. If startup fails, teardown() rejects the queued
    // requests, so the awaited Promise.all below surfaces the error.
    ensureStarted()
      .then(() => pump())
      .catch(() => {
        /* rejection already propagated through teardown() */
      })

    const parts = await Promise.all(pending)

    const out: Float32Array[] = []
    for (const part of parts) {
      for (const vec of part) {
        if (vec.length !== dimensions) {
          throw new Error(
            `embedding worker returned ${vec.length} dimensions, expected ${dimensions}`,
          )
        }
        out.push(Float32Array.from(vec))
      }
    }
    return out
  }

  return {
    embed,
    state: () => state,
    isWorkerAlive: () => worker !== null,
    shutdown: () => teardown(new Error('embedding client shut down')),
  }
}
