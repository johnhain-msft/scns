/**
 * Integration tests for Phase 15 broker extension routes.
 * Tests the /api/extension/config, /api/extension/context,
 * /api/memory/store, and /api/sessions endpoints through
 * the real Express app with SQLite.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { openDatabase, closeDatabase } from '../../../src/broker/storage/db.js'
import { createEventLog } from '../../../src/broker/services/event-log.js'
import { createEventDispatcher } from '../../../src/broker/event-dispatcher.js'
import { createBrokerServer, type BrokerServer } from '../../../src/broker/server.js'
import type Database from 'better-sqlite3'

// ── Helpers ────────────────────────────────────────────────────

interface TestResponse {
  status: number
  body: unknown
}

let db: Database.Database
let broker: BrokerServer
let server: Server
let baseUrl: string

async function req(method: string, path: string, body?: unknown): Promise<TestResponse> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, body: json }
}

// ── Setup / Teardown ───────────────────────────────────────────

function setupBroker(deps?: {
  memorySearch?: {
    search(query: string, topK: number): Promise<unknown>
    briefing?(query: string, topK: number, opts?: { sessionId?: string }): Promise<unknown>
  }
  memoryStore?: { store(key: string, value: string): Promise<{ stored: boolean; key: string }> }
  suggestionStore?: {
    listByStatus(status: string): ReadonlyArray<unknown>
    approve(id: string): unknown
    reject(id: string): unknown
  }
}) {
  db = openDatabase(':memory:')
  const dispatcher = createEventDispatcher()
  const eventLog = createEventLog(db, dispatcher)
  broker = createBrokerServer(db, eventLog, undefined, dispatcher, {
    authToken: null,
    ...deps,
  })

  server = createServer(broker.app)
  server.listen(0)
  const addr = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${addr.port}`
}

async function teardown() {
  await broker.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  closeDatabase(db)
}

// ═══════════════════════════════════════════════════════════════
// Extension Config
// ═══════════════════════════════════════════════════════════════

describe('/api/extension/config', () => {
  beforeEach(() => setupBroker())
  afterEach(teardown)

  it('returns defaults when no config stored', async () => {
    const { status, body } = await req('GET', '/api/extension/config')
    expect(status).toBe(200)
    expect(body).toEqual({
      contextInjectionEnabled: false,
      maxMemories: 5,
      maxSuggestions: 3,
    })
  })

  it('returns stored config values', async () => {
    // Insert config via state table
    db.exec(`
      INSERT INTO shared_state (key, value)
      VALUES ('extension.config', '${JSON.stringify({
        contextInjectionEnabled: true,
        maxMemories: 10,
        maxSuggestions: 5,
      })}')
    `)

    const { status, body } = await req('GET', '/api/extension/config')
    expect(status).toBe(200)
    expect(body).toEqual({
      contextInjectionEnabled: true,
      maxMemories: 10,
      maxSuggestions: 5,
    })
  })

  it('returns defaults when stored config is invalid JSON', async () => {
    db.exec(`INSERT INTO shared_state (key, value) VALUES ('extension.config', 'not-json')`)

    const { status, body } = await req('GET', '/api/extension/config')
    expect(status).toBe(200)
    expect(body).toEqual({
      contextInjectionEnabled: false,
      maxMemories: 5,
      maxSuggestions: 3,
    })
  })
})

// ═══════════════════════════════════════════════════════════════
// Extension Context
// ═══════════════════════════════════════════════════════════════

describe('/api/extension/context', () => {
  it('returns null context when no sources available', async () => {
    setupBroker()
    const { status, body } = await req('POST', '/api/extension/context', {
      prompt: 'test prompt',
    })
    expect(status).toBe(200)
    expect(body).toEqual({
      additionalContext: null,
      memoriesUsed: 0,
      suggestionsUsed: 0,
    })
    await teardown()
  })

  it('rejects invalid body', async () => {
    setupBroker()
    const { status, body } = await req('POST', '/api/extension/context', {})
    expect(status).toBe(400)
    expect(body).toHaveProperty('error')
    await teardown()
  })

  it('includes memory results when memorySearch is available', async () => {
    setupBroker({
      memorySearch: {
        search: async () => ({
          results: [{ content: 'Memory A' }, { content: 'Memory B' }],
        }),
      },
    })

    const { status, body } = await req('POST', '/api/extension/context', {
      prompt: 'test query',
    })
    expect(status).toBe(200)
    const b = body as { additionalContext: string; memoriesUsed: number; suggestionsUsed: number }
    expect(b.additionalContext).toContain('Memory A')
    expect(b.additionalContext).toContain('Memory B')
    expect(b.memoriesUsed).toBe(2)
    expect(b.suggestionsUsed).toBe(0)
    await teardown()
  })

  it('MAGMA: injects the Stage-4 briefing text when memorySearch.briefing is available (preferred over search)', async () => {
    let briefingQuery = ''
    let searchCalled = false
    setupBroker({
      memorySearch: {
        // If the route ever falls back to search() this would flip searchCalled true (it must not).
        search: async () => {
          searchCalled = true
          return { results: [{ content: 'PLAIN-JOIN-FALLBACK' }] }
        },
        briefing: async (q: string) => {
          briefingQuery = q
          return {
            text: 'Relevant SCNS memories:\n[<t:2026> the broker auto-merged the branch <ref:42>]',
            chunkIds: [42, 7, 9],
          }
        },
      },
    })

    const { status, body } = await req('POST', '/api/extension/context', {
      prompt: 'why did the broker auto-merge',
    })
    expect(status).toBe(200)
    const b = body as { additionalContext: string; memoriesUsed: number }
    expect(briefingQuery).toBe('why did the broker auto-merge') // briefing() actually invoked with the prompt
    expect(searchCalled).toBe(false) // briefing PREFERRED — search() not used on this path
    expect(b.additionalContext).toContain('<ref:42>') // the Stage-4 provenance-scaffolded briefing is injected
    expect(b.additionalContext).not.toContain('PLAIN-JOIN-FALLBACK')
    expect(b.memoriesUsed).toBe(3) // chunkIds length
    await teardown()
  })

  it('MAGMA: an empty briefing (no text) injects no memory block and does not throw', async () => {
    setupBroker({
      memorySearch: {
        search: async () => ({ results: [] }),
        briefing: async () => ({ text: '', chunkIds: [] }),
      },
    })
    const { status, body } = await req('POST', '/api/extension/context', {
      prompt: 'nothing relevant',
    })
    expect(status).toBe(200)
    const b = body as { memoriesUsed: number }
    expect(b.memoriesUsed).toBe(0)
    await teardown()
  })

  it('includes suggestions when suggestionStore is available', async () => {
    // Fixtures share content words with the prompt — since issue #75 the block is
    // relevance-filtered by default, so off-topic titles would (correctly) not inject.
    setupBroker({
      suggestionStore: {
        listByStatus: () => [
          { title: 'Harden broker heartbeat retry backoff', description: 'desc1' },
          { title: 'Add jitter to the broker heartbeat retry loop', description: 'desc2' },
        ],
        approve: () => ({}),
        reject: () => ({}),
      },
    })

    const { status, body } = await req('POST', '/api/extension/context', {
      prompt: 'why does the broker heartbeat retry loop hammer the backoff',
    })
    expect(status).toBe(200)
    const b = body as { additionalContext: string; memoriesUsed: number; suggestionsUsed: number }
    expect(b.additionalContext).toContain('Harden broker heartbeat retry backoff')
    expect(b.suggestionsUsed).toBe(2)
    await teardown()
  })

  it('combines memories and suggestions', async () => {
    setupBroker({
      memorySearch: {
        search: async () => ({
          results: [{ content: 'Relevant memory' }],
        }),
      },
      suggestionStore: {
        listByStatus: () => [{ title: 'Stabilize the flaky playwright test suite' }],
        approve: () => ({}),
        reject: () => ({}),
      },
    })

    const { status, body } = await req('POST', '/api/extension/context', {
      prompt: 'the flaky playwright test suite keeps timing out',
    })
    expect(status).toBe(200)
    const b = body as { additionalContext: string; memoriesUsed: number; suggestionsUsed: number }
    expect(b.additionalContext).toContain('Relevant memory')
    expect(b.additionalContext).toContain('Stabilize the flaky playwright test suite')
    expect(b.memoriesUsed).toBe(1)
    expect(b.suggestionsUsed).toBe(1)
    await teardown()
  })

  it('gracefully handles memory search failure', async () => {
    setupBroker({
      memorySearch: {
        search: async () => {
          throw new Error('DB error')
        },
      },
    })

    const { status, body } = await req('POST', '/api/extension/context', {
      prompt: 'test',
    })
    expect(status).toBe(200)
    expect(body).toEqual({
      additionalContext: null,
      memoriesUsed: 0,
      suggestionsUsed: 0,
    })
    await teardown()
  })

  // ── N1: bind a human verdict to the EXACT retrieval — sessionId IN, experienceId OUT ────────────
  // The route must thread the client's session key to briefing() (so the experience row carries a
  // session key the re-ask detector can scope to) and STOP DROPPING the experienceId (dashboard-routes.ts
  // used to destructure { text, chunkIds } only — the id it needs to bind a human outcome was discarded).

  it('N1: threads sessionId to briefing() and returns the experienceId (stops dropping it)', async () => {
    let seenOpts: unknown = 'UNSET'
    setupBroker({
      memorySearch: {
        search: async () => ({ results: [] }),
        briefing: async (_q: string, _k: number, opts?: { sessionId?: string }) => {
          seenOpts = opts
          return {
            text: 'Relevant SCNS memories:\n[<ref:7> the broker auto-merged]',
            chunkIds: [7, 9],
            experienceId: 909,
          }
        },
      },
    })

    const { status, body } = await req('POST', '/api/extension/context', {
      prompt: 'why did the broker auto-merge the branch',
      sessionId: 'sess-xyz',
    })
    expect(status).toBe(200)
    expect(seenOpts).toEqual({ sessionId: 'sess-xyz' }) // the session key reaches the briefing seam
    const b = body as { additionalContext: string; memoriesUsed: number; experienceId?: number }
    expect(b.additionalContext).toContain('<ref:7>')
    expect(b.experienceId).toBe(909) // the id is returned, not dropped
    await teardown()
  })

  it('N1: sessionId is OPTIONAL — the route still returns the experienceId when present', async () => {
    setupBroker({
      memorySearch: {
        search: async () => ({ results: [] }),
        briefing: async () => ({
          text: 'Relevant SCNS memories:\n[x]',
          chunkIds: [1],
          experienceId: 5,
        }),
      },
    })
    const { status, body } = await req('POST', '/api/extension/context', {
      prompt: 'some real standalone question here',
    })
    expect(status).toBe(200)
    expect((body as { experienceId?: number }).experienceId).toBe(5)
    await teardown()
  })

  it('N1: no experienceId field when the briefing does not mint one (backward-compatible)', async () => {
    setupBroker({
      memorySearch: {
        search: async () => ({ results: [] }),
        briefing: async () => ({ text: 'Relevant SCNS memories:\n[y]', chunkIds: [2] }),
      },
    })
    const { status, body } = await req('POST', '/api/extension/context', {
      prompt: 'another real standalone question',
    })
    expect(status).toBe(200)
    expect(body).not.toHaveProperty('experienceId')
    await teardown()
  })
})

// ═══════════════════════════════════════════════════════════════
// Extension Context — injection relevance (issue #75)
// ═══════════════════════════════════════════════════════════════

/**
 * Only the memory briefing used to be relevance-aware; pending suggestions and negative
 * rules injected in store order into EVERY prompt. Since issue #75 both blocks are
 * relevance-filtered against the prompt by default, with SCNS_INJECTION_RELEVANCE=0 as the
 * flip-back lever restoring the exact old behavior.
 */
