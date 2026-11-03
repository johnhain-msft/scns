import { describe, it, expect } from 'vitest'
import { chunkText, estimateTokens } from '../../../src/memory/chunker.js'

describe('estimateTokens', () => {
  it('estimates ~4 chars per token', () => {
    expect(estimateTokens('hello world')).toBe(3) // 11 chars / 4 = 2.75 -> 3
  })

  it('returns 1 for empty-ish text', () => {
    expect(estimateTokens('a')).toBe(1)
  })
})

describe('chunkText', () => {
  it('returns empty array for blank text', () => {
    expect(chunkText('')).toEqual([])
    expect(chunkText('   ')).toEqual([])
  })

  it('returns single chunk for short text', () => {
    const text = 'Hello, this is a short paragraph.'
    const chunks = chunkText(text)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.content).toBe(text)
    expect(chunks[0]!.index).toBe(0)
    expect(chunks[0]!.startOffset).toBe(0)
    expect(chunks[0]!.endOffset).toBe(text.length)
    expect(chunks[0]!.tokenCount).toBeGreaterThan(0)
  })

  it('splits long text into multiple chunks', () => {
    // Generate text that exceeds 400 tokens (~1600 chars)
    const paragraph = 'This is a test paragraph with enough words to make it meaningful. '
    const text = paragraph.repeat(30) // ~1950 chars
    const chunks = chunkText(text, { maxTokens: 400, overlapTokens: 50 })
    expect(chunks.length).toBeGreaterThan(1)
  })

  it('each chunk respects max token limit (approximately)', () => {
    const paragraph = 'The quick brown fox jumps over the lazy dog. '
    const text = paragraph.repeat(100) // ~4500 chars
    const chunks = chunkText(text, { maxTokens: 200, overlapTokens: 20 })

    for (const chunk of chunks) {
      // Allow some slack for boundary finding (30% tolerance)
      expect(chunk.tokenCount).toBeLessThanOrEqual(200 * 1.3)
    }
  })

  it('chunks have correct sequential indexes', () => {
    const text = 'word '.repeat(500)
    const chunks = chunkText(text, { maxTokens: 100, overlapTokens: 10 })
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i]!.index).toBe(i)
    }
  })

  it('chunks cover the entire text', () => {
    const text = 'A'.repeat(3000)
    const chunks = chunkText(text, { maxTokens: 200, overlapTokens: 20 })
    // First chunk starts at 0
    expect(chunks[0]!.startOffset).toBe(0)
    // Last chunk ends at text length
    expect(chunks[chunks.length - 1]!.endOffset).toBe(text.length)
  })

  it('prefers paragraph breaks', () => {
    const para1 = 'First paragraph content here. '.repeat(20)
    const para2 = 'Second paragraph content here. '.repeat(20)
    const text = para1 + '\n\n' + para2
    const chunks = chunkText(text, { maxTokens: 200, overlapTokens: 20 })
    // Should break at the paragraph boundary
    expect(chunks.length).toBeGreaterThan(1)
    // First chunk should end near the paragraph break
    const firstChunkEnd = chunks[0]!.content
    expect(firstChunkEnd.endsWith('here.')).toBe(true)
  })

  it('handles configurable overlap', () => {
    const text = 'word '.repeat(300)
    const noOverlap = chunkText(text, { maxTokens: 100, overlapTokens: 0 })
    const withOverlap = chunkText(text, { maxTokens: 100, overlapTokens: 30 })
    // More overlap = more chunks (because we advance less each time)
    expect(withOverlap.length).toBeGreaterThanOrEqual(noOverlap.length)
  })
})
