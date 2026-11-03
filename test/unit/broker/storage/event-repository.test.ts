import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { TestDb } from '../../../helpers/db-harness.js'
import { createBrokerTestDb } from '../../../helpers/broker-db-harness.js'
import {
  appendEvent,
  getEventsBySession,
  getEventsByType,
  getEventsSince,
  getEventsSinceFiltered,
  getTeamActivity,
} from '../../../../src/broker/storage/repositories/event-repository.js'

describe('EventRepository', () => {
  let testDb: TestDb

  beforeEach(() => {
    testDb = createBrokerTestDb()
    testDb.db
      .prepare("INSERT INTO sessions (id, purpose, working_dir) VALUES ('s1', 'test', '/')")
      .run()
    testDb.db
      .prepare("INSERT INTO sessions (id, purpose, working_dir) VALUES ('s2', 'test2', '/')")
      .run()
  })

  afterEach(() => {
    testDb.close()
  })

  it('appendEvent creates and returns an event', () => {
    const event = appendEvent(testDb.db, {
      event_type: 'session.registered',
      session_id: 's1',
      payload: '{"id":"s1"}',
    })
    expect(event.id).toBeGreaterThan(0)
    expect(event.event_type).toBe('session.registered')
    expect(event.session_id).toBe('s1')
  })

  it('getEventsBySession returns session events', () => {
    appendEvent(testDb.db, { event_type: 'a', session_id: 's1', payload: '{}' })
    appendEvent(testDb.db, { event_type: 'b', session_id: 's2', payload: '{}' })
    appendEvent(testDb.db, { event_type: 'c', session_id: 's1', payload: '{}' })

    const events = getEventsBySession(testDb.db, 's1')
    expect(events).toHaveLength(2)
  })

  it('getEventsByType returns events of a given type', () => {
    appendEvent(testDb.db, { event_type: 'heartbeat', session_id: 's1', payload: '{}' })
    appendEvent(testDb.db, { event_type: 'heartbeat', session_id: 's2', payload: '{}' })
    appendEvent(testDb.db, { event_type: 'other', session_id: 's1', payload: '{}' })

    const events = getEventsByType(testDb.db, 'heartbeat')
    expect(events).toHaveLength(2)
  })

  it('getEventsSince returns events after given id', () => {
    const e1 = appendEvent(testDb.db, { event_type: 'a', session_id: 's1', payload: '{}' })
    appendEvent(testDb.db, { event_type: 'b', session_id: 's1', payload: '{}' })
    appendEvent(testDb.db, { event_type: 'c', session_id: 's1', payload: '{}' })

    const events = getEventsSince(testDb.db, e1.id)
    expect(events).toHaveLength(2)
  })

  it('getEventsSinceFiltered applies type + session filters', () => {
    const e1 = appendEvent(testDb.db, { event_type: 'a', session_id: 's1', payload: '{}' })
    appendEvent(testDb.db, { event_type: 'a', session_id: 's2', payload: '{}' })
    appendEvent(testDb.db, { event_type: 'b', session_id: 's1', payload: '{}' })

    const events = getEventsSinceFiltered(testDb.db, {
      afterId: 0,
      eventTypes: ['a'],
      sessionId: 's1',
    })
    expect(events).toHaveLength(1)
    expect(events[0]!.id).toBe(e1.id)
  })

  it('getTeamActivity returns events for team members', () => {
    // Create team and add member
    testDb.db.prepare("INSERT INTO teams (id, name) VALUES ('t1', 'Alpha')").run()
    testDb.db
      .prepare("INSERT INTO team_members (team_id, session_id, name) VALUES ('t1', 's1', 'Agent')")
      .run()

    appendEvent(testDb.db, { event_type: 'work', session_id: 's1', payload: '{}' })
    appendEvent(testDb.db, { event_type: 'work', session_id: 's2', payload: '{}' })

    const events = getTeamActivity(testDb.db, { teamId: 't1' })
    expect(events).toHaveLength(1)
    expect(events[0]!.session_id).toBe('s1')
  })
})
