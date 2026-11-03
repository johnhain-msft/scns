/**
 * OTel-specific test DB harness — creates a temporary database
 * with the OTel schema applied.
 */

import { createTestDb, type TestDb } from './db-harness.js'
import { applyOtelSchema } from '../../src/otel/db.js'

export function createOtelTestDb(): TestDb {
  const testDb = createTestDb()
  applyOtelSchema(testDb.db)
  return testDb
}
