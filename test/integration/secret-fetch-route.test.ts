/**
 * Phase 13.12.17 — integration test for POST /api/secrets/:key/fetch.
 *
 * Uses a real Express app created via createBrokerServer with a real
 * in-memory SQLite DB and a temp-dir-backed secret store.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { createBrokerServer } from '../../src/broker/server.js'
import { createEventLog } from '../../src/broker/services/event-log.js'
import { createEventDispatcher } from '../../src/broker/event-dispatcher.js'
import { createSecretStore } from '../../src/secrets/secret-store.js'
import type { TestDb } from '../helpers/db-harness.js'
import { createBrokerTestDb } from '../helpers/broker-db-harness.js'

describe('POST /api/secrets/:key/fetch (integration)', () => {
  let testDb: TestDb
  let baseUrl: string
  let server: ReturnType<typeof createBrokerServer>
  let httpServer: import('node:http').Server
  const TOKEN = 'f'.repeat(64)
  let storeDir: string

  beforeAll(async () => {
    testDb = createBrokerTestDb()
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(testDb.db, dispatcher)
    storeDir = mkdtempSync(join(tmpdir(), 'scns-secret-route-'))
    const store = createSecretStore({ rootDir: storeDir })
    store.set('instagram.password', 'hunter2-real')

    server = createBrokerServer(testDb.db, eventLog, undefined, dispatcher, {
      authToken: null,
      secretStore: store,
      internalToken: TOKEN,
      dashboardReadinessTimeoutMs: 0,
    })

    httpServer = await new Promise<import('node:http').Server>((resolve) => {
      const s = server.app.listen(0, () => resolve(s))
    })
    const addr = httpServer.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    await server.close()
    testDb.close()
  })

  it('401 when no token header', async () => {
    const res = await fetch(`${baseUrl}/api/secrets/instagram.password/fetch`, {
      method: 'POST',
    })
    expect(res.status).toBe(401)
  })

  it('401 when token mismatches', async () => {
    const res = await fetch(`${baseUrl}/api/secrets/instagram.password/fetch`, {
      method: 'POST',
      headers: { 'X-SCNS-Internal-Token': 'wrong' },
    })
    expect(res.status).toBe(401)
  })

  it('200 + value when token matches', async () => {
    const res = await fetch(`${baseUrl}/api/secrets/instagram.password/fetch`, {
      method: 'POST',
      headers: { 'X-SCNS-Internal-Token': TOKEN },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { key: string; value: string }
    expect(body.key).toBe('instagram.password')
    expect(body.value).toBe('hunter2-real')
  })

  it('404 for unknown key with valid token', async () => {
    const res = await fetch(`${baseUrl}/api/secrets/does.not.exist/fetch`, {
      method: 'POST',
      headers: { 'X-SCNS-Internal-Token': TOKEN },
    })
    expect(res.status).toBe(404)
  })

  it('400 for invalid key shape with valid token', async () => {
    const res = await fetch(`${baseUrl}/api/secrets/..%2Fetc%2Fpasswd/fetch`, {
      method: 'POST',
      headers: { 'X-SCNS-Internal-Token': TOKEN },
    })
    expect(res.status).toBe(400)
  })

  it('dashboard-facing endpoints do NOT include the token', async () => {
    // The progressive health endpoint is the widest surface. Confirm it
    // never leaks the internal token.
    const res = await fetch(`${baseUrl}/api/health`)
    const text = await res.text()
    expect(text).not.toContain(TOKEN)
  })
})
