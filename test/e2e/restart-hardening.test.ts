/**
 * E2E: Phase 12.5 — Blue/Green Restart Hardening
 *
 * Verifies:
 * 1. Request body over 64KB is rejected with 413 Payload Too Large.
 * 2. /api/admin/health reports activeRequestCount (starts at 0).
 * 3. POST /api/admin/rollback invokes the configured onRollback handler.
 * 4. /api/admin/rollback returns 503 when no rollback handler is configured.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type Database from 'better-sqlite3'
import { openDatabase, closeDatabase } from '../../src/broker/storage/db.js'
import { createEventLog } from '../../src/broker/services/event-log.js'
import { createEventDispatcher } from '../../src/broker/event-dispatcher.js'
import { createBrokerServer, type BrokerServer } from '../../src/broker/server.js'
import { ShutdownManager } from '../../src/broker/shutdown.js'

describe('Restart Hardening E2E (Phase 12.5)', () => {
  let db: Database.Database
  let broker: BrokerServer
  let server: Server
  let baseUrl: string
  let shutdownManager: ShutdownManager
  let rollbackInvocations: Array<string | undefined>

  beforeAll(async () => {
    db = openDatabase(':memory:')
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(db, dispatcher)
    shutdownManager = new ShutdownManager()
    broker = createBrokerServer(db, eventLog, shutdownManager, dispatcher, { authToken: null })

    rollbackInvocations = []
    broker.setRestartManagerDeps({
      onRollback: (reason?: string) => {
        rollbackInvocations.push(reason)
      },
    })

    server = createServer(broker.app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterAll(async () => {
    await broker.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    closeDatabase(db)
  })

  it('rejects request bodies larger than 64KB with HTTP 413', async () => {
    // Generate a body > 64KB (use 100KB to be safe)
    const big = 'x'.repeat(100_000)
    const payload = JSON.stringify({ key: 'test', value: big })

    const res = await fetch(`${baseUrl}/api/register_session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    })

    expect(res.status).toBe(413)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.success).toBe(false)
    expect((body.error as Record<string, unknown>).code).toBe('PAYLOAD_TOO_LARGE')
  })

  it('accepts small bodies (well under 64KB)', async () => {
    const payload = JSON.stringify({ session_id: 'hardening-test-1', agent_type: 'test' })
    const res = await fetch(`${baseUrl}/api/register_session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    })
    // Should NOT be 413 (could be 200/201/400/etc depending on schema, but not 413)
    expect(res.status).not.toBe(413)
  })

  it('admin health reports activeRequestCount', async () => {
    const res = await fetch(`${baseUrl}/api/admin/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(typeof body.activeRequestCount).toBe('number')
    // After the request settles, count should be back at 0 (admin paths aren't counted anyway)
    expect(body.activeRequestCount).toBe(0)
  })

  it('POST /api/admin/rollback invokes the rollback handler', async () => {
    const before = rollbackInvocations.length
    const res = await fetch(`${baseUrl}/api/admin/rollback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'e2e test' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.success).toBe(true)
    expect(body.triggered).toBe(true)
    expect(rollbackInvocations.length).toBe(before + 1)
    expect(rollbackInvocations[rollbackInvocations.length - 1]).toBe('e2e test')
  })

  it('POST /api/admin/rollback accepts empty body (no reason)', async () => {
    const before = rollbackInvocations.length
    const res = await fetch(`${baseUrl}/api/admin/rollback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(200)
    expect(rollbackInvocations.length).toBe(before + 1)
    expect(rollbackInvocations[rollbackInvocations.length - 1]).toBeUndefined()
  })
})

describe('Restart Hardening E2E — no rollback handler', () => {
  let db: Database.Database
  let broker: BrokerServer
  let server: Server
  let baseUrl: string

  beforeAll(async () => {
    db = openDatabase(':memory:')
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(db, dispatcher)
    const shutdownManager = new ShutdownManager()
    broker = createBrokerServer(db, eventLog, shutdownManager, dispatcher, { authToken: null })
    // Intentionally do NOT configure onRollback

    server = createServer(broker.app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterAll(async () => {
    await broker.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    closeDatabase(db)
  })

  it('rollback endpoint returns 503 when handler is not configured', async () => {
    const res = await fetch(`${baseUrl}/api/admin/rollback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(503)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.success).toBe(false)
    expect(body.triggered).toBe(false)
    expect(typeof body.error).toBe('string')
  })
})
