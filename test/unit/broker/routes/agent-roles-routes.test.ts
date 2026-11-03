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
        res.on('data', (chunk: Buffer) => (responseBody += chunk.toString()))
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

describe('agent-roles (P4) routes', () => {
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

  it('GET /api/agent-roles lists the seeded builtin catalogue', async () => {
    const res = await request(server, 'GET', '/api/agent-roles')
    expect(res.status).toBe(200)
    const body = res.body as { roles: Array<Record<string, unknown>> }
    const names = new Set(body.roles.map((r) => r.role))
    expect(names.has('scns-manager')).toBe(true)
    expect(names.has('general')).toBe(true)
  })

  it('POST /api/agent-roles registers a novel role at runtime (self-innovate)', async () => {
    const res = await request(server, 'POST', '/api/agent-roles', {
      role: 'security-auditor',
      description: 'audits for vulns',
    })
    expect(res.status).toBe(201)

    const list = (await request(server, 'GET', '/api/agent-roles')).body as {
      roles: Array<Record<string, unknown>>
    }
    const row = list.roles.find((r) => r.role === 'security-auditor')
    expect(row).toBeDefined()
    expect(row!.builtin).toBe(false)

    // The novel role is now usable on a team member where the old CHECK would
    // have rejected it.
    const team = (await request(server, 'POST', '/api/teams', { name: 't-roles' }))
      .body as { id: string }
    db.exec("INSERT INTO sessions (id, purpose) VALUES ('s-aud', 'x')")
    const member = await request(server, 'POST', `/api/teams/${team.id}/members`, {
      session_id: 's-aud',
      name: 'auditor-1',
      role: 'security-auditor',
    })
    expect(member.status).toBeLessThan(400)
  })

  it('POST /api/agent-roles rejects an empty role with 400', async () => {
    const res = await request(server, 'POST', '/api/agent-roles', { role: '   ' })
    expect(res.status).toBe(400)
  })
})
