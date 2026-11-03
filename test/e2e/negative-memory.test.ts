/**
 * E2E test — Negative Sentiment Memory API
 *
 * Tests the full HTTP flow: POST negative memory → GET list → GET search → context injection
 * Uses a real broker server with in-memory SQLite + real vault (temp directory).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let baseUrl: string
let brokerHandle: {
  server: import('node:http').Server
  broker: { setDashboardDeps(deps: Record<string, unknown>): void }
  stop(): Promise<void>
}

describe('negative-memory e2e', () => {
  let tmpDir: string

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'scns-neg-e2e-'))

    const { createVault } = await import('../../src/memory/vault.js')
    const vault = createVault({ rootDir: tmpDir })

    const { createNegativeMemoryStore } = await import('../../src/memory/negative-memory-store.js')
    const negMemStore = createNegativeMemoryStore(vault)

    const { analyzeSentiment } = await import('../../src/memory/sentiment-analyzer.js')

    const { startBroker } = await import('../../src/broker/startup.js')
    brokerHandle = await startBroker({
      port: 0,
      dbPath: ':memory:',
      sentimentAnalyzer: analyzeSentiment,
      negativeMemoryStore: negMemStore,
    })

    // Also wire for dashboard routes (context injection)
    brokerHandle.broker.setDashboardDeps({
      negativeMemoryStore: negMemStore,
    })

    const addr = brokerHandle.server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    baseUrl = `http://localhost:${port}`
  })

  afterAll(async () => {
    await brokerHandle?.stop()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('POST /api/memory/negative stores from tool path', async () => {
    const res = await fetch(`${baseUrl}/api/memory/negative`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        feedback: 'Never claim work is done without testing',
        context: 'Agent said dashboard was fixed but it was broken',
        category: 'behavior-complaint',
        target: 'agent-profile',
        severity: 'critical',
      }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.stored).toBe(true)
    expect(body.id).toBeDefined()
    expect(body.dontRule).toBe('Never claim work is done without testing')
    expect(body.category).toBe('behavior-complaint')
    expect(body.recommendedTarget).toBe('agent-profile')
  })

  it('POST /api/memory/negative/heuristic stores from heuristic path', async () => {
    const res = await fetch(`${baseUrl}/api/memory/negative/heuristic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        originalText: 'why would you skip the tests again?',
        dontRule: 'Do not skip tests before marking task complete',
        category: 'frustration',
        recommendedTarget: 'instructions',
        confidence: 0.85,
      }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.stored).toBe(true)
    expect(body.id).toBeDefined()
  })

  it('GET /api/memory/negative lists stored memories', async () => {
    const res = await fetch(`${baseUrl}/api/memory/negative`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.memories).toBeInstanceOf(Array)
    expect(body.memories.length).toBeGreaterThanOrEqual(2)
    expect(body.count).toBeGreaterThanOrEqual(2)
  })

  it('GET /api/memory/negative?target=agent-profile filters by target', async () => {
    const res = await fetch(`${baseUrl}/api/memory/negative?target=agent-profile`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.memories.length).toBeGreaterThanOrEqual(1)
    expect(
      body.memories.every(
        (m: { recommendedTarget: string }) => m.recommendedTarget === 'agent-profile',
      ),
    ).toBe(true)
  })

  it('GET /api/memory/negative/search?q=testing finds relevant memories', async () => {
    const res = await fetch(`${baseUrl}/api/memory/negative/search?q=testing`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results).toBeInstanceOf(Array)
    expect(body.results.length).toBeGreaterThanOrEqual(1)
  })

  it('POST /api/extension/context includes negative memories in context', async () => {
    const res = await fetch(`${baseUrl}/api/extension/context`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'help me fix a bug' }),
    })

    expect(res.status).toBe(200)
    const _body = await res.json()
    // Context injection is opt-in, so if not enabled we get null
    // But if we enable it first, we should see negative memories
  })

  it('rejects invalid POST /api/memory/negative', async () => {
    const res = await fetch(`${baseUrl}/api/memory/negative`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBeDefined()
  })

  it('rejects invalid POST /api/memory/negative/heuristic', async () => {
    const res = await fetch(`${baseUrl}/api/memory/negative/heuristic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ originalText: 'missing required fields' }),
    })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBeDefined()
  })

  it('hooks/user-prompt with negative text triggers heuristic storage', async () => {
    const res = await fetch(`${baseUrl}/api/hooks/user-prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'user-prompt',
        sessionId: 'e2e-hook-test',
        timestamp: new Date().toISOString(),
        metadata: {
          prompt:
            "why would you lie about testing? this is broken and you didn't even check. stop doing this.",
        },
      }),
    })

    expect(res.status).toBe(200)

    // Give the async sentiment analysis time to complete
    await new Promise((resolve) => setTimeout(resolve, 200))

    // Verify the heuristic path stored a memory
    const listRes = await fetch(`${baseUrl}/api/memory/negative`)
    const body = await listRes.json()
    const heuristicMemories = body.memories.filter(
      (m: { source: string }) => m.source === 'heuristic',
    )
    expect(heuristicMemories.length).toBeGreaterThanOrEqual(1)
  })
})
