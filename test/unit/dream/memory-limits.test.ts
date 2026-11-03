import { describe, it, expect } from 'vitest'
import {
  truncateEntrypoint,
  countLines,
  countBytes,
  MAX_ENTRYPOINT_LINES,
  MAX_ENTRYPOINT_BYTES,
} from '../../../src/dream/memory-limits.js'

describe('countLines', () => {
  it('empty string → 0', () => {
    expect(countLines('')).toBe(0)
  })

  it('single line → 1', () => {
    expect(countLines('hello')).toBe(1)
  })

  it('multi-line → correct count', () => {
    expect(countLines('a\nb\nc')).toBe(3)
  })

  it('trailing newline handling', () => {
    expect(countLines('a\nb\n')).toBe(2)
  })
})

describe('countBytes', () => {
  it('ASCII string → correct', () => {
    expect(countBytes('hello')).toBe(5)
  })

  it('UTF-8 multibyte characters → correct byte count', () => {
    // '€' is 3 bytes in UTF-8, '🍕' is 4 bytes
    expect(countBytes('€')).toBe(3)
    expect(countBytes('🍕')).toBe(4)
    expect(countBytes('hi€')).toBe(5)
  })
})

describe('truncateEntrypoint', () => {
  it('content under both limits → unchanged', () => {
    const content = 'short content'
    const result = truncateEntrypoint(content)
    expect(result.content).toBe(content)
    expect(result.truncated).toBe(false)
    expect(result.warning).toBeNull()
  })

  it('exactly at line limit → unchanged', () => {
    const lines = Array.from({ length: MAX_ENTRYPOINT_LINES }, (_, i) => `line ${i + 1}`)
    const content = lines.join('\n')
    const result = truncateEntrypoint(content)
    expect(result.content).toBe(content)
    expect(result.truncated).toBe(false)
    expect(result.warning).toBeNull()
  })

  it('exactly at byte limit → unchanged', () => {
    // Create content exactly at MAX_ENTRYPOINT_BYTES
    const filler = 'x'.repeat(MAX_ENTRYPOINT_BYTES)
    const result = truncateEntrypoint(filler)
    expect(result.content).toBe(filler)
    expect(result.truncated).toBe(false)
    expect(result.warning).toBeNull()
  })

  it('1 line over → truncated to 200 lines + warning', () => {
    const lines = Array.from({ length: MAX_ENTRYPOINT_LINES + 1 }, (_, i) => `line ${i + 1}`)
    const content = lines.join('\n')
    const result = truncateEntrypoint(content)
    expect(result.truncated).toBe(true)
    expect(result.warning).toContain('lines')
    // The content before the warning should have exactly MAX_ENTRYPOINT_LINES lines
    const bodyLines = result.content.split('\n').filter((l) => !l.startsWith('<!-- Truncated:'))
    expect(bodyLines.length).toBe(MAX_ENTRYPOINT_LINES)
  })

  it('over byte limit → truncated at last newline before 25KB + warning', () => {
    // Create content with many short lines that exceeds byte limit
    const _lineContent = 'abcdefghij' // 10 chars per line
    const _numLines = Math.ceil(MAX_ENTRYPOINT_BYTES / 11) + 100 // well over byte limit but under line limit? No — need < 200 lines
    // Use fewer, longer lines to stay under line limit but exceed byte limit
    const longLine = 'x'.repeat(200)
    const lines = Array.from({ length: 150 }, () => longLine)
    const content = lines.join('\n')
    expect(Buffer.byteLength(content, 'utf-8')).toBeGreaterThan(MAX_ENTRYPOINT_BYTES)
    expect(countLines(content)).toBeLessThanOrEqual(MAX_ENTRYPOINT_LINES)

    const result = truncateEntrypoint(content)
    expect(result.truncated).toBe(true)
    expect(result.warning).toContain('bytes')
    // Body (without warning line) should be within byte limit
    const body = result.content
      .split('\n')
      .filter((l) => !l.startsWith('<!-- Truncated:'))
      .join('\n')
    expect(Buffer.byteLength(body, 'utf-8')).toBeLessThanOrEqual(MAX_ENTRYPOINT_BYTES)
  })

  it('both exceeded → line limit applied first, then byte, both in warning', () => {
    const longLine = 'x'.repeat(200)
    const lines = Array.from({ length: MAX_ENTRYPOINT_LINES + 50 }, () => longLine)
    const content = lines.join('\n')
    expect(countLines(content)).toBeGreaterThan(MAX_ENTRYPOINT_LINES)
    expect(Buffer.byteLength(content, 'utf-8')).toBeGreaterThan(MAX_ENTRYPOINT_BYTES)

    const result = truncateEntrypoint(content)
    expect(result.truncated).toBe(true)
    expect(result.warning).toContain('lines and bytes')
  })

  it('empty string → empty, not truncated', () => {
    const result = truncateEntrypoint('')
    expect(result.content).toBe('')
    expect(result.truncated).toBe(false)
    expect(result.warning).toBeNull()
  })

  it('single very long line over byte limit → truncated', () => {
    const content = 'x'.repeat(MAX_ENTRYPOINT_BYTES + 1000)
    const result = truncateEntrypoint(content)
    expect(result.truncated).toBe(true)
    expect(result.warning).toContain('bytes')
    // Body should be within byte limit
    const body = result.content
      .split('\n')
      .filter((l) => !l.startsWith('<!-- Truncated:'))
      .join('\n')
    expect(Buffer.byteLength(body, 'utf-8')).toBeLessThanOrEqual(MAX_ENTRYPOINT_BYTES)
  })
})