describe('/api/extension/context — injection relevance (issue #75)', () => {
  const PROMPT = 'why does the broker heartbeat retry loop hammer the backoff'

  const ON_TOPIC_1 = 'Harden broker heartbeat retry backoff'
  const ON_TOPIC_2 = 'Add jitter to the broker heartbeat retry loop'
  const OFF_TOPIC_1 = 'Refactor scheduler cold start catch-up'
  const OFF_TOPIC_2 = 'Adopt zod validation for dashboard forms'

  function suggestionStoreOf(titles: readonly string[]) {
    return {
      listByStatus: () => titles.map((title) => ({ title })),
      approve: () => ({}),
      reject: () => ({}),
    }
  }

  /** Full dashboard-deps negativeMemoryStore shape; only list() matters to this route. */
  function negativeStoreOf(memories: readonly Record<string, unknown>[]) {
    return {
      storeFromTool: () => ({
        id: 'unused',
        dontRule: 'unused',
        category: 'correction',
        recommendedTarget: 'general',
      }),
      storeFromHeuristic: () => ({ id: 'unused' }),
      list: () => memories,
      search: () => [],
      count: () => memories.length,
    }
  }

  const keepRule = (dontRule: string, over: Record<string, unknown> = {}) => ({
    dontRule,
    confidence: 0.9,
    pinned: false,
    criticVerdict: { status: 'keep' },
    ...over,
  })

  it('injects only prompt-relevant suggestions, best match first (off-topic ones do not consume the budget)', async () => {
    setupBroker({
      suggestionStore: suggestionStoreOf([OFF_TOPIC_1, ON_TOPIC_2, OFF_TOPIC_2, ON_TOPIC_1]),
    })

    const { status, body } = await req('POST', '/api/extension/context', { prompt: PROMPT })
    expect(status).toBe(200)
    const b = body as { additionalContext: string; suggestionsUsed: number }
    expect(b.additionalContext).toContain(ON_TOPIC_1)
    expect(b.additionalContext).toContain(ON_TOPIC_2)
    expect(b.additionalContext).not.toContain(OFF_TOPIC_1)
    expect(b.additionalContext).not.toContain(OFF_TOPIC_2)
    expect(b.suggestionsUsed).toBe(2)
    // Best match first: ON_TOPIC_1 covers the prompt more tightly than ON_TOPIC_2,
    // so it outranks ON_TOPIC_2 despite sitting BEHIND it in store order.
    expect(b.additionalContext.indexOf(ON_TOPIC_1)).toBeLessThan(
      b.additionalContext.indexOf(ON_TOPIC_2),
    )
    await teardown()
  })

  it('injects NO suggestions block when nothing pending is relevant', async () => {
    setupBroker({ suggestionStore: suggestionStoreOf([OFF_TOPIC_1, OFF_TOPIC_2]) })

    const { status, body } = await req('POST', '/api/extension/context', { prompt: PROMPT })
    expect(status).toBe(200)
    expect(body).toEqual({ additionalContext: null, memoriesUsed: 0, suggestionsUsed: 0 })
    await teardown()
  })

  it('still caps relevant suggestions at 3', async () => {
    setupBroker({
      suggestionStore: suggestionStoreOf([
        'Harden broker heartbeat retry backoff',
        'Add jitter to the broker heartbeat retry loop',
        'Log every broker heartbeat retry rejection',
        'Alert when the broker heartbeat retry loop stalls',
      ]),
    })

    const { status, body } = await req('POST', '/api/extension/context', { prompt: PROMPT })
    expect(status).toBe(200)
    expect((body as { suggestionsUsed: number }).suggestionsUsed).toBe(3)
    await teardown()
  })

  it('negative rules: on-topic and pinned rules inject; off-topic and critic-suppressed do not', async () => {
    const ON_RULE_1 = 'Never bypass the broker heartbeat retry backoff'
    const ON_RULE_2 = 'Do not call the heartbeat poller from the retry loop'
    const ON_RULE_3 = 'Never mock the broker heartbeat in retry tests'
    const OFF_RULE_1 = 'Do not hand-edit generated schema files'
    const OFF_RULE_2 = 'Never run destructive migrations on live data'
    const PINNED_RULE = 'Never commit credentials to the repository'
    const SUPPRESSED_ON_TOPIC = 'Quality gate rejected broker heartbeat retry backoff run'

    setupBroker()
    broker.setDashboardDeps({
      negativeMemoryStore: negativeStoreOf([
        keepRule(OFF_RULE_1),
        keepRule(ON_RULE_1),
        { dontRule: SUPPRESSED_ON_TOPIC, confidence: 0.9, criticVerdict: { status: 'suppress' } },
        keepRule(ON_RULE_2),
        { dontRule: PINNED_RULE, confidence: 0.9, pinned: true, criticVerdict: null },
        keepRule(OFF_RULE_2),
        keepRule(ON_RULE_3),
      ]),
    })

    const { status, body } = await req('POST', '/api/extension/context', { prompt: PROMPT })
    expect(status).toBe(200)
    const ctx = (body as { additionalContext: string }).additionalContext
    expect(ctx).toContain('Things to AVOID')
    expect(ctx).toContain(ON_RULE_1)
    expect(ctx).toContain(ON_RULE_2)
    expect(ctx).toContain(ON_RULE_3)
    expect(ctx).toContain(PINNED_RULE) // pinned bypasses relevance like it bypasses the critic
    expect(ctx).not.toContain(OFF_RULE_1)
    expect(ctx).not.toContain(OFF_RULE_2)
    expect(ctx).not.toContain(SUPPRESSED_ON_TOPIC) // quality gate still runs FIRST
    await teardown()
  })

  it('negative rules: the floor keeps the first 3 eligible rules flowing when nothing matches', async () => {
    const rules = [
      'Do not hand-edit generated schema files',
      'Never run destructive migrations on live data',
      'Do not skip the legacy database upgrade test',
      'Never delete another live participant inbox',
      'Do not open pull requests with open questions',
    ]
    setupBroker()
    broker.setDashboardDeps({
      negativeMemoryStore: negativeStoreOf(rules.map((r) => keepRule(r))),
    })

    const { status, body } = await req('POST', '/api/extension/context', { prompt: PROMPT })
    expect(status).toBe(200)
    const ctx = (body as { additionalContext: string }).additionalContext
    expect(ctx).toContain(rules[0])
    expect(ctx).toContain(rules[1])
    expect(ctx).toContain(rules[2])
    expect(ctx).not.toContain(rules[3])
    expect(ctx).not.toContain(rules[4])
    await teardown()
  })

  it('SCNS_INJECTION_RELEVANCE=0 restores the exact pre-#75 injection (byte-identical)', async () => {
    setupBroker({
      suggestionStore: suggestionStoreOf([OFF_TOPIC_1, ON_TOPIC_1, OFF_TOPIC_2, ON_TOPIC_2]),
    })
    broker.setDashboardDeps({
      negativeMemoryStore: negativeStoreOf([
        keepRule('Do not hand-edit generated schema files', { category: 'prohibition' }),
        keepRule('Never bypass the broker heartbeat retry backoff'),
      ]),
    })

    const prev = process.env.SCNS_INJECTION_RELEVANCE
    process.env.SCNS_INJECTION_RELEVANCE = '0'
    try {
      const { status, body } = await req('POST', '/api/extension/context', { prompt: PROMPT })
      expect(status).toBe(200)
      // The old behavior, byte for byte: first 3 pending suggestions in STORE order
      // (relevance ignored), then every eligible rule in STORE order with its category tag.
      expect((body as { additionalContext: string }).additionalContext).toBe(
        'Pending SCNS suggestions:\n' +
          `${OFF_TOPIC_1}\n${ON_TOPIC_1}\n${OFF_TOPIC_2}` +
          '\n\n' +
          'IMPORTANT — Things to AVOID (learned from past feedback):\n' +
          '- Do not hand-edit generated schema files [prohibition]\n' +
          '- Never bypass the broker heartbeat retry backoff',
      )
      expect((body as { suggestionsUsed: number }).suggestionsUsed).toBe(3)
    } finally {
      // Inside the finally so a failing assertion cannot leak the env var, the server,
      // or the DB handle into the rest of the suite.
      if (prev === undefined) delete process.env.SCNS_INJECTION_RELEVANCE
      else process.env.SCNS_INJECTION_RELEVANCE = prev
      await teardown()
    }
  })
})

