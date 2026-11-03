import type Database from 'better-sqlite3'
import {
  generateEmbedding,
  serializeEmbedding,
  deserializeEmbedding,
  cosineSimilarity,
  isEmbeddingAvailable,
} from './embeddings.js'
import {
  createEmbedding,
  findAllEmbeddings,
  findEmbeddingBySessionId,
  deleteEmbedding,
} from './storage/repositories/embedding-repository.js'
import { findSessionById } from './storage/repositories/session-repository.js'
import type { SessionSearchResult } from './types.js'

export interface IndexSessionOptions {
  readonly forceReindex?: boolean
}

/**
 * Index a session by generating an embedding for its purpose.
 * Called on session registration and purpose updates.
 *
 * @param db - Database connection
 * @param sessionId - Session to index
 * @param options - Optional indexing options
 * @returns true if indexed, false if skipped (no API key or already indexed)
 */
export async function indexSession(
  db: Database.Database,
  sessionId: string,
  options: IndexSessionOptions = {}
): Promise<boolean> {
  if (!isEmbeddingAvailable()) {
    return false
  }

  const session = findSessionById(db, sessionId)
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`)
  }

  const existingEmbedding = findEmbeddingBySessionId(db, sessionId)
  if (existingEmbedding && !options.forceReindex) {
    if (existingEmbedding.purpose_text === session.purpose) {
      return false
    }
  }

  const result = await generateEmbedding(session.purpose)

  createEmbedding(db, {
    session_id: sessionId,
    purpose_text: session.purpose,
    embedding: serializeEmbedding(result.embedding),
    model: result.model,
    dimensions: result.dimensions,
  })

  return true
}

/**
 * Remove a session's embedding from the index.
 * Called when a session is deregistered.
 *
 * @param db - Database connection
 * @param sessionId - Session to remove from index
 * @returns true if removed, false if not found
 */
export function removeSessionFromIndex(
  db: Database.Database,
  sessionId: string
): boolean {
  return deleteEmbedding(db, sessionId)
}

/**
 * Search for sessions similar to the given query text.
 *
 * @param db - Database connection
 * @param query - Search query text
 * @param topK - Maximum number of results to return
 * @param minSimilarity - Minimum similarity threshold (0-1)
 * @returns Array of sessions ranked by similarity
 */
export async function searchSessions(
  db: Database.Database,
  query: string,
  topK: number = 5,
  minSimilarity: number = 0.3
): Promise<ReadonlyArray<SessionSearchResult>> {
  if (!isEmbeddingAvailable()) {
    return []
  }

  const queryResult = await generateEmbedding(query)
  const queryVector = queryResult.embedding

  const allEmbeddings = findAllEmbeddings(db)

  const results: Array<{ sessionId: string; similarity: number }> = []

  for (const embedding of allEmbeddings) {
    const vector = deserializeEmbedding(embedding.embedding)
    const similarity = cosineSimilarity(queryVector, vector)

    if (similarity >= minSimilarity) {
      results.push({
        sessionId: embedding.session_id,
        similarity,
      })
    }
  }

  results.sort((a, b) => b.similarity - a.similarity)
  const topResults = results.slice(0, topK)

  const searchResults: SessionSearchResult[] = []
  for (const result of topResults) {
    const session = findSessionById(db, result.sessionId)
    if (session) {
      searchResults.push({
        session_id: session.id,
        purpose: session.purpose,
        working_dir: session.working_dir,
        status: session.status,
        similarity: result.similarity,
      })
    }
  }

  return searchResults
}

/**
 * Get indexing statistics.
 */
export function getIndexStats(db: Database.Database): {
  totalIndexed: number
  embeddingAvailable: boolean
} {
  const allEmbeddings = findAllEmbeddings(db)
  return {
    totalIndexed: allEmbeddings.length,
    embeddingAvailable: isEmbeddingAvailable(),
  }
}
