import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createBrokerTestDb } from '../../../helpers/broker-db-harness.js'
import { createEventLog } from '../../../../src/broker/services/event-log.js'
import {
  createEventDispatcher,
  createNullDispatcher,
  type TypedEvent,
} from '../../../../src/broker/event-dispatcher.js'
import type { TestDb } from '../../../helpers/db-harness.js'

let testDb: TestDb

beforeEach(() => {
  testDb = createBrokerTestDb()
})

afterEach(() => {
  testDb.close()
})

describe('EventLog', () => {
  it('persists event to DB with correct event_type (sessionRegistered)', () => {
    const log = createEventLog(testDb.db)
    const event = log.sessionRegistered('sess-1', { purpose: 'code review' })

    expect(event.id).toBeGreaterThan(0)
    expect(event.event_type).toBe('session_registered')
    expect(event.session_id).toBe('sess-1')
    expect(JSON.parse(event.payload)).toEqual({ purpose: 'code review' })
  })

  it('persists event to DB with correct event_type (messageSent)', () => {
    const log = createEventLog(testDb.db)
    const event = log.messageSent('sess-2', { content: 'hello' })

    expect(event.event_type).toBe('message_sent')
    expect(event.session_id).toBe('sess-2')
  })

  it('persists event to DB with correct event_type (teamCreated)', () => {
    const log = createEventLog(testDb.db)
    const event = log.teamCreated(null, { team_id: 'team-1', name: 'alpha' })

    expect(event.event_type).toBe('team_created')
    expect(event.session_id).toBeNull()
  })

  it('persists event to DB with correct event_type (zombieCleaned)', () => {
    const log = createEventLog(testDb.db)
    const event = log.zombieCleaned('sess-3', { reason: 'timeout' })

    expect(event.event_type).toBe('zombie_cleaned')
    expect(event.session_id).toBe('sess-3')
  })

  it('persists event to DB with correct event_type (brokerStarted)', () => {
    const log = createEventLog(testDb.db)
    const event = log.brokerStarted({ version: '1.0' })

    expect(event.event_type).toBe('broker_started')
    expect(event.session_id).toBeNull()
  })

  it('persists event to DB with correct event_type (agentAcpTiming — Phase 1.5 step 5)', () => {
    const log = createEventLog(testDb.db)
    const event = log.agentAcpTiming('sess-acp-1', {
      role: 'scns-dev',
      team_id: 'team-xyz',
      acp_session_id: 'acp-sess-id-1',
      process_spawn_to_initialize_ms: 2400,
      session_new_ms: 1200,
      cold_start_ms: 3600,
      process_spawn_started_at: 1_700_000_000_000,
      initialize_resolved_at: 1_700_000_002_400,
      session_new_started_at: 1_700_000_002_400,
      session_new_resolved_at: 1_700_000_003_600,
    })

    expect(event.event_type).toBe('agent_acp_timing')
    expect(event.session_id).toBe('sess-acp-1')
    const payload = JSON.parse(event.payload) as Record<string, unknown>
    expect(payload['role']).toBe('scns-dev')
    expect(payload['team_id']).toBe('team-xyz')
    expect(payload['cold_start_ms']).toBe(3600)
    expect(payload['process_spawn_to_initialize_ms']).toBe(2400)
    expect(payload['session_new_ms']).toBe(1200)
  })

  it('event includes session_id and JSON payload', () => {
    const log = createEventLog(testDb.db)
    const data = { key: 'value', nested: { a: 1 } }
    const event = log.stateUpdated('sess-5', data)

    expect(event.session_id).toBe('sess-5')
    expect(JSON.parse(event.payload)).toEqual(data)
  })

  it('dispatcher receives dispatched event', () => {
    const dispatcher = createEventDispatcher()
    const received: TypedEvent[] = []
    dispatcher.subscribe({}, (e) => received.push(e))

    const log = createEventLog(testDb.db, dispatcher)
    log.messageSent('sess-1', { content: 'hi' })

    expect(received).toHaveLength(1)
    expect(received[0]!.event_type).toBe('message_sent')
    expect(received[0]!.session_id).toBe('sess-1')
  })

  it('null dispatcher works (no crash)', () => {
    const log = createEventLog(testDb.db, createNullDispatcher())
    expect(() => log.sessionRegistered('sess-1', { ok: true })).not.toThrow()
  })

  it('since() returns events after given ID', () => {
    const log = createEventLog(testDb.db)
    const e1 = log.brokerStarted({ v: 1 })
    const e2 = log.messageSent('sess-1', { v: 2 })
    const e3 = log.zombieCleaned('sess-2', { v: 3 })

    const events = log.since(e1.id)
    expect(events).toHaveLength(2)
    expect(events[0]!.id).toBe(e2.id)
    expect(events[1]!.id).toBe(e3.id)
  })

  it('forSession() returns events for specific session', () => {
    const log = createEventLog(testDb.db)
    log.sessionRegistered('sess-1', { a: 1 })
    log.messageSent('sess-2', { b: 2 })
    log.messageSent('sess-1', { c: 3 })
    log.brokerStarted({ d: 4 })

    const events = log.forSession('sess-1')
    expect(events).toHaveLength(2)
    expect(events.every((e) => e.session_id === 'sess-1')).toBe(true)
  })
})
