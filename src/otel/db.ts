import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type Database from 'better-sqlite3'

const __otelDirname = dirname(fileURLToPath(import.meta.url))

export function applyOtelSchema(db: Database.Database): void {
  const schema = readFileSync(join(__otelDirname, 'schema.sql'), 'utf-8')
  db.exec(schema)
}
