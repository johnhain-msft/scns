/**
 * Session retirement — issue #70.
 *
 * Behavioral contract: execution liveness, participant identity, and message
 * retention are separate concerns. Expiry never touches messages; termination
 * settles them retention-aware; no path may empty another participant's inbox
 * or leak directed mail to broadcast via the ON DELETE SET NULL receiver FK.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { TestDb } from '../../../helpers/db-harness.js'
import { createBrokerTestDb } from '../../../helpers/broker-db-harness.js'
import {
  expireSessionLease,
  terminateSession,
} from '../../../../src/broker/services/session-retirement.js'
import {
  findSessionById,
  reviveSession,
} from '../../../../src/broker/storage/repositories/session-repository.js'
import {
  findMessagesByReceiver,
  markMessageRead,
  setMessageDisposition,
} from '../../../../src/broker/storage/repositories/message-repository.js'

type Db = import('better-sqlite3').Database

function insertSession(db: Db, id: string, status = 'active'): void {
  db.prepare(
    `INSERT INTO sessions (id, purpose, working_dir, status, last_heartbeat)
     VALUES (?, 'test', '/workspace', ?, datetime('now'))`,
  ).run(id, status)
}

function insertMessage(
  db: Db,
  id: string,
  senderId: string,
  receiverId: string | null,
  opts?: { readAt?: boolean },
): void {
  db.prepare(
    `INSERT INTO messages (id, sender_id, receiver_id, content, read_at)
     VALUES (?, ?, ?, 'payload-' || ?, ?)`,
  ).run(id, senderId, receiverId, id, opts?.readAt ? new Date().toISOString() : null)
}

function liveMessageIds(db: Db): string[] {
  return (db.prepare('SELECT id FROM messages ORDER BY id').all() as Array<{ id: string }>).map(
    (r) => r.id,
  )
}

function historyMessageIds(db: Db): string[] {
  return (
    db.prepare('SELECT id FROM messages_history ORDER BY id').all() as Array<{ id: string }>
  ).map((r) => r.id)
}

describe('session-retirement (issue #70)', () => {
  let testDb: TestDb
  let db: Db

  beforeEach(() => {
    testDb = createBrokerTestDb()
    db = testDb.db
  })

  afterEach(() => {
    testDb.close()
  })

  describe('expireSessionLease', () => {
    it('retires the lease but preserves the identity row and every message', () => {
      insertSession(db, 'stale')
      insertSession(db, 'recipient')
      insertMessage(db, 'm1', 'stale', 'recipient')
      insertMessage(db, 'm2', 'recipient', 'stale')
      db.prepare(
        `INSERT INTO file_intents (session_id, file_path, intent) VALUES ('stale', '/f.ts', 'edit')`,
      ).run()
      db.prepare(
        `INSERT INTO shared_state (session_id, key, value) VALUES ('stale', 'k', '{}')`,
      ).run()

      const result = expireSessionLease(db, 'stale')

      expect(result.expired).toBe(true)
      expect(result.messages_preserved).toBe(2)
      const session = findSessionById(db, 'stale')
      expect(session!.status).toBe('expired')
      expect(liveMessageIds(db)).toEqual(['m1', 'm2'])
      // Directed mail is still PRIVATE to its recipient, not broadcast.
      const inbox = findMessagesByReceiver(db, 'recipient')
      expect(inbox.map((m) => m.id)).toEqual(['m1'])
      // Transient execution resources are released.
      expect(db.prepare('SELECT COUNT(*) c FROM file_intents').get()).toEqual({ c: 0 })
      expect(db.prepare('SELECT COUNT(*) c FROM shared_state').get()).toEqual({ c: 0 })
    })

    it('acceptance: a directed message survives sender expiry and reaches the revived recipient exactly', () => {
      insertSession(db, 'sender')
      insertSession(db, 'receiver')
      insertSession(db, 'bystander')
      insertMessage(db, 'finding-1', 'sender', 'receiver')

      // Sender terminates AND receiver waits past grace — both expire.
      expireSessionLease(db, 'sender')
      expireSessionLease(db, 'receiver')

      // Reconnect: the receiver revives and reads the EXACT message.
      reviveSession(db, 'receiver')
      const inbox = findMessagesByReceiver(db, 'receiver', { unreadOnly: true })
      expect(inbox).toHaveLength(1)
      expect(inbox[0]!.id).toBe('finding-1')
      expect(inbox[0]!.content).toBe('payload-finding-1')
      expect(inbox[0]!.sender_id).toBe('sender')

      // No unrelated inbox gained it.
      const bystanderInbox = findMessagesByReceiver(db, 'bystander')
      expect(bystanderInbox).toHaveLength(0)

      // Explicit disposition — distinct from the send having succeeded.
      const acked = setMessageDisposition(db, 'finding-1', 'accepted', 'will fix')
      expect(acked!.disposition).toBe('accepted')
      expect(acked!.read_at).not.toBeNull()
    })
  })

  describe('terminateSession', () => {
    it('archives the inbox and settled correspondence to history', () => {
      insertSession(db, 'dead')
      insertSession(db, 'peer')
      insertMessage(db, 'inbox-1', 'peer', 'dead')
      insertMessage(db, 'read-1', 'dead', 'peer', { readAt: true })
      insertMessage(db, 'bcast-1', 'dead', null)

      const result = terminateSession(db, 'dead')

      expect(result.purged).toBe(true)
      expect(result.deferred).toBe(false)
      expect(result.messages_archived).toBe(3)
      expect(findSessionById(db, 'dead')).toBeNull()
      expect(historyMessageIds(db)).toEqual(['bcast-1', 'inbox-1', 'read-1'])
      expect(liveMessageIds(db)).toEqual([])
      const history = db.prepare("SELECT id FROM sessions_history WHERE id = 'dead'").all()
      expect(history).toHaveLength(1)
    })

    it('defers the physical delete while unread directed mail to a live participant exists', () => {
      insertSession(db, 'dead')
      insertSession(db, 'recipient')
      insertMessage(db, 'pending-1', 'dead', 'recipient')

      const first = terminateSession(db, 'dead')

      expect(first.purged).toBe(false)
      expect(first.deferred).toBe(true)
      expect(first.messages_retained).toBe(1)
      // Identity row retained so the mail keeps its sender; still non-routable.
      expect(findSessionById(db, 'dead')!.status).toBe('expired')
      // The recipient's inbox is intact and private.
      const inbox = findMessagesByReceiver(db, 'recipient', { unreadOnly: true })
      expect(inbox.map((m) => m.id)).toEqual(['pending-1'])
      expect(inbox[0]!.sender_id).toBe('dead')

      // Once the recipient reads it, the retry settles and purges.
      markMessageRead(db, 'pending-1')
      const second = terminateSession(db, 'dead')
      expect(second.purged).toBe(true)
      expect(findSessionById(db, 'dead')).toBeNull()
      expect(historyMessageIds(db)).toContain('pending-1')
    })

    it('naive-fix hazard control: terminating a RECEIVER never leaks its mail into bystander inboxes', () => {
      // The issue's live-confirmed control: keeping mail but deleting its
      // recipient turns receiver_id NULL (ON DELETE SET NULL), which
      // findMessagesByReceiver reads as broadcast — a privacy leak.
      insertSession(db, 'sender')
      insertSession(db, 'doomed-receiver')
      insertSession(db, 'bystander')
      insertMessage(db, 'private-1', 'sender', 'doomed-receiver')

      expect(findMessagesByReceiver(db, 'bystander')).toHaveLength(0)

      const result = terminateSession(db, 'doomed-receiver')

      // The receiver's inbox settles WITH the receiver — archived, not
      // orphaned in the live table with a nulled receiver.
      expect(result.purged).toBe(true)
      expect(historyMessageIds(db)).toContain('private-1')
      const bystanderInboxAfter = findMessagesByReceiver(db, 'bystander')
      expect(bystanderInboxAfter).toHaveLength(0)
      const storedReceiver = db
        .prepare("SELECT receiver_id FROM messages_history WHERE id = 'private-1'")
        .get() as { receiver_id: string | null }
      expect(storedReceiver.receiver_id).toBe('doomed-receiver')
    })

    it('two dead correspondents settle across successive passes without stranding rows', () => {
      insertSession(db, 'dead-a')
      insertSession(db, 'dead-b')
      insertMessage(db, 'a-to-b', 'dead-a', 'dead-b')

      // A cannot purge yet — its unread mail sits in B's live inbox.
      expect(terminateSession(db, 'dead-a').deferred).toBe(true)
      // B terminates: its inbox (the pending message) archives with it.
      expect(terminateSession(db, 'dead-b').purged).toBe(true)
      // Now A has nothing retained and purges cleanly.
      expect(terminateSession(db, 'dead-a').purged).toBe(true)
      expect(liveMessageIds(db)).toEqual([])
      expect(historyMessageIds(db)).toContain('a-to-b')
    })

    it('is a no-op for an unknown session', () => {
      const result = terminateSession(db, 'never-existed')
      expect(result).toEqual({
        purged: false,
        deferred: false,
        messages_archived: 0,
        messages_retained: 0,
      })
    })
  })
})

// ── Issue #70 review S4 — the acknowledgement record survives settlement ──
describe('settlement preserves the acknowledgement record (issue #70 S4)', () => {
  let testDb: TestDb
  let db: Db

  beforeEach(() => {
    testDb = createBrokerTestDb()
    db = testDb.db
  })

  afterEach(() => {
    testDb.close()
  })

  it('a disposed message carries its verdict, note, and delivery into messages_history', () => {
    insertSession(db, 'dead')
    insertSession(db, 'peer')
    insertMessage(db, 'verdict-1', 'dead', 'peer')
    db.prepare("UPDATE messages SET delivered_at = datetime('now') WHERE id = 'verdict-1'").run()
    setMessageDisposition(db, 'verdict-1', 'rejected', 'wrong root cause')

    const result = terminateSession(db, 'dead')
    expect(result.purged).toBe(true)

    const archived = db
      .prepare(
        'SELECT disposition, disposition_note, delivered_at, read_at FROM messages_history WHERE id = ?',
      )
      .get('verdict-1') as {
      disposition: string | null
      disposition_note: string | null
      delivered_at: string | null
      read_at: string | null
    }
    expect(archived.disposition).toBe('rejected')
    expect(archived.disposition_note).toBe('wrong root cause')
    expect(archived.delivered_at).not.toBeNull()
    expect(archived.read_at).not.toBeNull()
  })

  it("an explicitly 'deferred' message counts as settled (deliberate — see header)", () => {
    insertSession(db, 'dead')
    insertSession(db, 'peer')
    insertMessage(db, 'deferred-1', 'dead', 'peer')
    setMessageDisposition(db, 'deferred-1', 'deferred', 'needs repro')

    const result = terminateSession(db, 'dead')
    expect(result.purged).toBe(true)
    const archived = db
      .prepare('SELECT disposition FROM messages_history WHERE id = ?')
      .get('deferred-1') as { disposition: string | null }
    expect(archived.disposition).toBe('deferred')
  })
})
