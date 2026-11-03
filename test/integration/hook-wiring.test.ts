/**
 * Integration test for GAP-001 — verifies session hook events are actually
 * processed when handleSessionEvent is wired into the broker.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, closeDatabase } from '../../src/broker/storage/db.js'
import { createEventLog } from '../../src/broker/services/event-log.js'
import { createEventDispatcher } from '../../src/broker/event-dispatcher.js'
import { createBrokerServer, type BrokerServer } from '../../src/broker/server.js'
import { createObservationManager } from '../../src/observe/observation-manager.js'
import { loadObservationConfig } from '../../src/observe/config.js'
import type { SessionEventData } from '../../src/observe/observers/session-hooks.js'
import type Database from 'better-sqlite3'

// ── Helpers ────────────────────────────────────────────────────

interface TestResponse {
  status: number
  body: Record<string, unknown>
}

let db: Database.Database
let broker: BrokerServer
let server: Server
let baseUrl: string
let manager: ReturnType<typeof createObservationManager>
let vaultDir: string

function makeMinimalConfig() {
  const base = loadObservationConfig()
  return {
    ...base,
    activeApp: { ...base.activeApp, enabled: false },
    fileChanges: { ...base.fileChanges, enabled: false },
    gitActivity: { ...base.gitActivity, enabled: false },
    terminalHistory: { ...base.terminalHistory, enabled: false, optIn: false },
    browserTabs: { ...base.browserTabs, enabled: false, optIn: false },
    sessionHooks: { ...base.sessionHooks, enabled: true },
  }
}

async function post(path: string, body: unknown): Promise<TestResponse> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return { status: res.status, body: json }
}

// ── Setup / Teardown ───────────────────────────────────────────

beforeEach(() => {
  vaultDir = mkdtempSync(join(tmpdir(), 'scns-hook-wiring-'))

  const config = makeMinimalConfig()
  manager = createObservationManager({ config, vaultRootDir: vaultDir })
  manager.start()

  const handleSessionEvent = (event: {
    readonly event: string
    readonly sessionId?: string
    readonly tool?: string
    readonly timestamp: string
    readonly metadata?: Record<string, unknown>
    readonly model?: string
    readonly toolArgs?: string
    readonly toolResult?: string
    readonly mcpServer?: string
    readonly skillName?: string
    readonly exitCode?: number
    readonly errorMessage?: string
    readonly traceId?: string
    readonly tokenUsage?: { readonly input?: number; readonly output?: number }
  }) => {
    const obs = manager.handleSessionEvent(event as SessionEventData)
    return obs ? { id: obs.id } : null
  }

  db = openDatabase(':memory:')
  const dispatcher = createEventDispatcher()
  const eventLog = createEventLog(db, dispatcher)
  broker = createBrokerServer(db, eventLog, undefined, dispatcher, {
    authToken: null,
    handleSessionEvent,
  })

  server = createServer(broker.app)
  server.listen(0)
  const addr = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterEach(async () => {
  manager.stop()
  await broker.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  closeDatabase(db)
  rmSync(vaultDir, { recursive: true, force: true })
})

// ── Tests ──────────────────────────────────────────────────────

describe('hook wiring (GAP-001)', () => {
  it('creates an observation when session-start hook is posted', async () => {
    const before = manager.getStatus().observationCount

    const res = await post('/api/hooks/session-start', {
      event: 'session-start',
      sessionId: 'test-session-1',
      timestamp: new Date().toISOString(),
    })

    expect(res.status).toBe(200)
    expect(res.body.acknowledged).toBe(true)
    expect(res.body.observationId).toEqual(expect.any(String))

    const after = manager.getStatus().observationCount
    expect(after).toBe(before + 1)
  })

  it('creates an observation for tool-use events', async () => {
    const before = manager.getStatus().observationCount

    const res = await post('/api/hooks/tool-use', {
      event: 'tool-use',
      sessionId: 'test-session-2',
      tool: 'edit',
      timestamp: new Date().toISOString(),
    })

    expect(res.status).toBe(200)
    expect(res.body.acknowledged).toBe(true)

    const after = manager.getStatus().observationCount
    expect(after).toBe(before + 1)
  })

  it('creates an observation for session-end events', async () => {
    const before = manager.getStatus().observationCount

    const res = await post('/api/hooks/session-end', {
      event: 'session-end',
      sessionId: 'test-session-3',
      timestamp: new Date().toISOString(),
      tokenUsage: { input: 1000, output: 500 },
    })

    expect(res.status).toBe(200)
    expect(res.body.acknowledged).toBe(true)

    const after = manager.getStatus().observationCount
    expect(after).toBe(before + 1)
  })

  it('returns a real observation id (not a random fallback)', async () => {
    const res = await post('/api/hooks/session-start', {
      event: 'session-start',
      sessionId: 'test-session-4',
      timestamp: new Date().toISOString(),
    })

    expect(res.status).toBe(200)
    // The observation id should be a UUID from the observation manager
    const id = res.body.observationId as string
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('rejects when URL event does not match body event', async () => {
    const res = await post('/api/hooks/session-start', {
      event: 'session-end',
      sessionId: 'test-session-5',
      timestamp: new Date().toISOString(),
    })

    expect(res.status).toBe(400)
  })

  it('increments observation count for each hook event', async () => {
    const before = manager.getStatus().observationCount

    await post('/api/hooks/session-start', {
      event: 'session-start',
      sessionId: 's1',
      timestamp: new Date().toISOString(),
    })
    await post('/api/hooks/tool-use', {
      event: 'tool-use',
      sessionId: 's1',
      tool: 'read',
      timestamp: new Date().toISOString(),
    })
    await post('/api/hooks/session-end', {
      event: 'session-end',
      sessionId: 's1',
      timestamp: new Date().toISOString(),
    })

    const after = manager.getStatus().observationCount
    expect(after).toBe(before + 3)
  })
})
