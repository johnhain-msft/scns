import type Database from 'better-sqlite3'

interface MessageEmbeddingRow {
  readonly message_id: string
  readonly content_text: string
  readonly embedding: Buffer
  readonly model: string
  readonly dimensions: number
  readonly created_at?: string
}

interface CreateMessageEmbeddingInput {
  readonly message_id: string
  readonly content_text: string
  readonly embedding: Buffer
  readonly model: string
  readonly dimensions: number
}

export function createMessageEmbedding(
  db: Database.Database,
  input: CreateMessageEmbeddingInput,
): MessageEmbeddingRow {
  db.prepare(
    `INSERT INTO message_embeddings (message_id, content_text, embedding, model, dimensions)
     VALUES (@message_id, @content_text, @embedding, @model, @dimensions)
     ON CONFLICT(message_id) DO UPDATE SET
       content_text = @content_text,
       embedding = @embedding,
       model = @model,
       dimensions = @dimensions,
       created_at = datetime('now')`,
  ).run(input)

  return findMessageEmbeddingById(db, input.message_id)!
}

export function findMessageEmbeddingById(
  db: Database.Database,
  messageId: string,
): MessageEmbeddingRow | null {
  const row = db
    .prepare('SELECT * FROM message_embeddings WHERE message_id = ?')
    .get(messageId) as MessageEmbeddingRow | undefined
  return row ? { ...row } : null
}

export function findAllMessageEmbeddings(
  db: Database.Database,
): ReadonlyArray<MessageEmbeddingRow> {
  const rows = db
    .prepare('SELECT * FROM message_embeddings ORDER BY created_at')
    .all() as MessageEmbeddingRow[]
  return rows.map((row) => ({ ...row }))
}

export function deleteMessageEmbedding(
  db: Database.Database,
  messageId: string,
): boolean {
  const result = db
    .prepare('DELETE FROM message_embeddings WHERE message_id = ?')
    .run(messageId)
  return result.changes > 0
}

export function countMessageEmbeddings(db: Database.Database): number {
  const row = db
    .prepare('SELECT COUNT(*) as count FROM message_embeddings')
    .get() as { count: number }
  return row.count
}
