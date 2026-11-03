/**
 * WI-6 — POST /api/scheduler/tasks/:id/run must EXECUTE the task's handler.
 *
 * The old body only recorded a success history row — a "run now" that lied
 * (found live: triggering memory-reindex from the E2E harness embedded
 * nothing). With the schedulerRunNow dep wired the route runs the real
 * handler; without it the legacy record-only behavior remains.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import http from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { openDatabase, closeDatabase } from '../../../../src/broker/storage/db.js'
import { seedDefaultTasks } from '../../../../src/broker/storage/repositories/scheduler-repository.js'
import { createEventLog } from '../../../../src/broker/services/event-log.js'
import { registerDashboardRoutes } from '../../../../src/broker/routes/dashboard-routes.js'
import { createErrorHandler } from '../../../../src/broker/middleware/error-handler.js'
import type Database from 'better-sqlite3'

let db: Database.Database
let server: Server
let executed: string[]

function post(path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: (server.address() as AddressInfo).port,
        path,
        method: 'POST',
      },
      (res) => {
        let out = ''
        res.on('data', (c: Buffer) => (out += c.toString()))
        res.on('end', () => {
          let body: unknown = null
          try {
            body = JSON.parse(out)
          } catch {
            // non-JSON (e.g. express default error page) — status is enough
          }
          resolve({ status: res.statusCode ?? 0, body: body as any })
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

beforeEach(async () => {
  db = openDatabase(':memory:')
  seedDefaultTasks(db)
  executed = []
  const app = express()
  app.use(express.json())
  registerDashboardRoutes(app, {
    db,
    eventLog: createEventLog(db),
    schedulerRunNow: async (taskId: string) => {
      if (taskId === 'zombie-cleanup') return 'no-handler'
      executed.push(taskId)
      return 'ran'
    },
  } as Parameters<typeof registerDashboardRoutes>[1])
  app.use(
    createErrorHandler({
      warn: () => {},
      error: () => {},
    } as Parameters<typeof createErrorHandler>[0]),
  )
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
})

afterEach(async () => {
  await new Promise((r) => server.close(r))
  closeDatabase(db)
})

describe('POST /api/scheduler/tasks/:id/run (WI-6)', () => {
  it('executes the real handler through the dep', async () => {
    const res = await post('/api/scheduler/tasks/memory-reindex/run')
    expect(res.status).toBe(200)
    expect(res.body.executed).toBe(true)
    expect(executed).toEqual(['memory-reindex'])
  })

  it('409s when no handler is registered for the task', async () => {
    const res = await post('/api/scheduler/tasks/zombie-cleanup/run')
    expect(res.status).toBe(409)
    expect(executed).toEqual([])
  })

  it('404s for an unknown task id', async () => {
    const res = await post('/api/scheduler/tasks/nope/run')
    expect(res.status).toBe(404)
  })
})
