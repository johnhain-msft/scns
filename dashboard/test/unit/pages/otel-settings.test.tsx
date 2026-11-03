import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Theme } from '@radix-ui/themes'
import { server } from '../../mocks/server'
import { http, HttpResponse } from 'msw'
import axe from 'axe-core'
import OtelSettingsPage from '@/app/settings/otel/page'

const BROKER_URL = 'http://localhost:3456'

vi.mock('next/navigation', () => ({
  usePathname: () => '/settings/otel',
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

const mockConfig = {
  enabled: true,
  filePath: '/var/log/otel/traces.jsonl',
  retentionDays: 30,
  maxSpansPerTrace: 1000,
  pollIntervalMs: 1000,
  contentCapture: false,
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

function useConfigHandler(overrides: Record<string, unknown> = {}) {
  return http.get(`${BROKER_URL}/api/otel/config`, () =>
    HttpResponse.json({ config: { ...mockConfig, ...overrides } }),
  )
}

function usePatchHandler(response?: Record<string, unknown>) {
  return http.patch(`${BROKER_URL}/api/otel/config`, () =>
    HttpResponse.json({
      config: response ?? mockConfig,
      note: 'Restart required',
    }),
  )
}

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('OtelSettingsPage', () => {
  it('renders "OpenTelemetry Settings" heading', async () => {
    server.use(useConfigHandler())
    renderWithProviders(<OtelSettingsPage />)
    expect(
      screen.getByRole('heading', { name: /opentelemetry settings/i }),
    ).toBeInTheDocument()
  })

  it('shows current ingestion status (enabled/disabled)', async () => {
    server.use(useConfigHandler())
    renderWithProviders(<OtelSettingsPage />)

    await waitFor(() => {
      expect(screen.getByText(/enabled/i)).toBeInTheDocument()
    })
  })

  it('shows file path field', async () => {
    server.use(useConfigHandler())
    renderWithProviders(<OtelSettingsPage />)

    await waitFor(() => {
      const input = screen.getByLabelText(/jsonl file path/i)
      expect(input).toBeInTheDocument()
      expect(input).toHaveValue('/var/log/otel/traces.jsonl')
    })
  })

  it('shows retention days field', async () => {
    server.use(useConfigHandler())
    renderWithProviders(<OtelSettingsPage />)

    await waitFor(() => {
      const input = screen.getByLabelText(/retention days/i)
      expect(input).toBeInTheDocument()
      expect(input).toHaveValue(30)
    })
  })

  it('shows content capture warning when enabled', async () => {
    server.use(useConfigHandler({ contentCapture: true }))
    renderWithProviders(<OtelSettingsPage />)

    await waitFor(() => {
      expect(screen.getByText(/privacy/i)).toBeInTheDocument()
    })
  })

  it('save button calls updateOtelConfig API', async () => {
    const user = userEvent.setup()
    let patchCalled = false
    server.use(
      useConfigHandler(),
      http.patch(`${BROKER_URL}/api/otel/config`, async () => {
        patchCalled = true
        return HttpResponse.json({ config: mockConfig, note: 'ok' })
      }),
    )
    renderWithProviders(<OtelSettingsPage />)

    await waitFor(() => {
      expect(screen.getByLabelText(/jsonl file path/i)).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(() => {
      expect(patchCalled).toBe(true)
    })
  })

  it('shows success message after save', async () => {
    const user = userEvent.setup()
    server.use(useConfigHandler(), usePatchHandler())
    renderWithProviders(<OtelSettingsPage />)

    await waitFor(() => {
      expect(screen.getByLabelText(/jsonl file path/i)).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(() => {
      expect(screen.getByText(/saved|success/i)).toBeInTheDocument()
    })
  })

  it('shows error message on API failure', async () => {
    const user = userEvent.setup()
    server.use(
      useConfigHandler(),
      http.patch(`${BROKER_URL}/api/otel/config`, () =>
        new HttpResponse(null, { status: 500 }),
      ),
    )
    renderWithProviders(<OtelSettingsPage />)

    await waitFor(() => {
      expect(screen.getByLabelText(/jsonl file path/i)).toBeInTheDocument()
    })

    await user.click(screen.getByRole('button', { name: /save/i }))

    await waitFor(() => {
      expect(screen.getByText(/error|failed/i)).toBeInTheDocument()
    })
  })

  it('form fields have visible labels', async () => {
    server.use(useConfigHandler())
    renderWithProviders(<OtelSettingsPage />)

    await waitFor(() => {
      expect(screen.getByText(/jsonl file path/i)).toBeInTheDocument()
      expect(screen.getByText(/retention days/i)).toBeInTheDocument()
    })
  })

  it('file path field has placeholder text', async () => {
    server.use(useConfigHandler({ filePath: '' }))
    renderWithProviders(<OtelSettingsPage />)

    await waitFor(() => {
      const input = screen.getByLabelText(/jsonl file path/i)
      expect(input).toHaveAttribute('placeholder')
    })
  })

  it('retention days field accepts only numbers', async () => {
    server.use(useConfigHandler())
    renderWithProviders(<OtelSettingsPage />)

    await waitFor(() => {
      const input = screen.getByLabelText(/retention days/i)
      expect(input).toHaveAttribute('type', 'number')
    })
  })

  it('content capture toggle shows privacy warning', async () => {
    const user = userEvent.setup()
    server.use(useConfigHandler())
    renderWithProviders(<OtelSettingsPage />)

    await waitFor(() => {
      expect(screen.getByLabelText(/jsonl file path/i)).toBeInTheDocument()
    })

    const toggle = screen.getByRole('switch', { name: /content capture/i })
    await user.click(toggle)

    await waitFor(() => {
      expect(screen.getByText(/privacy/i)).toBeInTheDocument()
    })
  })

  it('has no axe-core violations', async () => {
    server.use(useConfigHandler())
    const { container } = renderWithProviders(<OtelSettingsPage />)

    await waitFor(() => {
      expect(screen.getByLabelText(/jsonl file path/i)).toBeInTheDocument()
    })

    const results = await axe.run(container)
    const serious = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious',
    )
    expect(serious).toEqual([])
  })
})
