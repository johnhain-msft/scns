import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Theme } from '@radix-ui/themes'
import { server } from '../../mocks/server'
import { http, HttpResponse } from 'msw'
import axe from 'axe-core'
import TracesPage from '@/app/traces/page'

const BROKER_URL = 'http://localhost:3456'

vi.mock('next/navigation', () => ({
  usePathname: () => '/traces',
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

const mockTraces = [
  {
    trace_id: 'abc12345-6789-0def-1234-567890abcdef',
    root_span_name: 'POST /api/sessions',
    span_count: 5,
    start_time: '2024-01-15T10:30:00Z',
    duration_ms: 142,
    status: 'OK',
    total_tokens: 1500,
  },
  {
    trace_id: 'def98765-4321-0abc-5678-901234567890',
    root_span_name: 'memory.search',
    span_count: 3,
    start_time: '2024-01-15T10:25:00Z',
    duration_ms: 2500,
    status: 'ERROR',
    total_tokens: null,
  },
]

function makeSpan(overrides: Record<string, unknown> = {}) {
  return {
    trace_id: 'abc12345-6789-0def-1234-567890abcdef',
    span_id: 'span-001',
    parent_span_id: null,
    name: 'POST /api/sessions',
    kind: 'INTERNAL',
    start_time: '2024-01-15T10:30:00Z',
    end_time: '2024-01-15T10:30:00.142Z',
    duration_ms: 142,
    status: 'OK',
    attributes_json: '{"http.method":"POST"}',
    events_json: '[]',
    resource_json: '{}',
    session_id: null,
    created_at: '2024-01-15T10:30:00Z',
    ...overrides,
  }
}

const mockTraceDetail = {
  trace_id: 'abc12345-6789-0def-1234-567890abcdef',
  spans: [
    makeSpan(),
    makeSpan({ span_id: 'span-002', parent_span_id: 'span-001', name: 'db.query', duration_ms: 45, start_time: '2024-01-15T10:30:00.050Z' }),
  ],
  tree: [
    {
      span: makeSpan(),
      children: [
        {
          span: makeSpan({ span_id: 'span-002', parent_span_id: 'span-001', name: 'db.query', duration_ms: 45 }),
          children: [],
        },
      ],
    },
  ],
}

function renderWithProviders(ui: React.ReactElement) {
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

describe('TracesPage', () => {
  it('renders "Traces" heading', async () => {
    server.use(
      http.get(`${BROKER_URL}/api/otel/traces`, () => HttpResponse.json({ traces: mockTraces })),
    )
    renderWithProviders(<TracesPage />)
    expect(screen.getByRole('heading', { name: /traces/i })).toBeInTheDocument()
  })

  it('shows trace list table with correct columns', async () => {
    server.use(
      http.get(`${BROKER_URL}/api/otel/traces`, () => HttpResponse.json({ traces: mockTraces })),
    )
    renderWithProviders(<TracesPage />)

    await waitFor(() => {
      expect(screen.getByText(/abc12345/)).toBeInTheDocument()
    })

    const columnHeaders = ['Trace ID', 'Root Span', 'Duration', 'Spans', 'Status', 'Time']
    for (const header of columnHeaders) {
      expect(screen.getByRole('columnheader', { name: header })).toBeInTheDocument()
    }
  })

  it('shows loading state', () => {
    server.use(
      http.get(`${BROKER_URL}/api/otel/traces`, () => new Promise(() => {})),
    )
    renderWithProviders(<TracesPage />)
    expect(screen.getByText(/loading/i)).toBeInTheDocument()
  })

  it('shows empty state when no traces', async () => {
    server.use(
      http.get(`${BROKER_URL}/api/otel/traces`, () => HttpResponse.json({ traces: [] })),
    )
    renderWithProviders(<TracesPage />)

    await waitFor(() => {
      expect(screen.getByText(/no traces/i)).toBeInTheDocument()
    })
  })

  it('clicking a trace navigates to trace detail view', async () => {
    const user = userEvent.setup()
    server.use(
      http.get(`${BROKER_URL}/api/otel/traces`, () => HttpResponse.json({ traces: mockTraces })),
      http.get(`${BROKER_URL}/api/otel/traces/:traceId`, () =>
        HttpResponse.json(mockTraceDetail),
      ),
    )
    renderWithProviders(<TracesPage />)

    await waitFor(() => {
      expect(screen.getByText(/abc12345/)).toBeInTheDocument()
    })

    await user.click(screen.getByText(/abc12345/))

    await waitFor(() => {
      expect(screen.getByText('POST /api/sessions')).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: /back/i })).toBeInTheDocument()
  })

  it('trace detail shows span tree with waterfall', async () => {
    const user = userEvent.setup()
    server.use(
      http.get(`${BROKER_URL}/api/otel/traces`, () => HttpResponse.json({ traces: mockTraces })),
      http.get(`${BROKER_URL}/api/otel/traces/:traceId`, () =>
        HttpResponse.json(mockTraceDetail),
      ),
    )
    renderWithProviders(<TracesPage />)

    await waitFor(() => {
      expect(screen.getByText(/abc12345/)).toBeInTheDocument()
    })
    await user.click(screen.getByText(/abc12345/))

    await waitFor(() => {
      expect(screen.getByRole('tree', { name: /span tree/i })).toBeInTheDocument()
    })
  })

  it('each span in tree shows name, duration, status', async () => {
    const user = userEvent.setup()
    server.use(
      http.get(`${BROKER_URL}/api/otel/traces`, () => HttpResponse.json({ traces: mockTraces })),
      http.get(`${BROKER_URL}/api/otel/traces/:traceId`, () =>
        HttpResponse.json(mockTraceDetail),
      ),
    )
    renderWithProviders(<TracesPage />)

    await waitFor(() => {
      expect(screen.getByText(/abc12345/)).toBeInTheDocument()
    })
    await user.click(screen.getByText(/abc12345/))

    await waitFor(() => {
      const tree = screen.getByRole('tree')
      expect(within(tree).getByText('POST /api/sessions')).toBeInTheDocument()
      expect(within(tree).getByText('142ms')).toBeInTheDocument()
      expect(within(tree).getByText('OK')).toBeInTheDocument()
    })
  })

  it('span tree is expandable/collapsible', async () => {
    const user = userEvent.setup()
    server.use(
      http.get(`${BROKER_URL}/api/otel/traces`, () => HttpResponse.json({ traces: mockTraces })),
      http.get(`${BROKER_URL}/api/otel/traces/:traceId`, () =>
        HttpResponse.json(mockTraceDetail),
      ),
    )
    renderWithProviders(<TracesPage />)

    await waitFor(() => {
      expect(screen.getByText(/abc12345/)).toBeInTheDocument()
    })
    await user.click(screen.getByText(/abc12345/))

    await waitFor(() => {
      expect(screen.getByRole('tree')).toBeInTheDocument()
    })

    const expandBtn = screen.getByRole('button', { name: /expand post \/api\/sessions/i })
    expect(expandBtn).toBeInTheDocument()

    expect(screen.queryByText('db.query')).not.toBeInTheDocument()

    await user.click(expandBtn)
    expect(screen.getByText('db.query')).toBeInTheDocument()

    const collapseBtn = screen.getByRole('button', { name: /collapse post \/api\/sessions/i })
    await user.click(collapseBtn)
    expect(screen.queryByText('db.query')).not.toBeInTheDocument()
  })

  it('time filter buttons work', async () => {
    const user = userEvent.setup()
    server.use(
      http.get(`${BROKER_URL}/api/otel/traces`, () => HttpResponse.json({ traces: mockTraces })),
    )
    renderWithProviders(<TracesPage />)

    const btn1h = screen.getByRole('button', { name: '1h' })
    expect(btn1h).toHaveAttribute('aria-pressed', 'true')

    const btn24h = screen.getByRole('button', { name: '24h' })
    await user.click(btn24h)
    expect(btn24h).toHaveAttribute('aria-pressed', 'true')
    expect(btn1h).toHaveAttribute('aria-pressed', 'false')
  })

  it('status badge shows OK/ERROR/UNSET with appropriate colors', async () => {
    server.use(
      http.get(`${BROKER_URL}/api/otel/traces`, () => HttpResponse.json({ traces: mockTraces })),
    )
    renderWithProviders(<TracesPage />)

    await waitFor(() => {
      expect(screen.getByText(/abc12345/)).toBeInTheDocument()
    })

    const table = screen.getByRole('table')
    expect(within(table).getByText('OK')).toBeInTheDocument()
    expect(within(table).getByText('ERROR')).toBeInTheDocument()
  })

  it('table has proper headers', async () => {
    server.use(
      http.get(`${BROKER_URL}/api/otel/traces`, () => HttpResponse.json({ traces: mockTraces })),
    )
    renderWithProviders(<TracesPage />)

    await waitFor(() => {
      expect(screen.getByText(/abc12345/)).toBeInTheDocument()
    })

    const table = screen.getByRole('table')
    const headers = within(table).getAllByRole('columnheader')
    expect(headers).toHaveLength(6)
  })

  it('tree uses aria-expanded for collapsible nodes', async () => {
    const user = userEvent.setup()
    server.use(
      http.get(`${BROKER_URL}/api/otel/traces`, () => HttpResponse.json({ traces: mockTraces })),
      http.get(`${BROKER_URL}/api/otel/traces/:traceId`, () =>
        HttpResponse.json(mockTraceDetail),
      ),
    )
    renderWithProviders(<TracesPage />)

    await waitFor(() => {
      expect(screen.getByText(/abc12345/)).toBeInTheDocument()
    })
    await user.click(screen.getByText(/abc12345/))

    await waitFor(() => {
      const treeItems = screen.getAllByRole('treeitem')
      const expandableItem = treeItems.find(
        (item) => item.getAttribute('aria-expanded') !== null,
      )
      expect(expandableItem).toBeTruthy()
      expect(expandableItem!.getAttribute('aria-expanded')).toBe('false')
    })

    const expandBtn = screen.getByRole('button', { name: /expand/i })
    await user.click(expandBtn)

    const treeItems = screen.getAllByRole('treeitem')
    const expandedItem = treeItems.find(
      (item) => item.getAttribute('aria-expanded') === 'true',
    )
    expect(expandedItem).toBeTruthy()
  })

  it('has no axe-core violations', async () => {
    server.use(
      http.get(`${BROKER_URL}/api/otel/traces`, () => HttpResponse.json({ traces: mockTraces })),
    )
    const { container } = renderWithProviders(<TracesPage />)

    await waitFor(() => {
      expect(screen.getByText(/abc12345/)).toBeInTheDocument()
    })

    const results = await axe.run(container)
    const serious = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    )
    expect(serious).toEqual([])
  })
})
