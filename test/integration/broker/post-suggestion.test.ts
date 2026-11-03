/**
 * Integration test for POST /api/suggestions (Phase 13.9.5).
 *
 * Uses a real broker, a real filesystem-backed suggestionStore, and real
 * HTTP. Verifies round-trip: POST JSON → file on disk → parseable via the
 * same suggestion-file parser → visible via GET /api/suggestions.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, closeDatabase } from '../../../src/broker/storage/db.js'
import { createEventLog } from '../../../src/broker/services/event-log.js'
import { createEventDispatcher } from '../../../src/broker/event-dispatcher.js'
import { createBrokerServer, type BrokerServer } from '../../../src/broker/server.js'
import { ShutdownManager } from '../../../src/broker/shutdown.js'
import { createSuggestionStore } from '../../../src/suggest/suggestion-store.js'
import { parseSuggestion } from '../../../src/suggest/suggestion-file.js'
import type { Suggestion } from '../../../src/suggest/types.js'
import type Database from 'better-sqlite3'

describe('POST /api/suggestions (integration)', () => {
  let db: Database.Database
  let broker: BrokerServer
  let server: Server
  let baseUrl: string
  let tmpRoot: string

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

    tmpRoot = mkdtempSync(join(tmpdir(), 'scns-post-sug-'))
    const store = createSuggestionStore({ rootDir: tmpRoot })
    broker.setDashboardDeps({
      suggestionStore: {
        listByStatus: (status: string) => store.list(status as 'pending'),
        approve: (id: string) => store.updateStatus(id, 'approved'),
        reject: (id: string) => store.updateStatus(id, 'rejected'),
        save: (s: Suggestion) => {
          store.save(s)
        },
      },
    })
  })

  afterEach(async () => {
    await broker.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    closeDatabase(db)
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('persists a posted suggestion to disk in parseable format', async () => {
    const postRes = await fetch(`${baseUrl}/api/suggestions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'integration roundtrip',
        type: 'workflow',
        confidence: 0.75,
        description: 'integration body',
        estimatedComplexity: 'solo',
      }),
    })
    expect(postRes.status).toBe(201)
    const posted = (await postRes.json()) as { id: string; path: string; suggestion: Suggestion }

    // File exists on disk in pending/
    const pendingDir = join(tmpRoot, 'pending')
    const files = readdirSync(pendingDir)
    expect(files).toContain(`${posted.id}.md`)

    // File parses back via the canonical parser
    const raw = readFileSync(join(pendingDir, `${posted.id}.md`), 'utf-8')
    const parsed = parseSuggestion(raw)
    expect(parsed.id).toBe(posted.id)
    expect(parsed.title).toBe('integration roundtrip')
    expect(parsed.type).toBe('workflow')
    expect(parsed.status).toBe('pending')

    // GET /api/suggestions?status=pending returns it
    const getRes = await fetch(`${baseUrl}/api/suggestions?status=pending`)
    expect(getRes.status).toBe(200)
    const body = (await getRes.json()) as { suggestions: Suggestion[] }
    const ids = body.suggestions.map((s) => s.id)
    expect(ids).toContain(posted.id)
  })
})
