import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import http from 'node:http'
import { openDatabase, closeDatabase } from '../../../../src/broker/storage/db.js'
import { createEventLog } from '../../../../src/broker/services/event-log.js'
import { createBrokerServer, type BrokerServer } from '../../../../src/broker/server.js'
import type Database from 'better-sqlite3'

function request(
  server: Server,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined
    const req = http.request(
      {
        hostname: 'localhost',
        port: (server.address() as { port: number }).port,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let responseBody = ''
        res.on('data', (chunk: Buffer) => {
          responseBody += chunk.toString()
        })
        res.on('end', () => {
          let parsed: unknown
          try {
            parsed = JSON.parse(responseBody)
          } catch {
            parsed = responseBody
          }
          resolve({ status: res.statusCode!, body: parsed })
        })
      },
    )
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

describe('Hook routes — POST /api/hooks/:event', () => {
  let db: Database.Database
  let broker: BrokerServer
  let server: Server
  let handleSessionEvent: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    db = openDatabase(':memory:')
    const eventLog = createEventLog(db)
    handleSessionEvent = vi.fn().mockReturnValue({ id: 'obs-test-id' })
    broker = createBrokerServer(db, eventLog, undefined, undefined, {
      handleSessionEvent,
    })
    server = createServer(broker.app)
    await new Promise<void>((resolve) => server.listen(0, resolve))
  })

  afterEach(async () => {
    await broker.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    closeDatabase(db)
  })

  it('POST valid session-start event → 200 + acknowledged', async () => {
    const res = await request(server, 'POST', '/api/hooks/session-start', {
      event: 'session-start',
      sessionId: 'sess-1',
      timestamp: '2025-01-01T00:00:00Z',
    })
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown>
    expect(body.acknowledged).toBe(true)
    expect(body.observationId).toBe('obs-test-id')
  })

  it('POST valid session-end event → 200 + acknowledged', async () => {
    const res = await request(server, 'POST', '/api/hooks/session-end', {
      event: 'session-end',
      sessionId: 'sess-2',
      timestamp: '2025-01-01T01:00:00Z',
    })
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown>
    expect(body.acknowledged).toBe(true)
    expect(body.observationId).toBe('obs-test-id')
  })

  it('POST valid tool-use event with tool name → 200 + correct tool in callback', async () => {
    const res = await request(server, 'POST', '/api/hooks/tool-use', {
      event: 'tool-use',
      sessionId: 'sess-3',
      tool: 'edit',
      timestamp: '2025-01-01T02:00:00Z',
    })
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown>
    expect(body.acknowledged).toBe(true)

    expect(handleSessionEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'tool-use', tool: 'edit' }),
    )
  })

  it('POST valid pre-compact event → 200 + acknowledged', async () => {
    const res = await request(server, 'POST', '/api/hooks/pre-compact', {
      event: 'pre-compact',
      timestamp: '2025-01-01T03:00:00Z',
    })
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown>
    expect(body.acknowledged).toBe(true)
  })

  it('POST with mismatched event param vs body → 400', async () => {
    const res = await request(server, 'POST', '/api/hooks/session-start', {
      event: 'session-end',
      timestamp: '2025-01-01T00:00:00Z',
    })
    expect(res.status).toBe(400)
    const body = res.body as Record<string, unknown>
    expect(body.error).toBeDefined()
  })

  it('POST with invalid body (missing timestamp) → 400', async () => {
    const res = await request(server, 'POST', '/api/hooks/session-start', {
      event: 'session-start',
    })
    expect(res.status).toBe(400)
  })

  it('POST with unknown event type → 400', async () => {
    const res = await request(server, 'POST', '/api/hooks/unknown-event', {
      event: 'unknown-event',
      timestamp: '2025-01-01T00:00:00Z',
    })
    expect(res.status).toBe(400)
  })

  it('handleSessionEvent callback is called with correct data', async () => {
    await request(server, 'POST', '/api/hooks/session-start', {
      event: 'session-start',
      sessionId: 'callback-sess',
      timestamp: '2025-01-01T04:00:00Z',
      metadata: { foo: 'bar' },
    })

    expect(handleSessionEvent).toHaveBeenCalledTimes(1)
    expect(handleSessionEvent).toHaveBeenCalledWith({
      event: 'session-start',
      sessionId: 'callback-sess',
      timestamp: '2025-01-01T04:00:00Z',
      metadata: { foo: 'bar' },
    })
  })

  it('returns observationId even when handler returns null', async () => {
    handleSessionEvent.mockReturnValue(null)

    const res = await request(server, 'POST', '/api/hooks/session-start', {
      event: 'session-start',
      timestamp: '2025-01-01T05:00:00Z',
    })
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown>
    expect(body.acknowledged).toBe(true)
    expect(typeof body.observationId).toBe('string')
    expect((body.observationId as string).length).toBeGreaterThan(0)
  })

  it('hooks bypass auth when token is set', async () => {
    // Create a new broker WITH auth token
    await broker.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    closeDatabase(db)

    db = openDatabase(':memory:')
    const eventLog = createEventLog(db)
    const authedHandler = vi.fn().mockReturnValue({ id: 'auth-obs-id' })
    broker = createBrokerServer(db, eventLog, undefined, undefined, {
      authToken: 'secret-token',
      handleSessionEvent: authedHandler,
    })
    server = createServer(broker.app)
    await new Promise<void>((resolve) => server.listen(0, resolve))

    // Hook should work WITHOUT auth header
    const res = await request(server, 'POST', '/api/hooks/session-start', {
      event: 'session-start',
      timestamp: '2025-01-01T06:00:00Z',
    })
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown>
    expect(body.acknowledged).toBe(true)
  })

  // ── Enriched payload tests ──────────────────────────────────────

  it('POST enriched session-end with model, tokenUsage, exitCode → 200', async () => {
    const res = await request(server, 'POST', '/api/hooks/session-end', {
      event: 'session-end',
      sessionId: 'enriched-sess',
      timestamp: '2025-01-01T07:00:00Z',
      model: 'claude-opus-4.6',
      exitCode: 0,
      tokenUsage: { input: 45231, output: 12456 },
    })
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown>
    expect(body.acknowledged).toBe(true)
  })

  it('POST enriched tool-use with mcpServer and toolArgs → 200 + callback receives all fields', async () => {
    const res = await request(server, 'POST', '/api/hooks/tool-use', {
      event: 'tool-use',
      sessionId: 'mcp-sess',
      tool: 'search_code',
      timestamp: '2025-01-01T08:00:00Z',
      mcpServer: 'github-mcp-server',
      toolArgs: 'query: "auth"',
      toolResult: '3 results found',
      traceId: 'trace-abc-123',
    })
    expect(res.status).toBe(200)

    expect(handleSessionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'tool-use',
        tool: 'search_code',
        mcpServer: 'github-mcp-server',
        toolArgs: 'query: "auth"',
        toolResult: '3 results found',
        traceId: 'trace-abc-123',
      }),
    )
  })

  it('POST session-end with errorMessage → 200 + callback receives it', async () => {
    const res = await request(server, 'POST', '/api/hooks/session-end', {
      event: 'session-end',
      sessionId: 'err-sess',
      timestamp: '2025-01-01T09:00:00Z',
      errorMessage: 'rate limit exceeded',
      exitCode: 1,
    })
    expect(res.status).toBe(200)

    expect(handleSessionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        errorMessage: 'rate limit exceeded',
        exitCode: 1,
      }),
    )
  })

  it('POST tool-use with skillName → 200', async () => {
    const res = await request(server, 'POST', '/api/hooks/tool-use', {
      event: 'tool-use',
      timestamp: '2025-01-01T10:00:00Z',
      skillName: 'quality-gate',
    })
    expect(res.status).toBe(200)

    expect(handleSessionEvent).toHaveBeenCalledWith(
      expect.objectContaining({ skillName: 'quality-gate' }),
    )
  })

  it('rejects exitCode as string', async () => {
    const res = await request(server, 'POST', '/api/hooks/session-end', {
      event: 'session-end',
      timestamp: '2025-01-01T11:00:00Z',
      exitCode: 'zero',
    })
    expect(res.status).toBe(400)
  })

  it('rejects tokenUsage.input as string', async () => {
    const res = await request(server, 'POST', '/api/hooks/session-end', {
      event: 'session-end',
      timestamp: '2025-01-01T12:00:00Z',
      tokenUsage: { input: 'many' },
    })
    expect(res.status).toBe(400)
  })
})
