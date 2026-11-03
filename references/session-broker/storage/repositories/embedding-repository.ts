import type Database from 'better-sqlite3'
import type { SessionEmbedding } from '../../types.js'

interface CreateEmbeddingInput {
  readonly session_id: string
  readonly purpose_text: string
  readonly embedding: Buffer
  readonly model: string
  readonly dimensions: number
}

export function createEmbedding(
  db: Database.Database,
  input: CreateEmbeddingInput
): SessionEmbedding {
  db.prepare(
    `INSERT INTO session_embeddings (session_id, purpose_text, embedding, model, dimensions)
     VALUES (@session_id, @purpose_text, @embedding, @model, @dimensions)
     ON CONFLICT(session_id) DO UPDATE SET
       purpose_text = @purpose_text,
       embedding = @embedding,
       model = @model,
       dimensions = @dimensions,
       updated_at = datetime('now')`
  ).run(input)

  return findEmbeddingBySessionId(db, input.session_id)!
}

export function findEmbeddingBySessionId(
  db: Database.Database,
  sessionId: string
): SessionEmbedding | null {
  const row = db
    .prepare('SELECT * FROM session_embeddings WHERE session_id = ?')
    .get(sessionId) as SessionEmbedding | undefined
  return row ? { ...row } : null
}

export function findAllEmbeddings(
  db: Database.Database
): ReadonlyArray<SessionEmbedding> {
  const rows = db
    .prepare('SELECT * FROM session_embeddings ORDER BY created_at')
    .all() as SessionEmbedding[]
  return rows.map((row) => ({ ...row }))
}

export function deleteEmbedding(
  db: Database.Database,
  sessionId: string
): boolean {
  const result = db
    .prepare('DELETE FROM session_embeddings WHERE session_id = ?')
    .run(sessionId)
  return result.changes > 0
}

export function countEmbeddings(db: Database.Database): number {
  const row = db
    .prepare('SELECT COUNT(*) as count FROM session_embeddings')
    .get() as { count: number }
  return row.count
}
