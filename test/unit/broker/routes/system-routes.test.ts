import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import http from 'node:http'
import { openDatabase, closeDatabase } from '../../../../src/broker/storage/db.js'
import { createEventLog } from '../../../../src/broker/services/event-log.js'
import { createBrokerServer, type BrokerServer } from '../../../../src/broker/server.js'
import { ShutdownManager } from '../../../../src/broker/shutdown.js'
import type Database from 'better-sqlite3'

function request(
  server: Server,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
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
          ...headers,
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

describe('POST /api/system/stop', () => {
  let db: Database.Database
  let broker: BrokerServer
  let server: Server
  let shutdownManager: ShutdownManager

  beforeEach(async () => {
    db = openDatabase(':memory:')
    const eventLog = createEventLog(db)
    shutdownManager = new ShutdownManager()
    broker = createBrokerServer(db, eventLog, shutdownManager)
    server = createServer(broker.app)
    await new Promise<void>((resolve) => server.listen(0, resolve))
  })

  afterEach(async () => {
    await broker.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    closeDatabase(db)
  })

  it('returns acknowledged with shutdown message', async () => {
    vi.spyOn(shutdownManager, 'shutdown').mockResolvedValue(undefined)
    const res = await request(server, 'POST', '/api/system/stop')
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown>
    expect(body.acknowledged).toBe(true)
    expect(body.message).toBe('Shutdown initiated')
  })

  it('calls shutdown manager', async () => {
    const spy = vi.spyOn(shutdownManager, 'shutdown').mockResolvedValue(undefined)
    await request(server, 'POST', '/api/system/stop')
    // shutdownFn fires async after response, give it a tick
    await new Promise((r) => setTimeout(r, 50))
    expect(spy).toHaveBeenCalledOnce()
  })

  it('requires auth when broker has a token', async () => {
    await broker.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    closeDatabase(db)

    db = openDatabase(':memory:')
    const eventLog = createEventLog(db)
    shutdownManager = new ShutdownManager()
    broker = createBrokerServer(db, eventLog, shutdownManager, undefined, {
      authToken: 'test-secret',
    })
    server = createServer(broker.app)
    await new Promise<void>((resolve) => server.listen(0, resolve))

    const noAuth = await request(server, 'POST', '/api/system/stop')
    expect(noAuth.status).toBe(401)

    vi.spyOn(shutdownManager, 'shutdown').mockResolvedValue(undefined)
    const withAuth = await request(server, 'POST', '/api/system/stop', undefined, {
      Authorization: 'Bearer test-secret',
    })
    expect(withAuth.status).toBe(200)
    expect((withAuth.body as Record<string, unknown>).acknowledged).toBe(true)
  })
})
