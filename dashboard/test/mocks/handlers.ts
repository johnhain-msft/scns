import { http, HttpResponse } from 'msw'

const BROKER_URL = 'http://localhost:3456'

export const handlers = [
  http.get(`${BROKER_URL}/api/health`, () =>
    HttpResponse.json({ status: 'ok', uptime_seconds: 12345 }),
  ),

  http.get(`${BROKER_URL}/api/sessions`, () =>
    HttpResponse.json({
      sessions: [
        { id: 'sess-1', status: 'active', created_at: '2024-01-01T00:00:00Z' },
      ],
    }),
  ),

  http.get(`${BROKER_URL}/api/teams`, () =>
    HttpResponse.json({
      teams: [
        { id: 'team-1', name: 'Alpha', status: 'active', created_at: '2024-01-01T00:00:00Z' },
      ],
    }),
  ),

  http.get(`${BROKER_URL}/api/teams/:id`, ({ params }) =>
    HttpResponse.json({ id: params.id, name: 'Alpha', status: 'active', members: [] }),
  ),

  http.get(`${BROKER_URL}/api/tasks`, ({ request }) => {
    const url = new URL(request.url)
    const teamId = url.searchParams.get('team_id')
    if (!teamId) return HttpResponse.json({ error: 'team_id required' }, { status: 400 })
    return HttpResponse.json({ tasks: [] })
  }),

  http.get(`${BROKER_URL}/api/scheduler/tasks`, () =>
    HttpResponse.json({
      tasks: [
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
      ],
    }),
  ),

  http.patch(`${BROKER_URL}/api/scheduler/tasks/:id`, async ({ params, request }) => {
    const body = (await request.json()) as object
    return HttpResponse.json({
      id: params.id,
      name: 'cleanup',
      description: 'Cleanup old sessions',
      category: 'cron',
      cron_expression: '0 * * * *',
      enabled: true,
      last_run_at: null,
      next_run_at: null,
      run_count: 0,
      last_status: null,
      config_json: '{}',
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
      ...body,
    })
  }),

  http.post(`${BROKER_URL}/api/scheduler/tasks/:id/run`, ({ params }) =>
    HttpResponse.json({
      success: true,
      task: {
        id: params.id,
        name: 'cleanup',
        description: 'Cleanup old sessions',
        category: 'cron',
        cron_expression: '0 * * * *',
        enabled: true,
        last_run_at: new Date().toISOString(),
        next_run_at: null,
        run_count: 6,
        last_status: 'success',
        config_json: '{}',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: new Date().toISOString(),
      },
    }),
  ),

  http.get(`${BROKER_URL}/api/scheduler/history/:id`, () =>
    HttpResponse.json({
      history: [
        {
          id: 1,
          task_id: 'task-1',
          status: 'success',
          started_at: '2024-01-01T00:00:00Z',
          finished_at: '2024-01-01T00:00:01Z',
          duration_ms: 1000,
          error_message: null,
          created_at: '2024-01-01T00:00:00Z',
        },
      ],
    }),
  ),

  http.get(`${BROKER_URL}/api/dream/status`, () =>
    HttpResponse.json({
      available: true,
      gateCheck: { allPassed: false },
      lastRunAt: new Date(Date.now() - 3600_000).toISOString(),
      totalRuns: 42,
      entriesProcessed: 150,
    }),
  ),

  http.post(`${BROKER_URL}/api/dream/trigger`, () =>
    HttpResponse.json({ triggered: true, runId: 'dream-run-1' }),
  ),

  http.get(`${BROKER_URL}/api/suggestions`, () =>
    HttpResponse.json({
      suggestions: [
        { id: 'sug-1', title: 'Refactor auth', type: 'skill', status: 'pending', confidence: 0.85 },
      ],
    }),
  ),

  http.post(`${BROKER_URL}/api/suggestions/:id/approve`, ({ params }) =>
    HttpResponse.json({ id: params.id, status: 'approved' }),
  ),

  http.post(`${BROKER_URL}/api/suggestions/:id/reject`, ({ params }) =>
    HttpResponse.json({ id: params.id, status: 'rejected' }),
  ),

  http.get(`${BROKER_URL}/api/observers`, () =>
    HttpResponse.json({
      available: true,
      observers: [
        { type: 'claude-hooks', enabled: true, count: 10 },
        { type: 'computer-activity', enabled: false, count: 0 },
      ],
    }),
  ),

  http.post(`${BROKER_URL}/api/observers/:type/toggle`, ({ params }) =>
    HttpResponse.json({ type: params.type, enabled: true }),
  ),

  http.get(`${BROKER_URL}/api/memory/search`, () =>
    HttpResponse.json({ results: [{ id: 'mem-1', content: 'test memory', score: 0.95 }] }),
  ),

  http.get(`${BROKER_URL}/api/memory/stats`, () =>
    HttpResponse.json({ available: true, totalFiles: 100, totalChunks: 5000, lastIndexedAt: '2024-01-01T00:00:00Z' }),
  ),

  http.get(`${BROKER_URL}/api/otel/traces`, () =>
    HttpResponse.json({
      traces: [
        {
          trace_id: 'trace-1',
          root_span_name: 'invoke_agent',
          span_count: 5,
          start_time: '2024-01-01T00:00:00Z',
          duration_ms: 4200,
          status: 'OK',
          total_tokens: 1500,
        },
      ],
    }),
  ),

  http.get(`${BROKER_URL}/api/otel/traces/:traceId`, ({ params }) =>
    HttpResponse.json({
      trace_id: params.traceId,
      spans: [
        {
          trace_id: params.traceId,
          span_id: 'span-1',
          parent_span_id: null,
          name: 'invoke_agent',
          kind: 'INTERNAL',
          start_time: '2024-01-01T00:00:00Z',
          end_time: '2024-01-01T00:00:04.200Z',
          duration_ms: 4200,
          status: 'OK',
          attributes_json: '{}',
          events_json: '[]',
          resource_json: '{}',
          session_id: null,
          created_at: '2024-01-01T00:00:00Z',
        },
      ],
      tree: [
        {
          span: {
            trace_id: params.traceId,
            span_id: 'span-1',
            parent_span_id: null,
            name: 'invoke_agent',
            kind: 'INTERNAL',
            start_time: '2024-01-01T00:00:00Z',
            end_time: '2024-01-01T00:00:04.200Z',
            duration_ms: 4200,
            status: 'OK',
            attributes_json: '{}',
            events_json: '[]',
            resource_json: '{}',
            session_id: null,
            created_at: '2024-01-01T00:00:00Z',
          },
          children: [],
        },
      ],
    }),
  ),

  http.get(`${BROKER_URL}/api/otel/metrics/summary`, () =>
    HttpResponse.json({
      total_spans: 150,
      total_metrics: 300,
      total_input_tokens: 50000,
      total_output_tokens: 25000,
      avg_duration_ms: 2100,
      top_tools: [
        { name: 'bash', count: 45 },
        { name: 'view', count: 30 },
      ],
      model_distribution: [
        { model: 'claude-sonnet-4-20250514', count: 80 },
        { model: 'gpt-4o', count: 20 },
      ],
      error_count: 3,
    }),
  ),

  http.get(`${BROKER_URL}/api/otel/metrics/timeseries`, () =>
    HttpResponse.json({
      buckets: [
        { bucket: '2024-01-01T00:00:00Z', value: 100, count: 5 },
        { bucket: '2024-01-01T01:00:00Z', value: 150, count: 8 },
      ],
    }),
  ),

  http.get(`${BROKER_URL}/api/otel/config`, () =>
    HttpResponse.json({
      config: {
        enabled: false,
        filePath: null,
        retentionDays: 7,
        maxSpansPerTrace: 1000,
        pollIntervalMs: 1000,
      },
    }),
  ),

  http.patch(`${BROKER_URL}/api/otel/config`, () =>
    HttpResponse.json({
      config: {
        enabled: false,
        filePath: null,
        retentionDays: 7,
        maxSpansPerTrace: 1000,
        pollIntervalMs: 1000,
      },
      note: 'Restart required for changes to take effect',
    }),
  ),

  http.get(`${BROKER_URL}/api/autonomy`, () =>
    HttpResponse.json({ level: 1, changedAt: '2024-01-01T00:00:00Z', changedBy: 'user' }),
  ),

  http.post(`${BROKER_URL}/api/autonomy/promote`, () =>
    HttpResponse.json({ level: 2, changedAt: new Date().toISOString(), changedBy: 'user' }),
  ),

  http.post(`${BROKER_URL}/api/autonomy/demote`, () =>
    HttpResponse.json({ level: 0, changedAt: new Date().toISOString(), changedBy: 'user' }),
  ),

  http.get(`${BROKER_URL}/api/cost/summary`, () =>
    HttpResponse.json({
      totalInputTokens: 50000,
      totalOutputTokens: 25000,
      totalTokens: 75000,
      estimatedTotalCostUSD: 12.34,
      sessionCount: 5,
      perSession: [
        { sessionId: 'sess-1', inputTokens: 10000, outputTokens: 5000, totalTokens: 15000, estimatedCostUSD: 2.47 },
      ],
    }),
  ),

  http.get(`${BROKER_URL}/api/conflicts`, () =>
    HttpResponse.json({ conflicts: [] }),
  ),

  http.get(`${BROKER_URL}/api/events`, () =>
    HttpResponse.json({
      events: [
        { id: 1, type: 'session.started', session_id: 'sess-1', payload: {}, team_id: null, created_at: '2024-01-01T00:00:00Z' },
      ],
    }),
  ),
]
