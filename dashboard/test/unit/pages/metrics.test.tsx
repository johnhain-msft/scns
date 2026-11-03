import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Theme } from '@radix-ui/themes'
import { server } from '../../mocks/server'
import { http, HttpResponse } from 'msw'
import axe from 'axe-core'
import MetricsPage from '@/app/metrics/page'

const BROKER_URL = 'http://localhost:3456'

vi.mock('next/navigation', () => ({
  usePathname: () => '/metrics',
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

const mockMetrics = {
  total_spans: 45000,
  total_metrics: 300,
  total_input_tokens: 750000,
  total_output_tokens: 500000,
  avg_duration_ms: 23.5,
  top_tools: [
    { name: 'code_search', count: 5432 },
    { name: 'file_edit', count: 3210 },
    { name: 'bash', count: 2100 },
  ],
  model_distribution: [
    { model: 'claude-sonnet-4', count: 8000 },
    { model: 'claude-haiku', count: 5000 },
  ],
  error_count: 1530,
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

describe('MetricsPage', () => {
  it('renders "Metrics" heading', async () => {
    server.use(
      http.get(`${BROKER_URL}/api/otel/metrics/summary`, () =>
        HttpResponse.json(mockMetrics),
      ),
    )
    renderWithProviders(<MetricsPage />)
    expect(screen.getByRole('heading', { name: /metrics/i })).toBeInTheDocument()
  })

  it('shows summary cards: Total Spans, Total Tokens, Avg Duration, Error Rate', async () => {
    server.use(
      http.get(`${BROKER_URL}/api/otel/metrics/summary`, () =>
        HttpResponse.json(mockMetrics),
      ),
    )
    renderWithProviders(<MetricsPage />)

    await waitFor(() => {
      expect(screen.getAllByText('Total Spans').length).toBeGreaterThanOrEqual(1)
      expect(screen.getAllByText('Total Tokens').length).toBeGreaterThanOrEqual(1)
      expect(screen.getAllByText('Avg Duration').length).toBeGreaterThanOrEqual(1)
      expect(screen.getAllByText('Error Rate').length).toBeGreaterThanOrEqual(1)
    })
  })

  it('shows top tools list', async () => {
    server.use(
      http.get(`${BROKER_URL}/api/otel/metrics/summary`, () =>
        HttpResponse.json(mockMetrics),
      ),
    )
    renderWithProviders(<MetricsPage />)

    await waitFor(() => {
      expect(screen.getAllByText('code_search').length).toBeGreaterThanOrEqual(1)
      expect(screen.getAllByText('file_edit').length).toBeGreaterThanOrEqual(1)
      expect(screen.getAllByText('bash').length).toBeGreaterThanOrEqual(1)
    })
  })

  it('shows model distribution list', async () => {
    server.use(
      http.get(`${BROKER_URL}/api/otel/metrics/summary`, () =>
        HttpResponse.json(mockMetrics),
      ),
    )
    renderWithProviders(<MetricsPage />)

    await waitFor(() => {
      expect(screen.getAllByText('claude-sonnet-4').length).toBeGreaterThanOrEqual(1)
      expect(screen.getAllByText('claude-haiku').length).toBeGreaterThanOrEqual(1)
    })
  })

  it('time range selector works', async () => {
    const user = userEvent.setup()
    server.use(
      http.get(`${BROKER_URL}/api/otel/metrics/summary`, () =>
        HttpResponse.json(mockMetrics),
      ),
    )
    renderWithProviders(<MetricsPage />)

    const btn1h = screen.getByRole('button', { name: '1h' })
    expect(btn1h).toHaveAttribute('aria-pressed', 'true')

    const btn30d = screen.getByRole('button', { name: '30d' })
    await user.click(btn30d)
    expect(btn30d).toHaveAttribute('aria-pressed', 'true')
    expect(btn1h).toHaveAttribute('aria-pressed', 'false')
  })

  it('shows loading state', () => {
    server.use(
      http.get(`${BROKER_URL}/api/otel/metrics/summary`, () => new Promise(() => {})),
    )
    renderWithProviders(<MetricsPage />)
    expect(screen.getByText(/loading/i)).toBeInTheDocument()
  })

  it('shows "No data" when metrics are empty', async () => {
    server.use(
      http.get(`${BROKER_URL}/api/otel/metrics/summary`, () =>
        HttpResponse.json({
          total_spans: 0,
          total_metrics: 0,
          total_input_tokens: 0,
          total_output_tokens: 0,
          avg_duration_ms: null,
          top_tools: [],
          model_distribution: [],
          error_count: 0,
        }),
      ),
    )
    renderWithProviders(<MetricsPage />)

    await waitFor(() => {
      expect(screen.getByText(/no data/i)).toBeInTheDocument()
    })
  })

  it('summary values formatted with commas for large numbers', async () => {
    server.use(
      http.get(`${BROKER_URL}/api/otel/metrics/summary`, () =>
        HttpResponse.json(mockMetrics),
      ),
    )
    renderWithProviders(<MetricsPage />)

    await waitFor(() => {
      // 45000 → "45,000", 750000+500000 → "1,250,000"
      expect(screen.getAllByText('45,000').length).toBeGreaterThanOrEqual(1)
      expect(screen.getAllByText('1,250,000').length).toBeGreaterThanOrEqual(1)
    })
  })

  it('data table fallback exists for charts (visible to screen readers)', async () => {
    server.use(
      http.get(`${BROKER_URL}/api/otel/metrics/summary`, () =>
        HttpResponse.json(mockMetrics),
      ),
    )
    renderWithProviders(<MetricsPage />)

    await waitFor(() => {
      expect(screen.getAllByText('code_search').length).toBeGreaterThanOrEqual(1)
    })

    const srTable = screen.getByRole('table', { name: /metrics data/i })
    expect(srTable).toBeInTheDocument()
  })

  it('token usage section shows input/output breakdown', async () => {
    server.use(
      http.get(`${BROKER_URL}/api/otel/metrics/summary`, () =>
        HttpResponse.json(mockMetrics),
      ),
    )
    renderWithProviders(<MetricsPage />)

    await waitFor(() => {
      expect(screen.getAllByText(/token usage/i).length).toBeGreaterThanOrEqual(1)
      expect(screen.getAllByText(/input tokens/i).length).toBeGreaterThanOrEqual(1)
      expect(screen.getAllByText(/output tokens/i).length).toBeGreaterThanOrEqual(1)
    })
  })

  it('has no axe-core violations', async () => {
    server.use(
      http.get(`${BROKER_URL}/api/otel/metrics/summary`, () =>
        HttpResponse.json(mockMetrics),
      ),
    )
    const { container } = renderWithProviders(<MetricsPage />)

    await waitFor(() => {
      expect(screen.getAllByText('code_search').length).toBeGreaterThanOrEqual(1)
    })

    const results = await axe.run(container)
    const serious = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    )
    expect(serious).toEqual([])
  })
})
