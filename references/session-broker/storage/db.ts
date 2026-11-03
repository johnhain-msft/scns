import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function runMigrations(db: Database.Database): void {
  const schemaPath = join(__dirname, 'schema.sql')
  const schema = readFileSync(schemaPath, 'utf-8')
  db.exec(schema)

  // Add archived_at columns to existing tables (idempotent — no-op if already present)
  const migrations = [
    'ALTER TABLE sessions ADD COLUMN archived_at DATETIME DEFAULT NULL',
    'ALTER TABLE teams ADD COLUMN archived_at DATETIME DEFAULT NULL',
    'ALTER TABLE teams ADD COLUMN parent_team_id TEXT REFERENCES teams(id) ON DELETE CASCADE',
    'ALTER TABLE sessions ADD COLUMN repo_context TEXT',
    'ALTER TABLE sessions ADD COLUMN parent_session_id TEXT REFERENCES sessions(id)',
    'ALTER TABLE sessions ADD COLUMN branch_point_message_id TEXT',
  ]
  for (const sql of migrations) {
    try { db.exec(sql) } catch { /* column already exists */ }
  }

  // Trigger to clear parent_session_id when parent is deleted (idempotent)
  try {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS clear_parent_session_on_delete
      AFTER DELETE ON sessions
      FOR EACH ROW
      BEGIN
        UPDATE sessions SET parent_session_id = NULL WHERE parent_session_id = OLD.id;
      END
    `)
  } catch { /* trigger already exists */ }
}

export function openDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath)

  // WAL mode for file-based databases (in-memory uses 'memory' mode)
  if (dbPath !== ':memory:') {
    db.pragma('journal_mode = WAL')
  }
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')

  runMigrations(db)

  return db
}

export function closeDatabase(db: Database.Database): void {
  db.close()
}
