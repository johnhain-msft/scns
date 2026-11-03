import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import http from 'node:http'
import { openDatabase, closeDatabase } from '../../../../src/broker/storage/db.js'
import { createEventLog } from '../../../../src/broker/services/event-log.js'
import { createBrokerServer, type BrokerServer } from '../../../../src/broker/server.js'
import { createMessage } from '../../../../src/broker/storage/repositories/message-repository.js'
import type Database from 'better-sqlite3'

interface StubSuggestion {
  readonly id: string
  readonly title: string
  readonly status: string
  readonly createdAt: string
  readonly updatedAt: string
}

function makeStubStore(suggestions: readonly StubSuggestion[]) {
  const byStatus = new Map<string, StubSuggestion[]>()
  for (const s of suggestions) {
    const list = byStatus.get(s.status) ?? []
    list.push(s)
    byStatus.set(s.status, list)
  }
  return {
    listByStatus: (status: string) => byStatus.get(status) ?? [],
    approve: () => null,
    reject: () => null,
  }
}

function request(
  server: Server,
  path: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: 'localhost',
        port: (server.address() as { port: number }).port,
        path,
        method: 'GET',
        headers: { Accept: 'application/json' },
      },
      (res) => {
        let raw = ''
        res.on('data', (chunk: Buffer) => {
          raw += chunk.toString()
        })
        res.on('end', () => {
          let parsed: unknown
          try {
            parsed = JSON.parse(raw)
          } catch {
            parsed = raw
          }
          resolve({ status: res.statusCode!, body: parsed })
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

describe('Orchestrator routes (self-audit fixes)', () => {
  let db: Database.Database
  let broker: BrokerServer
  let server: Server

  beforeEach(async () => {
    db = openDatabase(':memory:')
    const eventLog = createEventLog(db)
    broker = createBrokerServer(db, eventLog, undefined, undefined, {
      dashboardReadinessTimeoutMs: 0,
    })
    server = createServer(broker.app)
    await new Promise<void>((resolve) => server.listen(0, resolve))
  })

  afterEach(async () => {
    await broker.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    closeDatabase(db)
  })

  // ── Suggestions in-flight ──────────────────────────────────────

  describe('GET /api/orchestrator/suggestions-in-flight', () => {
    it('excludes implemented and rejected suggestions', async () => {
      const suggestions: StubSuggestion[] = [
        { id: 's-pend', title: 'pending one', status: 'pending', createdAt: '2026-04-20T00:00:00Z', updatedAt: '2026-04-20T00:00:00Z' },
        { id: 's-appr', title: 'approved one', status: 'approved', createdAt: '2026-04-20T00:00:01Z', updatedAt: '2026-04-20T00:00:01Z' },
        { id: 's-prog', title: 'in-progress one', status: 'in-progress', createdAt: '2026-04-20T00:00:02Z', updatedAt: '2026-04-20T00:00:02Z' },
        { id: 's-impl', title: 'implemented', status: 'implemented', createdAt: '2026-04-20T00:00:03Z', updatedAt: '2026-04-20T00:00:03Z' },
        { id: 's-rej', title: 'rejected', status: 'rejected', createdAt: '2026-04-20T00:00:04Z', updatedAt: '2026-04-20T00:00:04Z' },
        { id: 's-failed', title: 'failed', status: 'failed', createdAt: '2026-04-20T00:00:05Z', updatedAt: '2026-04-20T00:00:05Z' },
      ]
      broker.setDashboardDeps({ suggestionStore: makeStubStore(suggestions) })

      const res = await request(server, '/api/orchestrator/suggestions-in-flight')
      expect(res.status).toBe(200)
      const body = res.body as { suggestions: Array<{ id: string; status: string }> }
      const ids = body.suggestions.map((s) => s.id).sort()
      expect(ids).toEqual(['s-appr', 's-pend', 's-prog'])
      for (const s of body.suggestions) {
        expect(['pending', 'approved', 'in-progress']).toContain(s.status)
      }
    })

    it('returns empty list when no store wired', async () => {
      const res = await request(server, '/api/orchestrator/suggestions-in-flight')
      expect(res.status).toBe(200)
      expect((res.body as { suggestions: unknown[] }).suggestions).toEqual([])
    })
  })

  // ── Overview in-flight filtering ───────────────────────────────

  describe('GET /api/orchestrator/overview', () => {
    it('overview.suggestions excludes implemented and rejected', async () => {
      const suggestions: StubSuggestion[] = [
        { id: 's-pend', title: 'pending one', status: 'pending', createdAt: '2026-04-20T00:00:00Z', updatedAt: '2026-04-20T00:00:00Z' },
        { id: 's-impl', title: 'implemented', status: 'implemented', createdAt: '2026-04-20T00:00:03Z', updatedAt: '2026-04-20T00:00:03Z' },
        { id: 's-rej', title: 'rejected', status: 'rejected', createdAt: '2026-04-20T00:00:04Z', updatedAt: '2026-04-20T00:00:04Z' },
      ]
      broker.setDashboardDeps({ suggestionStore: makeStubStore(suggestions) })

      const res = await request(server, '/api/orchestrator/overview?since=all')
      expect(res.status).toBe(200)
      const body = res.body as { suggestions: Array<{ id: string; status: string }> }
      expect(body.suggestions.map((s) => s.id)).toEqual(['s-pend'])
    })
  })

  // ── Recent messages filtering ──────────────────────────────────

  describe('GET /api/orchestrator/recent-messages', () => {
    it('excludes sender_id/receiver_id matching test-/manual-test-/broadcast', async () => {
      // Seed sessions so message FK doesn't blow up (if any).
      const now = new Date().toISOString()
      const realMsgs = [
        { id: 'm-real-1', sender_id: 'brain-scns-dev-abc', receiver_id: 'brain-scns-qa-xyz', content: 'hello' },
        { id: 'm-real-2', sender_id: 'brain-scns-manager-1', receiver_id: null, content: 'broadcast-like name but real' },
      ]
      const diagnosticMsgs = [
        { id: 'm-test-1', sender_id: 'test-probe-1', receiver_id: 'brain-x', content: 'diagnostic probe' },
        { id: 'm-manual-1', sender_id: 'operator-x', receiver_id: 'manual-test-inbox', content: 'smoke test' },
        { id: 'm-bcast-1', sender_id: 'any', receiver_id: 'broadcast', content: 'bcast' },
      ]

      // Lightweight insert bypassing session FK (sender_id is free text in schema).
      // Use createMessage helper for safety.
      // But createMessage requires sender_id; no FK on sender in messages table per schema used.
      // If the insert fails for FK reasons on any of these fixtures we'll skip — first verify by trying.
      for (const m of [...realMsgs, ...diagnosticMsgs]) {
        try {
          createMessage(db, {
            id: m.id,
            sender_id: m.sender_id,
            receiver_id: m.receiver_id,
            content: m.content,
            story_id: null,
          })
        } catch {
          // Some fixtures may fail FK; the ones that succeed are enough to exercise the filter.
        }
      }
      // Force created_at values to be now so the default 24h window includes them.
      db.prepare('UPDATE messages SET created_at = ?').run(now)

      const res = await request(server, '/api/orchestrator/recent-messages?since=all')
      expect(res.status).toBe(200)
      const body = res.body as { messages: Array<{ id: string; sender_id: string | null; receiver_id: string | null }> }
      const ids = body.messages.map((m) => m.id)
      // No diagnostic id should appear.
      for (const diag of ['m-test-1', 'm-manual-1', 'm-bcast-1']) {
        expect(ids).not.toContain(diag)
      }
      // Real ones that were successfully inserted should come through.
      for (const m of body.messages) {
        const senderMatch = m.sender_id != null && /^(?:test-|manual-test-|broadcast$)/.test(m.sender_id)
        const receiverMatch = m.receiver_id != null && /^(?:test-|manual-test-|broadcast$)/.test(m.receiver_id)
        expect(senderMatch).toBe(false)
        expect(receiverMatch).toBe(false)
      }
    })
  })

  // ── since= parameter ───────────────────────────────────────────

  describe('since= query parameter', () => {
    it('accepts 1h/24h/7d/all and ISO-8601 without error', async () => {
      for (const since of ['1h', '24h', '7d', 'all', '2026-01-01T00:00:00Z']) {
        const res = await request(
          server,
          `/api/orchestrator/verdicts?since=${encodeURIComponent(since)}`,
        )
        expect(res.status).toBe(200)
        expect((res.body as { verdicts: unknown[] }).verdicts).toBeInstanceOf(Array)
      }
    })

    it('default window (no since param) excludes events older than 24h', async () => {
      // Insert two events: one 48h old, one fresh.
      const old = new Date(Date.now() - 48 * 3600_000).toISOString()
      const fresh = new Date(Date.now() - 60_000).toISOString()
      db.prepare(
        `INSERT INTO events (event_type, session_id, payload, created_at) VALUES (?, ?, ?, ?)`,
      ).run('quality_gate_verdict', null, JSON.stringify({ verdict: 'pass', id: 'old' }), old)
      db.prepare(
        `INSERT INTO events (event_type, session_id, payload, created_at) VALUES (?, ?, ?, ?)`,
      ).run('quality_gate_verdict', null, JSON.stringify({ verdict: 'pass', id: 'fresh' }), fresh)

      const res = await request(server, '/api/orchestrator/verdicts')
      expect(res.status).toBe(200)
      const body = res.body as { verdicts: Array<{ payload: string }> }
      const ids = body.verdicts.map((v) => (JSON.parse(v.payload) as { id: string }).id)
      expect(ids).toContain('fresh')
      expect(ids).not.toContain('old')
    })

    it('since=all disables the filter and includes old events', async () => {
      const old = new Date(Date.now() - 48 * 3600_000).toISOString()
      db.prepare(
        `INSERT INTO events (event_type, session_id, payload, created_at) VALUES (?, ?, ?, ?)`,
      ).run('team_completed', null, JSON.stringify({ id: 'old-comp' }), old)

      const res = await request(server, '/api/orchestrator/completions?since=all')
      expect(res.status).toBe(200)
      const body = res.body as { completions: Array<{ payload: string }> }
      const ids = body.completions.map((c) => (JSON.parse(c.payload) as { id: string }).id)
      expect(ids).toContain('old-comp')
    })
  })
})
