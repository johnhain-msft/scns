/**
 * Issue #70 — REST contract for durable participants and message lifecycle.
 *
 * Covers: register-revival of known ids, heartbeat revival of expired leases,
 * distinguishable participant errors on send, idempotent client message ids,
 * delivery receipts vs read vs explicit disposition, and the {messages:[...]}
 * envelope. All writes target an in-memory database.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import http from 'node:http'
import { openDatabase, closeDatabase } from '../../../../src/broker/storage/db.js'
import { createEventLog } from '../../../../src/broker/services/event-log.js'
import { createBrokerServer, type BrokerServer } from '../../../../src/broker/server.js'
import type Database from 'better-sqlite3'

function request(
  server: Server,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined
    const req = http.request(
      {
        hostname: 'localhost',
        port: (server.address() as { port: number }).port,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let responseBody = ''
        res.on('data', (chunk: Buffer) => {
          responseBody += chunk.toString()
        })
        res.on('end', () => {
          let parsed: unknown
          try {
            parsed = JSON.parse(responseBody)
          } catch {
            parsed = responseBody
          }
          resolve({ status: res.statusCode!, body: parsed })
        })
      },
    )
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

describe('issue #70 message lifecycle routes', () => {
  let db: Database.Database
  let broker: BrokerServer
  let server: Server

  beforeEach(async () => {
    db = openDatabase(':memory:')
    const eventLog = createEventLog(db)
    broker = createBrokerServer(db, eventLog)
    server = createServer(broker.app)
    await new Promise<void>((resolve) => server.listen(0, resolve))
  })

  afterEach(async () => {
    await broker.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    closeDatabase(db)
  })

  async function register(id: string): Promise<void> {
    const res = await request(server, 'POST', '/api/register', { id, purpose: 'test' })
    expect(res.status).toBe(200)
  }

  function forceStatus(id: string, status: string): void {
    db.prepare("UPDATE sessions SET status = ?, archived_at = datetime('now') WHERE id = ?").run(
      status,
      id,
    )
  }

  describe('participant identity is durable', () => {
    it('re-registering a known id revives it instead of failing', async () => {
      await register('sess-a')
      forceStatus('sess-a', 'expired')

      const res = await request(server, 'POST', '/api/register', {
        id: 'sess-a',
        purpose: 'test',
      })
      expect(res.status).toBe(200)
      expect(res.body.revived).toBe(true)
      expect(res.body.status).toBe('active')
    })

    it('re-registering revives even a completed (session-end) id — resume support', async () => {
      await register('sess-resume')
      forceStatus('sess-resume', 'completed')

      const res = await request(server, 'POST', '/api/register', {
        id: 'sess-resume',
        purpose: 'test',
      })
      expect(res.status).toBe(200)
      expect(res.body.status).toBe('active')
    })

    it('heartbeat revives an expired lease but never resurrects a completed session', async () => {
      await register('sess-hb')
      forceStatus('sess-hb', 'expired')

      const revived = await request(server, 'POST', '/api/heartbeat', { session_id: 'sess-hb' })
      expect(revived.status).toBe(200)
      expect(revived.body.revived).toBe(true)

      forceStatus('sess-hb', 'completed')
      const completed = await request(server, 'POST', '/api/heartbeat', { session_id: 'sess-hb' })
      expect(completed.status).toBe(200)
      expect(completed.body.revived).toBeUndefined()
      const row = db.prepare("SELECT status FROM sessions WHERE id = 'sess-hb'").get() as {
        status: string
      }
      expect(row.status).toBe('completed')
    })

    it('heartbeat for an unknown session is a distinguishable 404, not a silent failure', async () => {
      const res = await request(server, 'POST', '/api/heartbeat', { session_id: 'ghost' })
      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('NOT_FOUND')
    })
  })

  describe('send validation (issue #70: no collapsed errors)', () => {
    it('unknown sender → 404 UNKNOWN_PARTICIPANT with an actionable message', async () => {
      const res = await request(server, 'POST', '/api/messages', {
        sender_id: 'nobody',
        receiver_id: 'nobody-else',
        content: 'hello',
      })
      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('UNKNOWN_PARTICIPANT')
      expect(res.body.error.message).toContain('nobody')
      expect(res.body.error.message).toContain('register')
    })

    it('unknown receiver → 404 UNKNOWN_PARTICIPANT naming the receiver', async () => {
      await register('known-sender')
      const res = await request(server, 'POST', '/api/messages', {
        sender_id: 'known-sender',
        receiver_id: 'ghost-receiver',
        content: 'hello',
      })
      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('UNKNOWN_PARTICIPANT')
      expect(res.body.error.message).toContain('ghost-receiver')
    })

    it('an EXPIRED receiver still accepts mail — identity outlives the lease', async () => {
      await register('sender-1')
      await register('waiting-receiver')
      forceStatus('waiting-receiver', 'expired')

      const res = await request(server, 'POST', '/api/messages', {
        sender_id: 'sender-1',
        receiver_id: 'waiting-receiver',
        content: 'blocking finding',
      })
      expect(res.status).toBe(201)
      expect(res.body.receiver_status).toBe('expired')
      // Acceptance is not delivery: nothing marks it delivered/read/disposed.
      expect(res.body.delivered_at).toBeNull()
      expect(res.body.read_at).toBeNull()
      expect(res.body.disposition).toBeNull()
    })
  })

  describe('idempotent sends (client_message_id)', () => {
    it('replaying the same id + payload lands as ONE logical message', async () => {
      await register('s1')
      await register('r1')
      const body = {
        sender_id: 's1',
        receiver_id: 'r1',
        content: 'retry me',
        client_message_id: 'cmid-1',
      }
      const first = await request(server, 'POST', '/api/messages', body)
      expect(first.status).toBe(201)
      expect(first.body.replayed).toBe(false)

      const second = await request(server, 'POST', '/api/messages', body)
      expect(second.status).toBe(200)
      expect(second.body.replayed).toBe(true)
      expect(second.body.id).toBe(first.body.id)

      const count = db.prepare('SELECT COUNT(*) c FROM messages').get() as { c: number }
      expect(count.c).toBe(1)
    })

    it('a retry that changes threading/story linkage is a conflict, not a silent replay (review S3)', async () => {
      await register('s-thread')
      await register('r-thread')
      const first = await request(server, 'POST', '/api/messages', {
        sender_id: 's-thread',
        receiver_id: 'r-thread',
        content: 'same content',
        client_message_id: 'cmid-thread',
      })
      expect(first.status).toBe(201)

      const conflict = await request(server, 'POST', '/api/messages', {
        sender_id: 's-thread',
        receiver_id: 'r-thread',
        content: 'same content',
        reply_to: first.body.id,
        client_message_id: 'cmid-thread',
      })
      expect(conflict.status).toBe(409)
    })

    it('conflicting reuse of an id is rejected with 409', async () => {
      await register('s2')
      await register('r2')
      await request(server, 'POST', '/api/messages', {
        sender_id: 's2',
        receiver_id: 'r2',
        content: 'original',
        client_message_id: 'cmid-2',
      })
      const conflict = await request(server, 'POST', '/api/messages', {
        sender_id: 's2',
        receiver_id: 'r2',
        content: 'DIFFERENT payload',
        client_message_id: 'cmid-2',
      })
      expect(conflict.status).toBe(409)
      expect(conflict.body.error.code).toBe('CONFLICT')
    })
  })

  describe('delivery, read, and disposition are distinct', () => {
    it('mark-delivered stamps directed mail for its recipient only — broadcasts are untouched', async () => {
      await register('s3')
      await register('r3')
      const directed = await request(server, 'POST', '/api/messages', {
        sender_id: 's3',
        receiver_id: 'r3',
        content: 'directed',
      })
      const broadcast = await request(server, 'POST', '/api/messages', {
        sender_id: 's3',
        content: 'broadcast',
      })

      const res = await request(server, 'POST', '/api/messages/mark-delivered', {
        message_ids: [directed.body.id, broadcast.body.id],
        receiver_id: 'r3',
      })
      expect(res.status).toBe(200)
      expect(res.body.delivered).toBe(1)

      const rows = db
        .prepare('SELECT id, delivered_at, read_at FROM messages ORDER BY created_at')
        .all() as Array<{ id: string; delivered_at: string | null; read_at: string | null }>
      const directedRow = rows.find((r) => r.id === directed.body.id)!
      const broadcastRow = rows.find((r) => r.id === broadcast.body.id)!
      expect(directedRow.delivered_at).not.toBeNull()
      // Delivery is NOT read.
      expect(directedRow.read_at).toBeNull()
      expect(broadcastRow.delivered_at).toBeNull()
    })

    it('ack refuses broadcasts — dispositions are per-recipient (review S2b)', async () => {
      await register('s-bcast')
      const broadcast = await request(server, 'POST', '/api/messages', {
        sender_id: 's-bcast',
        content: 'to everyone',
      })

      const ack = await request(server, 'POST', '/api/messages/ack', {
        message_id: broadcast.body.id,
        disposition: 'accepted',
      })
      expect(ack.status).toBe(409)
      expect(ack.body.error.code).toBe('BROADCAST_NOT_ACKABLE')
      // The broadcast is untouched — still unread for every inbox.
      const row = db
        .prepare('SELECT read_at, disposition FROM messages WHERE id = ?')
        .get(broadcast.body.id) as { read_at: string | null; disposition: string | null }
      expect(row.read_at).toBeNull()
      expect(row.disposition).toBeNull()
    })

    it('ack records an explicit disposition; unknown message is 404', async () => {
      await register('s4')
      await register('r4')
      const sent = await request(server, 'POST', '/api/messages', {
        sender_id: 's4',
        receiver_id: 'r4',
        content: 'please review',
      })

      const ack = await request(server, 'POST', '/api/messages/ack', {
        message_id: sent.body.id,
        disposition: 'deferred',
        note: 'needs a repro first',
      })
      expect(ack.status).toBe(200)
      expect(ack.body.message.disposition).toBe('deferred')
      expect(ack.body.message.disposition_note).toBe('needs a repro first')
      expect(ack.body.message.read_at).not.toBeNull()

      const missing = await request(server, 'POST', '/api/messages/ack', {
        message_id: 'no-such-message',
        disposition: 'accepted',
      })
      expect(missing.status).toBe(404)
    })
  })

  describe('mailbox contract', () => {
    it('GET /api/messages/:receiverId serializes the {messages:[...]} envelope', async () => {
      await register('s5')
      await register('r5')
      await request(server, 'POST', '/api/messages', {
        sender_id: 's5',
        receiver_id: 'r5',
        content: 'enveloped',
      })

      const res = await request(server, 'GET', '/api/messages/r5?unread_only=true')
      expect(res.status).toBe(200)
      expect(Array.isArray(res.body.messages)).toBe(true)
      expect(res.body.messages).toHaveLength(1)
      expect(res.body.messages[0].content).toBe('enveloped')
    })
  })
})
