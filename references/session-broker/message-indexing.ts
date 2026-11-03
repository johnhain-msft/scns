import type Database from 'better-sqlite3'
import {
  generateEmbedding,
  serializeEmbedding,
  deserializeEmbedding,
  cosineSimilarity,
  isEmbeddingAvailable,
} from './embeddings.js'
import {
  createMessageEmbedding,
  findAllMessageEmbeddings,
} from './storage/repositories/message-embedding-repository.js'
import { findMessageById } from './storage/repositories/message-repository.js'
import type { MessageSearchResult } from './types.js'

export interface SearchMessagesOptions {
  readonly session_id?: string
  readonly top_k?: number
  readonly min_similarity?: number
}

/**
 * Index a message by generating an embedding for its content.
 * Called after message creation for semantic search.
 *
 * @param db - Database connection
 * @param messageId - Message to index
 * @returns true if indexed, false if embeddings unavailable
 */
export async function indexMessage(
  db: Database.Database,
  messageId: string,
): Promise<boolean> {
  if (!isEmbeddingAvailable()) {
    return false
  }

  const message = findMessageById(db, messageId)
  if (!message) {
    throw new Error(`Message not found: ${messageId}`)
  }

  const result = await generateEmbedding(message.content)

  createMessageEmbedding(db, {
    message_id: messageId,
    content_text: message.content,
    embedding: serializeEmbedding(result.embedding),
    model: result.model,
    dimensions: result.dimensions,
  })

  return true
}

/**
 * Search messages by semantic similarity to a query.
 *
 * @param db - Database connection
 * @param query - Search query text
 * @param options - Search options (session_id filter, top_k, min_similarity)
 * @returns Array of messages ranked by similarity
 */
export async function searchMessages(
  db: Database.Database,
  query: string,
  options: SearchMessagesOptions = {},
): Promise<ReadonlyArray<MessageSearchResult>> {
  if (!isEmbeddingAvailable()) {
    return []
  }

  const topK = options.top_k ?? 10
  const minSimilarity = options.min_similarity ?? 0.3

  const queryResult = await generateEmbedding(query)
  const queryVector = queryResult.embedding

  const allEmbeddings = findAllMessageEmbeddings(db)

  const results: Array<{ messageId: string; similarity: number }> = []

  for (const embedding of allEmbeddings) {
    const vector = deserializeEmbedding(embedding.embedding)
    const similarity = cosineSimilarity(queryVector, vector)

    if (similarity >= minSimilarity) {
      results.push({
        messageId: embedding.message_id,
        similarity,
      })
    }
  }

  results.sort((a, b) => b.similarity - a.similarity)
  const topResults = results.slice(0, topK)

  const searchResults: MessageSearchResult[] = []
  for (const result of topResults) {
    const message = findMessageById(db, result.messageId)
    if (message) {
      // Apply session_id filter: match if sender or receiver
      if (
        options.session_id &&
        message.sender_id !== options.session_id &&
        message.receiver_id !== options.session_id
      ) {
        continue
      }

      searchResults.push({
        message_id: message.id,
        sender_id: message.sender_id,
        receiver_id: message.receiver_id ?? null,
        content: message.content,
        similarity: result.similarity,
        created_at: message.created_at,
      })
    }
  }

  return searchResults
}
