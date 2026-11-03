/**
 * Embedding facade — local ONNX embeddings (BGE-small-en-v1.5, 384-dim).
 *
 * Embedding generation runs in a **disposable child process**
 * (`embedding-worker`), NOT in the broker. The `fastembed`/`onnxruntime`
 * native runtime has a ~1.3 GB mmap-arena footprint that
 * `InferenceSession.release()` does not reclaim (measured 2026-06-02), so
 * keeping it in the long-lived broker made RSS ratchet to >1.5 GB. Isolating
 * it in a child that idle-exits lets the OS reclaim the arena and keeps the
 * broker bounded (~180 MB). See `embedding-client.ts` for the lifecycle.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { EMBEDDING_DIMENSIONS } from './db.js'
import {
  createEmbeddingClient,
  type EmbeddingClient,
  type WorkerHandle,
} from './embedding-client.js'
import { isWorkerOutbound } from './embedding-protocol.js'

export interface EmbeddingResult {
  readonly embedding: Float32Array
  readonly dimensions: number
}

export type EmbeddingStatus = 'pending' | 'ready' | 'failed'

let client: EmbeddingClient | null = null
let embeddingStatus: EmbeddingStatus = 'pending'

/**
 * OPT-IN, default-OFF, process-local content-keyed embedding memo (enable with `SCNS_EMBED_MEMO=1`).
 * PROD behavior is byte-identical when unset — the map is only consulted/populated when the flag is
 * on. Embeddings are a pure function of their input text (deterministic BGE), so returning a cached
 * vector for an identical string cannot change any result; the memo only avoids RECOMPUTING it.
 * Added for the WS-2d LoCoMo ruler, where the same query is embedded ~10× (per graph config ×
 * substrate) and the worker caps at ~10 texts/s — without memoization a 10-conversation ×2 benchmark
 * is impractical. Left OFF in prod (the broker must stay memory-bounded); the harness turns it on. */
const embedMemo = new Map<string, EmbeddingResult>()
function memoEnabled(): boolean {
  return process.env.SCNS_EMBED_MEMO === '1'
}

/** Returns the current embedding availability status. */
export function getEmbeddingStatus(): EmbeddingStatus {
  return embeddingStatus
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/**
 * Resolve the embedding-worker entry to spawn.
 *
 * Production: the compiled `embedding-worker.js` sits next to this module in `dist/`.
 * `SCNS_EMBED_WORKER_PATH` overrides it — used by the test harness to point at a compiled
 * worker (vitest transpiles TS in-memory, but the worker is a raw Node process that needs a real
 * file on disk), and by deployments with non-standard layouts. A missing/garbage override falls
 * back to the default so a bad env can never break production embedding.
 */
function resolveWorkerPath(): string {
  const override = process.env.SCNS_EMBED_WORKER_PATH
  if (override && existsSync(override)) return override
  return fileURLToPath(new URL('./embedding-worker.js', import.meta.url))
}

/**
 * The exec flags handed to the embedding worker.
 *
 * `fork()` supplied `process.execArgv` automatically and spliced out `-e`/`--eval`
 * so the child could never re-execute the parent's inline script instead of the
 * worker. `spawn` does neither, so that splice is reproduced here — including the
 * VALUE of the space-separated form, which must not be left behind where it would
 * be mistaken for the script path.
 *
 * Nothing else is filtered, deliberately. `fork()` does NOT special-case inspector
 * ports: measured 2026-09-28, a child inheriting `--inspect=9230` logs "Starting
 * inspector on 127.0.0.1:9230 failed: address already in use" and then runs
 * normally (exit 0, IPC intact). Dropping `--inspect*` would therefore be a
 * behaviour CHANGE rather than parity — and dropping a space-separated flag
 * without its value corrupted argv outright, killing the worker with
 * `Cannot find module '<cwd>\9231'`. See worker-exec-argv.test.ts.
 */
export function workerExecArgv(argv: readonly string[] = process.execArgv): readonly string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '-e' || arg === '--eval') {
      i++
      continue
    }
    if (arg.startsWith('--eval=') || arg.startsWith('-e=')) continue
    out.push(arg)
  }
  return out
}

