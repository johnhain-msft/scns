import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Theme } from '@radix-ui/themes'
import { server } from '../mocks/server'
import { http, HttpResponse } from 'msw'
import type { ReactElement } from 'react'

const BROKER_URL = 'http://localhost:3456'

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('@/hooks/use-sse', () => ({
  useSSE: () => ({ connected: false }),
}))

import SessionsPage from '@/app/sessions/page'
import SuggestionsPage from '@/app/suggestions/page'
import TracesPage from '@/app/traces/page'
import MetricsPage from '@/app/metrics/page'
import {
  getSchedulerTasks,
  getSuggestions,
  getOtelTraces,
  getOtelMetricsSummary,
  listSessions,
  listTeams,
} from '@/lib/api'

function renderWithProviders(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <Theme>
      <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
    </Theme>,
  )
}

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

// ── Data generators ──────────────────────────────────────────

function generateSessions(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `sess-${String(i).padStart(4, '0')}`,
    status: ['active', 'idle', 'working', 'zombie'][i % 4],
    created_at: new Date(Date.now() - i * 60_000).toISOString(),
    intent: `Task ${i}`,
    working_dir: `/home/user/project-${i}`,
    last_heartbeat: new Date(Date.now() - (i % 3) * 20_000).toISOString(),
  }))
}

function generateSuggestions(count: number) {
  const types = ['skill', 'workflow', 'automation', 'agent', 'mcp']
  return Array.from({ length: count }, (_, i) => ({
    id: `sug-${String(i).padStart(4, '0')}`,
    title: `Suggestion ${i}`,
    description: `Description for suggestion ${i}`,
    type: types[i % types.length],
    confidence: Math.round((0.5 + Math.random() * 0.5) * 100) / 100,
    status: 'pending',
    evidence: i % 3 === 0 ? [`Evidence for ${i}`] : [],
  }))
}

function generateTraces(count: number) {
  const statuses = ['OK', 'ERROR', 'UNSET']
  const names = [
    'POST /api/sessions',
    'memory.search',
    'invoke_agent',
    'GET /api/health',
    'dream.consolidate',
  ]
  return Array.from({ length: count }, (_, i) => ({
    trace_id: `trace-${String(i).padStart(6, '0')}`,
    root_span_name: names[i % names.length],
    span_count: 1 + (i % 20),
    start_time: new Date(Date.now() - i * 30_000).toISOString(),
    duration_ms: 10 + (i * 7) % 5000,
    status: statuses[i % statuses.length],
    total_tokens: i % 5 === 0 ? null : 100 + i * 10,
  }))
}

function generateFlatSpans(traceId: string, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    trace_id: traceId,
    span_id: `span-${String(i).padStart(6, '0')}`,
    parent_span_id: null,
    name: `operation-${i}`,
    kind: 'INTERNAL',
    start_time: new Date(Date.now() - (count - i) * 10).toISOString(),
    end_time: new Date(Date.now() - (count - i) * 10 + 5).toISOString(),
    duration_ms: 5,
    status: i % 10 === 0 ? 'ERROR' : 'OK',
    attributes_json: '{}',
    events_json: '[]',
    resource_json: '{}',
    session_id: null,
    created_at: new Date().toISOString(),
  }))
}

function generateTopTools(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    name: `tool_${String(i).padStart(3, '0')}`,
    count: 1000 - i * 15,
  }))
}

function generateModelDistribution(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    model: `model-v${i}`,
    count: 500 - i * 20,
  }))
}

// ── Tests ────────────────────────────────────────────────────

