/**
 * SQLite test harness — creates temporary databases for testing,
 * tears them down after each test.
 */

import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export interface TestDb {
  db: Database.Database
  path: string
  close: () => void
}

/** Create a temporary SQLite database for testing */
export function createTestDb(): TestDb {
  const dir = mkdtempSync(join(tmpdir(), 'scns-test-'))
  const dbPath = join(dir, 'test.db')
  const db = new Database(dbPath)

  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  return {
    db,
    path: dbPath,
    close: () => {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** Create a test database with the SCNS schema applied */
export function createTestDbWithSchema(schema: string): TestDb {
  const testDb = createTestDb()
  testDb.db.exec(schema)
  return testDb
}
