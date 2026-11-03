import type Database from 'better-sqlite3'
import type { Event } from '../../types.js'
import { toSqliteDateTime } from '../sqlite-time.js'

interface AppendEventInput {
  readonly event_type: string
  readonly session_id: string | null
  readonly payload: string
}

export function appendEvent(db: Database.Database, input: AppendEventInput): Event {
  const result = db
    .prepare(
      `INSERT INTO events (event_type, session_id, payload)
     VALUES (@event_type, @session_id, @payload)`,
    )
    .run(input)

  const id = Number(result.lastInsertRowid)
  const row = db.prepare('SELECT * FROM events WHERE id = ?').get(id) as Event
  return { ...row }
}

export function getEventsBySession(db: Database.Database, sessionId: string): ReadonlyArray<Event> {
  const rows = db
    .prepare('SELECT * FROM events WHERE session_id = ? ORDER BY id')
    .all(sessionId) as Event[]
  return rows.map((row) => ({ ...row }))
}

export function getEventsByType(db: Database.Database, eventType: string): ReadonlyArray<Event> {
  const rows = db
    .prepare('SELECT * FROM events WHERE event_type = ? ORDER BY id')
    .all(eventType) as Event[]
  return rows.map((row) => ({ ...row }))
}

export function getEventsSince(db: Database.Database, afterId: number): ReadonlyArray<Event> {
  const rows = db.prepare('SELECT * FROM events WHERE id > ? ORDER BY id').all(afterId) as Event[]
  return rows.map((row) => ({ ...row }))
}

export interface EventFilter {
  readonly afterId: number
  readonly eventTypes?: ReadonlyArray<string>
  readonly sessionId?: string
  readonly limit?: number
  readonly newestFirst?: boolean
  /** ISO-8601 lower bound on created_at (inclusive). */
  readonly since?: string
}

export function getEventsSinceFiltered(
  db: Database.Database,
  filter: EventFilter,
): ReadonlyArray<Event> {
  const conditions: string[] = ['id > ?']
  const params: unknown[] = [filter.afterId]

  if (filter.eventTypes && filter.eventTypes.length > 0) {
    const placeholders = filter.eventTypes.map(() => '?').join(', ')
    conditions.push(`event_type IN (${placeholders})`)
    params.push(...filter.eventTypes)
  }

  if (filter.sessionId) {
    conditions.push('session_id = ?')
    params.push(filter.sessionId)
  }

  if (filter.since) {
    conditions.push('created_at >= ?')
    params.push(toSqliteDateTime(filter.since))
  }

  const orderDir = filter.newestFirst ? 'DESC' : 'ASC'
  let sql = `SELECT * FROM events WHERE ${conditions.join(' AND ')} ORDER BY id ${orderDir}`
  if (typeof filter.limit === 'number' && filter.limit > 0) {
    sql += ' LIMIT ?'
    params.push(filter.limit)
  }
  const rows = db.prepare(sql).all(...params) as Event[]
  return rows.map((row) => ({ ...row }))
}

export interface TeamActivityFilter {
  readonly teamId: string
  readonly limit?: number
  readonly offset?: number
  readonly eventTypes?: ReadonlyArray<string>
  readonly since?: string
}

export function getTeamActivity(
  db: Database.Database,
  filter: TeamActivityFilter,
): ReadonlyArray<Event> {
  const conditions: string[] = [
    'e.session_id IN (SELECT session_id FROM team_members WHERE team_id = ?)',
  ]
  const params: unknown[] = [filter.teamId]

  if (filter.eventTypes && filter.eventTypes.length > 0) {
    const placeholders = filter.eventTypes.map(() => '?').join(', ')
    conditions.push(`e.event_type IN (${placeholders})`)
    params.push(...filter.eventTypes)
  }

  if (filter.since) {
    conditions.push('e.created_at >= ?')
    params.push(toSqliteDateTime(filter.since))
  }

  const limit = filter.limit ?? 50
  const offset = filter.offset ?? 0

  const sql = `SELECT e.* FROM events e WHERE ${conditions.join(' AND ')} ORDER BY e.id DESC LIMIT ? OFFSET ?`
  params.push(limit, offset)

  const rows = db.prepare(sql).all(...params) as Event[]
  return rows.map((row) => ({ ...row }))
}