describe('Stress: large data volumes', () => {
  describe('100+ sessions in table', () => {
    it('renders all rows without crashing', async () => {
      const sessions = generateSessions(120)
      server.use(
        http.get(`${BROKER_URL}/api/sessions`, () =>
          HttpResponse.json({ sessions }),
        ),
      )
      renderWithProviders(<SessionsPage />)

      await waitFor(
        () => {
          expect(screen.getByText('120')).toBeInTheDocument()
        },
        { timeout: 10_000 },
      )

      const rows = screen.getAllByRole('row')
      // 120 data rows + 1 header row
      expect(rows.length).toBe(121)
    })

    it('first and last sessions are both visible', async () => {
      const sessions = generateSessions(100)
      server.use(
        http.get(`${BROKER_URL}/api/sessions`, () =>
          HttpResponse.json({ sessions }),
        ),
      )
      renderWithProviders(<SessionsPage />)

      await waitFor(
        () => {
          expect(screen.getByText(/Task 0/)).toBeInTheDocument()
        },
        { timeout: 10_000 },
      )

      expect(screen.getByText(/Task 99/)).toBeInTheDocument()
    })
  })

  describe('500+ suggestions', () => {
    it('renders all suggestion cards', { timeout: 30_000 }, async () => {
      const suggestions = generateSuggestions(500)
      server.use(
        http.get(`${BROKER_URL}/api/suggestions`, () =>
          HttpResponse.json({ suggestions }),
        ),
      )
      renderWithProviders(<SuggestionsPage />)

      await waitFor(
        () => {
          expect(screen.getByText('Suggestion 0')).toBeInTheDocument()
        },
        { timeout: 15_000 },
      )

      expect(screen.getByText('Suggestion 499')).toBeInTheDocument()

      const approveButtons = screen.getAllByRole('button', { name: /approve/i })
      expect(approveButtons.length).toBe(500)
    })
  })

  describe('100+ traces in table', () => {
    it('renders full trace table', async () => {
      const traces = generateTraces(150)
      server.use(
        http.get(`${BROKER_URL}/api/otel/traces`, () =>
          HttpResponse.json({ traces }),
        ),
      )
      renderWithProviders(<TracesPage />)

      await waitFor(
        () => {
          expect(screen.getAllByText(/trace-0/).length).toBeGreaterThan(0)
        },
        { timeout: 10_000 },
      )

      // Each trace row has role="button" with aria-label="View trace ..."
      const traceButtons = screen.getAllByRole('button', { name: /view trace/i })
      expect(traceButtons.length).toBe(150)
    }, 15_000)

    it('contains traces with varied statuses', async () => {
      const traces = generateTraces(120)
      server.use(
        http.get(`${BROKER_URL}/api/otel/traces`, () =>
          HttpResponse.json({ traces }),
        ),
      )
      renderWithProviders(<TracesPage />)

      await waitFor(
        () => {
          expect(screen.getAllByText(/trace-0/).length).toBeGreaterThan(0)
        },
        { timeout: 10_000 },
      )

      const table = screen.getByRole('table')
      expect(table).toBeInTheDocument()

      // All three statuses should appear
      expect(screen.getAllByText('OK').length).toBeGreaterThan(0)
      expect(screen.getAllByText('ERROR').length).toBeGreaterThan(0)
      expect(screen.getAllByText('UNSET').length).toBeGreaterThan(0)
    }, 15_000)
  })

  describe('10K+ spans in trace detail', () => {
    it('renders trace detail without crashing', { timeout: 60_000 }, async () => {
      const traceId = 'trace-mega-001'
      const spanCount = 10_000
      const spans = generateFlatSpans(traceId, spanCount)

      server.use(
        http.get(`${BROKER_URL}/api/otel/traces`, () =>
          HttpResponse.json({
            traces: [
              {
                trace_id: traceId,
                root_span_name: 'mega-operation',
                span_count: spanCount,
                start_time: '2024-01-15T10:00:00Z',
                duration_ms: 50_000,
                status: 'OK',
                total_tokens: 100_000,
              },
            ],
          }),
        ),
        http.get(`${BROKER_URL}/api/otel/traces/:traceId`, () =>
          HttpResponse.json({
            trace_id: traceId,
            spans,
            tree: spans.map((s) => ({ span: s, children: [] })),
          }),
        ),
      )

      const user = userEvent.setup()
      renderWithProviders(<TracesPage />)

      await waitFor(
        () => {
          expect(screen.getByText(/trace-me/)).toBeInTheDocument()
        },
        { timeout: 10_000 },
      )

      await user.click(screen.getByText(/trace-me/))

      await waitFor(
        () => {
          expect(
            screen.getByRole('tree', { name: /span tree/i }),
          ).toBeInTheDocument()
        },
        { timeout: 30_000 },
      )

      const treeItems = screen.getAllByRole('treeitem')
      expect(treeItems.length).toBe(spanCount)
    })
  })

  describe('concurrent API calls', () => {
    it('resolves all parallel API calls', async () => {
      server.use(
        http.get(`${BROKER_URL}/api/scheduler/tasks`, () =>
          HttpResponse.json({
            tasks: [
              {
                id: 'task-1',
                name: 'cleanup',
                description: 'Cleanup',
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
              },
            ],
          }),
        ),
        http.get(`${BROKER_URL}/api/suggestions`, () =>
          HttpResponse.json({
            suggestions: generateSuggestions(10),
          }),
        ),
        http.get(`${BROKER_URL}/api/otel/traces`, () =>
          HttpResponse.json({ traces: generateTraces(10) }),
        ),
        http.get(`${BROKER_URL}/api/otel/metrics/summary`, () =>
          HttpResponse.json({
            total_spans: 100,
            total_metrics: 50,
            total_input_tokens: 5000,
            total_output_tokens: 2500,
            avg_duration_ms: 100,
            top_tools: [{ name: 'bash', count: 10 }],
            model_distribution: [{ model: 'claude-sonnet-4', count: 50 }],
            error_count: 2,
          }),
        ),
        http.get(`${BROKER_URL}/api/sessions`, () =>
          HttpResponse.json({ sessions: generateSessions(10) }),
        ),
        http.get(`${BROKER_URL}/api/teams`, () =>
          HttpResponse.json({
            teams: [{ id: 'team-1', name: 'Alpha', status: 'active', created_at: '2024-01-01T00:00:00Z' }],
          }),
        ),
      )

      const results = await Promise.all([
        getSchedulerTasks(),
        getSuggestions(),
        getOtelTraces(),
        getOtelMetricsSummary(),
        listSessions(),
        listTeams(),
      ])

      expect(results).toHaveLength(6)
      expect(results[0]).toHaveLength(1)   // tasks
      expect(results[1]).toHaveLength(10)  // suggestions
      expect(results[2]).toHaveLength(10)  // traces
      expect(results[3]).toHaveProperty('total_spans', 100) // metrics
      expect(results[4]).toHaveLength(10)  // sessions
      expect(results[5]).toHaveLength(1)   // teams
    })
  })

  describe('large metrics summary', () => {
    it('renders 50 tools and 20 models', async () => {
      const topTools = generateTopTools(50)
      const modelDistribution = generateModelDistribution(20)
      server.use(
        http.get(`${BROKER_URL}/api/otel/metrics/summary`, () =>
          HttpResponse.json({
            total_spans: 999_999,
            total_metrics: 50_000,
            total_input_tokens: 10_000_000,
            total_output_tokens: 5_000_000,
            avg_duration_ms: 42.7,
            top_tools: topTools,
            model_distribution: modelDistribution,
            error_count: 1234,
          }),
        ),
      )
      renderWithProviders(<MetricsPage />)

      await waitFor(
        () => {
          expect(screen.getAllByText('999,999').length).toBeGreaterThanOrEqual(1)
        },
        { timeout: 10_000 },
      )

      // Verify all 50 tools are rendered (getAllByText because SR table duplicates)
      expect(screen.getAllByText('tool_000').length).toBeGreaterThanOrEqual(1)
      expect(screen.getAllByText('tool_049').length).toBeGreaterThanOrEqual(1)

      // Verify all 20 models are rendered
      expect(screen.getAllByText('model-v0').length).toBeGreaterThanOrEqual(1)
      expect(screen.getAllByText('model-v19').length).toBeGreaterThanOrEqual(1)

      // Summary cards present
      expect(screen.getAllByText('Total Spans').length).toBeGreaterThanOrEqual(1)
      expect(screen.getAllByText('Total Tokens').length).toBeGreaterThanOrEqual(1)
    })
  })
})
