import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openMemoryDb, closeMemoryDb } from '../../../src/memory/db.js'
import { keywordSearch, keywordOnlySearch, escapeFts5Query } from '../../../src/memory/search.js'
import type Database from 'better-sqlite3'

describe('escapeFts5Query', () => {
  it('joins words with OR', () => {
    expect(escapeFts5Query('hello world')).toBe('hello OR world')
  })

  it('strips special FTS5 characters', () => {
    expect(escapeFts5Query('hello*world')).toBe('hello OR world')
    expect(escapeFts5Query('"quoted"')).toBe('quoted')
  })

  it('returns empty for blank input', () => {
    expect(escapeFts5Query('')).toBe('')
    expect(escapeFts5Query('   ')).toBe('')
  })

  it('handles single word', () => {
    expect(escapeFts5Query('typescript')).toBe('typescript')
  })

  it('splits hyphenated terms so FTS5 does not parse them as column filters', () => {
    // Regression: 'auto-merger' was passed through verbatim and FTS5 read the
    // hyphen as a column-filter separator → "no such column: merger". Hyphens
    // (and other operator chars) must be reduced to term separators.
    expect(escapeFts5Query('auto-merger refuses')).toBe('auto OR merger OR refuses')
    expect(escapeFts5Query('quality-gate arbiter')).toBe('quality OR gate OR arbiter')
    expect(escapeFts5Query('deny-all policy')).toBe('deny OR all OR policy')
  })
})

describe('keywordSearch', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb(':memory:')
    // Seed data
    db.prepare(
      "INSERT INTO vault_files (path, mtime_ms, size_bytes) VALUES ('a.md', 1000, 100)",
    ).run()
    db.prepare(
      "INSERT INTO chunks (file_path, chunk_index, content, start_offset, end_offset, token_count) VALUES ('a.md', 0, 'TypeScript is a strongly typed programming language', 0, 50, 8)",
    ).run()
    db.prepare(
      "INSERT INTO chunks (file_path, chunk_index, content, start_offset, end_offset, token_count) VALUES ('a.md', 1, 'Python is great for data science and machine learning', 50, 103, 9)",
    ).run()
    db.prepare(
      "INSERT INTO vault_files (path, mtime_ms, size_bytes) VALUES ('b.md', 1000, 80)",
    ).run()
    db.prepare(
      "INSERT INTO chunks (file_path, chunk_index, content, start_offset, end_offset, token_count) VALUES ('b.md', 0, 'React and TypeScript work well together', 0, 38, 7)",
    ).run()
    db.prepare(
      "INSERT INTO chunks (file_path, chunk_index, content, start_offset, end_offset, token_count) VALUES ('b.md', 1, 'The auto-merger refuses a dirty working tree', 38, 82, 8)",
    ).run()
  })

  afterEach(() => {
    closeMemoryDb(db)
  })

  it('does not throw and matches on hyphenated query terms', () => {
    // Regression: a hyphenated term threw "no such column: merger", which is
    // not caught (message lacks "fts5"), so the whole hybrid search aborted.
    let scores!: Map<number, number>
    expect(() => {
      scores = keywordSearch(db, 'auto-merger')
    }).not.toThrow()
    expect(scores.size).toBeGreaterThanOrEqual(1)
  })

  it('finds chunks matching keyword', () => {
    const scores = keywordSearch(db, 'TypeScript')
    expect(scores.size).toBe(2) // two chunks mention TypeScript
  })

  it('returns empty for no matches', () => {
    const scores = keywordSearch(db, 'Rust')
    expect(scores.size).toBe(0)
  })

  it('returns empty for blank query', () => {
    const scores = keywordSearch(db, '')
    expect(scores.size).toBe(0)
  })

  it('normalizes scores between 0 and 1', () => {
    const scores = keywordSearch(db, 'TypeScript')
    for (const score of scores.values()) {
      expect(score).toBeGreaterThanOrEqual(0)
      expect(score).toBeLessThanOrEqual(1)
    }
  })
})

describe('keywordOnlySearch', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb(':memory:')
    db.prepare(
      "INSERT INTO vault_files (path, mtime_ms, size_bytes) VALUES ('notes.md', 1000, 200)",
    ).run()
    db.prepare(
      "INSERT INTO chunks (file_path, chunk_index, content, start_offset, end_offset, token_count) VALUES ('notes.md', 0, 'The user prefers TypeScript over JavaScript', 0, 43, 7)",
    ).run()
    db.prepare(
      "INSERT INTO chunks (file_path, chunk_index, content, start_offset, end_offset, token_count) VALUES ('notes.md', 1, 'Express is used for the HTTP server', 43, 78, 7)",
    ).run()
  })

  afterEach(() => {
    closeMemoryDb(db)
  })

  it('returns SearchResult objects', () => {
    const results = keywordOnlySearch(db, 'TypeScript')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]!.content).toContain('TypeScript')
    expect(results[0]!.filePath).toBe('notes.md')
    expect(results[0]!.score).toBeGreaterThan(0)
    expect(results[0]!.vectorScore).toBe(0) // no vector in keyword-only
    expect(results[0]!.keywordScore).toBeGreaterThan(0)
  })

  it('respects limit parameter', () => {
    const results = keywordOnlySearch(db, 'the', 1)
    expect(results.length).toBeLessThanOrEqual(1)
  })
})

describe('hybrid score calculation', () => {
  it('weights vector 0.7 and keyword 0.3 by default', () => {
    // Verify the math: score = 0.7 * vectorScore + 0.3 * keywordScore
    const vectorScore = 0.8
    const keywordScore = 0.6
    const expected = 0.7 * vectorScore + 0.3 * keywordScore
    expect(expected).toBeCloseTo(0.74)
  })

  it('pure keyword score = 0.3 * keywordScore when no vector match', () => {
    const score = 0.7 * 0 + 0.3 * 1.0
    expect(score).toBeCloseTo(0.3)
  })

  it('pure vector score = 0.7 * vectorScore when no keyword match', () => {
    const score = 0.7 * 1.0 + 0.3 * 0
    expect(score).toBeCloseTo(0.7)
  })
})
