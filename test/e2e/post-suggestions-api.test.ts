/**
 * E2E: POST /api/suggestions end-to-end with real broker + real filesystem
 * suggestion store. Verifies a minimal JSON injection produces a 201 and
 * is immediately visible via GET /api/suggestions?status=pending.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, closeDatabase } from '../../src/broker/storage/db.js'
import { createEventLog } from '../../src/broker/services/event-log.js'
import { createEventDispatcher } from '../../src/broker/event-dispatcher.js'
import { createBrokerServer, type BrokerServer } from '../../src/broker/server.js'
import { ShutdownManager } from '../../src/broker/shutdown.js'
import { createSuggestionStore } from '../../src/suggest/suggestion-store.js'
import type { Suggestion } from '../../src/suggest/types.js'
import type Database from 'better-sqlite3'

let db: Database.Database
let broker: BrokerServer
let server: Server
let port: number
let tmpRoot: string

describe('POST /api/suggestions (E2E)', { timeout: 15_000 }, () => {
  beforeAll(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'scns-e2e-sug-'))
    db = openDatabase(':memory:')
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(db, dispatcher)
    const shutdownManager = new ShutdownManager()
    broker = createBrokerServer(db, eventLog, shutdownManager, dispatcher, { authToken: null })
    server = createServer(broker.app)
    await new Promise<void>((resolve) => server.listen(0, resolve))
    port = (server.address() as { port: number }).port

    const store = createSuggestionStore({ rootDir: tmpRoot })
    broker.setDashboardDeps({
      suggestionStore: {
        listByStatus: (status: string) => store.list(status as 'pending'),
        approve: (id: string) => store.updateStatus(id, 'approved'),
        reject: (id: string) => store.updateStatus(id, 'rejected'),
        save: (s: Suggestion) => {
          store.save(s)
        },
      },
    })
  })

  afterAll(async () => {
    await broker.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    closeDatabase(db)
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('posts minimal JSON and appears in GET within 1 second', async () => {
    const title = `e2e live ${Date.now()}`
    const postRes = await fetch(`http://localhost:${port}/api/suggestions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        type: 'workflow',
        confidence: 0.88,
        description: 'e2e minimal',
      }),
    })
    expect(postRes.status).toBe(201)
    const posted = (await postRes.json()) as { id: string }

    const deadline = Date.now() + 1000
    let found = false
    while (Date.now() < deadline) {
      const getRes = await fetch(`http://localhost:${port}/api/suggestions?status=pending`)
      const body = (await getRes.json()) as { suggestions: Suggestion[] }
      if (body.suggestions.some((s) => s.id === posted.id)) {
        found = true
        break
      }
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(found).toBe(true)
  })

  it('rejects malformed payload with 400 + Zod issues', async () => {
    const res = await fetch(`http://localhost:${port}/api/suggestions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'x', type: 'NOT-IN-ENUM', confidence: 99 }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; issues: Array<unknown> }
    expect(body.error).toBeTruthy()
    expect(body.issues.length).toBeGreaterThan(0)
  })
})
