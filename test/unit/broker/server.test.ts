import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { openDatabase, closeDatabase } from '../../../src/broker/storage/db.js'
import { createEventLog } from '../../../src/broker/services/event-log.js'
import { createBrokerServer, type BrokerServer } from '../../../src/broker/server.js'
import type Database from 'better-sqlite3'

function request(
  server: Server,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, 'http://localhost')
    const data = body ? JSON.stringify(body) : undefined
    const req = httpRequest(
      {
        hostname: 'localhost',
        port: (server.address() as { port: number }).port,
        path: url.pathname + url.search,
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
          const headers: Record<string, string> = {}
          for (const [key, value] of Object.entries(res.headers)) {
            if (typeof value === 'string') headers[key] = value
          }
          resolve({ status: res.statusCode!, body: parsed, headers })
        })
      },
    )
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

describe('createBrokerServer', () => {
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

  it('returns app + transports + close', () => {
    expect(broker.app).toBeDefined()
    expect(broker.transports).toBeInstanceOf(Map)
    expect(typeof broker.close).toBe('function')
  })

  it('health liveness returns ok', async () => {
    const res = await request(server, 'GET', '/health/live')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'ok' })
  })

  it('health readiness returns version + uptime + dependencies', async () => {
    const res = await request(server, 'GET', '/health/ready')
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown>
    expect(body.version).toBeDefined()
    expect(body.uptime_seconds).toBeDefined()
    expect(body.dependencies).toBeDefined()
  })

  it('unknown route returns 404', async () => {
    const res = await request(server, 'GET', '/api/nonexistent')
    expect(res.status).toBe(404)
  })

  it('close cleans up transports', async () => {
    await broker.close()
    expect(broker.transports.size).toBe(0)
  })

  it('CORS headers are set', async () => {
    const res = await request(server, 'GET', '/health/live')
    expect(res.headers['access-control-allow-origin']).toBe('*')
  })

  it('/api/metrics/runtime returns rss, heap, event-loop, spawner stats', async () => {
    const res = await request(server, 'GET', '/api/metrics/runtime')
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown>
    expect(body.memory).toBeDefined()
    expect((body.memory as Record<string, unknown>).rssMb).toBeTypeOf('number')
    expect(body.eventLoop).toBeDefined()
    // spawner is null in this test harness (no agentSpawner supplied)
    expect('spawner' in body).toBe(true)
  })
})
