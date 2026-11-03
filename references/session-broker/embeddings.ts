// fastembed is loaded dynamically so the broker can start without it installed.

interface FastembedModule {
  readonly EmbeddingModel: Record<string, string>
  readonly FlagEmbedding: {
    init(opts: { model: string }): Promise<FastembedInstance>
  }
}

interface FastembedInstance {
  queryEmbed(text: string): Promise<number[]>
  embed(texts: string[], batchSize: number): AsyncIterable<number[][]>
}

export interface EmbeddingConfig {
  readonly model: string
}

export interface EmbeddingResult {
  readonly embedding: Float32Array
  readonly model: string
  readonly dimensions: number
}

// Must use the enum VALUE (the download slug), not the enum KEY.
// fastembed uses this to build the GCS download URL:
// https://storage.googleapis.com/qdrant-fastembed/${model}.tar.gz
const DEFAULT_MODEL = 'fast-bge-small-en-v1.5'

let fastembedModule: FastembedModule | null = null
let fastembedLoadAttempted = false
let fastembedAvailable = false

let embeddingModel: FastembedInstance | null = null
let modelInitPromise: Promise<FastembedInstance> | null = null

async function loadFastembed(): Promise<FastembedModule | null> {
  if (fastembedLoadAttempted) return fastembedModule
  fastembedLoadAttempted = true

  try {
    const mod = await import('fastembed') as unknown as FastembedModule
    fastembedModule = mod
    fastembedAvailable = true
    return mod
  } catch {
    process.stderr.write(
      'WARNING: fastembed not available. Semantic search will be disabled. Install fastembed for full functionality.\n'
    )
    fastembedAvailable = false
    return null
  }
}

async function getModel(model: string = DEFAULT_MODEL): Promise<FastembedInstance> {
  const mod = await loadFastembed()
  if (!mod) {
    throw new Error('fastembed is not installed. Install it with: npm install fastembed')
  }

  if (embeddingModel !== null) {
    return embeddingModel
  }

  if (modelInitPromise === null) {
    modelInitPromise = mod.FlagEmbedding.init({ model }).then((m) => {
      embeddingModel = m
      return m
    })
  }

  return modelInitPromise
}

/**
 * Generate an embedding for the given text using local fastembed model.
 * No API key required - runs entirely locally using ONNX runtime.
 *
 * @param text - The text to embed
 * @param config - Optional configuration for model
 * @returns EmbeddingResult containing the embedding vector and metadata
 */
export async function generateEmbedding(
  text: string,
  config: Partial<EmbeddingConfig> = {}
): Promise<EmbeddingResult> {
  const model = config.model ?? DEFAULT_MODEL
  const embedder = await getModel(model)

  const embedding = await embedder.queryEmbed(text)

  return {
    embedding: new Float32Array(embedding),
    model: `fastembed:${model}`,
    dimensions: embedding.length,
  }
}

/**
 * Generate embeddings for multiple texts in a batch.
 *
 * @param texts - Array of texts to embed
 * @param config - Optional configuration for model
 * @returns Array of EmbeddingResult for each input text
 */
export async function generateEmbeddingsBatch(
  texts: ReadonlyArray<string>,
  config: Partial<EmbeddingConfig> = {}
): Promise<ReadonlyArray<EmbeddingResult>> {
  if (texts.length === 0) {
    return []
  }

  const model = config.model ?? DEFAULT_MODEL
  const embedder = await getModel(model)

  const results: EmbeddingResult[] = []
  const batchSize = 32

  for await (const batch of embedder.embed([...texts], batchSize)) {
    for (const embedding of batch) {
      results.push({
        embedding: new Float32Array(embedding),
        model: `fastembed:${model}`,
        dimensions: embedding.length,
      })
    }
  }

  return results
}

/**
 * Serialize a Float32Array embedding to a Buffer for SQLite BLOB storage.
 */
export function serializeEmbedding(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength)
}

/**
 * Deserialize a Buffer from SQLite BLOB to a Float32Array embedding.
 */
export function deserializeEmbedding(buffer: Buffer): Float32Array {
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  return new Float32Array(arrayBuffer)
}

/**
 * Compute cosine similarity between two embedding vectors.
 * Returns a value between -1 and 1, where 1 means identical direction.
 *
 * @param a - First embedding vector
 * @param b - Second embedding vector
 * @returns Cosine similarity score
 * @throws Error if vectors have different dimensions
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`Dimension mismatch: ${a.length} vs ${b.length}`)
  }

  let dotProduct = 0
  let magnitudeA = 0
  let magnitudeB = 0

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    magnitudeA += a[i] * a[i]
    magnitudeB += b[i] * b[i]
  }

  const magnitude = Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB)
  return magnitude === 0 ? 0 : dotProduct / magnitude
}

/**
 * Check if fastembed is available for generating embeddings.
 * Returns true if fastembed loaded successfully, or if load has not been attempted yet
 * (optimistic — the first actual call to generateEmbedding will attempt the load).
 * Returns false only after a failed load attempt.
 */
export function isEmbeddingAvailable(): boolean {
  if (!fastembedLoadAttempted) return true
  return fastembedAvailable
}

/**
 * Initialize the embedding system by attempting to load fastembed.
 * Logs a warning to stderr if fastembed is not available.
 * Safe to call multiple times — only loads once.
 */
export async function initEmbeddings(): Promise<boolean> {
  await loadFastembed()
  return fastembedAvailable
}

/**
 * Reset the embedding client and load state (useful for testing).
 */
export function resetClient(): void {
  embeddingModel = null
  modelInitPromise = null
  fastembedModule = null
  fastembedLoadAttempted = false
  fastembedAvailable = false
}
