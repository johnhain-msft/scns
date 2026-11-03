import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import http from 'node:http'
import { openDatabase, closeDatabase } from '../../../../src/broker/storage/db.js'
import { createEventLog } from '../../../../src/broker/services/event-log.js'
import { createBrokerServer, type BrokerServer } from '../../../../src/broker/server.js'
import { findAllMessages } from '../../../../src/broker/storage/repositories/message-repository.js'
import { getEventsSinceFiltered } from '../../../../src/broker/storage/repositories/event-repository.js'
import { findRecentScalingDecisions } from '../../../../src/broker/storage/repositories/scaling-outcomes-repository.js'
import type Database from 'better-sqlite3'

/**
 * Regression: the orchestrator `?since=` filter compares an ISO-8601 cutoff
 * (`2026-03-15T11:00:00.000Z`) against `created_at` values written by the
 * column default `datetime('now')`, which stores `2026-03-15 12:00:00`.
 *
 * SQLite compares these as plain strings. At offset 10 the stored value has
 * `' '` (0x20) and the cutoff has `'T'` (0x54), so every row whose date equals
 * the cutoff's date sorts *below* the cutoff and is silently dropped — no
 * matter how recent it is. That is the dashboard "staleness" symptom.
 *
 * Timestamps here are pinned (not wall-clock) so the reproduction cannot flake
 * across a UTC midnight boundary, and each case carries a negative control
 * (a genuinely out-of-window row that must stay excluded).
 */

// Pinned reference day — all fixtures share this UTC date.
const CUTOFF_ISO = '2026-03-15T11:00:00.000Z'
/** Inside the window: one hour after the cutoff, same UTC date. */
const IN_WINDOW = '2026-03-15 12:00:00'
/** Negative control: same UTC date but an hour *before* the cutoff. */
const BEFORE_CUTOFF = '2026-03-15 10:00:00'
/** Negative control: the previous UTC date. */
const PREVIOUS_DAY = '2026-03-14 12:00:00'

function seedSession(db: Database.Database, id: string): void {
  db.prepare('INSERT OR IGNORE INTO sessions (id, purpose) VALUES (?, ?)').run(id, 'test fixture')
}

