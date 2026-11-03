import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { TestDb } from '../../helpers/db-harness.js'
import { createBrokerTestDb } from '../../helpers/broker-db-harness.js'
import type { Event } from '../../../src/broker/types.js'
import type { EventLog } from '../../../src/broker/services/event-log.js'
import { startHeartbeatPoller } from '../../../src/broker/heartbeat-poller.js'
import {
  findSessionById,
  reviveSession,
} from '../../../src/broker/storage/repositories/session-repository.js'

// ── Mock EventLog ────────────────────────────────────────────

interface CapturedEvent {
  readonly type: string
  readonly sessionId: string
  readonly data: Record<string, unknown>
}

function createMockEventLog(): EventLog & { events: CapturedEvent[] } {
  const events: CapturedEvent[] = []
  let nextId = 1

  const log = (
    eventType: string,
    sessionId: string | null,
    data: Record<string, unknown>,
  ): Event => {
    const event: CapturedEvent = {
      type: eventType,
      sessionId: sessionId ?? '',
      data,
    }
    events.push(event)
    return {
      id: nextId++,
      event_type: eventType,
      session_id: sessionId,
      payload: JSON.stringify(data),
      created_at: new Date().toISOString(),
    }
  }

  // Build a proxy that returns a logging function for any method name
  const handler: ProxyHandler<EventLog & { events: CapturedEvent[] }> = {
    get(_target, prop) {
      if (prop === 'events') return events
      if (typeof prop === 'string') {
        return (
          sidOrData: string | Record<string, unknown>,
          maybeData?: Record<string, unknown>,
        ) => {
          if (prop === 'since' || prop === 'forSession') return []
          if (typeof sidOrData === 'string') {
            return log(prop, sidOrData, maybeData ?? {})
          }
          return log(prop, null, sidOrData as Record<string, unknown>)
        }
      }
      return undefined
    },
  }

  return new Proxy({} as EventLog & { events: CapturedEvent[] }, handler)
}

// ── Helpers ──────────────────────────────────────────────────

function insertZombieSession(
  db: import('better-sqlite3').Database,
  id: string,
  ageSeconds: number,
): void {
  db.prepare(
    `INSERT INTO sessions (id, purpose, working_dir, status, last_heartbeat)
     VALUES (?, 'test', '/workspace', 'active', datetime('now', '-' || ? || ' seconds'))`,
  ).run(id, ageSeconds)
}

function insertActiveSession(db: import('better-sqlite3').Database, id: string): void {
  db.prepare(
    `INSERT INTO sessions (id, purpose, working_dir, status, last_heartbeat)
     VALUES (?, 'test', '/workspace', 'active', datetime('now'))`,
  ).run(id)
}

function insertMessage(
  db: import('better-sqlite3').Database,
  senderId: string,
  receiverId: string,
): void {
  const id = `msg-${senderId}-${receiverId}-${Date.now()}`
  db.prepare(
    `INSERT INTO messages (id, sender_id, receiver_id, content)
     VALUES (?, ?, ?, 'hello')`,
  ).run(id, senderId, receiverId)
}

function insertFileIntent(
  db: import('better-sqlite3').Database,
  sessionId: string,
  filePath: string,
): void {
  db.prepare(
    `INSERT INTO file_intents (session_id, file_path, intent)
     VALUES (?, ?, 'edit')`,
  ).run(sessionId, filePath)
}

function insertState(db: import('better-sqlite3').Database, sessionId: string, key: string): void {
  db.prepare(
    `INSERT INTO shared_state (session_id, key, value)
     VALUES (?, ?, '{}')`,
  ).run(sessionId, key)
}

function countMessages(db: import('better-sqlite3').Database, sessionId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) as cnt FROM messages WHERE sender_id = ? OR receiver_id = ?')
    .get(sessionId, sessionId) as { cnt: number }
  return row.cnt
}

function countIntents(db: import('better-sqlite3').Database, sessionId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) as cnt FROM file_intents WHERE session_id = ?')
    .get(sessionId) as { cnt: number }
  return row.cnt
}

function countState(db: import('better-sqlite3').Database, sessionId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) as cnt FROM shared_state WHERE session_id = ?')
    .get(sessionId) as { cnt: number }
  return row.cnt
}

// ── Tests ────────────────────────────────────────────────────