// ═══════════════════════════════════════════════════════════════
// Memory Store
// ═══════════════════════════════════════════════════════════════

describe('/api/memory/store', () => {
  it('returns 503 when memoryStore not available', async () => {
    setupBroker()
    const { status, body } = await req('POST', '/api/memory/store', {
      key: 'test-key',
      value: 'test-value',
    })
    expect(status).toBe(503)
    expect(body).toHaveProperty('error')
    await teardown()
  })

  it('stores and returns result when memoryStore available', async () => {
    setupBroker({
      memoryStore: {
        store: async (key: string) => ({ stored: true, key }),
      },
    })

    // WI-3: the route normalizes the key to a .md filename. The vault indexes
    // only *.md, so a bare key (what the extension's scns_memory_store passes
    // verbatim from the model) previously wrote a file no search could ever
    // return — stored-but-invisible. See test/unit/broker/routes/memory-store-key.test.ts.
    const { status, body } = await req('POST', '/api/memory/store', {
      key: 'my-fact',
      value: 'important info',
    })
    expect(status).toBe(200)
    expect(body).toEqual({ stored: true, key: 'my-fact.md' })
    await teardown()
  })

  it('rejects invalid body', async () => {
    setupBroker({
      memoryStore: {
        store: async (key: string) => ({ stored: true, key }),
      },
    })

    const { status, body } = await req('POST', '/api/memory/store', { key: '', value: '' })
    expect(status).toBe(400)
    expect(body).toHaveProperty('error')
    await teardown()
  })
})

