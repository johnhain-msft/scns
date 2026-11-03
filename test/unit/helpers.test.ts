import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { createTestDb, createTestDbWithSchema } from '../helpers/db-harness.js'

describe('SQLite test harness', () => {
  it('creates a temp database that is writable', () => {
    const testDb = createTestDb()
    try {
      testDb.db.prepare('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)').run()
      testDb.db.prepare("INSERT INTO test (name) VALUES ('hello')").run()
      const row = testDb.db.prepare('SELECT name FROM test WHERE id = 1').get() as {
        name: string
      }
      expect(row.name).toBe('hello')
    } finally {
      testDb.close()
    }
  })

  it('uses WAL journal mode', () => {
    const testDb = createTestDb()
    try {
      const result = testDb.db.pragma('journal_mode') as Array<{ journal_mode: string }>
      expect(result[0]?.journal_mode).toBe('wal')
    } finally {
      testDb.close()
    }
  })

  it('enforces foreign keys', () => {
    const testDb = createTestDb()
    try {
      const result = testDb.db.pragma('foreign_keys') as Array<{ foreign_keys: number }>
      expect(result[0]?.foreign_keys).toBe(1)
    } finally {
      testDb.close()
    }
  })

  it('cleans up temp directory on close', () => {
    const testDb = createTestDb()
    const dbPath = testDb.path
    testDb.close()
    expect(existsSync(dbPath)).toBe(false)
  })

  it('creates a database with schema applied', () => {
    const schema = `
      CREATE TABLE items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `
    const testDb = createTestDbWithSchema(schema)
    try {
      testDb.db.prepare("INSERT INTO items (content) VALUES ('test item')").run()
      const row = testDb.db.prepare('SELECT content FROM items WHERE id = 1').get() as {
        content: string
      }
      expect(row.content).toBe('test item')
    } finally {
      testDb.close()
    }
  })
})
