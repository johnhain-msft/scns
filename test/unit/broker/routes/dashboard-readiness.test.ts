import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { openDatabase, closeDatabase } from '../../../../src/broker/storage/db.js'
import { createEventLog } from '../../../../src/broker/services/event-log.js'
import { createEventDispatcher } from '../../../../src/broker/event-dispatcher.js'
import { createBrokerServer, type BrokerServer } from '../../../../src/broker/server.js'
import { ShutdownManager } from '../../../../src/broker/shutdown.js'

/**
 * Verifies the Phase 12.6 dashboard readiness gate: routes that depend on
 * late-bound deps (wired by the CLI via setDashboardDeps) pause their
 * response until those deps arrive, rather than immediately returning a
 * degraded `{available: false}` / 503 response.
 */

describe('Dashboard readiness gate', () => {
  let db: ReturnType<typeof openDatabase>
  let server: Server
  let broker: BrokerServer
  let baseUrl: string

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
  })

  afterEach(async () => {
    await broker.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    closeDatabase(db)
  })

  it('holds /api/suggestions until setDashboardDeps is called', async () => {
    const fetchPromise = fetch(`${baseUrl}/api/suggestions?status=pending`)
    // Wire deps shortly after the request starts.
    setTimeout(() => {
      broker.setDashboardDeps({
        suggestionStore: {
          listByStatus: () => [{ id: 'sug-1', status: 'pending' }],
          approve: () => ({ ok: true }),
          reject: () => ({ ok: true }),
        },
      })
    }, 50)
    const res = await fetchPromise
    expect(res.status).toBe(200)
    const body = (await res.json()) as { suggestions: unknown[] }
    expect(body.suggestions).toHaveLength(1)
  })

  it('non-gated routes (e.g. /api/scheduler/tasks) respond immediately', async () => {
    // The scheduler route does not depend on late-bound deps.
    const res = await fetch(`${baseUrl}/api/scheduler/tasks`)
    expect(res.status).toBe(200)
  })

  it('gated routes fall through after timeout if deps never arrive', async () => {
    // Build a broker with a short readiness timeout so we don't hang the test.
    const db2 = openDatabase(':memory:')
    const dispatcher2 = createEventDispatcher()
    const eventLog2 = createEventLog(db2, dispatcher2)
    const shutdownManager2 = new ShutdownManager()
    const broker2 = createBrokerServer(db2, eventLog2, shutdownManager2, dispatcher2, {
      authToken: null,
      dashboardReadinessTimeoutMs: 100,
    })
    const server2 = createServer(broker2.app)
    await new Promise<void>((resolve) => server2.listen(0, '127.0.0.1', resolve))
    const addr = server2.address() as AddressInfo
    const url2 = `http://127.0.0.1:${addr.port}`
    try {
      const res = await fetch(`${url2}/api/observers`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { available: boolean }
      expect(body.available).toBe(false)
    } finally {
      await broker2.close()
      await new Promise<void>((resolve) => server2.close(() => resolve()))
      closeDatabase(db2)
    }
  })
})
