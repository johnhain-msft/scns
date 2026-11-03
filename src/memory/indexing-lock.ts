/**
 * Indexing mutex — serializes all vault-indexing / embedding-backfill passes
 * across the process so the ONNX runtime never runs concurrent batches from
 * different call sites (backfill runner + scheduled memory-reindex).
 *
 * Phase 13.9.4: rubber-duck identified concurrent indexing as a likely source
 * of post-backfill CPU churn.
 */

let queue: Promise<unknown> = Promise.resolve()

/**
 * Run fn exclusively — queued behind any other withIndexingLock caller.
 * If another call is in-flight, awaits it before starting.
 */
export function withIndexingLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(() => fn())
  queue = next.catch(() => undefined)
  return next
}