// ═══════════════════════════════════════════════════════════════
// Sessions Alias
// ═══════════════════════════════════════════════════════════════

describe('/api/sessions', () => {
  beforeEach(() => setupBroker())
  afterEach(teardown)

  it('returns empty sessions list', async () => {
    const { status, body } = await req('GET', '/api/sessions')
    expect(status).toBe(200)
    expect(body).toHaveProperty('sessions')
    expect((body as { sessions: unknown[] }).sessions).toEqual([])
  })

  it('returns sessions from database', async () => {
    // Create a session via the register API
    await req('POST', '/api/register', {
      id: 'test-sess-1',
      purpose: 'test session',
    })

    const { status, body } = await req('GET', '/api/sessions')
    expect(status).toBe(200)
    const sessions = (body as { sessions: unknown[] }).sessions
    expect(sessions.length).toBeGreaterThanOrEqual(1)
  })
})

// ═══════════════════════════════════════════════════════════════
// Session Hook Events (/api/hooks/:event)
// ═══════════════════════════════════════════════════════════════

describe('/api/hooks/:event', () => {
  beforeEach(() => setupBroker())
  afterEach(teardown)

  it('accepts event with event field in body', async () => {
    const { status, body } = await req('POST', '/api/hooks/session-start', {
      event: 'session-start',
      sessionId: 'test-hook-1',
      timestamp: new Date().toISOString(),
    })
    expect(status).toBe(200)
    const b = body as { acknowledged: boolean; observationId: string }
    expect(b.acknowledged).toBe(true)
    expect(b.observationId).toBeTruthy()
  })

  it('accepts event WITHOUT event field in body — coerces from URL', async () => {
    const { status, body } = await req('POST', '/api/hooks/session-start', {
      sessionId: 'test-hook-2',
      timestamp: new Date().toISOString(),
    })
    expect(status).toBe(200)
    const b = body as { acknowledged: boolean; observationId: string }
    expect(b.acknowledged).toBe(true)
  })

  it('rejects when body event mismatches URL event', async () => {
    const { status, body } = await req('POST', '/api/hooks/session-start', {
      event: 'session-end',
      sessionId: 'test-hook-3',
      timestamp: new Date().toISOString(),
    })
    expect(status).toBe(400)
    expect(body).toHaveProperty('error')
    expect((body as { error: string }).error).toContain('does not match')
  })

  it('rejects invalid event type in URL', async () => {
    const { status } = await req('POST', '/api/hooks/invalid-event', {
      sessionId: 'test-hook-4',
      timestamp: new Date().toISOString(),
    })
    expect(status).toBe(400)
  })

  it('accepts all 8 event types', async () => {
    const events = [
      'session-start',
      'session-end',
      'tool-use',
      'pre-compact',
      'user-prompt',
      'error',
      'pre-tool-use',
      'post-tool-use',
    ]
    for (const event of events) {
      const { status, body } = await req('POST', `/api/hooks/${event}`, {
        event,
        sessionId: 'test-hook-all',
        timestamp: new Date().toISOString(),
      })
      expect(status).toBe(200)
      expect((body as { acknowledged: boolean }).acknowledged).toBe(true)
    }
  })

  it('accepts tool metadata in pre-tool-use event', async () => {
    const { status, body } = await req('POST', '/api/hooks/pre-tool-use', {
      event: 'pre-tool-use',
      sessionId: 'test-hook-tool',
      timestamp: new Date().toISOString(),
      tool: 'bash',
      toolArgs: '{"command":"ls"}',
    })
    expect(status).toBe(200)
    expect((body as { acknowledged: boolean }).acknowledged).toBe(true)
  })

  it('accepts error metadata in error event', async () => {
    const { status, body } = await req('POST', '/api/hooks/error', {
      event: 'error',
      sessionId: 'test-hook-err',
      timestamp: new Date().toISOString(),
      errorMessage: 'Something failed',
    })
    expect(status).toBe(200)
    expect((body as { acknowledged: boolean }).acknowledged).toBe(true)
  })

  it('coerces event from URL for all event types without body event', async () => {
    const events = [
      'session-start',
      'session-end',
      'user-prompt',
      'pre-tool-use',
      'post-tool-use',
      'error',
    ]
    for (const event of events) {
      const { status } = await req('POST', `/api/hooks/${event}`, {
        sessionId: `coerce-${event}`,
        timestamp: new Date().toISOString(),
      })
      expect(status).toBe(200)
    }
  })
})
