/**
 * Broker service-level integration tests — verifies components that need
 * direct DB/service access rather than HTTP (zombie cleanup, startup
 * cleanup, event dispatcher).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openDatabase, closeDatabase } from '../../../src/broker/storage/db.js'
import { createEventLog } from '../../../src/broker/services/event-log.js'
import { createEventDispatcher, type TypedEvent } from '../../../src/broker/event-dispatcher.js'
import { cleanupStaleSessionsOnStartup } from '../../../src/broker/startup-cleanup.js'
import {
  createSession,
  findZombieSessions,
  deleteSession,
} from '../../../src/broker/storage/repositories/session-repository.js'
import {
  createMessage,
  deleteMessagesBySession,
} from '../../../src/broker/storage/repositories/message-repository.js'
import {
  declareIntent,
  releaseIntentsBySession,
} from '../../../src/broker/storage/repositories/intent-repository.js'
import {
  setState,
  deleteStateBySession,
} from '../../../src/broker/storage/repositories/state-repository.js'
import type Database from 'better-sqlite3'

let db: Database.Database

beforeEach(() => {
  db = openDatabase(':memory:')
})

afterEach(() => {
  closeDatabase(db)
})

// ═══════════════════════════════════════════════════════════════
// 4. Zombie cleanup — direct DB + heartbeat-poller logic
// ═══════════════════════════════════════════════════════════════

describe('Zombie session cleanup', () => {
  it('cleans up a session with an old heartbeat', () => {
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(db, dispatcher)

    // Insert a session and backdate its heartbeat past the grace period
    createSession(db, { id: 'stale-1', purpose: 'test', working_dir: '/w', worktree: null })
    db.prepare(
      "UPDATE sessions SET last_heartbeat = datetime('now', '-600 seconds') WHERE id = 'stale-1'",
    ).run()

    // Also create related data that should be cleaned with the session
    createMessage(db, {
      id: 'msg-1',
      sender_id: 'stale-1',
      receiver_id: null,
      content: 'test',
      story_id: null,
      reply_to: null,
    })
    declareIntent(db, { file_path: 'src/index.ts', session_id: 'stale-1' })
    setState(db, { key: 'stale-key', value: 'val', story_id: null, session_id: 'stale-1' })

    const zombies = findZombieSessions(db, 300)
    expect(zombies).toHaveLength(1)
    expect(zombies[0]!.id).toBe('stale-1')

    // Clean the zombie
    for (const z of zombies) {
      deleteMessagesBySession(db, z.id)
      releaseIntentsBySession(db, z.id)
      deleteStateBySession(db, z.id)
      deleteSession(db, z.id)
      eventLog.zombieCleaned(z.id, { cleanup_source: 'test' })
    }

    // Verify session is gone
    const remaining = db.prepare('SELECT COUNT(*) as count FROM sessions').get() as {
      count: number
    }
    expect(remaining.count).toBe(0)

    // Verify related data is gone
    const msgs = db.prepare('SELECT COUNT(*) as count FROM messages').get() as { count: number }
    expect(msgs.count).toBe(0)
    const intents = db.prepare('SELECT COUNT(*) as count FROM file_intents').get() as {
      count: number
    }
    expect(intents.count).toBe(0)
    const state = db.prepare('SELECT COUNT(*) as count FROM shared_state').get() as {
      count: number
    }
    expect(state.count).toBe(0)
  })

  it('does not clean sessions within grace period', () => {
    createSession(db, { id: 'fresh-1', purpose: 'test', working_dir: '/w', worktree: null })
    // last_heartbeat defaults to now, so it's within grace

    const zombies = findZombieSessions(db, 300)
    expect(zombies).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════
// 5. Startup cleanup — pre-populate stale sessions, then clean
// ═══════════════════════════════════════════════════════════════

describe('Startup cleanup', () => {
  it('expires all active sessions on startup — identity survives, lease ends (issue #70)', () => {
    const eventLog = createEventLog(db)

    // Insert 3 active sessions directly
    createSession(db, { id: 'old-1', purpose: 'worker', working_dir: '/w', worktree: null })
    createSession(db, { id: 'old-2', purpose: 'worker', working_dir: '/w', worktree: null })
    createSession(db, { id: 'old-3', purpose: 'worker', working_dir: '/w', worktree: null })

    // Verify they exist
    const before = db
      .prepare("SELECT COUNT(*) as count FROM sessions WHERE status = 'active'")
      .get() as { count: number }
    expect(before.count).toBe(3)

    // Run startup cleanup
    const result = cleanupStaleSessionsOnStartup(db, eventLog)

    expect(result.sessions).toBe(3)

    // Issue #70: the rows survive as expired participants (revivable, with
    // their correspondence intact) — no session remains routable.
    const active = db
      .prepare("SELECT COUNT(*) as count FROM sessions WHERE status = 'active'")
      .get() as { count: number }
    expect(active.count).toBe(0)
    const expired = db
      .prepare("SELECT COUNT(*) as count FROM sessions WHERE status = 'expired'")
      .get() as { count: number }
    expect(expired.count).toBe(3)
  })

  it('cleans up teams and tasks on startup', () => {
    const eventLog = createEventLog(db)

    // Create a team with members
    db.prepare(
      "INSERT INTO teams (id, name, status) VALUES ('team-1', 'Test Team', 'active')",
    ).run()
    createSession(db, { id: 'member-1', purpose: 'dev', working_dir: '/w', worktree: null })
    db.prepare(
      "INSERT INTO team_members (team_id, session_id, name, role) VALUES ('team-1', 'member-1', 'Dev', 'dev')",
    ).run()

    const result = cleanupStaleSessionsOnStartup(db, eventLog)

    expect(result.teams).toBe(1)
    expect(result.sessions).toBe(1)
  })

  it('returns zero counts when nothing to clean', () => {
    const eventLog = createEventLog(db)

    const result = cleanupStaleSessionsOnStartup(db, eventLog)

    expect(result.sessions).toBe(0)
    expect(result.teams).toBe(0)
    expect(result.tasks).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════════
// 8. Event dispatcher — subscribe/dispatch integration
// ═══════════════════════════════════════════════════════════════

describe('Event dispatcher integration', () => {
  it('subscriber receives dispatched events via event log', () => {
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(db, dispatcher)
    const received: TypedEvent[] = []

    // Subscribe to session_registered events
    const unsub = dispatcher.subscribe({ event_types: ['session_registered'] }, (event) =>
      received.push(event),
    )

    expect(dispatcher.subscriberCount()).toBe(1)

    // Register a session (triggers event dispatch)
    createSession(db, { id: 'ev-test', purpose: 'test', working_dir: '/w', worktree: null })
    eventLog.sessionRegistered('ev-test', { purpose: 'test' })

    // Verify event received
    expect(received).toHaveLength(1)
    expect(received[0]!.event_type).toBe('session_registered')
    expect(received[0]!.session_id).toBe('ev-test')

    unsub()
    expect(dispatcher.subscriberCount()).toBe(0)
  })

  it('filtered subscriber ignores non-matching events', () => {
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(db, dispatcher)
    const received: TypedEvent[] = []

    dispatcher.subscribe({ event_types: ['team_created'] }, (event) => received.push(event))

    createSession(db, { id: 'filter-test', purpose: 'test', working_dir: '/w', worktree: null })
    eventLog.sessionRegistered('filter-test', { purpose: 'test' })

    expect(received).toHaveLength(0)
  })

  it('session_id filter narrows events to one session', () => {
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(db, dispatcher)
    const received: TypedEvent[] = []

    dispatcher.subscribe({ session_id: 'target' }, (event) => received.push(event))

    createSession(db, { id: 'target', purpose: 'test', working_dir: '/w', worktree: null })
    createSession(db, { id: 'other', purpose: 'test', working_dir: '/w', worktree: null })
    eventLog.sessionRegistered('target', { purpose: 'test' })
    eventLog.sessionRegistered('other', { purpose: 'test' })

    expect(received).toHaveLength(1)
    expect(received[0]!.session_id).toBe('target')
  })

  it('multiple subscribers receive the same event', () => {
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(db, dispatcher)
    const received1: TypedEvent[] = []
    const received2: TypedEvent[] = []

    dispatcher.subscribe({}, (e) => received1.push(e))
    dispatcher.subscribe({}, (e) => received2.push(e))

    createSession(db, { id: 'multi-sub', purpose: 'test', working_dir: '/w', worktree: null })
    eventLog.sessionRegistered('multi-sub', {})

    expect(received1).toHaveLength(1)
    expect(received2).toHaveLength(1)
  })

  it('events are persisted in DB and retrievable via eventLog.since()', () => {
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(db, dispatcher)

    createSession(db, { id: 'persist-test', purpose: 'test', working_dir: '/w', worktree: null })
    eventLog.sessionRegistered('persist-test', { purpose: 'test' })
    eventLog.heartbeatReceived('persist-test', {})

    const events = eventLog.since(0)
    expect(events.length).toBeGreaterThanOrEqual(2)

    const types = events.map((e) => e.event_type)
    expect(types).toContain('session_registered')
    expect(types).toContain('heartbeat_received')
  })
})
