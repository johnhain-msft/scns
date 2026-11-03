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

describe('multi-project (P3) routes', () => {
  let db: Database.Database
  let broker: BrokerServer
  let server: Server

  beforeEach(async () => {
    db = openDatabase(':memory:')
    const eventLog = createEventLog(db)
    // Bind the broker to a project id (as startup.ts does from cfg.projectId).
    broker = createBrokerServer(db, eventLog, undefined, undefined, {
      projectId: 'proj-test',
    })
    server = createServer(broker.app)
    await new Promise<void>((resolve) => server.listen(0, resolve))
  })

  afterEach(async () => {
    await broker.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    closeDatabase(db)
  })

  it('stamps project_id on teams created via POST /api/teams', async () => {
    const res = await request(server, 'POST', '/api/teams', { name: 'team-x' })
    expect(res.status).toBe(201)
    const team = res.body as Record<string, unknown>
    expect(team.project_id).toBe('proj-test')
  })

  it('stamps project_id on sessions created via POST /api/register', async () => {
    const res = await request(server, 'POST', '/api/register', {
      id: 'sess-p3',
      purpose: 'x',
    })
    expect(res.status).toBe(200)
    const row = db.prepare('SELECT project_id FROM sessions WHERE id = ?').get('sess-p3') as {
      project_id: string
    }
    expect(row.project_id).toBe('proj-test')
  })

  it('GET /api/admin/projects returns the supervisor view with current project', async () => {
    await request(server, 'POST', '/api/teams', { name: 'team-y' })
    const res = await request(server, 'GET', '/api/admin/projects')
    expect(res.status).toBe(200)
    const body = res.body as { current: string; projects: Array<Record<string, unknown>> }
    expect(body.current).toBe('proj-test')
    const proj = body.projects.find((p) => p.projectId === 'proj-test')
    expect(proj).toBeDefined()
    expect(proj!.teams).toBe(1)
  })
})