/** Spawn the disposable embedding worker child and adapt it to a WorkerHandle. */
function spawnRealWorker(): WorkerHandle {
  const workerPath = resolveWorkerPath()
  // `spawn` with an explicit 'ipc' stdio slot, NOT `fork`: `ForkOptions` has no
  // `windowsHide`, and the broker is started `detached` (watchdog-runtime.ts), so
  // it owns no console — Windows ignores CREATE_NO_WINDOW when combined with
  // DETACHED_PROCESS. A forked child of a console-less parent therefore allocates
  // a brand-new VISIBLE console (Windows 11 delegates it to Windows Terminal).
  // Measured 2026-09-25 with the parent detached: fork → new console host 3/3,
  // this form → 0/3. The 'ipc' slot gives the same channel `fork` provided.
  const child = spawn(process.execPath, [...workerExecArgv(), workerPath], {
    // Reserve the IPC channel for the protocol; route worker stderr to the
    // broker's stderr for diagnostics; never use stdout for protocol.
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    windowsHide: true,
  })
  return {
    send: (msg) => {
      child.send(msg)
    },
    onMessage: (cb) => {
      child.on('message', (m) => {
        if (isWorkerOutbound(m)) cb(m)
      })
    },
    onExit: (cb) => {
      child.on('exit', (code) => cb(code))
      child.on('error', () => cb(null))
    },
    kill: () => {
      try {
        child.kill()
      } catch {
        // best-effort
      }
    },
  }
}

function getClient(): EmbeddingClient {
  if (!client) {
    client = createEmbeddingClient({
      spawnWorker: spawnRealWorker,
      dimensions: EMBEDDING_DIMENSIONS,
      subBatchSize: envInt('SCNS_EMBED_SUB_BATCH', 32),
      startupTimeoutMs: envInt('SCNS_EMBED_STARTUP_TIMEOUT_MS', 30_000),
      requestTimeoutMs: envInt('SCNS_EMBED_REQUEST_TIMEOUT_MS', 120_000),
      idleMs: envInt('SCNS_EMBED_IDLE_MS', 90_000),
    })
  }
  return client
}

/** Generate an embedding for a single text. */
export async function generateEmbedding(text: string): Promise<EmbeddingResult> {
  const memo = memoEnabled()
  if (memo) {
    const hit = embedMemo.get(text)
    if (hit) return hit
  }
  try {
    const vectors = await getClient().embed([text])
    const embedding = vectors[0]
    if (!embedding) {
      throw new Error('embedding worker returned no vector')
    }
    embeddingStatus = 'ready'
    const result = { embedding, dimensions: embedding.length }
    if (memo) embedMemo.set(text, result)
    return result
  } catch (err) {
    embeddingStatus = 'failed'
    throw err
  }
}

/** Generate embeddings for multiple texts. */
export async function generateEmbeddingsBatch(
  texts: readonly string[],
): Promise<readonly EmbeddingResult[]> {
  if (texts.length === 0) return []
  const memo = memoEnabled()
  if (!memo) {
    try {
      const vectors = await getClient().embed(texts)
      embeddingStatus = 'ready'
      return vectors.map((embedding) => ({ embedding, dimensions: embedding.length }))
    } catch (err) {
      embeddingStatus = 'failed'
      throw err
    }
  }
  // Memoized path: embed only the cache-miss texts, then reassemble in original order.
  const out = new Array<EmbeddingResult | undefined>(texts.length)
  const missIdx: number[] = []
  const missTexts: string[] = []
  for (let i = 0; i < texts.length; i++) {
    const hit = embedMemo.get(texts[i]!)
    if (hit) out[i] = hit
    else {
      missIdx.push(i)
      missTexts.push(texts[i]!)
    }
  }
  if (missTexts.length > 0) {
    try {
      const vectors = await getClient().embed(missTexts)
      embeddingStatus = 'ready'
      for (let j = 0; j < missIdx.length; j++) {
        const embedding = vectors[j]!
        const result = { embedding, dimensions: embedding.length }
        embedMemo.set(missTexts[j]!, result)
        out[missIdx[j]!] = result
      }
    } catch (err) {
      embeddingStatus = 'failed'
      throw err
    }
  }
  return out as EmbeddingResult[]
}

/** Serialize Float32Array to Buffer for SQLite BLOB storage */
export function serializeEmbedding(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength)
}

/** Deserialize SQLite BLOB Buffer to Float32Array */
export function deserializeEmbedding(buffer: Buffer): Float32Array {
  const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  return new Float32Array(ab)
}

/**
 * Shut down the embedding worker child (idempotent).
 *
 * Kills the worker child, reclaiming its ~1.3 GB native arena immediately
 * rather than waiting for the idle timeout. Safe to call after a reindex
 * batch and as a shutdown-manager cleanup step. The next embedding call
 * transparently respawns a fresh worker.
 */
export async function resetEmbeddingClient(): Promise<void> {
  if (client) {
    client.shutdown()
    client = null
  }
  embedMemo.clear()
  embeddingStatus = 'pending'
}
