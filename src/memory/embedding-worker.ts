/**
 * Disposable embedding worker child process.
 *
 * Spawned by the broker-side embedding client via `child_process.spawn` with an
 * explicit `'ipc'` stdio slot (NOT `fork` — see `embeddings.ts` for why). Loads
 * `fastembed`/`onnxruntime` ONCE (the ~1.3 GB native footprint lives HERE, not
 * in the broker), answers embed requests over Node IPC, and exits after an
 * idle period or when the parent disconnects — at which point the OS reclaims
 * the entire native arena.
 *
 * The message-handling loop is factored into `createWorkerLoop` with injected
 * transport + embedder so it is unit-testable without the native model. The
 * `runWorkerMain` entry wires the real fastembed batcher and `process` IPC.
 */

import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'
import { type WorkerInbound, type WorkerOutbound } from './embedding-protocol.js'

export interface WorkerLoopDeps {
  /** Embed a batch of texts -> one vector per text. */
  readonly embedBatch: (texts: readonly string[]) => Promise<number[][]>
  /** Send a message to the parent. */
  readonly send: (msg: WorkerOutbound) => void
  /** Register the inbound message handler. */
  readonly onMessage: (cb: (msg: WorkerInbound) => void) => void
  /** Exit the process. */
  readonly exit: (code: number) => void
  /** Self-terminate after this long without a message. 0 disables. */
  readonly idleMs: number
  /** Emit a `ready` message immediately. Default true. */
  readonly signalReady?: boolean
}

export interface WorkerLoop {
  stop(): void
}

/**
 * Wire the request/response loop. Each `embed` request is answered with a
 * `result` (or `error`) carrying the same `id`. An idle timer self-terminates
 * the process so the native arena is reclaimed when no longer in use.
 */
export function createWorkerLoop(deps: WorkerLoopDeps): WorkerLoop {
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  function clearIdle(): void {
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }

  function armIdle(): void {
    clearIdle()
    if (deps.idleMs > 0 && !stopped) {
      idleTimer = setTimeout(() => {
        idleTimer = null
        deps.exit(0)
      }, deps.idleMs)
    }
  }

  deps.onMessage((msg) => {
    if (stopped || msg.kind !== 'embed') return
    clearIdle()
    void (async () => {
      try {
        const vectors = await deps.embedBatch(msg.texts)
        deps.send({ kind: 'result', id: msg.id, vectors })
      } catch (err) {
        deps.send({
          kind: 'error',
          id: msg.id,
          message: err instanceof Error ? err.message : String(err),
        })
      } finally {
        armIdle()
      }
    })()
  })

  armIdle()
  if (deps.signalReady !== false) deps.send({ kind: 'ready' })

  return {
    stop: () => {
      stopped = true
      clearIdle()
    },
  }
}

function parseEnvInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

const MODEL_NAME = 'fast-bge-small-en-v1.5'
const FASTEMBED_BATCH_SIZE = 32

/**
 * Absolute on-disk location of the fastembed model cache.
 *
 * fastembed defaults `cacheDir` to the relative path `local_cache`, which
 * resolves against `process.cwd()`. That silently breaks any process started
 * from a different directory: the meta-broker runs children from `dist/`, so
 * they looked for `dist/local_cache`, missed the package-root cache, and
 * re-downloaded the model — a truncated download then left the cache without
 * `tokenizer.json`, permanently failing every embed with a non-zero exit.
 *
 * Resolving from `import.meta.url` instead makes the lookup CWD-independent
 * and lands on the same `<package-root>/local_cache` from both `src/memory`
 * (tests) and `dist/memory` (production). `SCNS_EMBED_CACHE_DIR` overrides it
 * for deployments with a non-standard layout.
 */
function resolveModelCacheDir(): string {
  const override = process.env.SCNS_EMBED_CACHE_DIR
  if (override) return override
  return fileURLToPath(new URL('../../local_cache', import.meta.url))
}

/**
 * Build the real fastembed-backed batcher. Isolated so the native module is
 * only imported inside the worker process.
 */
async function createFastembedBatcher(): Promise<
  (texts: readonly string[]) => Promise<number[][]>
> {
  const mod = await import('fastembed')
  const embedder = await (
    mod as unknown as {
      FlagEmbedding: {
        init(opts: { model: string; cacheDir: string }): Promise<{
          embed(texts: string[], batchSize: number): AsyncIterable<number[][]>
        }>
      }
    }
  ).FlagEmbedding.init({ model: MODEL_NAME, cacheDir: resolveModelCacheDir() })

  return async (texts: readonly string[]): Promise<number[][]> => {
    const out: number[][] = []
    for await (const batch of embedder.embed([...texts], FASTEMBED_BATCH_SIZE)) {
      // fastembed yields Float32Array rows; convert to plain arrays so they
      // survive Node's default JSON IPC serialization (typed arrays would
      // otherwise arrive as `{0:..,1:..}` objects with no `.length`).
      for (const vec of batch) out.push(Array.from(vec as ArrayLike<number>))
    }
    return out
  }
}

/** Real worker entry: load the model, then serve requests over IPC. */
export async function runWorkerMain(): Promise<void> {
  const idleMs = parseEnvInt('SCNS_EMBED_WORKER_IDLE_MS', 120_000)

  let batcher: (texts: readonly string[]) => Promise<number[][]>
  try {
    batcher = await createFastembedBatcher()
  } catch (err) {
    // Could not load the model — exit non-zero so the client rejects the
    // request and degrades (e.g. to keyword-only search).
    process.stderr.write(
      `embedding-worker: failed to load model: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    )
    process.exit(1)
    return
  }

  createWorkerLoop({
    embedBatch: batcher,
    send: (msg) => {
      process.send?.(msg)
    },
    onMessage: (cb) => {
      process.on('message', (m) => cb(m as WorkerInbound))
    },
    exit: (code) => process.exit(code),
    idleMs,
    signalReady: true,
  })

  // Parent went away — reclaim immediately.
  process.on('disconnect', () => process.exit(0))
}

/** True when this module is the process entry point (the spawned worker child). */
function isMainEntry(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return import.meta.url === pathToFileURL(entry).href
  } catch {
    return false
  }
}

if (isMainEntry()) {
  // Surface the resolved path for diagnostics; harmless in the parent because
  // this branch only runs in the spawned worker child.
  void fileURLToPath(import.meta.url)
  void runWorkerMain()
}