describe('HeartbeatPoller', () => {
  let testDb: TestDb
  let eventLog: ReturnType<typeof createMockEventLog>

  beforeEach(() => {
    vi.useFakeTimers()
    testDb = createBrokerTestDb()
    eventLog = createMockEventLog()
  })

  afterEach(() => {
    testDb.close()
    vi.useRealTimers()
  })

  it('startHeartbeatPoller returns a stop handle', () => {
    const poller = startHeartbeatPoller(testDb.db, eventLog, { intervalMs: 1000, graceSeconds: 60 })
    expect(poller).toBeDefined()
    expect(typeof poller.stop).toBe('function')
    poller.stop()
  })

  it('cleanup expires zombie sessions — identity survives, routing lease ends (issue #70)', () => {
    insertZombieSession(testDb.db, 'zombie-1', 600)

    const poller = startHeartbeatPoller(testDb.db, eventLog, {
      intervalMs: 1000,
      graceSeconds: 300,
    })

    vi.advanceTimersByTime(1000)

    const session = findSessionById(testDb.db, 'zombie-1')
    expect(session).not.toBeNull()
    expect(session!.status).toBe('expired')
    poller.stop()
  })

  it('cleanup expires sessions already in status=zombie regardless of heartbeat age (13.10.2)', () => {
    // Regression: a session stuck with status='zombie' and a recent heartbeat
    // (or any heartbeat) was never retired because findZombieSessions only
    // matched live statuses. Also includes a related session_handoffs row —
    // transient execution state that lease expiry must still release.
    testDb.db
      .prepare(
        `INSERT INTO sessions (id, purpose, working_dir, status, last_heartbeat)
         VALUES ('stuck', 'handoff test', '/tmp', 'zombie', datetime('now'))`,
      )
      .run()
    testDb.db
      .prepare(
        `INSERT INTO session_handoffs (id, session_id, status, progress, files_modified)
         VALUES ('ho-1', 'stuck', 'ready', 'work in progress', '[]')`,
      )
      .run()
    expect(findSessionById(testDb.db, 'stuck')).not.toBeNull()

    const poller = startHeartbeatPoller(testDb.db, eventLog, {
      intervalMs: 1000,
      graceSeconds: 300,
    })

    vi.advanceTimersByTime(1000)

    // Issue #70: the identity row survives (expired), and does NOT get
    // re-processed on subsequent ticks.
    expect(findSessionById(testDb.db, 'stuck')?.status).toBe('expired')
    const handoffCount = (
      testDb.db
        .prepare("SELECT COUNT(*) AS c FROM session_handoffs WHERE session_id = 'stuck'")
        .get() as { c: number }
    ).c
    expect(handoffCount).toBe(0)

    vi.advanceTimersByTime(1000)
    const zombieEvents = eventLog.events.filter((e) => e.type === 'zombieCleaned')
    expect(zombieEvents).toHaveLength(1)
    poller.stop()
  })

  it('cleanup preserves active sessions', () => {
    insertActiveSession(testDb.db, 'active-1')
    insertZombieSession(testDb.db, 'zombie-1', 600)

    const poller = startHeartbeatPoller(testDb.db, eventLog, {
      intervalMs: 1000,
      graceSeconds: 300,
    })

    vi.advanceTimersByTime(1000)

    expect(findSessionById(testDb.db, 'active-1')!.status).toBe('active')
    expect(findSessionById(testDb.db, 'zombie-1')!.status).toBe('expired')
    poller.stop()
  })

  it('cleanup releases intents and state but PRESERVES messages (issue #70)', () => {
    insertZombieSession(testDb.db, 'zombie-1', 600)
    // Need a second session for message receiver
    insertActiveSession(testDb.db, 'active-1')

    insertMessage(testDb.db, 'zombie-1', 'active-1')
    insertFileIntent(testDb.db, 'zombie-1', '/src/foo.ts')
    insertState(testDb.db, 'zombie-1', 'my-key')

    expect(countMessages(testDb.db, 'zombie-1')).toBe(1)
    expect(countIntents(testDb.db, 'zombie-1')).toBe(1)
    expect(countState(testDb.db, 'zombie-1')).toBe(1)

    const poller = startHeartbeatPoller(testDb.db, eventLog, {
      intervalMs: 1000,
      graceSeconds: 300,
    })

    vi.advanceTimersByTime(1000)

    // The stale sender's message to the active recipient MUST survive: one
    // participant going stale never empties another participant's inbox.
    expect(countMessages(testDb.db, 'zombie-1')).toBe(1)
    const inbox = testDb.db
      .prepare("SELECT receiver_id FROM messages WHERE receiver_id = 'active-1'")
      .all() as Array<{ receiver_id: string }>
    expect(inbox).toHaveLength(1)
    // Transient execution state IS released.
    expect(countIntents(testDb.db, 'zombie-1')).toBe(0)
    expect(countState(testDb.db, 'zombie-1')).toBe(0)
    poller.stop()
  })

  it('an expired session revives on heartbeat and its retained mail is still addressed to it (issue #70)', () => {
    insertZombieSession(testDb.db, 'wait-1', 600)
    insertActiveSession(testDb.db, 'sender-1')
    insertMessage(testDb.db, 'sender-1', 'wait-1')

    const poller = startHeartbeatPoller(testDb.db, eventLog, {
      intervalMs: 1000,
      graceSeconds: 300,
    })
    vi.advanceTimersByTime(1000)
    expect(findSessionById(testDb.db, 'wait-1')!.status).toBe('expired')

    // Reconnect: proof of life revives the lease.
    reviveSession(testDb.db, 'wait-1')
    const revived = findSessionById(testDb.db, 'wait-1')
    expect(revived!.status).toBe('active')

    // The directed message survived the expiry and is still PRIVATE to
    // wait-1 (receiver_id intact — never leaked to broadcast).
    const mail = testDb.db
      .prepare("SELECT receiver_id, sender_id FROM messages WHERE receiver_id = 'wait-1'")
      .all() as Array<{ receiver_id: string; sender_id: string }>
    expect(mail).toHaveLength(1)
    expect(mail[0]!.sender_id).toBe('sender-1')
    poller.stop()
  })

  it('zombie event is logged with correct data', () => {
    insertZombieSession(testDb.db, 'zombie-1', 600)

    const poller = startHeartbeatPoller(testDb.db, eventLog, {
      intervalMs: 1000,
      graceSeconds: 300,
    })

    vi.advanceTimersByTime(1000)

    const zombieEvents = eventLog.events.filter((e) => e.type === 'zombieCleaned')
    expect(zombieEvents).toHaveLength(1)
    expect(zombieEvents[0]!.sessionId).toBe('zombie-1')
    expect(zombieEvents[0]!.data).toMatchObject({
      cleanup_source: 'heartbeat_poller',
    })
    expect(zombieEvents[0]!.data).toHaveProperty('messages_deleted')
    expect(zombieEvents[0]!.data).toHaveProperty('intents_released')
    expect(zombieEvents[0]!.data).toHaveProperty('state_deleted')
    poller.stop()
  })

  it('grace period is respected — session just inside grace survives', () => {
    // Grace is 300s, session heartbeat is 200s old — should survive
    insertZombieSession(testDb.db, 'borderline-1', 200)

    const poller = startHeartbeatPoller(testDb.db, eventLog, {
      intervalMs: 1000,
      graceSeconds: 300,
    })

    vi.advanceTimersByTime(1000)

    expect(findSessionById(testDb.db, 'borderline-1')).not.toBeNull()
    poller.stop()
  })

  it('multiple zombies are expired in one tick', () => {
    insertZombieSession(testDb.db, 'zombie-1', 600)
    insertZombieSession(testDb.db, 'zombie-2', 700)
    insertZombieSession(testDb.db, 'zombie-3', 800)

    const poller = startHeartbeatPoller(testDb.db, eventLog, {
      intervalMs: 1000,
      graceSeconds: 300,
    })

    vi.advanceTimersByTime(1000)

    expect(findSessionById(testDb.db, 'zombie-1')!.status).toBe('expired')
    expect(findSessionById(testDb.db, 'zombie-2')!.status).toBe('expired')
    expect(findSessionById(testDb.db, 'zombie-3')!.status).toBe('expired')

    const zombieEvents = eventLog.events.filter((e) => e.type === 'zombieCleaned')
    expect(zombieEvents).toHaveLength(3)
    poller.stop()
  })

  it('stop() prevents further ticks', () => {
    const poller = startHeartbeatPoller(testDb.db, eventLog, {
      intervalMs: 1000,
      graceSeconds: 300,
    })

    // First tick expires this zombie
    insertZombieSession(testDb.db, 'zombie-1', 600)
    vi.advanceTimersByTime(1000)
    expect(findSessionById(testDb.db, 'zombie-1')!.status).toBe('expired')

    poller.stop()

    // Insert new zombie after stop — should NOT be touched
    insertZombieSession(testDb.db, 'zombie-2', 600)
    vi.advanceTimersByTime(5000)
    expect(findSessionById(testDb.db, 'zombie-2')!.status).toBe('active')
  })

  it('tick counter increments and GC runs on correct interval', () => {
    const poller = startHeartbeatPoller(testDb.db, eventLog, {
      intervalMs: 1000,
      graceSeconds: 300,
      gcIntervalTicks: 3,
    })

    // Advance through 3 ticks — GC should run on tick 3
    // We don't have disbanded teams, so GC is a no-op, but we verify no errors
    vi.advanceTimersByTime(3000)

    // Advance through 3 more ticks (tick 6) — GC runs again
    vi.advanceTimersByTime(3000)

    // No errors thrown — poller is stable
    poller.stop()
  })
})

