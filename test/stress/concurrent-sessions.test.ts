/**
 * Stress: Concurrent sessions — 50 sessions, mass heartbeats, 100 messages.
 *
 * The broker uses a 100 req/sec rate limiter. We space batches with
 * small delays so the stress test exercises throughput without tripping
 * the limiter, which is a separate unit-tested concern.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type Database from 'better-sqlite3'
import { openDatabase, closeDatabase } from '../../src/broker/storage/db.js'
import { createEventLog } from '../../src/broker/services/event-log.js'
import { createEventDispatcher } from '../../src/broker/event-dispatcher.js'
import { createBrokerServer, type BrokerServer } from '../../src/broker/server.js'

const SESSION_COUNT = 50
const MESSAGE_COUNT = 100
const BATCH_SIZE = 20
const BATCH_DELAY_MS = 250

/** Wait for rate limit window to reset */
function waitForWindow(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS))
}

describe('Concurrent Sessions Stress Test', { timeout: 60_000 }, () => {
  let db: Database.Database
  let broker: BrokerServer
  let server: Server
  let baseUrl: string
  const sessionIds: string[] = []

  beforeAll(async () => {
    db = openDatabase(':memory:')
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(db, dispatcher)
    broker = createBrokerServer(db, eventLog, undefined, dispatcher, { authToken: null })
    server = createServer(broker.app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${addr.port}`

    for (let i = 0; i < SESSION_COUNT; i++) {
      sessionIds.push(`stress-session-${String(i).padStart(3, '0')}`)
    }
  })

  afterAll(async () => {
    await broker.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    closeDatabase(db)
  })

  it(`registers ${SESSION_COUNT} sessions in rapid succession`, async () => {
    const start = performance.now()

    for (let i = 0; i < sessionIds.length; i += BATCH_SIZE) {
      if (i > 0) await waitForWindow()
      const batch = sessionIds.slice(i, i + BATCH_SIZE)
      const results = await Promise.all(
        batch.map((id) =>
          fetch(`${baseUrl}/api/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, purpose: 'stress test' }),
          }),
        ),
      )
      for (const res of results) {
        expect(res.status).toBe(200)
      }
    }

    const elapsed = performance.now() - start
    console.log(
      `Registered ${SESSION_COUNT} sessions in ${elapsed.toFixed(1)}ms (${(SESSION_COUNT / (elapsed / 1000)).toFixed(0)} sessions/sec)`,
    )

    // Verify all sessions are active
    const listRes = await fetch(`${baseUrl}/api/list_sessions?status=active`)
    const { sessions } = (await listRes.json()) as {
      sessions: Array<{ id: string }>
    }
    for (const id of sessionIds) {
      expect(sessions.some((s) => s.id === id)).toBe(true)
    }
  })

  it(`sends ${SESSION_COUNT} concurrent heartbeats`, async () => {
    const start = performance.now()

    for (let i = 0; i < sessionIds.length; i += BATCH_SIZE) {
      if (i > 0) await waitForWindow()
      const batch = sessionIds.slice(i, i + BATCH_SIZE)
      const results = await Promise.all(
        batch.map((id) =>
          fetch(`${baseUrl}/api/heartbeat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: id }),
          }),
        ),
      )
      for (const res of results) {
        expect(res.status).toBe(200)
      }
    }

    const elapsed = performance.now() - start
    console.log(
      `Sent ${SESSION_COUNT} heartbeats in ${elapsed.toFixed(1)}ms (${(SESSION_COUNT / (elapsed / 1000)).toFixed(0)} heartbeats/sec)`,
    )
  })

  it(`sends and verifies ${MESSAGE_COUNT} messages between random pairs`, async () => {
    const start = performance.now()
    const sentMessages: Array<{
      id: string
      sender: string
      receiver: string
      content: string
    }> = []

    for (let i = 0; i < MESSAGE_COUNT; i += BATCH_SIZE) {
      if (i > 0) await waitForWindow()
      const batch = Array.from({ length: Math.min(BATCH_SIZE, MESSAGE_COUNT - i) }, (_, j) => {
        const idx = i + j
        const senderIdx = idx % SESSION_COUNT
        const receiverIdx = (idx + 1 + Math.floor(idx / SESSION_COUNT)) % SESSION_COUNT
        return {
          sender: sessionIds[senderIdx]!,
          receiver: sessionIds[receiverIdx]!,
          content: `Stress message #${idx}`,
        }
      })

      const results = await Promise.all(
        batch.map(async (msg) => {
          const res = await fetch(`${baseUrl}/api/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sender_id: msg.sender,
              receiver_id: msg.receiver,
              content: msg.content,
            }),
          })
          expect(res.status).toBe(201)
          const body = (await res.json()) as { id: string }
          return { ...msg, id: body.id }
        }),
      )
      sentMessages.push(...results)
    }

    const sendElapsed = performance.now() - start
    console.log(
      `Sent ${MESSAGE_COUNT} messages in ${sendElapsed.toFixed(1)}ms (${(MESSAGE_COUNT / (sendElapsed / 1000)).toFixed(0)} msgs/sec)`,
    )

    // Verify delivery: check each receiver got their messages
    const receiveStart = performance.now()
    const receiverMap = new Map<string, string[]>()
    for (const msg of sentMessages) {
      const existing = receiverMap.get(msg.receiver) ?? []
      existing.push(msg.content)
      receiverMap.set(msg.receiver, existing)
    }

    // Sample verification — check a subset of receivers
    const receiversToCheck = [...receiverMap.keys()].slice(0, 10)
    for (const receiverId of receiversToCheck) {
      const res = await fetch(`${baseUrl}/api/messages/${receiverId}`)
      expect(res.status).toBe(200)
      const { messages } = (await res.json()) as {
        messages: Array<{ content: string }>
      }
      const expected = receiverMap.get(receiverId)!
      for (const content of expected) {
        expect(messages.some((m) => m.content === content)).toBe(true)
      }
    }

    const receiveElapsed = performance.now() - receiveStart
    console.log(
      `Verified delivery for ${receiversToCheck.length} receivers in ${receiveElapsed.toFixed(1)}ms`,
    )
  })

  it('all sessions remain active after load', async () => {
    await waitForWindow()
    const res = await fetch(`${baseUrl}/api/list_sessions?status=active`)
    const body = (await res.json()) as { sessions: Array<{ id: string }> }
    expect(body.sessions.length).toBeGreaterThanOrEqual(SESSION_COUNT)
    for (const id of sessionIds) {
      expect(body.sessions.some((s) => s.id === id)).toBe(true)
    }
  })

  it(`deregisters all ${SESSION_COUNT} sessions`, async () => {
    const start = performance.now()

    for (let i = 0; i < sessionIds.length; i += BATCH_SIZE) {
      if (i > 0) await waitForWindow()
      const batch = sessionIds.slice(i, i + BATCH_SIZE)
      const results = await Promise.all(
        batch.map((id) => fetch(`${baseUrl}/api/deregister/${id}`, { method: 'POST' })),
      )
      for (const res of results) {
        expect(res.status).toBe(200)
      }
    }

    const elapsed = performance.now() - start
    console.log(`Deregistered ${SESSION_COUNT} sessions in ${elapsed.toFixed(1)}ms`)

    // Verify clean state
    await waitForWindow()
    const listRes = await fetch(`${baseUrl}/api/list_sessions?status=active`)
    const { sessions } = (await listRes.json()) as {
      sessions: Array<{ id: string }>
    }
    const stressSessions = sessions.filter((s) => s.id.startsWith('stress-session-'))
    expect(stressSessions).toHaveLength(0)
  })
})
