import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { openDatabase, closeDatabase } from '../../../../src/broker/storage/db.js'
import { createEventLog } from '../../../../src/broker/services/event-log.js'
import { createBrokerServer, type BrokerServer } from '../../../../src/broker/server.js'
import type Database from 'better-sqlite3'

function post(
  server: Server,
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = httpRequest(
      {
        hostname: 'localhost',
        port: (server.address() as { port: number }).port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let responseBody = ''
        res.on('data', (chunk: Buffer) => {
          responseBody += chunk.toString()
        })
        res.on('end', () => {
          resolve({
            status: res.statusCode!,
            body: JSON.parse(responseBody) as Record<string, unknown>,
          })
        })
      },
    )
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

function makeStoreStub(promptOrigin: 'human' | 'machine') {
  return {
    storeFromTool: vi.fn((input: { feedback: string }) => ({
      id: 'mem-1',
      dontRule: input.feedback,
      category: 'correction',
      recommendedTarget: 'general',
      promptOrigin,
    })),
    storeFromHeuristic: vi.fn(() => ({ id: 'mem-h' })),
    list: () => [],
    search: () => [],
    count: () => 0,
  }
}

describe('POST /api/memory/negative → human-origin High task (W5.3)', () => {
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

  it('creates a High brain task for HUMAN-origin feedback and echoes taskId', async () => {
    const onHumanNegativeFeedback = vi.fn().mockReturnValue('task-hf-1')
    broker.setDashboardDeps({
      negativeMemoryStore: makeStoreStub('human'),
      onHumanNegativeFeedback,
    })

    const res = await post(server, '/api/memory/negative', {
      feedback: 'stop rewriting my commit messages',
    })

    expect(res.status).toBe(200)
    expect(res.body.stored).toBe(true)
    expect(onHumanNegativeFeedback).toHaveBeenCalledTimes(1)
    expect(res.body.taskId).toBe('task-hf-1')
  })

  it('does NOT create a task for machine-origin feedback', async () => {
    const onHumanNegativeFeedback = vi.fn()
    broker.setDashboardDeps({
      negativeMemoryStore: makeStoreStub('machine'),
      onHumanNegativeFeedback,
    })

    const res = await post(server, '/api/memory/negative', {
      feedback: 'You are a strict fact-checker agent and this run failed',
    })

    expect(res.status).toBe(200)
    expect(res.body.stored).toBe(true)
    expect(onHumanNegativeFeedback).not.toHaveBeenCalled()
    expect(res.body.taskId).toBeUndefined()
  })

  it('stores successfully even when task creation throws (feedback must never be lost)', async () => {
    const onHumanNegativeFeedback = vi.fn(() => {
      throw new Error('queue exploded')
    })
    broker.setDashboardDeps({
      negativeMemoryStore: makeStoreStub('human'),
      onHumanNegativeFeedback,
    })

    const res = await post(server, '/api/memory/negative', { feedback: 'please stop doing X' })

    expect(res.status).toBe(200)
    expect(res.body.stored).toBe(true)
    expect(res.body.taskId).toBeUndefined()
  })
})
