import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { openDatabase, closeDatabase } from '../../../../src/broker/storage/db.js'
import { createEventLog } from '../../../../src/broker/services/event-log.js'
import { createBrokerServer, type BrokerServer } from '../../../../src/broker/server.js'
import { BrainAction, DecisionPriority } from '../../../../src/brain/state-types.js'
import type Database from 'better-sqlite3'

function request(
  server: Server,
  method: string,
  path: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: 'localhost',
        port: (server.address() as { port: number }).port,
        path,
        method,
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
    req.end()
  })
}

describe('GET /api/brain/status (Phase 13.12.14)', () => {
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
    const res = await request(server, 'GET', '/api/brain/status')
    expect(res.status).toBe(503)
    const body = res.body as Record<string, unknown>
    expect(body.error).toBeDefined()
    expect(body.available).toBe(false)
  })

  it('returns 503 when bound agent lacks getStatusSnapshot', async () => {
    broker.setBrainAgent({
      wake: async () => ({
        action: BrainAction.Idle,
        reason: 'x',
        confidence: 1,
        priority: DecisionPriority.Normal,
      }),
      isWakeInProgress: () => false,
    })
    const res = await request(server, 'GET', '/api/brain/status')
    expect(res.status).toBe(503)
  })

  it('returns the full snapshot shape with valid types', async () => {
    const lastTick = new Date().toISOString()
    broker.setBrainAgent({
      wake: async () => ({
        action: BrainAction.Idle,
        reason: 'x',
        confidence: 1,
        priority: DecisionPriority.Normal,
      }),
      isWakeInProgress: () => false,
      getStatusSnapshot: () => ({
        state: 'idle',
        lastTickAt: lastTick,
        ticksToday: 7,
        currentDecisionId: 42,
        queueDepth: 3,
        taskQueueDepth: 5,
        pendingSuggestions: 3,
        autonomy: 2,
        isWoken: false,
      }),
    })

    const res = await request(server, 'GET', '/api/brain/status')
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown>

    expect(body.state).toBe('idle')
    expect(body.lastTickAt).toBe(lastTick)
    expect(typeof body.ticksToday).toBe('number')
    expect(body.ticksToday).toBe(7)
    expect(body.currentDecisionId).toBe(42)
    expect(typeof body.queueDepth).toBe('number')
    expect(body.queueDepth).toBe(3)
    // R3: the REAL brain task queue depth is a first-class field; queueDepth
    // stays the legacy pending-suggestions alias the dashboard reads.
    expect(body.taskQueueDepth).toBe(5)
    expect(body.pendingSuggestions).toBe(3)
    expect(typeof body.autonomy).toBe('number')
    expect(body.autonomy).toBe(2)
    expect(body.isWoken).toBe(false)

    // All required keys present
    for (const k of [
      'state',
      'lastTickAt',
      'ticksToday',
      'currentDecisionId',
      'queueDepth',
      'taskQueueDepth',
      'pendingSuggestions',
      'autonomy',
      'isWoken',
    ]) {
      expect(body).toHaveProperty(k)
    }
  })

  it('accepts null currentDecisionId and lastTickAt', async () => {
    broker.setBrainAgent({
      wake: async () => ({
        action: BrainAction.Idle,
        reason: 'x',
        confidence: 1,
        priority: DecisionPriority.Normal,
      }),
      isWakeInProgress: () => true,
      getStatusSnapshot: () => ({
        state: 'starting',
        lastTickAt: null,
        ticksToday: 0,
        currentDecisionId: null,
        queueDepth: 0,
        taskQueueDepth: 0,
        pendingSuggestions: 0,
        autonomy: 0,
        isWoken: true,
      }),
    })
    const res = await request(server, 'GET', '/api/brain/status')
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown>
    expect(body.state).toBe('starting')
    expect(body.lastTickAt).toBeNull()
    expect(body.currentDecisionId).toBeNull()
    expect(body.isWoken).toBe(true)
  })

  it('returns 500 when getStatusSnapshot throws', async () => {
    broker.setBrainAgent({
      wake: async () => ({
        action: BrainAction.Idle,
        reason: 'x',
        confidence: 1,
        priority: DecisionPriority.Normal,
      }),
      isWakeInProgress: () => false,
      getStatusSnapshot: () => {
        throw new Error('snapshot boom')
      },
    })
    const res = await request(server, 'GET', '/api/brain/status')
    expect(res.status).toBe(500)
    const body = res.body as Record<string, unknown>
    expect(String(body.error)).toContain('snapshot boom')
  })
})
