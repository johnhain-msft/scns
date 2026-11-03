/**
 * Chunking pipeline — split markdown into ~400 token chunks.
 * Simple whitespace-based tokenizer (1 token ~ 4 chars).
 * Preserves paragraph boundaries where possible.
 */

export interface ChunkConfig {
  readonly maxTokens: number
  readonly overlapTokens: number
}

export interface Chunk {
  readonly content: string
  readonly index: number
  readonly startOffset: number
  readonly endOffset: number
  readonly tokenCount: number
}

const DEFAULT_CONFIG: ChunkConfig = {
  maxTokens: 400,
  overlapTokens: 50,
}

/** Estimate token count (~4 chars per token, simple heuristic) */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

/**
 * Split text into chunks of approximately maxTokens size.
 * Tries to break at paragraph boundaries, falls back to sentence/word.
 */
export function chunkText(text: string, config: Partial<ChunkConfig> = {}): readonly Chunk[] {
  const { maxTokens, overlapTokens } = { ...DEFAULT_CONFIG, ...config }

  if (!text.trim()) return []

  const maxChars = maxTokens * 4
  const overlapChars = overlapTokens * 4

  // If text fits in one chunk, return it directly
  if (text.length <= maxChars) {
    return [
      {
        content: text,
        index: 0,
        startOffset: 0,
        endOffset: text.length,
        tokenCount: estimateTokens(text),
      },
    ]
  }

  const chunks: Chunk[] = []
  let position = 0
  let chunkIndex = 0

  while (position < text.length) {
    const remaining = text.length - position
    const sliceEnd = Math.min(position + maxChars, text.length)

    if (remaining <= maxChars) {
      const content = text.slice(position)
      chunks.push({
        content,
        index: chunkIndex,
        startOffset: position,
        endOffset: text.length,
        tokenCount: estimateTokens(content),
      })
      break
    }

    const slice = text.slice(position, sliceEnd)
    const breakPoint = findBreakPoint(slice)
    const content = slice.slice(0, breakPoint).trimEnd()

    if (content.length > 0) {
      chunks.push({
        content,
        index: chunkIndex,
        startOffset: position,
        endOffset: position + breakPoint,
        tokenCount: estimateTokens(content),
      })
      chunkIndex++
    }

    const advance = breakPoint - overlapChars
    position += Math.max(advance, 1)
  }

  return chunks
}

/** Find the best break point, preferring paragraph > sentence > word */
function findBreakPoint(text: string): number {
  // Try paragraph break (double newline)
  const paraBreak = text.lastIndexOf('\n\n')
  if (paraBreak > text.length * 0.3) return paraBreak + 2

  // Try sentence break (. or ! or ? followed by space/newline)
  const sentencePattern = /[.!?]\s/g
  let lastSentence = -1
  let match: RegExpExecArray | null
  while ((match = sentencePattern.exec(text)) !== null) {
    if (match.index > text.length * 0.3) {
      lastSentence = match.index + match[0].length
    }
  }
  if (lastSentence > 0) return lastSentence

  // Try word break
  const lastSpace = text.lastIndexOf(' ')
  if (lastSpace > text.length * 0.3) return lastSpace + 1

  // Fallback: hard break at max
  return text.length
}
