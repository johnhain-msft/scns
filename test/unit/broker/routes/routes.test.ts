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
): Promise<{ status: number; body: unknown }> {
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

describe('REST routes', () => {
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

  it('POST /api/register creates session', async () => {
    const res = await request(server, 'POST', '/api/register', {
      id: 'test-session-1',
      purpose: 'unit test',
    })
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown>
    expect(body.id).toBe('test-session-1')
  })

  it('POST /api/heartbeat updates heartbeat', async () => {
    // First register
    await request(server, 'POST', '/api/register', {
      id: 'hb-session',
      purpose: 'heartbeat test',
    })

    const res = await request(server, 'POST', '/api/heartbeat', {
      session_id: 'hb-session',
    })
    expect(res.status).toBe(200)
  })

  it('GET /api/list_sessions returns sessions', async () => {
    // Register a session first
    await request(server, 'POST', '/api/register', {
      id: 'list-sess-1',
      purpose: 'list test',
    })

    const res = await request(server, 'GET', '/api/list_sessions')
    expect(res.status).toBe(200)
    const body = res.body as { sessions: unknown[] }
    expect(body.sessions).toBeInstanceOf(Array)
    expect(body.sessions.length).toBeGreaterThanOrEqual(1)
  })

  it('POST /api/messages sends message', async () => {
    // Register sender and receiver
    await request(server, 'POST', '/api/register', {
      id: 'msg-sender',
      purpose: 'send messages',
    })
    await request(server, 'POST', '/api/register', {
      id: 'msg-receiver',
      purpose: 'receive messages',
    })

    const res = await request(server, 'POST', '/api/messages', {
      sender_id: 'msg-sender',
      receiver_id: 'msg-receiver',
      content: 'Hello from test',
    })
    expect(res.status).toBe(201)
    const body = res.body as Record<string, unknown>
    expect(body.id).toBeDefined()
  })

  it('GET /api/messages/:receiverId gets messages', async () => {
    await request(server, 'POST', '/api/register', {
      id: 'get-msg-sender',
      purpose: 'send messages',
    })
    await request(server, 'POST', '/api/register', {
      id: 'get-msg-receiver',
      purpose: 'receive messages',
    })

    await request(server, 'POST', '/api/messages', {
      sender_id: 'get-msg-sender',
      receiver_id: 'get-msg-receiver',
      content: 'test message',
    })

    const res = await request(server, 'GET', '/api/messages/get-msg-receiver')
    expect(res.status).toBe(200)
    const body = res.body as { messages: unknown[] }
    expect(body.messages).toBeInstanceOf(Array)
    expect(body.messages.length).toBeGreaterThanOrEqual(1)
  })

  it('POST /api/teams creates team', async () => {
    const res = await request(server, 'POST', '/api/teams', {
      name: 'test-team',
    })
    expect(res.status).toBe(201)
    const body = res.body as Record<string, unknown>
    expect(body.name).toBe('test-team')
  })

  it('GET /api/teams lists teams', async () => {
    await request(server, 'POST', '/api/teams', { name: 'list-team' })
    const res = await request(server, 'GET', '/api/teams')
    expect(res.status).toBe(200)
    const body = res.body as { teams: unknown[] }
    expect(body.teams).toBeInstanceOf(Array)
  })

  it('POST /api/teams/:id/members adds member', async () => {
    // Create team first
    const teamRes = await request(server, 'POST', '/api/teams', {
      name: 'member-team',
    })
    const teamId = (teamRes.body as Record<string, string>).id

    // Register session
    await request(server, 'POST', '/api/register', {
      id: 'member-session',
      purpose: 'join team',
    })

    const res = await request(server, 'POST', `/api/teams/${teamId}/members`, {
      session_id: 'member-session',
      name: 'test-agent',
    })
    expect(res.status).toBe(201)
  })

  it('POST /api/declare_intent declares intent', async () => {
    await request(server, 'POST', '/api/register', {
      id: 'intent-sess',
      purpose: 'intent test',
    })

    const res = await request(server, 'POST', '/api/declare_intent', {
      session_id: 'intent-sess',
      file: 'src/main.ts',
    })
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown>
    expect(body).toHaveProperty('conflict')
  })

  it('POST /api/state sets shared state', async () => {
    const res = await request(server, 'POST', '/api/state', {
      key: 'test-key',
      value: 'test-value',
    })
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown>
    expect(body.key).toBe('test-key')
  })

  it('GET /api/state/:key gets shared state', async () => {
    await request(server, 'POST', '/api/state', {
      key: 'get-key',
      value: 'get-value',
    })

    const res = await request(server, 'GET', '/api/state/get-key')
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown>
    expect(body.value).toBe('get-value')
  })

  it('DELETE /api/state/:key deletes shared state', async () => {
    await request(server, 'POST', '/api/state', {
      key: 'del-key',
      value: 'del-value',
    })

    const res = await request(server, 'DELETE', '/api/state/del-key')
    expect(res.status).toBe(200)
  })

  it('POST /api/deregister/:id deregisters session', async () => {
    await request(server, 'POST', '/api/register', {
      id: 'dereg-sess',
      purpose: 'deregister test',
    })

    const res = await request(server, 'POST', '/api/deregister/dereg-sess')
    expect(res.status).toBe(200)
  })

  it('GET /api/conflicts returns conflicts', async () => {
    const res = await request(server, 'GET', '/api/conflicts')
    expect(res.status).toBe(200)
    const body = res.body as { conflicts: unknown[] }
    expect(body.conflicts).toBeInstanceOf(Array)
  })

  it('GET /api/events/since/:afterId returns events', async () => {
    const res = await request(server, 'GET', '/api/events/since/0')
    expect(res.status).toBe(200)
    const body = res.body as { events: unknown[] }
    expect(body.events).toBeInstanceOf(Array)
  })
})
