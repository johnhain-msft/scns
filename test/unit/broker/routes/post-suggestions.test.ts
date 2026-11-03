import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { openDatabase, closeDatabase } from '../../../../src/broker/storage/db.js'
import { createEventLog } from '../../../../src/broker/services/event-log.js'
import { createEventDispatcher } from '../../../../src/broker/event-dispatcher.js'
import { createBrokerServer, type BrokerServer } from '../../../../src/broker/server.js'
import { ShutdownManager } from '../../../../src/broker/shutdown.js'
import type { Suggestion } from '../../../../src/suggest/types.js'

/**
 * Phase 13.9.5 — POST /api/suggestions endpoint.
 *
 * Verifies the Zod-validated JSON injection endpoint: server fills
 * id/status/timestamps, persists via suggestionStore.save(), and returns
 * 201 with the canonical suggestion shape. Malformed input → 400 with
 * Zod issues.
 */

describe('POST /api/suggestions', () => {
  let db: ReturnType<typeof openDatabase>
  let server: Server
  let broker: BrokerServer
  let baseUrl: string
  let saved: Suggestion[]
  let saveShouldThrow: Error | null

  beforeEach(async () => {
    db = openDatabase(':memory:')
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(db, dispatcher)
    const shutdownManager = new ShutdownManager()
    broker = createBrokerServer(db, eventLog, shutdownManager, dispatcher, { authToken: null })
    server = createServer(broker.app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${addr.port}`

    saved = []
    saveShouldThrow = null
    broker.setDashboardDeps({
      suggestionStore: {
        listByStatus: (status: string) => saved.filter((s) => s.status === status),
        approve: (id: string) => ({ id }),
        reject: (id: string) => ({ id }),
        save: (s: Suggestion) => {
          if (saveShouldThrow) throw saveShouldThrow
          saved.push(s)
        },
      },
    })
  })

  afterEach(async () => {
    await broker.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    closeDatabase(db)
  })

  it('returns 201 with generated id/path/suggestion on valid POST', async () => {
    const res = await fetch(`${baseUrl}/api/suggestions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'valid suggestion',
        type: 'workflow',
        confidence: 0.9,
        description: 'unit test',
        estimatedComplexity: 'solo',
      }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as {
      id: string
      path: string
      suggestion: Suggestion
    }
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(body.path).toContain('pending')
    expect(body.path).toContain(body.id)
    expect(body.suggestion.id).toBe(body.id)
    expect(body.suggestion.title).toBe('valid suggestion')
    expect(body.suggestion.type).toBe('workflow')
    expect(body.suggestion.status).toBe('pending')
    expect(body.suggestion.createdAt).toMatch(/T.*Z$/)
    expect(body.suggestion.updatedAt).toMatch(/T.*Z$/)
    expect(body.suggestion.evidence).toEqual([])
    expect(body.suggestion.tags).toEqual([])
    expect(body.suggestion.actionable).toBe(true)
    expect(body.suggestion.estimatedComplexity).toBe('solo')
    expect(saved).toHaveLength(1)
    expect(saved[0]!.id).toBe(body.id)
  })

  it('honors client-supplied evidence, tags, suggestedRoles', async () => {
    const res = await fetch(`${baseUrl}/api/suggestions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'with evidence',
        type: 'skill',
        confidence: 0.7,
        description: 'desc',
        evidence: [
          {
            source: 'unit-test',
            detail: 'because',
            observedAt: '2026-04-17T12:00:00.000Z',
            weight: 0.8,
          },
        ],
        tags: ['alpha', 'beta'],
        estimatedComplexity: 'team',
        suggestedRoles: ['implementer', 'reviewer'],
        actionable: false,
      }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { suggestion: Suggestion }
    expect(body.suggestion.evidence).toHaveLength(1)
    expect(body.suggestion.evidence[0]!.source).toBe('unit-test')
    expect(body.suggestion.tags).toEqual(['alpha', 'beta'])
    expect(body.suggestion.suggestedRoles).toEqual(['implementer', 'reviewer'])
    expect(body.suggestion.estimatedComplexity).toBe('team')
    expect(body.suggestion.actionable).toBe(false)
  })

  it('rejects missing title with 400 + Zod issues', async () => {
    const res = await fetch(`${baseUrl}/api/suggestions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'workflow',
        confidence: 0.5,
        description: 'no title',
      }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; issues: Array<{ path: string[] }> }
    expect(body.error).toBeTruthy()
    expect(Array.isArray(body.issues)).toBe(true)
    expect(body.issues.some((i) => i.path.includes('title'))).toBe(true)
    expect(saved).toHaveLength(0)
  })

  it('rejects invalid type enum with 400', async () => {
    const res = await fetch(`${baseUrl}/api/suggestions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'bogus type',
        type: 'NOT-IN-ENUM',
        confidence: 0.5,
        description: 'x',
      }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { issues: Array<{ path: string[] }> }
    expect(body.issues.some((i) => i.path.includes('type'))).toBe(true)
  })

  it('rejects confidence out of range with 400', async () => {
    const res = await fetch(`${baseUrl}/api/suggestions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'bad confidence',
        type: 'workflow',
        confidence: 1.5,
        description: 'x',
      }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { issues: Array<{ path: string[] }> }
    expect(body.issues.some((i) => i.path.includes('confidence'))).toBe(true)
  })

  it('ignores client-supplied id/status/timestamps and generates server values', async () => {
    const clientSuppliedId = '00000000-0000-0000-0000-000000000000'
    const res = await fetch(`${baseUrl}/api/suggestions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: clientSuppliedId,
        status: 'approved',
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:00.000Z',
        title: 'override attempt',
        type: 'workflow',
        confidence: 0.5,
        description: 'x',
      }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { id: string; suggestion: Suggestion }
    expect(body.id).not.toBe(clientSuppliedId)
    expect(body.suggestion.status).toBe('pending')
    expect(body.suggestion.createdAt.startsWith('2020')).toBe(false)
  })

  it('returns 500 when suggestionStore.save throws', async () => {
    saveShouldThrow = new Error('disk full')
    const res = await fetch(`${baseUrl}/api/suggestions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'will fail',
        type: 'workflow',
        confidence: 0.5,
        description: 'x',
      }),
    })
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('disk full')
  })

  // Phase 13.12.4 — auto-wake brain after successful POST /api/suggestions
  it('invokes onSuggestionPosted BEFORE the 201 is sent, so the wake is never deferred', async () => {
    let callCount = 0
    broker.setDashboardDeps({
      onSuggestionPosted: () => {
        callCount += 1
      },
    })
    const res = await fetch(`${baseUrl}/api/suggestions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'auto-wake me',
        type: 'workflow',
        confidence: 0.9,
        description: 'x',
        estimatedComplexity: 'solo',
      }),
    })
    expect(res.status).toBe(201)
    // NO sleep, deliberately. The handler dispatches the callback synchronously ahead of the
    // response, so a client that has the 201 in hand proves the wake already happened. Deferring it
    // behind a timer/microtask would leave callCount at 0 here.
    //
    // This replaces a `calledAtMs - startMs < 100` wall-clock budget, which measured the undici
    // client's one-time init plus scheduler contention rather than anything the broker does: it
    // failed at 116ms under parallel load while passing in isolation. Ordering is the property that
    // actually encodes "not deferred", and it is load-independent.
    expect(callCount).toBe(1)
  })

  it('does NOT invoke onSuggestionPosted when POST fails validation', async () => {
    let called = false
    broker.setDashboardDeps({
      onSuggestionPosted: () => {
        called = true
      },
    })
    const res = await fetch(`${baseUrl}/api/suggestions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'workflow', confidence: 0.5, description: 'no title' }),
    })
    expect(res.status).toBe(400)
    await new Promise((r) => setTimeout(r, 20))
    expect(called).toBe(false)
  })

  it('does NOT invoke onSuggestionPosted when save throws', async () => {
    saveShouldThrow = new Error('disk full')
    let called = false
    broker.setDashboardDeps({
      onSuggestionPosted: () => {
        called = true
      },
    })
    const res = await fetch(`${baseUrl}/api/suggestions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 't',
        type: 'workflow',
        confidence: 0.5,
        description: 'x',
      }),
    })
    expect(res.status).toBe(500)
    await new Promise((r) => setTimeout(r, 20))
    expect(called).toBe(false)
  })

  it('callback thrown errors do not affect the 201 response', async () => {
    broker.setDashboardDeps({
      onSuggestionPosted: () => {
        throw new Error('callback boom')
      },
    })
    const res = await fetch(`${baseUrl}/api/suggestions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'callback will throw',
        type: 'workflow',
        confidence: 0.8,
        description: 'x',
      }),
    })
    expect(res.status).toBe(201)
    expect(saved).toHaveLength(1)
  })
})

describe('POST /api/suggestions (no store)', () => {
  let db: ReturnType<typeof openDatabase>
  let server: Server
  let broker: BrokerServer
  let baseUrl: string

  beforeEach(async () => {
    db = openDatabase(':memory:')
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(db, dispatcher)
    const shutdownManager = new ShutdownManager()
    broker = createBrokerServer(db, eventLog, shutdownManager, dispatcher, {
      authToken: null,
      dashboardReadinessTimeoutMs: 50,
    })
    server = createServer(broker.app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterEach(async () => {
    await broker.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    closeDatabase(db)
  })

  it('returns 503 when suggestionStore is not wired', async () => {
    const res = await fetch(`${baseUrl}/api/suggestions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 't',
        type: 'workflow',
        confidence: 0.5,
        description: 'x',
      }),
    })
    expect(res.status).toBe(503)
  })
})