// ── Issue #70 review B1 — session GC runs from the poller tick ────────────
describe('HeartbeatPoller session GC (issue #70 B1)', () => {
  let testDb: TestDb
  let eventLog: ReturnType<typeof createMockEventLog>

  beforeEach(() => {
    vi.useFakeTimers()
    testDb = createBrokerTestDb()
    eventLog = createMockEventLog()
  })

  afterEach(() => {
    testDb.close()
    vi.useRealTimers()
  })

  function insertArchivedExpiredSession(id: string, archivedAgeSeconds: number): void {
    testDb.db
      .prepare(
        `INSERT INTO sessions (id, purpose, working_dir, status, last_heartbeat, archived_at)
         VALUES (?, 'test', '/workspace', 'expired', datetime('now', '-' || ? || ' seconds'), datetime('now', '-' || ? || ' seconds'))`,
      )
      .run(id, archivedAgeSeconds, archivedAgeSeconds)
  }

  it('settles archived-expired sessions past TTL on the GC tick', () => {
    insertArchivedExpiredSession('long-dead', 7200)

    const poller = startHeartbeatPoller(testDb.db, eventLog, {
      intervalMs: 1000,
      graceSeconds: 300,
      gcTtlSeconds: 3600,
      gcIntervalTicks: 1,
    })
    vi.advanceTimersByTime(1000)

    expect(findSessionById(testDb.db, 'long-dead')).toBeNull()
    const history = testDb.db
      .prepare("SELECT id FROM sessions_history WHERE id = 'long-dead'")
      .all()
    expect(history).toHaveLength(1)
    poller.stop()
  })

  it('retries a deferred termination until the retained mail settles', () => {
    insertArchivedExpiredSession('dead-sender', 7200)
    testDb.db
      .prepare(
        `INSERT INTO sessions (id, purpose, working_dir, status, last_heartbeat)
         VALUES ('live-recipient', 'test', '/workspace', 'active', datetime('now'))`,
      )
      .run()
    testDb.db
      .prepare(
        `INSERT INTO messages (id, sender_id, receiver_id, content)
         VALUES ('pending-1', 'dead-sender', 'live-recipient', 'unread finding')`,
      )
      .run()

    const poller = startHeartbeatPoller(testDb.db, eventLog, {
      intervalMs: 1000,
      graceSeconds: 300,
      gcTtlSeconds: 3600,
      gcIntervalTicks: 1,
    })

    // First GC pass: deferred — the recipient's inbox is intact and the
    // sender's identity row survives so the mail keeps its sender.
    vi.advanceTimersByTime(1000)
    expect(findSessionById(testDb.db, 'dead-sender')).not.toBeNull()
    const mail = testDb.db
      .prepare("SELECT sender_id, receiver_id FROM messages WHERE id = 'pending-1'")
      .get() as { sender_id: string; receiver_id: string }
    expect(mail).toEqual({ sender_id: 'dead-sender', receiver_id: 'live-recipient' })

    // The recipient reads it — the next GC pass settles and purges.
    testDb.db.prepare("UPDATE messages SET read_at = datetime('now') WHERE id = 'pending-1'").run()
    vi.advanceTimersByTime(1000)
    expect(findSessionById(testDb.db, 'dead-sender')).toBeNull()
    const archived = testDb.db
      .prepare("SELECT id FROM messages_history WHERE id = 'pending-1'")
      .all()
    expect(archived).toHaveLength(1)
    poller.stop()
  })

  it('does not settle a revived (unarchived) session', () => {
    insertArchivedExpiredSession('came-back', 7200)
    reviveSession(testDb.db, 'came-back')

    const poller = startHeartbeatPoller(testDb.db, eventLog, {
      intervalMs: 1000,
      graceSeconds: 300,
      gcTtlSeconds: 3600,
      gcIntervalTicks: 1,
    })
    vi.advanceTimersByTime(1000)

    expect(findSessionById(testDb.db, 'came-back')!.status).toBe('active')
    poller.stop()
  })
})