function seedMessage(db: Database.Database, id: string, createdAt: string): void {
  seedSession(db, 'brain-scns-dev-sender')
  seedSession(db, 'brain-scns-qa-receiver')
  db.prepare(
    `INSERT INTO messages (id, sender_id, receiver_id, content, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, 'brain-scns-dev-sender', 'brain-scns-qa-receiver', `content ${id}`, createdAt)
}

function seedEvent(db: Database.Database, marker: string, createdAt: string): void {
  db.prepare(
    `INSERT INTO events (event_type, session_id, payload, created_at) VALUES (?, ?, ?, ?)`,
  ).run('quality_gate_verdict', null, JSON.stringify({ id: marker }), createdAt)
}

function seedScalingDecision(db: Database.Database, sig: string, createdAt: string): void {
  db.prepare(
    `INSERT INTO scaling_decisions
       (task_signature, task_snippet, hint_shape, chosen_shape, reasoning, created_at)
     VALUES (?, ?, 'solo', 'team', 'because', ?)`,
  ).run(sig, `snippet ${sig}`, createdAt)
}

function request(server: Server, path: string): Promise<{ status: number; body: unknown }> {
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

describe('orchestrator since= filter vs SQLite datetime storage format', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openDatabase(':memory:')
  })

  afterEach(() => {
    closeDatabase(db)
  })

  it('stores created_at in SQLite datetime format, not ISO-8601', () => {
    // Establishes the premise: production rows land via the column default.
    seedSession(db, 'fmt-probe')
    const row = db.prepare('SELECT created_at FROM sessions WHERE id = ?').get('fmt-probe') as {
      created_at: string
    }
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    expect(row.created_at).not.toContain('T')
  })

  describe('findAllMessages', () => {
    it('includes a message inside the window when since is ISO-8601', () => {
      seedMessage(db, 'm-in-window', IN_WINDOW)
      seedMessage(db, 'm-before-cutoff', BEFORE_CUTOFF)
      seedMessage(db, 'm-previous-day', PREVIOUS_DAY)

      const ids = findAllMessages(db, { limit: 50, since: CUTOFF_ISO }).map((m) => m.id)

      expect(ids).toContain('m-in-window')
      // Negative controls: genuinely outside the window.
      expect(ids).not.toContain('m-before-cutoff')
      expect(ids).not.toContain('m-previous-day')
    })
  })

  describe('getEventsSinceFiltered', () => {
    it('includes an event inside the window when since is ISO-8601', () => {
      seedEvent(db, 'e-in-window', IN_WINDOW)
      seedEvent(db, 'e-before-cutoff', BEFORE_CUTOFF)
      seedEvent(db, 'e-previous-day', PREVIOUS_DAY)

      const ids = getEventsSinceFiltered(db, {
        afterId: 0,
        eventTypes: ['quality_gate_verdict'],
        limit: 50,
        newestFirst: true,
        since: CUTOFF_ISO,
      }).map((e) => (JSON.parse(e.payload as string) as { id: string }).id)

      expect(ids).toContain('e-in-window')
      expect(ids).not.toContain('e-before-cutoff')
      expect(ids).not.toContain('e-previous-day')
    })
  })

  describe('findRecentScalingDecisions', () => {
    it('includes a decision inside the window when since is ISO-8601', () => {
      seedScalingDecision(db, 'sig-in-window', IN_WINDOW)
      seedScalingDecision(db, 'sig-before-cutoff', BEFORE_CUTOFF)
      seedScalingDecision(db, 'sig-previous-day', PREVIOUS_DAY)

      const sigs = findRecentScalingDecisions(db, 50, CUTOFF_ISO).map((d) => d.task_signature)

      expect(sigs).toContain('sig-in-window')
      expect(sigs).not.toContain('sig-before-cutoff')
      expect(sigs).not.toContain('sig-previous-day')
    })
  })

  describe('orchestrator endpoints', () => {
    let broker: BrokerServer
    let server: Server

    beforeEach(async () => {
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
    })

    it('GET /api/orchestrator/recent-messages returns in-window rows', async () => {
      seedMessage(db, 'm-route-in-window', IN_WINDOW)
      seedMessage(db, 'm-route-previous-day', PREVIOUS_DAY)

      const res = await request(
        server,
        `/api/orchestrator/recent-messages?since=${encodeURIComponent(CUTOFF_ISO)}`,
      )
      expect(res.status).toBe(200)
      const ids = (res.body as { messages: Array<{ id: string }> }).messages.map((m) => m.id)

      expect(ids).toContain('m-route-in-window')
      expect(ids).not.toContain('m-route-previous-day')
    })

    it('GET /api/orchestrator/verdicts returns in-window rows', async () => {
      seedEvent(db, 'v-route-in-window', IN_WINDOW)
      seedEvent(db, 'v-route-previous-day', PREVIOUS_DAY)

      const res = await request(
        server,
        `/api/orchestrator/verdicts?since=${encodeURIComponent(CUTOFF_ISO)}`,
      )
      expect(res.status).toBe(200)
      const ids = (res.body as { verdicts: Array<{ payload: string }> }).verdicts.map(
        (v) => (JSON.parse(v.payload) as { id: string }).id,
      )

      expect(ids).toContain('v-route-in-window')
      expect(ids).not.toContain('v-route-previous-day')
    })

    it('GET /api/orchestrator/scaling-decisions returns in-window rows', async () => {
      seedScalingDecision(db, 'sig-route-in-window', IN_WINDOW)
      seedScalingDecision(db, 'sig-route-previous-day', PREVIOUS_DAY)

      const res = await request(
        server,
        `/api/orchestrator/scaling-decisions?since=${encodeURIComponent(CUTOFF_ISO)}`,
      )
      expect(res.status).toBe(200)
      const sigs = (res.body as { decisions: Array<{ task_signature: string }> }).decisions.map(
        (d) => d.task_signature,
      )

      expect(sigs).toContain('sig-route-in-window')
      expect(sigs).not.toContain('sig-route-previous-day')
    })
  })
})
