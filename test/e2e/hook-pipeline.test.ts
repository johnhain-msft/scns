/**
 * E2E test: full hook pipeline from HTTP request through broker to DB persistence.
 *
 * Starts a real broker server on a random port with a real EventLog (SQLite)
 * and real ObservationManager. Verifies the complete pipeline:
 *   HTTP POST → route handler → eventLog (SQLite) + observationManager (vault)
 *   session-start → auto-registration in sessions table
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDatabase, closeDatabase } from '../../src/broker/storage/db.js'
import { createEventLog } from '../../src/broker/services/event-log.js'
import { createBrokerServer, type BrokerServer } from '../../src/broker/server.js'
import { createObservationManager } from '../../src/observe/observation-manager.js'
import { loadObservationConfig } from '../../src/observe/config.js'
import {
  findSessionById,
  _findAllSessions,
  createSession,
} from '../../src/broker/storage/repositories/session-repository.js'
import type Database from 'better-sqlite3'
import type { SessionEventData } from '../../src/observe/observers/session-hooks.js'

let db: Database.Database
let broker: BrokerServer
let server: Server
let port: number
let tmpDir: string

function baseUrl(): string {
  return `http://localhost:${port}`
}

async function postHook(
  event: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl()}/api/hooks/${event}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = (await res.json()) as Record<string, unknown>
  return { status: res.status, body: json }
}

describe('Hook pipeline — real E2E with DB persistence', { timeout: 30_000 }, () => {
  beforeAll(async () => {
    // Create temp directory for vault
    tmpDir = mkdtempSync(join(tmpdir(), 'scns-e2e-hooks-'))

    // Real SQLite database (in-memory for speed but still real SQL)
    db = openDatabase(':memory:')
    const eventLog = createEventLog(db)

    // Real observation manager with real vault
    const config = loadObservationConfig()
    const manager = createObservationManager({
      config: { ...config, enabled: true },
      vaultRootDir: join(tmpDir, 'vault'),
    })
    manager.start()

    // Real handleSessionEvent callback — same as cli.ts uses
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
    }): { readonly id: string } | null => {
      const obs = manager.handleSessionEvent(event as SessionEventData)
      return obs ? { id: obs.id } : null
    }

    broker = createBrokerServer(db, eventLog, undefined, undefined, {
      handleSessionEvent,
    })
    server = createServer(broker.app)
    await new Promise<void>((resolve) => server.listen(0, resolve))
    port = (server.address() as { port: number }).port
  })

  afterAll(async () => {
    await broker.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    closeDatabase(db)
    rmSync(tmpDir, { recursive: true, force: true })
  })

  // ── Core pipeline: events persist to SQLite ───────────────

  it('session-start hook creates session + persists hook_received event', async () => {
    const res = await postHook('session-start', {
      event: 'session-start',
      sessionId: 'e2e-sess-001',
      timestamp: '2025-06-01T10:00:00Z',
    })

    expect(res.status).toBe(200)
    expect(res.body.acknowledged).toBe(true)
    expect(typeof res.body.observationId).toBe('string')

    // Verify session was auto-registered in DB
    const session = findSessionById(db, 'e2e-sess-001')
    expect(session).not.toBeNull()
    expect(session!.id).toBe('e2e-sess-001')
    expect(session!.purpose).toBe('copilot-hook')
    expect(session!.status).toBe('active')

    // Verify hook_received event persisted in event_log
    const events = db
      .prepare("SELECT * FROM events WHERE event_type = 'hook_received'")
      .all() as Array<{ session_id: string; payload: string }>
    expect(events.length).toBeGreaterThanOrEqual(1)
    const hookEvent = events.find((e) => e.session_id === 'e2e-sess-001')
    expect(hookEvent).toBeDefined()
    const payload = JSON.parse(hookEvent!.payload)
    expect(payload.hookEvent).toBe('session-start')
  })

  it('second session-start for same session is idempotent (no overwrite)', async () => {
    const res = await postHook('session-start', {
      event: 'session-start',
      sessionId: 'e2e-sess-001',
      timestamp: '2025-06-01T10:01:00Z',
    })

    expect(res.status).toBe(200)

    // Session should still exist with original purpose
    const session = findSessionById(db, 'e2e-sess-001')
    expect(session).not.toBeNull()
    expect(session!.purpose).toBe('copilot-hook')
  })

  it('pre-existing session is not overwritten by hook auto-registration', async () => {
    // Register a session via the normal API path first
    createSession(db, {
      id: 'pre-existing-sess',
      purpose: 'interactive coding',
      working_dir: '/Users/test/project',
      worktree: null,
    })

    // Now a session-start hook arrives for the same session
    const res = await postHook('session-start', {
      event: 'session-start',
      sessionId: 'pre-existing-sess',
      timestamp: '2025-06-01T10:02:00Z',
    })

    expect(res.status).toBe(200)

    // Verify the original session data is preserved (not overwritten)
    const session = findSessionById(db, 'pre-existing-sess')
    expect(session).not.toBeNull()
    expect(session!.purpose).toBe('interactive coding')
    expect(session!.working_dir).toBe('/Users/test/project')
  })

  it('tool-use hook persists to event log with full details', async () => {
    const res = await postHook('tool-use', {
      event: 'tool-use',
      sessionId: 'e2e-sess-001',
      tool: 'search_code',
      timestamp: '2025-06-01T10:05:00Z',
      mcpServer: 'github-mcp-server',
      toolArgs: 'query: "auth middleware"',
      toolResult: 'Found 5 matches',
      traceId: 'trace-e2e-001',
    })

    expect(res.status).toBe(200)
    expect(res.body.acknowledged).toBe(true)

    // Verify the event persisted with correct payload
    const events = db
      .prepare(
        "SELECT * FROM events WHERE event_type = 'hook_received' AND session_id = 'e2e-sess-001' ORDER BY id DESC",
      )
      .all() as Array<{ payload: string }>
    const toolEvent = events.find((e) => {
      const p = JSON.parse(e.payload)
      return p.hookEvent === 'tool-use'
    })
    expect(toolEvent).toBeDefined()
    const payload = JSON.parse(toolEvent!.payload)
    expect(payload.tool).toBe('search_code')
    expect(payload.hookEvent).toBe('tool-use')
  })

  it('session-end hook persists with enriched fields and marks session completed', async () => {
    const res = await postHook('session-end', {
      event: 'session-end',
      sessionId: 'e2e-sess-001',
      timestamp: '2025-06-01T11:00:00Z',
      model: 'claude-opus-4.6',
      exitCode: 0,
      tokenUsage: { input: 45231, output: 12456 },
    })

    expect(res.status).toBe(200)
    expect(res.body.acknowledged).toBe(true)

    // Verify session status transitioned to 'completed'
    const session = findSessionById(db, 'e2e-sess-001')
    expect(session).not.toBeNull()
    expect(session!.status).toBe('completed')

    // Verify the event persisted
    const events = db
      .prepare(
        "SELECT * FROM events WHERE event_type = 'hook_received' AND session_id = 'e2e-sess-001' ORDER BY id DESC",
      )
      .all() as Array<{ payload: string }>
    const endEvent = events.find((e) => {
      const p = JSON.parse(e.payload)
      return p.hookEvent === 'session-end'
    })
    expect(endEvent).toBeDefined()
    const payload = JSON.parse(endEvent!.payload)
    expect(payload.hookEvent).toBe('session-end')
    expect(payload.model).toBe('claude-opus-4.6')
  })

  it('hook without sessionId still persists as null session', async () => {
    const res = await postHook('pre-compact', {
      event: 'pre-compact',
      timestamp: '2025-06-01T10:30:00Z',
    })

    expect(res.status).toBe(200)

    const events = db
      .prepare(
        "SELECT * FROM events WHERE event_type = 'hook_received' AND session_id IS NULL ORDER BY id DESC",
      )
      .all() as Array<{ payload: string }>
    const compactEvent = events.find((e) => {
      const p = JSON.parse(e.payload)
      return p.hookEvent === 'pre-compact'
    })
    expect(compactEvent).toBeDefined()
  })

  // ── Event coercion ────────────────────────────────────────

  it('event coerced from URL param when missing from body', async () => {
    const res = await postHook('user-prompt', {
      timestamp: '2025-06-01T10:15:00Z',
      sessionId: 'coerce-test',
    })

    expect(res.status).toBe(200)
    expect(res.body.acknowledged).toBe(true)
  })

  it('mismatched event param vs body → 400', async () => {
    const res = await postHook('session-start', {
      event: 'session-end',
      timestamp: '2025-06-01T13:00:00Z',
    })

    expect(res.status).toBe(400)
    expect(res.body.error).toBeDefined()
  })

  // ── Validation ────────────────────────────────────────────

  it('missing timestamp → 400', async () => {
    const res = await postHook('session-start', {
      event: 'session-start',
    })

    expect(res.status).toBe(400)
  })

  it('unknown event type → 400', async () => {
    const res = await postHook('unknown-event', {
      event: 'unknown-event',
      timestamp: '2025-06-01T14:00:00Z',
    })

    expect(res.status).toBe(400)
  })

  // ── Dashboard sees sessions ───────────────────────────────

  it('sessions registered via hooks appear in /api/list_sessions', async () => {
    // Note: e2e-sess-001 was marked 'completed' by session-end test (archived),
    // so it won't appear in default listing. pre-existing-sess should still appear.
    const res = await fetch(`${baseUrl()}/api/list_sessions`)
    const body = (await res.json()) as { sessions: Array<{ id: string; status: string }> }
    const sessionIds = body.sessions.map((s) => s.id)

    expect(sessionIds).toContain('pre-existing-sess')

    // Completed sessions visible with include_archived
    const archivedRes = await fetch(`${baseUrl()}/api/list_sessions?include_archived=true`)
    const archivedBody = (await archivedRes.json()) as {
      sessions: Array<{ id: string; status: string }>
    }
    const archivedIds = archivedBody.sessions.map((s) => s.id)

    expect(archivedIds).toContain('e2e-sess-001')
    const completed = archivedBody.sessions.find((s) => s.id === 'e2e-sess-001')
    expect(completed!.status).toBe('completed')
  })

  it('events from hooks appear in /api/events/since', async () => {
    const res = await fetch(`${baseUrl()}/api/events/since/0`)
    const body = (await res.json()) as { events: Array<{ event_type: string }> }
    const hookEvents = body.events.filter((e) => e.event_type === 'hook_received')

    expect(hookEvents.length).toBeGreaterThanOrEqual(3)
  })
})
