import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { TestDb } from '../../../helpers/db-harness.js'
import { createBrokerTestDb } from '../../../helpers/broker-db-harness.js'
import { gcArchivedSessions } from '../../../../src/broker/services/session-gc.js'
import {
  createSession,
  findSessionById,
  updateSessionStatus,
  _archiveSession,
} from '../../../../src/broker/storage/repositories/session-repository.js'
import { querySessionHistory } from '../../../../src/broker/storage/repositories/history-repository.js'
import type { Event } from '../../../../src/broker/types.js'
import type { EventLog } from '../../../../src/broker/services/session-gc.js'

function createMockEventLog(): EventLog & { events: Event[] } {
  const events: Event[] = []
  let nextId = 1

  const log = (
    eventType: string,
    sessionId: string | null,
    data: Record<string, unknown>,
  ): Event => {
    const event: Event = {
      id: nextId++,
      event_type: eventType,
      session_id: sessionId,
      payload: JSON.stringify(data),
      created_at: new Date().toISOString(),
    }
    events.push(event)
    return event
  }

  return {
    events,
    sessionPurged: (sid, data) => log('session_purged', sid, data),
  } as EventLog & { events: Event[] }
}

describe('SessionGC', () => {
  let testDb: TestDb
  let eventLog: ReturnType<typeof createMockEventLog>

  beforeEach(() => {
    testDb = createBrokerTestDb()
    eventLog = createMockEventLog()
  })

  afterEach(() => {
    testDb.close()
  })

  function createArchivedSession(id: string, purpose: string): void {
    createSession(testDb.db, { id, purpose, working_dir: '/workspace', worktree: null })
    updateSessionStatus(testDb.db, id, 'completed')
    // Backdate archived_at so it's older than TTL
    testDb.db
      .prepare("UPDATE sessions SET archived_at = datetime('now', '-2 days') WHERE id = ?")
      .run(id)
  }

  it('returns empty result when no archived sessions exist', () => {
    const result = gcArchivedSessions(testDb.db, eventLog, 60)
    expect(result.sessions_purged).toBe(0)
    expect(result.session_ids).toEqual([])
  })

  it('purges sessions archived longer than TTL', () => {
    createArchivedSession('s1', 'old-session')

    const result = gcArchivedSessions(testDb.db, eventLog, 60) // 60s TTL
    expect(result.sessions_purged).toBe(1)
    expect(result.session_ids).toContain('s1')
    expect(findSessionById(testDb.db, 's1')).toBeNull()
  })

  it('does NOT purge recently archived sessions', () => {
    createSession(testDb.db, {
      id: 's1',
      purpose: 'recent',
      working_dir: '/workspace',
      worktree: null,
    })
    updateSessionStatus(testDb.db, 's1', 'completed')
    // archived_at is now() — within any reasonable TTL

    const result = gcArchivedSessions(testDb.db, eventLog, 86400) // 24h TTL
    expect(result.sessions_purged).toBe(0)
    expect(findSessionById(testDb.db, 's1')).not.toBeNull()
  })

  it('falls back to direct delete when purgeSessionToHistory returns null', () => {
    createArchivedSession('s1', 'will-vanish')
    // Delete the session from sessions table so purgeSessionToHistory returns null,
    // but re-insert a minimal row so findArchivedSessionsOlderThan still finds it
    testDb.db.prepare('DELETE FROM sessions WHERE id = ?').run('s1')
    testDb.db
      .prepare(
        `INSERT INTO sessions (id, purpose, working_dir, status, archived_at)
         VALUES ('s1', 'will-vanish', '/workspace', 'completed', datetime('now', '-2 days'))`,
      )
      .run()

    // purgeSessionToHistory will find the session, archive it, and delete it.
    // But if it couldn't find it, it would return null and we'd fall back.
    // To truly test the fallback, we need purgeSessionToHistory to return null.
    // We do this by inserting a row into sessions_history first so the INSERT conflicts.
    testDb.db
      .prepare(
        `INSERT INTO sessions_history (id, purpose, working_dir, status, archived_at)
         VALUES ('s1', 'will-vanish', '/workspace', 'completed', datetime('now', '-2 days'))`,
      )
      .run()

    const result = gcArchivedSessions(testDb.db, eventLog, 60)
    expect(result.sessions_purged).toBe(1)
    // Session should be gone from active tables either way
    expect(findSessionById(testDb.db, 's1')).toBeNull()
  })

  it('emits events for each purged session', () => {
    createArchivedSession('s1', 'session-a')
    createArchivedSession('s2', 'session-b')

    gcArchivedSessions(testDb.db, eventLog, 60)

    expect(eventLog.events).toHaveLength(2)
    expect(eventLog.events[0]!.event_type).toBe('session_purged')
    expect(eventLog.events[1]!.event_type).toBe('session_purged')

    const payloads = eventLog.events.map((e) => JSON.parse(e.payload))
    const sessionIds = payloads.map((p: Record<string, unknown>) => p.session_id)
    expect(sessionIds).toContain('s1')
    expect(sessionIds).toContain('s2')
  })

  it('reports correct count', () => {
    createArchivedSession('s1', 'old-1')
    createArchivedSession('s2', 'old-2')
    // Active session — should not be purged
    createSession(testDb.db, {
      id: 's3',
      purpose: 'active',
      working_dir: '/workspace',
      worktree: null,
    })

    const result = gcArchivedSessions(testDb.db, eventLog, 60)
    expect(result.sessions_purged).toBe(2)
    expect(result.session_ids).toEqual(expect.arrayContaining(['s1', 's2']))
    expect(result.session_ids).not.toContain('s3')
  })

  it('preserves session data in history tables after purge', () => {
    createArchivedSession('s1', 'history-session')

    gcArchivedSessions(testDb.db, eventLog, 60)

    expect(findSessionById(testDb.db, 's1')).toBeNull()

    const history = querySessionHistory(testDb.db)
    expect(history.length).toBeGreaterThanOrEqual(1)
    const record = history.find((h) => h.id === 's1')
    expect(record).toBeDefined()
    expect(record!.purpose).toBe('history-session')
  })
})
