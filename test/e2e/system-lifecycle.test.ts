/**
 * E2E: Full broker lifecycle — startup, health, sessions, heartbeat, shutdown.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type Database from 'better-sqlite3'
import { openDatabase, closeDatabase } from '../../src/broker/storage/db.js'
import { createEventLog } from '../../src/broker/services/event-log.js'
import { createEventDispatcher } from '../../src/broker/event-dispatcher.js'
import { createBrokerServer, type BrokerServer } from '../../src/broker/server.js'

describe('System Lifecycle E2E', () => {
  let db: Database.Database
  let broker: BrokerServer
  let server: Server
  let baseUrl: string

  beforeAll(async () => {
    db = openDatabase(':memory:')
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(db, dispatcher)
    broker = createBrokerServer(db, eventLog, undefined, dispatcher, { authToken: null })
    server = createServer(broker.app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterAll(async () => {
    await broker.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    closeDatabase(db)
  })

  it('health endpoint responds with 200', async () => {
    const res = await fetch(`${baseUrl}/health/live`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('status', 'ok')
  })

  it('health/ready returns session counts', async () => {
    const res = await fetch(`${baseUrl}/health/ready`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string; sessions: { active: number } }
    expect(body.status).toBe('ok')
    expect(body.sessions).toBeDefined()
    expect(typeof body.sessions.active).toBe('number')
  })

  it('full session lifecycle: register → list → heartbeat → deregister', async () => {
    // Register session
    const regRes = await fetch(`${baseUrl}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'e2e-lifecycle-1', purpose: 'lifecycle test' }),
    })
    expect(regRes.status).toBe(200)
    const session = (await regRes.json()) as { id: string; status: string }
    expect(session.id).toBe('e2e-lifecycle-1')
    expect(session.status).toBe('active')

    // List sessions — should include the new session
    const listRes = await fetch(`${baseUrl}/api/list_sessions`)
    expect(listRes.status).toBe(200)
    const { sessions } = (await listRes.json()) as { sessions: Array<{ id: string }> }
    expect(sessions.some((s) => s.id === 'e2e-lifecycle-1')).toBe(true)

    // Send heartbeat
    const hbRes = await fetch(`${baseUrl}/api/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'e2e-lifecycle-1' }),
    })
    expect(hbRes.status).toBe(200)
    const hbBody = (await hbRes.json()) as { success: boolean }
    expect(hbBody.success).toBe(true)

    // Deregister
    const deregRes = await fetch(`${baseUrl}/api/deregister/e2e-lifecycle-1`, {
      method: 'POST',
    })
    expect(deregRes.status).toBe(200)
    const deregBody = (await deregRes.json()) as { success: boolean; id: string }
    expect(deregBody.success).toBe(true)
    expect(deregBody.id).toBe('e2e-lifecycle-1')

    // List again — session should be completed
    const list2Res = await fetch(`${baseUrl}/api/list_sessions?status=active`)
    const { sessions: active } = (await list2Res.json()) as { sessions: Array<{ id: string }> }
    expect(active.some((s) => s.id === 'e2e-lifecycle-1')).toBe(false)
  })

  it('deregistering non-existent session returns 404', async () => {
    const res = await fetch(`${baseUrl}/api/deregister/non-existent-session`, {
      method: 'POST',
    })
    expect(res.status).toBe(404)
  })

  it('heartbeat for non-existent session returns 404', async () => {
    const res = await fetch(`${baseUrl}/api/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'non-existent' }),
    })
    expect(res.status).toBe(404)
  })

  it('multiple sessions can coexist independently', async () => {
    const ids = ['e2e-multi-a', 'e2e-multi-b', 'e2e-multi-c']

    // Register all
    for (const id of ids) {
      const res = await fetch(`${baseUrl}/api/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, purpose: 'multi test' }),
      })
      expect(res.status).toBe(200)
    }

    // List — all should appear
    const listRes = await fetch(`${baseUrl}/api/list_sessions?status=active`)
    const { sessions } = (await listRes.json()) as { sessions: Array<{ id: string }> }
    for (const id of ids) {
      expect(sessions.some((s) => s.id === id)).toBe(true)
    }

    // Deregister one
    await fetch(`${baseUrl}/api/deregister/${ids[1]}`, { method: 'POST' })

    // Others still active
    const list2 = await fetch(`${baseUrl}/api/list_sessions?status=active`)
    const { sessions: remaining } = (await list2.json()) as { sessions: Array<{ id: string }> }
    expect(remaining.some((s) => s.id === ids[0])).toBe(true)
    expect(remaining.some((s) => s.id === ids[1])).toBe(false)
    expect(remaining.some((s) => s.id === ids[2])).toBe(true)

    // Cleanup
    for (const id of [ids[0]!, ids[2]!]) {
      await fetch(`${baseUrl}/api/deregister/${id}`, { method: 'POST' })
    }
  })

  it('events are recorded for session lifecycle', async () => {
    const res = await fetch(`${baseUrl}/api/events/since/0`)
    expect(res.status).toBe(200)
    const { events } = (await res.json()) as {
      events: Array<{ event_type: string; session_id: string }>
    }
    expect(events.length).toBeGreaterThan(0)
    // Should have session_registered and session_deregistered events
    expect(events.some((e) => e.event_type === 'session_registered')).toBe(true)
    expect(events.some((e) => e.event_type === 'session_deregistered')).toBe(true)
  })

  it('server port is freed after stop', async () => {
    // Start a second server on random port
    const db2 = openDatabase(':memory:')
    const dispatcher2 = createEventDispatcher()
    const eventLog2 = createEventLog(db2, dispatcher2)
    const broker2 = createBrokerServer(db2, eventLog2, undefined, dispatcher2, { authToken: null })
    const server2 = createServer(broker2.app)
    await new Promise<void>((resolve) => server2.listen(0, '127.0.0.1', resolve))
    const port = (server2.address() as AddressInfo).port
    const url2 = `http://127.0.0.1:${port}`

    // Verify it's running
    const alive = await fetch(`${url2}/health/live`)
    expect(alive.status).toBe(200)

    // Stop it
    await broker2.close()
    await new Promise<void>((resolve) => server2.close(() => resolve()))
    closeDatabase(db2)

    // Verify port is freed: bind a new server to the same port
    const server3 = createServer()
    await new Promise<void>((resolve, reject) => {
      server3.once('error', reject)
      server3.listen(port, '127.0.0.1', () => resolve())
    })
    await new Promise<void>((resolve) => server3.close(() => resolve()))
  })
})
