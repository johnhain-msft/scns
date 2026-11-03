import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { openDatabase, closeDatabase } from '../../../../src/broker/storage/db.js'
import { createEventLog } from '../../../../src/broker/services/event-log.js'
import { createBrokerServer, type BrokerServer } from '../../../../src/broker/server.js'
import { BrainAction, DecisionPriority, type Decision } from '../../../../src/brain/state-types.js'
import type Database from 'better-sqlite3'

function request(
  server: Server,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined
    const req = httpRequest(
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

describe('POST /api/brain/wake', () => {
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

  it('returns 503 when no brain agent bound', async () => {
    const res = await request(server, 'POST', '/api/brain/wake')
    expect(res.status).toBe(503)
    const body = res.body as Record<string, unknown>
    expect(body.error).toBeDefined()
    expect(body.available).toBe(false)
  })

  it('invokes brain.wake() and returns the decision', async () => {
    const decision: Decision = {
      action: BrainAction.Idle,
      reason: 'nothing to do',
      confidence: 0.9,
      priority: DecisionPriority.Normal,
    }
    let wakeCalls = 0
    broker.setBrainAgent({
      wake: async () => {
        wakeCalls += 1
        return decision
      },
      isWakeInProgress: () => false,
    })

    const res = await request(server, 'POST', '/api/brain/wake')
    expect(res.status).toBe(200)
    expect(wakeCalls).toBe(1)
    const body = res.body as Record<string, unknown>
    expect(body.status).toBe('woken')
    expect(body.decision).toMatchObject({
      action: BrainAction.Idle,
      reason: 'nothing to do',
      confidence: 0.9,
    })
  })

  it('returns already-running without calling wake() when another wake is in progress', async () => {
    let wakeCalls = 0
    broker.setBrainAgent({
      wake: async () => {
        wakeCalls += 1
        return {
          action: BrainAction.Idle,
          reason: 'x',
          confidence: 1,
          priority: DecisionPriority.Normal,
        }
      },
      isWakeInProgress: () => true,
    })

    const res = await request(server, 'POST', '/api/brain/wake')
    expect(res.status).toBe(202)
    expect(wakeCalls).toBe(0)
    const body = res.body as Record<string, unknown>
    expect(body.status).toBe('already-running')
  })

  it('returns 500 when wake() throws', async () => {
    broker.setBrainAgent({
      wake: async () => {
        throw new Error('boom')
      },
      isWakeInProgress: () => false,
    })

    const res = await request(server, 'POST', '/api/brain/wake')
    expect(res.status).toBe(500)
    const body = res.body as Record<string, unknown>
    expect(body.error).toContain('boom')
  })
})
