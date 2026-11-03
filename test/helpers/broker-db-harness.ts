/**
 * Broker-specific test DB harness — creates a temporary database
 * with the broker schema applied.
 */

import { createTestDb, type TestDb } from './db-harness.js'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export function createBrokerTestDb(): TestDb {
  const testDb = createTestDb()
  const schemaPath = resolve('src/broker/storage/schema.sql')
  const schema = readFileSync(schemaPath, 'utf-8')
  testDb.db.exec(schema)
  return testDb
}
