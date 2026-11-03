/**
 * Semantic-relevance scoring — rank a set of candidate chunks by their QUERY relevance using
 * the stored embeddings (design-m1.md §5, semantic tier hardening).
 *
 * The 2-hop semantic augmentation ({@link ../intent-search.ts augmentWithSemanticTwoHop})
 * reaches associatively-related chunks the hybrid query misses, but it ORDERS them by edge
 * weight (similarity to the bridge chunk), which is NOT the same as similarity to the QUERY —
 * so the strongest-edge candidate can be the least query-relevant one. This module supplies the
 * missing signal: cosine(query, candidate) computed from the query embedding and each
 * candidate's ALREADY-STORED `chunk_embeddings` vector. The query is embedded once; the
 * candidate vectors are read from disk (no re-embedding), so it is cheap when the worker is warm.
 *
 * Embedding-dependent by design, so it lives OUTSIDE the deterministic, embedding-free intent
 * router and is INJECTED as an optional scorer — the router falls back to edge-weight order when
 * no scorer is supplied (CI / keyword-only paths), keeping it deterministic and never worse.
 */

import type Database from 'better-sqlite3'
import { generateEmbedding, deserializeEmbedding } from './embeddings.js'

/**
 * Cosine similarity of two equal-length vectors. Returns 0 if either vector is zero-length or
 * has zero magnitude (so a missing/degenerate embedding never poisons a ranking).
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!
    const y = b[i]!
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/**
 * Score each candidate chunk by cosine similarity to `query`, using the query's freshly-computed
 * embedding and the candidates' STORED `chunk_embeddings` vectors. Returns a Map chunkId → cosine
 * (only for candidates that have a stored embedding; ids without one are omitted). Returns an
 * empty Map for an empty candidate set WITHOUT embedding the query (so a no-op costs nothing).
 *
 * Throws only if the query embedding itself fails (cold worker) — callers that must never break
 * search should wrap this and fall back to the edge-weight order.
 */
export async function scoreSemanticRelevance(
  db: Database.Database,
  query: string,
  candidateChunkIds: readonly number[],
): Promise<Map<number, number>> {
  if (candidateChunkIds.length === 0) return new Map()
  const queryVec = (await generateEmbedding(query)).embedding
  return scoreAgainstVector(db, queryVec, candidateChunkIds)
}

/**
 * Score candidates against an ALREADY-COMPUTED query vector. Split out so a query-bound scorer can
 * embed its query once and reuse the vector across calls (see {@link makeSemanticRelevanceScorer}).
 */
function scoreAgainstVector(
  db: Database.Database,
  queryVec: Float32Array,
  candidateChunkIds: readonly number[],
): Map<number, number> {
  const scores = new Map<number, number>()
  const getEmbedding = db.prepare('SELECT embedding FROM chunk_embeddings WHERE chunk_id = ?')

  for (const id of candidateChunkIds) {
    const row = getEmbedding.get(id) as { embedding: Buffer } | undefined
    if (!row?.embedding) continue
    scores.set(id, cosineSimilarity(queryVec, deserializeEmbedding(row.embedding)))
  }
  return scores
}

/** A query-bound relevance scorer the intent router can inject (see `IntentSearchOptions`). */
export type SemanticRelevanceScorer = (
  candidateChunkIds: readonly number[],
) => Promise<Map<number, number>> | Map<number, number>

/**
 * Build a query-bound {@link SemanticRelevanceScorer} over `db` for `query`. Convenience for
 * the CLI adapter, which knows the query at search time and injects this into the router.
 *
 * The query is embedded AT MOST ONCE per scorer, and the vector is reused for every subsequent call.
 * A scorer is bound to a single query string and a retrieval issues many scoring calls (one per
 * traversal stage, and multi-hop multiplies that by its rounds), so the previous embed-per-call cost a
 * full embedding-worker IPC roundtrip each time to recompute an IDENTICAL vector. The process-wide
 * content-keyed memo in `embeddings.ts` does not cover this: it is opt-in and deliberately OFF in prod
 * so the broker stays memory-bounded. MEASURED on the live briefing path (the broker's own
 * `stage_timings`, isolated broker + copy of the production vault): `semanticMs` was 92-96% of TOTAL
 * retrieval latency on BOTH arms and scaled linearly with `semanticCalls` — magma 4-6 calls / 751ms,
 * multihop-iter 15-23 calls / 1931ms.
 *
 * Safe by construction: BGE embedding is deterministic, so reusing the vector for the same string
 * cannot change a ranking — it only stops recomputing it. Scope is ONE request (not a global cache),
 * and a FAILED embed is never cached, so a cold-worker error retries on the next call instead of
 * poisoning the scorer.
 */
export function makeSemanticRelevanceScorer(
  db: Database.Database,
  query: string,
): SemanticRelevanceScorer {
  let pending: Promise<Float32Array> | null = null
  return async (candidateChunkIds: readonly number[]) => {
    if (candidateChunkIds.length === 0) return new Map<number, number>()
    if (pending === null) {
      pending = generateEmbedding(query).then(
        (r) => r.embedding,
        (err: unknown) => {
          pending = null // never cache a failure — the next call retries a cold worker
          throw err
        },
      )
    }
    return scoreAgainstVector(db, await pending, candidateChunkIds)
  }
}
