/**
 * Wire protocol between the broker-side embedding client and the disposable
 * embedding worker child process.
 *
 * Messages travel over Node's structured-clone IPC channel
 * (`child.send` / `process.send`), so they are plain JSON-serialisable
 * objects. Every request carries a numeric `id`; the worker echoes that `id`
 * back on the matching `result`/`error` so the client can correlate
 * concurrent in-flight requests.
 */

/** Client -> worker: embed a sub-batch of texts. */
export interface WorkerEmbedRequest {
  readonly kind: 'embed'
  readonly id: number
  readonly texts: readonly string[]
}

export type WorkerInbound = WorkerEmbedRequest

/** Worker -> client: the worker has finished loading the model and is ready. */
export interface WorkerReady {
  readonly kind: 'ready'
}

/** Worker -> client: embeddings for the request with the matching `id`. */
export interface WorkerResult {
  readonly kind: 'result'
  readonly id: number
  readonly vectors: readonly (readonly number[])[]
}

/** Worker -> client: the request with the matching `id` failed. */
export interface WorkerError {
  readonly kind: 'error'
  readonly id: number
  readonly message: string
}

export type WorkerOutbound = WorkerReady | WorkerResult | WorkerError

/** Type guard for outbound worker messages received over IPC. */
export function isWorkerOutbound(value: unknown): value is WorkerOutbound {
  if (value === null || typeof value !== 'object') return false
  const kind = (value as { kind?: unknown }).kind
  return kind === 'ready' || kind === 'result' || kind === 'error'
}

/** Type guard for inbound worker messages received over IPC. */
export function isWorkerInbound(value: unknown): value is WorkerInbound {
  if (value === null || typeof value !== 'object') return false
  return (value as { kind?: unknown }).kind === 'embed'
}
