import type Database from 'better-sqlite3'
import type { SharedStateEntry } from '../../types.js'
import { DatabaseError } from '../../../shared/errors.js'

interface SetStateInput {
  readonly key: string
  readonly value: string
  readonly story_id: string | null
  readonly session_id: string | null
}

export function setState(db: Database.Database, input: SetStateInput): SharedStateEntry {
  try {
    db.prepare(
      `INSERT INTO shared_state (key, value, story_id, session_id, updated_at)
       VALUES (@key, @value, @story_id, @session_id, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         story_id = excluded.story_id,
         session_id = excluded.session_id,
         updated_at = datetime('now')`,
    ).run(input)
  } catch (err) {
    throw new DatabaseError(`Failed to set state key '${input.key}'`, { cause: err })
  }

  return getState(db, input.key)!
}

export function getState(db: Database.Database, key: string): SharedStateEntry | null {
  const row = db.prepare('SELECT * FROM shared_state WHERE key = ?').get(key) as
    | SharedStateEntry
    | undefined
  return row ? { ...row } : null
}

export function deleteState(db: Database.Database, key: string): boolean {
  try {
    const result = db.prepare('DELETE FROM shared_state WHERE key = ?').run(key)
    return result.changes > 0
  } catch (err) {
    throw new DatabaseError(`Failed to delete state key '${key}'`, { cause: err })
  }
}

export function getStateByStory(
  db: Database.Database,
  storyId: string,
): ReadonlyArray<SharedStateEntry> {
  const rows = db
    .prepare('SELECT * FROM shared_state WHERE story_id = ? ORDER BY key')
    .all(storyId) as SharedStateEntry[]
  return rows.map((row) => ({ ...row }))
}

export function deleteStateByStory(db: Database.Database, storyId: string): number {
  const result = db.prepare('DELETE FROM shared_state WHERE story_id = ?').run(storyId)
  return result.changes
}

export function deleteStateBySession(db: Database.Database, sessionId: string): number {
  const result = db.prepare('DELETE FROM shared_state WHERE session_id = ?').run(sessionId)
  return result.changes
}

export function deleteAllState(db: Database.Database): number {
  const result = db.prepare('DELETE FROM shared_state').run()
  return result.changes
}
