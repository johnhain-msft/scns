import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, closeDatabase } from '../../../../src/broker/storage/db.js'
import { createEventLog } from '../../../../src/broker/services/event-log.js'
import { createBrokerServer, type BrokerServer } from '../../../../src/broker/server.js'
import { seedDefaultTasks } from '../../../../src/broker/storage/repositories/scheduler-repository.js'
import { insertSpans, insertMetrics } from '../../../../src/otel/otel-repository.js'
import type Database from 'better-sqlite3'

function request(
  server: Server,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: unknown }> {
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
          resolve({ status: res.statusCode!, headers: res.headers, body: parsed })
        })
      },
    )
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

function sseConnect(
  server: Server,
  path: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: 'localhost',
        port: (server.address() as { port: number }).port,
        path,
        method: 'GET',
        headers: { Accept: 'text/event-stream' },
      },
      (res) => {
        resolve({ status: res.statusCode!, headers: res.headers })
        res.destroy()
      },
    )
    req.on('error', reject)
    req.end()
  })
}

describe('Dashboard routes', () => {
  let db: Database.Database
  let broker: BrokerServer
  let server: Server

  beforeEach(async () => {
    db = openDatabase(':memory:')
    seedDefaultTasks(db)
    const eventLog = createEventLog(db)
    broker = createBrokerServer(db, eventLog, undefined, undefined, {
      // Disable the dashboard readiness gate for these tests — they intentionally
      // exercise the degraded-response paths that occur when deps aren't wired.
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

  // ── Scheduler Routes ──────────────────────────────────────────

  describe('GET /api/scheduler/tasks', () => {
    it('returns seeded tasks', async () => {
      const res = await request(server, 'GET', '/api/scheduler/tasks')
      expect(res.status).toBe(200)
      const body = res.body as { tasks: unknown[] }
      expect(body.tasks).toBeInstanceOf(Array)
      expect(body.tasks.length).toBeGreaterThanOrEqual(11)
    })
  })

  describe('PATCH /api/scheduler/tasks/:id', () => {
    it('toggles enabled on a task', async () => {
      const res = await request(server, 'PATCH', '/api/scheduler/tasks/heartbeat-poller', {
        enabled: false,
      })
      expect(res.status).toBe(200)
      const body = res.body as { id: string; enabled: boolean }
      expect(body.id).toBe('heartbeat-poller')
      expect(body.enabled).toBe(false)
    })

    it('returns 404 for unknown task', async () => {
      const res = await request(server, 'PATCH', '/api/scheduler/tasks/nonexistent', {
        enabled: true,
      })
      expect(res.status).toBe(404)
    })

    it('returns 400 for invalid body', async () => {
      const res = await request(server, 'PATCH', '/api/scheduler/tasks/heartbeat-poller', {
        enabled: 'not-a-boolean',
      })
      expect(res.status).toBe(400)
    })
  })

  describe('POST /api/scheduler/tasks/:id/run', () => {
    it('records a task run', async () => {
      const res = await request(server, 'POST', '/api/scheduler/tasks/heartbeat-poller/run')
      expect(res.status).toBe(200)
      const body = res.body as { success: boolean; task: { run_count: number } }
      expect(body.success).toBe(true)
      expect(body.task.run_count).toBeGreaterThanOrEqual(1)
    })

    it('returns 404 for unknown task', async () => {
      const res = await request(server, 'POST', '/api/scheduler/tasks/nonexistent/run')
      expect(res.status).toBe(404)
    })
  })

  describe('GET /api/scheduler/history/:id', () => {
    it('returns empty history for task with no runs', async () => {
      const res = await request(server, 'GET', '/api/scheduler/history/heartbeat-poller')
      expect(res.status).toBe(200)
      const body = res.body as { history: unknown[] }
      expect(body.history).toEqual([])
    })

    it('returns history after a run', async () => {
      await request(server, 'POST', '/api/scheduler/tasks/heartbeat-poller/run')
      const res = await request(server, 'GET', '/api/scheduler/history/heartbeat-poller')
      expect(res.status).toBe(200)
      const body = res.body as { history: Array<{ task_id: string }> }
      expect(body.history.length).toBe(1)
      expect(body.history[0]!.task_id).toBe('heartbeat-poller')
    })

    it('returns 404 for unknown task', async () => {
      const res = await request(server, 'GET', '/api/scheduler/history/nonexistent')
      expect(res.status).toBe(404)
    })

    it('respects limit query param', async () => {
      await request(server, 'POST', '/api/scheduler/tasks/heartbeat-poller/run')
      await request(server, 'POST', '/api/scheduler/tasks/heartbeat-poller/run')
      const res = await request(server, 'GET', '/api/scheduler/history/heartbeat-poller?limit=1')
      expect(res.status).toBe(200)
      const body = res.body as { history: unknown[] }
      expect(body.history.length).toBe(1)
    })
  })

  // ── Dream Routes ──────────────────────────────────────────────

  describe('GET /api/dream/status', () => {
    it('returns unavailable when no daemon', async () => {
      const res = await request(server, 'GET', '/api/dream/status')
      expect(res.status).toBe(200)
      const body = res.body as { available: boolean; message: string }
      expect(body.available).toBe(false)
      expect(body.message).toBe('Dream daemon not initialized')
    })
  })

  describe('POST /api/dream/trigger', () => {
    it('returns 503 when no daemon', async () => {
      const res = await request(server, 'POST', '/api/dream/trigger')
      expect(res.status).toBe(503)
    })
  })

  // ── Suggestion Routes ─────────────────────────────────────────

  describe('GET /api/suggestions', () => {
    it('returns unavailable when no store', async () => {
      const res = await request(server, 'GET', '/api/suggestions')
      expect(res.status).toBe(200)
      const body = res.body as { available: boolean; suggestions: unknown[] }
      expect(body.available).toBe(false)
      expect(body.suggestions).toEqual([])
    })
  })

  describe('POST /api/suggestions/:id/approve', () => {
    it('returns 503 when no store', async () => {
      const res = await request(server, 'POST', '/api/suggestions/test-id/approve')
      expect(res.status).toBe(503)
    })
  })

  describe('POST /api/suggestions/:id/reject', () => {
    it('returns 503 when no store', async () => {
      const res = await request(server, 'POST', '/api/suggestions/test-id/reject')
      expect(res.status).toBe(503)
    })
  })

  // ── Observer Routes ───────────────────────────────────────────

  describe('GET /api/observers', () => {
    it('returns unavailable when no manager', async () => {
      const res = await request(server, 'GET', '/api/observers')
      expect(res.status).toBe(200)
      const body = res.body as { available: boolean; observers: unknown[] }
      expect(body.available).toBe(false)
      expect(body.observers).toEqual([])
    })
  })

  describe('POST /api/observers/:type/toggle', () => {
    it('returns 503 when no manager', async () => {
      const res = await request(server, 'POST', '/api/observers/file-watcher/toggle')
      expect(res.status).toBe(503)
    })
  })

  // ── Memory Routes ─────────────────────────────────────────────

  describe('GET /api/memory/search', () => {
    it('returns unavailable when no search', async () => {
      const res = await request(server, 'GET', '/api/memory/search?q=test')
      expect(res.status).toBe(200)
      const body = res.body as { available: boolean; results: unknown[] }
      expect(body.available).toBe(false)
      expect(body.results).toEqual([])
    })
  })

  describe('GET /api/memory/stats', () => {
    it('returns unavailable when no stats', async () => {
      const res = await request(server, 'GET', '/api/memory/stats')
      expect(res.status).toBe(200)
      const body = res.body as { available: boolean }
      expect(body.available).toBe(false)
    })
  })

  // ── OTel Routes ───────────────────────────────────────────────

  describe('GET /api/otel/traces', () => {
    it('returns empty array when no spans', async () => {
      const res = await request(server, 'GET', '/api/otel/traces')
      expect(res.status).toBe(200)
      const body = res.body as { traces: unknown[] }
      expect(body.traces).toEqual([])
    })

    it('returns traces after inserting spans', async () => {
      insertSpans(db, [
        {
          trace_id: 'trace-1',
          span_id: 'span-1',
          parent_span_id: null,
          name: 'test-operation',
          kind: 'INTERNAL',
          start_time: '2024-01-01T00:00:00.000Z',
          end_time: '2024-01-01T00:00:01.000Z',
          duration_ms: 1000,
          status: 'OK',
          attributes_json: '{}',
          events_json: '[]',
          resource_json: '{}',
          session_id: null,
        },
      ])
      const res = await request(server, 'GET', '/api/otel/traces')
      expect(res.status).toBe(200)
      const body = res.body as { traces: Array<{ trace_id: string }> }
      expect(body.traces.length).toBe(1)
      expect(body.traces[0]!.trace_id).toBe('trace-1')
    })

    it('returns 400 for invalid limit', async () => {
      const res = await request(server, 'GET', '/api/otel/traces?limit=0')
      expect(res.status).toBe(400)
    })
  })

  describe('GET /api/otel/traces/:traceId', () => {
    it('returns span tree for existing trace', async () => {
      insertSpans(db, [
        {
          trace_id: 'trace-tree',
          span_id: 'root-span',
          parent_span_id: null,
          name: 'root',
          kind: 'SERVER',
          start_time: '2024-01-01T00:00:00.000Z',
          end_time: '2024-01-01T00:00:02.000Z',
          duration_ms: 2000,
          status: 'OK',
          attributes_json: '{}',
          events_json: '[]',
          resource_json: '{}',
          session_id: null,
        },
        {
          trace_id: 'trace-tree',
          span_id: 'child-span',
          parent_span_id: 'root-span',
          name: 'child',
          kind: 'INTERNAL',
          start_time: '2024-01-01T00:00:00.500Z',
          end_time: '2024-01-01T00:00:01.500Z',
          duration_ms: 1000,
          status: 'OK',
          attributes_json: '{}',
          events_json: '[]',
          resource_json: '{}',
          session_id: null,
        },
      ])
      const res = await request(server, 'GET', '/api/otel/traces/trace-tree')
      expect(res.status).toBe(200)
      const body = res.body as {
        trace_id: string
        spans: unknown[]
        tree: { span: unknown; children: unknown[] }
      }
      expect(body.trace_id).toBe('trace-tree')
      expect(body.spans.length).toBe(2)
      expect(body.tree).toBeDefined()
      expect(body.tree.children.length).toBe(1)
    })

    it('returns 404 for unknown trace', async () => {
      const res = await request(server, 'GET', '/api/otel/traces/nonexistent')
      expect(res.status).toBe(404)
    })
  })

  describe('GET /api/otel/metrics/summary', () => {
    it('returns zeroed summary when empty', async () => {
      const res = await request(server, 'GET', '/api/otel/metrics/summary')
      expect(res.status).toBe(200)
      const body = res.body as { total_spans: number; total_metrics: number }
      expect(body.total_spans).toBe(0)
      expect(body.total_metrics).toBe(0)
    })
  })

  describe('GET /api/otel/metrics/timeseries', () => {
    it('returns empty buckets when no data', async () => {
      const res = await request(server, 'GET', '/api/otel/metrics/timeseries?metric=cpu')
      expect(res.status).toBe(200)
      const body = res.body as { buckets: unknown[] }
      expect(body.buckets).toEqual([])
    })

    it('returns buckets after inserting metrics', async () => {
      insertMetrics(db, [
        {
          name: 'test-metric',
          metric_type: 'counter',
          value: 42,
          attributes_json: '{}',
          resource_json: '{}',
          timestamp: '2024-01-01T12:30:00.000Z',
        },
      ])
      const res = await request(server, 'GET', '/api/otel/metrics/timeseries?metric=test-metric')
      expect(res.status).toBe(200)
      const body = res.body as { buckets: Array<{ value: number }> }
      expect(body.buckets.length).toBe(1)
      expect(body.buckets[0]!.value).toBe(42)
    })

    it('returns 400 when metric param is missing', async () => {
      const res = await request(server, 'GET', '/api/otel/metrics/timeseries')
      expect(res.status).toBe(400)
    })
  })

  describe('GET /api/otel/config', () => {
    it('returns config', async () => {
      const res = await request(server, 'GET', '/api/otel/config')
      expect(res.status).toBe(200)
      const body = res.body as { config: { retentionDays: number } }
      expect(body.config).toBeDefined()
      expect(typeof body.config.retentionDays).toBe('number')
    })
  })

  describe('PATCH /api/otel/config', () => {
    it('returns config with restart note', async () => {
      const res = await request(server, 'PATCH', '/api/otel/config', { enabled: true })
      expect(res.status).toBe(200)
      const body = res.body as { config: unknown; note: string }
      expect(body.note).toBe('Configuration updated. Some changes require restart to take effect.')
    })

    it('rejects filePath outside home directory', async () => {
      const res = await request(server, 'PATCH', '/api/otel/config', {
        filePath: '/etc/passwd',
      })
      expect(res.status).toBe(400)
      expect((res.body as { error: string }).error).toContain('home directory')
    })

    it('rejects filePath with path traversal', async () => {
      const { homedir } = await import('node:os')
      const res = await request(server, 'PATCH', '/api/otel/config', {
        filePath: `${homedir()}/../../../etc/shadow`,
      })
      expect(res.status).toBe(400)
    })

    it('accepts filePath under home directory', async () => {
      const { homedir } = await import('node:os')
      const res = await request(server, 'PATCH', '/api/otel/config', {
        filePath: `${homedir()}/.scns/otel/traces.jsonl`,
      })
      expect(res.status).toBe(200)
    })

    // posix-only: on win32 '/tmp' resolves to a drive-root path that is
    // deliberately NOT allowed — the OS temp dir (next test) is the analogue.
    it.skipIf(process.platform === 'win32')('accepts filePath under /tmp', async () => {
      const res = await request(server, 'PATCH', '/api/otel/config', {
        filePath: '/tmp/otel-traces.jsonl',
      })
      expect(res.status).toBe(200)
    })

    it('accepts filePath under the OS temp dir', async () => {
      const res = await request(server, 'PATCH', '/api/otel/config', {
        filePath: join(tmpdir(), 'otel-traces.jsonl'),
      })
      expect(res.status).toBe(200)
    })
  })

  // ── SSE Stream ────────────────────────────────────────────────

  describe('GET /api/events/stream', () => {
    it('sets correct SSE headers', async () => {
      const res = await sseConnect(server, '/api/events/stream')
      expect(res.status).toBe(200)
      expect(res.headers['content-type']).toContain('text/event-stream')
      expect(res.headers['cache-control']).toBe('no-cache')
    })
  })
})
