/**
 * Dream database setup — opens and initializes the dream-specific SQLite DB.
 * Separate from the broker database.
 */

import Database from 'better-sqlite3'
import { initDreamState } from './dream-state.js'

/**
 * Open (or create) the dream SQLite database, enable WAL + foreign keys,
 * and ensure the dream_state table exists.
 */
export function openDreamDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  initDreamState(db)
  return db
}
