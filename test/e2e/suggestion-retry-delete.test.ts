/**
 * Phase 13.12.9 E2E:
 * Verifies the new lifecycle endpoints wired against a real broker + real
 * filesystem suggestion store.
 *   - POST /api/suggestions/:id/retry resets backoff + (if failed) returns
 *     the suggestion to approved.
 *   - DELETE /api/suggestions/:id removes the file.
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
let store: ReturnType<typeof createSuggestionStore>

function seed(overrides: Partial<Suggestion> = {}): Suggestion {
  const now = new Date().toISOString()
  const id =
    overrides.id ??
    `${Math.random().toString(16).slice(2, 10)}-1111-2222-3333-${Math.random()
      .toString(16)
      .slice(2, 14)
      .padEnd(12, '0')}`
  const s: Suggestion = {
    id,
    type: 'automation',
    title: 'retry-test',
    description: 'phase 13.12.9',
    status: 'pending',
    confidence: 0.9,
    evidence: [],
    tags: [],
    createdAt: now,
    updatedAt: now,
    actionable: true,
    estimatedComplexity: 'solo',
    attemptCount: 0,
    lastError: null,
    lastAttemptAt: null,
    nextRetryAt: null,
    ...overrides,
  }
  store.save(s)
  return s
}

describe('Phase 13.12.9 retry + delete endpoints (E2E)', { timeout: 15_000 }, () => {
  beforeAll(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'scns-e2e-retry-'))
    db = openDatabase(':memory:')
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(db, dispatcher)
    const shutdownManager = new ShutdownManager()
    broker = createBrokerServer(db, eventLog, shutdownManager, dispatcher, { authToken: null })
    server = createServer(broker.app)
    await new Promise<void>((resolve) => server.listen(0, resolve))
    port = (server.address() as { port: number }).port

    store = createSuggestionStore({ rootDir: tmpRoot })
    broker.setDashboardDeps({
      suggestionStore: {
        listByStatus: (status: string) => store.list(status as 'pending'),
        approve: (id: string) => store.updateStatus(id, 'approved'),
        reject: (id: string) => store.updateStatus(id, 'rejected'),
        save: (s: Suggestion) => store.save(s),
        retry: (id: string) => store.clearBackoff(id),
        remove: (id: string) => store.remove(id),
        repromote: (id: string) => store.repromote(id),
      },
    })
  })

  afterAll(async () => {
    await broker.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    closeDatabase(db)
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('POST /api/suggestions/:id/retry on a failed item returns 200, clears backoff, sets status=approved', async () => {
    const s = seed({ id: 'ffffffff-aaaa-bbbb-cccc-111111111111' })
    store.updateStatus(s.id, 'approved')
    // Simulate 5 failures to reach `failed`.
    const base = Date.now()
    for (let i = 0; i < 5; i++) store.recordFailure(s.id, 'RunCommand skipped at L2', base + i)
    expect(store.get(s.id)!.status).toBe('failed')

    const res = await fetch(`http://localhost:${port}/api/suggestions/${s.id}/retry`, {
      method: 'POST',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { success: boolean; suggestion: Suggestion }
    expect(body.success).toBe(true)
    expect(body.suggestion.status).toBe('approved')
    expect(body.suggestion.attemptCount).toBe(0)
    expect(body.suggestion.nextRetryAt).toBeNull()
    expect(body.suggestion.lastError).toBeNull()

    // GET /api/suggestions?status=approved must include it now.
    const getRes = await fetch(`http://localhost:${port}/api/suggestions?status=approved`)
    const list = (await getRes.json()) as { suggestions: Suggestion[] }
    expect(list.suggestions.some((x) => x.id === s.id)).toBe(true)
  })

  it('POST /api/suggestions/:id/retry on an unknown id returns 404', async () => {
    const res = await fetch(
      `http://localhost:${port}/api/suggestions/00000000-0000-0000-0000-000000000000/retry`,
      { method: 'POST' },
    )
    expect(res.status).toBe(404)
  })

  it('DELETE /api/suggestions/:id removes the suggestion and subsequent GET does not list it', async () => {
    const s = seed({ id: 'ffffffff-aaaa-bbbb-cccc-222222222222' })
    const del = await fetch(`http://localhost:${port}/api/suggestions/${s.id}`, {
      method: 'DELETE',
    })
    expect(del.status).toBe(200)
    const body = (await del.json()) as { success: boolean; id: string }
    expect(body.success).toBe(true)
    expect(body.id).toBe(s.id)
    expect(store.get(s.id)).toBeNull()

    // Second DELETE returns 404.
    const del2 = await fetch(`http://localhost:${port}/api/suggestions/${s.id}`, {
      method: 'DELETE',
    })
    expect(del2.status).toBe(404)
  })

  // Phase 13.12.16: repromote endpoint.
  it('POST /api/suggestions/:id/repromote on needs-human returns 200 and moves to pending', async () => {
    const s = seed({ id: 'ffffffff-aaaa-bbbb-cccc-333333333333' })
    store.updateStatus(s.id, 'needs-human', 'awaiting user')
    expect(store.get(s.id)!.status).toBe('needs-human')

    const res = await fetch(
      `http://localhost:${port}/api/suggestions/${s.id}/repromote`,
      { method: 'POST' },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { success: boolean; suggestion: Suggestion }
    expect(body.success).toBe(true)
    expect(body.suggestion.status).toBe('pending')
    expect(body.suggestion.reviewReason).toBeUndefined()

    const pending = await fetch(
      `http://localhost:${port}/api/suggestions?status=pending`,
    ).then((r) => r.json() as Promise<{ suggestions: Suggestion[] }>)
    expect(pending.suggestions.some((x) => x.id === s.id)).toBe(true)
  })

  it('POST /api/suggestions/:id/repromote on a non-needs-human item returns 404', async () => {
    const s = seed({ id: 'ffffffff-aaaa-bbbb-cccc-444444444444' }) // stays in pending
    const res = await fetch(
      `http://localhost:${port}/api/suggestions/${s.id}/repromote`,
      { method: 'POST' },
    )
    expect(res.status).toBe(404)
  })
})
