/**
 * E2E: Broker restart lifecycle — admin endpoints, drain mode, health checks.
 *
 * Tests the blue/green restart flow:
 * 1. Admin health responds correctly before restart
 * 2. Prepare-restart triggers dream + housekeeping
 * 3. Drain mode causes regular endpoints to 503 while health stays up
 * 4. Admin health reports draining state
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

describe('Broker Restart Lifecycle E2E', () => {
  let db: Database.Database
  let broker: BrokerServer
  let server: Server
  let baseUrl: string
  let shutdownManager: ShutdownManager

  beforeAll(async () => {
    db = openDatabase(':memory:')
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(db, dispatcher)
    shutdownManager = new ShutdownManager()
    broker = createBrokerServer(db, eventLog, shutdownManager, dispatcher, { authToken: null })

    // Wire restart manager with mock deps to test lifecycle
    let dreamRunCount = 0
    broker.setRestartManagerDeps({
      dreamDaemon: {
        triggerRun: async (_force: boolean) => {
          dreamRunCount++
          return { success: true, skipped: false, dreamCount: dreamRunCount }
        },
      },
      runHousekeeping: (_config) => ({
        success: true,
        otelSpansPruned: 10,
        otelMetricsPruned: 20,
        eventsPruned: 5,
        taskRunHistoryPruned: 0,
        messagesHistoryPruned: 0,
        vacuumed: false,
        walTruncated: true,
        walFramesCheckpointed: 0,
        durationMs: 42,
      }),
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

  // ── Health check ────────────────────────────────────────────

  it('admin health reports ok when not draining', async () => {
    const res = await fetch(`${baseUrl}/api/admin/health`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as Record<string, unknown>
    expect(body.status).toBe('ok')
    expect(body.draining).toBe(false)
    expect(body.hasDreamDaemon).toBe(true)
    expect(body.hasHousekeeping).toBe(true)
    expect(typeof body.uptimeSeconds).toBe('number')
    expect(typeof body.startedAt).toBe('string')
  })

  // ── Prepare-restart ─────────────────────────────────────────

  it('prepare-restart runs dream and housekeeping', async () => {
    const res = await fetch(`${baseUrl}/api/admin/prepare-restart`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    expect(res.status).toBe(200)

    const body = (await res.json()) as Record<string, unknown>
    expect(body.success).toBe(true)
    expect(body.dreamResult).toBeTruthy()
    expect(body.housekeepingResult).toBeTruthy()
    expect(typeof body.durationMs).toBe('number')

    // Verify housekeeping ran with vacuum=false
    const hk = body.housekeepingResult as Record<string, unknown>
    expect(hk.vacuumed).toBe(false)
    expect(hk.success).toBe(true)
  })

  // ── Drain mode ──────────────────────────────────────────────

  it('drain mode causes 503 for regular endpoints', async () => {
    // Before drain, regular endpoints should work
    const preRes = await fetch(`${baseUrl}/api/list_sessions`)
    expect(preRes.status).toBe(200)

    // Activate drain
    const drainRes = await fetch(`${baseUrl}/api/admin/drain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    expect(drainRes.status).toBe(200)
    const drainBody = (await drainRes.json()) as Record<string, unknown>
    expect(drainBody.success).toBe(true)
    expect(drainBody.draining).toBe(true)

    // After drain, regular endpoints should 503
    const postRes = await fetch(`${baseUrl}/api/list_sessions`)
    expect(postRes.status).toBe(503)
  })

  it('admin health still responds during drain', async () => {
    // Health endpoint is exempt from drain middleware
    const res = await fetch(`${baseUrl}/api/admin/health`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as Record<string, unknown>
    expect(body.status).toBe('draining')
    expect(body.draining).toBe(true)
  })

  it('standard health endpoints still respond during drain', async () => {
    const liveRes = await fetch(`${baseUrl}/health/live`)
    expect(liveRes.status).toBe(200)

    const readyRes = await fetch(`${baseUrl}/health/ready`)
    expect(readyRes.status).toBe(200)
  })
})
