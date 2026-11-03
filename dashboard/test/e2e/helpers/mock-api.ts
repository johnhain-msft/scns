import type { Page } from '@playwright/test'

const BROKER = 'http://localhost:3456'

/**
 * Stateful mock broker for Playwright E2E tests.
 * Intercepts all fetch requests to the broker URL and returns mock data.
 * State can be mutated via PATCH/POST handlers to verify optimistic UI flows.
 */
export async function mockBrokerApi(page: Page) {
  // ── Mutable state for mutation flows ──────────────────────

  let autonomyLevel = 1

  let schedulerTasks = [
    {
      id: 'task-1',
      name: 'cleanup',
      description: 'Cleanup old sessions',
      category: 'cron',
      cron_expression: '0 * * * *',
      enabled: true,
      last_run_at: '2024-01-01T00:00:00Z',
      next_run_at: '2024-01-01T01:00:00Z',
      run_count: 5,
      last_status: 'success',
      config_json: '{}',
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    },
    {
      id: 'task-2',
      name: 'dream-check',
      description: 'Check dream gates',
      category: 'cron',
      cron_expression: '*/30 * * * *',
      enabled: false,
      last_run_at: null,
      next_run_at: null,
      run_count: 0,
      last_status: null,
      config_json: '{}',
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    },
  ]

  let otelConfig = {
    enabled: false,
    filePath: null as string | null,
    retentionDays: 7,
    maxSpansPerTrace: 1000,
    pollIntervalMs: 1000,
  }

  interface MockSuggestion {
    id: string
    title: string
    type: string
    status: string
    confidence: number
    description?: string
    evidence?: string[]
  }

  let suggestions: MockSuggestion[] = [
    { id: 'sug-1', title: 'Refactor auth', type: 'skill', status: 'pending', confidence: 0.85, description: 'Refactor the auth module', evidence: ['High complexity'] },
    { id: 'sug-2', title: 'Add caching', type: 'workflow', status: 'pending', confidence: 0.72, description: 'Add Redis caching layer' },
    { id: 'sug-3', title: 'Upgrade deps', type: 'automation', status: 'approved', confidence: 0.9 },
    { id: 'sug-4', title: 'Remove logging', type: 'agent', status: 'rejected', confidence: 0.3 },
  ]

  interface MockObserver { type: string; enabled: boolean }

  let observers: MockObserver[] = [
    { type: 'claude-hooks', enabled: true },
    { type: 'computer-activity', enabled: false },
  ]

  let dreamRunning = false

  // ── Suppress EventSource errors ───────────────────────────

  await page.addInitScript(() => {
    // Replace EventSource to prevent connection errors to broker
    window.EventSource = class MockEventSource extends EventTarget {
      readonly CONNECTING = 0
      readonly OPEN = 1
      readonly CLOSED = 2
      readyState = 0
      url: string
      withCredentials = false
      onopen: ((this: EventSource, ev: Event) => void) | null = null
      onmessage: ((this: EventSource, ev: MessageEvent) => void) | null = null
      onerror: ((this: EventSource, ev: Event) => void) | null = null
      constructor(url: string | URL) {
        super()
        this.url = typeof url === 'string' ? url : url.toString()
        this.readyState = this.OPEN
      }
      close() {
        this.readyState = this.CLOSED
      }
    } as unknown as typeof EventSource
  })

  // ── Route interception ────────────────────────────────────

  await page.route(`${BROKER}/**`, async (route) => {
    const url = new URL(route.request().url())
    const method = route.request().method()
    const pathname = url.pathname

    // Health
    if (pathname === '/api/health' && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'ok', uptime_seconds: 12345 }),
      })
    }

    // Sessions
    if (pathname === '/api/sessions' && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          sessions: [
            { id: 'sess-1', status: 'active', created_at: '2024-01-01T00:00:00Z', intent: 'Build feature', working_dir: '/home/user/project', last_heartbeat: new Date().toISOString() },
            { id: 'sess-2', status: 'idle', created_at: '2024-01-01T00:00:00Z', intent: 'Review code', working_dir: '/home/user/other' },
          ],
        }),
      })
    }

    // Teams
    if (pathname === '/api/teams' && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          teams: [
            { id: 'team-1', name: 'Alpha', status: 'active', created_at: '2024-01-01T00:00:00Z' },
          ],
        }),
      })
    }

    if (pathname.match(/^\/api\/teams\/[^/]+$/) && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'team-1', name: 'Alpha', status: 'active', members: [] }),
      })
    }

    // Scheduler tasks
    if (pathname === '/api/scheduler/tasks' && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ tasks: schedulerTasks }),
      })
    }

    if (pathname.match(/^\/api\/scheduler\/tasks\/[^/]+$/) && method === 'PATCH') {
      const body = JSON.parse(route.request().postData() || '{}')
      const taskId = pathname.split('/').pop()!
      schedulerTasks = schedulerTasks.map((t) =>
        t.id === taskId ? { ...t, ...body, updated_at: new Date().toISOString() } : t,
      )
      const updated = schedulerTasks.find((t) => t.id === taskId)!
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(updated),
      })
    }

    if (pathname.match(/^\/api\/scheduler\/tasks\/[^/]+\/run$/) && method === 'POST') {
      const taskId = pathname.split('/').at(-2)!
      schedulerTasks = schedulerTasks.map((t) =>
        t.id === taskId
          ? { ...t, run_count: t.run_count + 1, last_run_at: new Date().toISOString(), last_status: 'success' as const, updated_at: new Date().toISOString(), next_run_at: t.next_run_at ?? '' }
          : t,
      )
      const updated = schedulerTasks.find((t) => t.id === taskId)!
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, task: updated }),
      })
    }

    if (pathname.match(/^\/api\/scheduler\/history\/[^/]+$/) && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          history: [
            { id: 1, task_id: 'task-1', status: 'success', started_at: '2024-01-01T00:00:00Z', finished_at: '2024-01-01T00:00:01Z', duration_ms: 1000, error_message: null, created_at: '2024-01-01T00:00:00Z' },
          ],
        }),
      })
    }

    // Dream — stateful: trigger mutates running flag
    if (pathname === '/api/dream/status' && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          running: dreamRunning,
          last_run: '2024-01-01T00:00:00Z',
          total_runs: 42,
          memories_consolidated: 150,
          duration_ms: 3500,
          gates: [
            { name: 'idle-check', passed: true },
            { name: 'memory-threshold', passed: false },
          ],
        }),
      })
    }

    if (pathname === '/api/dream/trigger' && method === 'POST') {
      dreamRunning = true
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ triggered: true, runId: 'dream-run-1' }),
      })
    }

    // Suggestions — stateful: approve/reject mutate the in-memory list
    if (pathname === '/api/suggestions' && method === 'GET') {
      const statusFilter = url.searchParams.get('status') || 'pending'
      const filtered = suggestions.filter((s) => s.status === statusFilter)
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ suggestions: filtered }),
      })
    }

    if (pathname.match(/^\/api\/suggestions\/[^/]+\/approve$/) && method === 'POST') {
      const id = pathname.split('/').at(-2)!
      suggestions = suggestions.map((s) => (s.id === id ? { ...s, status: 'approved' } : s))
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id, status: 'approved' }),
      })
    }

    if (pathname.match(/^\/api\/suggestions\/[^/]+\/reject$/) && method === 'POST') {
      const id = pathname.split('/').at(-2)!
      suggestions = suggestions.map((s) => (s.id === id ? { ...s, status: 'rejected' } : s))
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id, status: 'rejected' }),
      })
    }

    // Observers — stateful: toggle mutates in-memory list
    if (pathname === '/api/observers' && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ available: true, observers }),
      })
    }

    if (pathname.match(/^\/api\/observers\/[^/]+\/toggle$/) && method === 'POST') {
      const type = pathname.split('/').at(-2)!
      observers = observers.map((o) =>
        o.type === type ? { ...o, enabled: !o.enabled } : o,
      )
      const updated = observers.find((o) => o.type === type)!
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ type, enabled: updated.enabled }),
      })
    }

    // Memory
    if (pathname === '/api/memory/search' && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          results: [
            { id: 'mem-1', file_path: 'src/auth.ts', content: 'Auth module implementation', score: 0.95, vector_score: 0.9, keyword_score: 0.85 },
          ],
        }),
      })
    }

    if (pathname === '/api/memory/stats' && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ total_memories: 100, vault_size_bytes: 51200 }),
      })
    }

    // OTel Traces
    if (pathname === '/api/otel/traces' && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          traces: [
            { trace_id: 'trace-abc123', root_span_name: 'invoke_agent', span_count: 5, start_time: '2024-01-01T00:00:00Z', duration_ms: 4200, status: 'OK', total_tokens: 1500 },
            { trace_id: 'trace-def456', root_span_name: 'memory.search', span_count: 3, start_time: '2024-01-01T00:01:00Z', duration_ms: 120, status: 'ERROR', total_tokens: 200 },
          ],
        }),
      })
    }

    if (pathname.match(/^\/api\/otel\/traces\/[^/]+$/) && method === 'GET') {
      const traceId = pathname.split('/').pop()!
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          trace_id: traceId,
          spans: [
            {
              trace_id: traceId, span_id: 'span-root', parent_span_id: null, name: 'invoke_agent', kind: 'INTERNAL',
              start_time: '2024-01-01T00:00:00Z', end_time: '2024-01-01T00:00:04.200Z', duration_ms: 4200,
              status: 'OK', attributes_json: '{}', events_json: '[]', resource_json: '{}',
              session_id: null, created_at: '2024-01-01T00:00:00Z',
            },
            {
              trace_id: traceId, span_id: 'span-child', parent_span_id: 'span-root', name: 'tool_call', kind: 'INTERNAL',
              start_time: '2024-01-01T00:00:01Z', end_time: '2024-01-01T00:00:02Z', duration_ms: 1000,
              status: 'OK', attributes_json: '{}', events_json: '[]', resource_json: '{}',
              session_id: null, created_at: '2024-01-01T00:00:00Z',
            },
          ],
          tree: [
            {
              span: {
                trace_id: traceId, span_id: 'span-root', parent_span_id: null, name: 'invoke_agent', kind: 'INTERNAL',
                start_time: '2024-01-01T00:00:00Z', end_time: '2024-01-01T00:00:04.200Z', duration_ms: 4200,
                status: 'OK', attributes_json: '{}', events_json: '[]', resource_json: '{}',
                session_id: null, created_at: '2024-01-01T00:00:00Z',
              },
              children: [
                {
                  span: {
                    trace_id: traceId, span_id: 'span-child', parent_span_id: 'span-root', name: 'tool_call', kind: 'INTERNAL',
                    start_time: '2024-01-01T00:00:01Z', end_time: '2024-01-01T00:00:02Z', duration_ms: 1000,
                    status: 'OK', attributes_json: '{}', events_json: '[]', resource_json: '{}',
                    session_id: null, created_at: '2024-01-01T00:00:00Z',
                  },
                  children: [],
                },
              ],
            },
          ],
        }),
      })
    }

    // OTel Metrics
    if (pathname === '/api/otel/metrics/summary' && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          total_spans: 150,
          total_metrics: 300,
          total_input_tokens: 50000,
          total_output_tokens: 25000,
          avg_duration_ms: 2100,
          top_tools: [{ name: 'bash', count: 45 }, { name: 'view', count: 30 }],
          model_distribution: [{ model: 'claude-sonnet-4-20250514', count: 80 }, { model: 'gpt-4o', count: 20 }],
          error_count: 3,
        }),
      })
    }

    if (pathname === '/api/otel/metrics/timeseries' && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          buckets: [
            { bucket: '2024-01-01T00:00:00Z', value: 100, count: 5 },
            { bucket: '2024-01-01T01:00:00Z', value: 150, count: 8 },
          ],
        }),
      })
    }

    // OTel Config
    if (pathname === '/api/otel/config' && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ config: otelConfig }),
      })
    }

    if (pathname === '/api/otel/config' && method === 'PATCH') {
      const body = JSON.parse(route.request().postData() || '{}')
      otelConfig = { ...otelConfig, ...body }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ config: otelConfig, note: 'Restart required for changes to take effect' }),
      })
    }

    // Autonomy
    if (pathname === '/api/autonomy' && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ level: autonomyLevel, changedAt: '2024-01-01T00:00:00Z', changedBy: 'user' }),
      })
    }

    if (pathname === '/api/autonomy/promote' && method === 'POST') {
      autonomyLevel = Math.min(3, autonomyLevel + 1)
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ level: autonomyLevel, changedAt: new Date().toISOString(), changedBy: 'user' }),
      })
    }

    if (pathname === '/api/autonomy/demote' && method === 'POST') {
      autonomyLevel = Math.max(0, autonomyLevel - 1)
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ level: autonomyLevel, changedAt: new Date().toISOString(), changedBy: 'user' }),
      })
    }

    // Cost
    if (pathname === '/api/cost/summary' && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          totalInputTokens: 50000,
          totalOutputTokens: 25000,
          totalTokens: 75000,
          estimatedTotalCostUSD: 12.34,
          sessionCount: 5,
          perSession: [
            { sessionId: 'sess-1', inputTokens: 10000, outputTokens: 5000, totalTokens: 15000, estimatedCostUSD: 2.47 },
          ],
        }),
      })
    }

    // Conflicts
    if (pathname === '/api/conflicts' && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ conflicts: [] }),
      })
    }

    // Events (REST polling)
    if (pathname === '/api/events' && method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          events: [
            { id: 1, type: 'session.started', session_id: 'sess-1', payload: {}, team_id: null, created_at: '2024-01-01T00:00:00Z' },
          ],
        }),
      })
    }

    // SSE stream — return empty to prevent errors
    if (pathname === '/api/events/stream') {
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: 'data: {}\n\n',
      })
    }

    // Fallback — abort unknown routes so tests catch missing mocks
    return route.abort()
  })
}
