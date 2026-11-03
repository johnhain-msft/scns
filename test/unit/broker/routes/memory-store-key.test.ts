/**
 * WI-3 — store→search contract: POST /api/memory/store must normalize the
 * vault key to a `.md` filename.
 *
 * The vault indexes ONLY `*.md` files, but the extension's scns_memory_store
 * passes the model-chosen key verbatim. Without normalization a key like
 * "project-decision" writes an extensionless file that no search will ever
 * see — silent data loss, found live by the WI-3 repo-isolation test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import http from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { openDatabase, closeDatabase } from '../../../../src/broker/storage/db.js'
import { createEventLog } from '../../../../src/broker/services/event-log.js'
import { registerDashboardRoutes } from '../../../../src/broker/routes/dashboard-routes.js'
import type Database from 'better-sqlite3'

let db: Database.Database
let server: Server
let storedKeys: string[]

function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: (server.address() as AddressInfo).port,
        path,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      },
      (res) => {
        let out = ''
        res.on('data', (c: Buffer) => (out += c.toString()))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(out) }))
      },
    )
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

beforeEach(async () => {
  db = openDatabase(':memory:')
  storedKeys = []
  const app = express()
  app.use(express.json())
  registerDashboardRoutes(app, {
    db,
    eventLog: createEventLog(db),
    memoryStore: {
      store: async (key: string, _value: string) => {
        storedKeys.push(key)
        return { stored: true, key }
      },
    },
  } as Parameters<typeof registerDashboardRoutes>[1])
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
})

afterEach(async () => {
  await new Promise((r) => server.close(r))
  closeDatabase(db)
})

describe('POST /api/memory/store — key normalization', () => {
  it('appends .md to an extensionless key so the fact is indexable', async () => {
    const res = await post('/api/memory/store', { key: 'project-decision', value: 'fact' })
    expect(res.status).toBe(200)
    expect(storedKeys).toEqual(['project-decision.md'])
    expect(res.body.key).toBe('project-decision.md')
  })

  it('leaves an explicit .md key unchanged', async () => {
    await post('/api/memory/store', { key: 'notes/decision.md', value: 'fact' })
    expect(storedKeys).toEqual(['notes/decision.md'])
  })
})
