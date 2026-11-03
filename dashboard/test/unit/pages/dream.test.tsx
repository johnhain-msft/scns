import { describe, it, expect, beforeAll, afterEach, afterAll, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { server } from '../../mocks/server'
import { renderWithProviders } from '../../helpers/render'
import { checkA11y } from '../../helpers/a11y'
import DreamPage from '@/app/dream/page'

const BROKER_URL = 'http://localhost:3456'

const mockDreamStatus = {
  running: false,
  last_run: '2024-01-15T10:30:00Z',
  memories_consolidated: 42,
  total_runs: 10,
  duration_ms: 5200,
  gates: [
    { name: 'Memory Threshold', passed: true },
    { name: 'Time Window', passed: true },
    { name: 'Session Idle', passed: false },
    { name: 'Rate Limit', passed: true },
  ],
}

beforeAll(() => server.listen({ onUnhandledRequest: 'warn' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('DreamPage', () => {
  beforeEach(() => {
    server.use(
      http.get(`${BROKER_URL}/api/dream/status`, () =>
        HttpResponse.json(mockDreamStatus),
      ),
      http.post(`${BROKER_URL}/api/dream/trigger`, () =>
        HttpResponse.json({ triggered: true }),
      ),
    )
  })

  it('renders "Dream" heading', async () => {
    renderWithProviders(<DreamPage />)
    expect(screen.getByRole('heading', { name: /dream/i, level: 1 })).toBeInTheDocument()
  })

  it('shows current status (last run, total runs, duration)', async () => {
    renderWithProviders(<DreamPage />)
    await waitFor(() => {
      expect(screen.getByText(/last run/i)).toBeInTheDocument()
    })
    expect(screen.getByText(/10/)).toBeInTheDocument()
  })

  it('shows gate status panel (each gate: pass/fail)', async () => {
    renderWithProviders(<DreamPage />)
    await waitFor(() => {
      expect(screen.getByText('Memory Threshold')).toBeInTheDocument()
    })
    expect(screen.getByText('Time Window')).toBeInTheDocument()
    expect(screen.getByText('Session Idle')).toBeInTheDocument()
    expect(screen.getByText('Rate Limit')).toBeInTheDocument()
  })

  it('shows "Force Run" button', async () => {
    renderWithProviders(<DreamPage />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /force run/i })).toBeInTheDocument()
    })
  })

  it('Force Run shows confirmation dialog', async () => {
    const user = userEvent.setup()
    renderWithProviders(<DreamPage />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /force run/i })).toBeInTheDocument()
    })
    await user.click(screen.getByRole('button', { name: /force run/i }))
    await waitFor(() => {
      expect(screen.getByRole('alertdialog') || screen.getByRole('dialog')).toBeInTheDocument()
    })
  })

  it('Force Run calls triggerDream API', async () => {
    let apiCalled = false
    server.use(
      http.post(`${BROKER_URL}/api/dream/trigger`, () => {
        apiCalled = true
        return HttpResponse.json({ triggered: true })
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(<DreamPage />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /force run/i })).toBeInTheDocument()
    })
    await user.click(screen.getByRole('button', { name: /force run/i }))
    await waitFor(() => {
      expect(screen.getByRole('alertdialog') || screen.getByRole('dialog')).toBeInTheDocument()
    })
    const confirmBtn = screen.getByRole('button', { name: /confirm/i })
    await user.click(confirmBtn)
    await waitFor(() => {
      expect(apiCalled).toBe(true)
    })
  })

  it('shows loading state', () => {
    server.use(
      http.get(`${BROKER_URL}/api/dream/status`, () => new Promise(() => {})),
    )
    renderWithProviders(<DreamPage />)
    expect(screen.getByText(/loading/i)).toBeInTheDocument()
  })

  it('shows "not available" when dream daemon unavailable', async () => {
    server.use(
      http.get(`${BROKER_URL}/api/dream/status`, () =>
        new HttpResponse('Service Unavailable', { status: 503 }),
      ),
    )
    renderWithProviders(<DreamPage />)
    await waitFor(() => {
      expect(screen.getByText(/not available/i)).toBeInTheDocument()
    })
  })

  it('gate status uses color+text (not color alone)', async () => {
    renderWithProviders(<DreamPage />)
    await waitFor(() => {
      expect(screen.getByText('Memory Threshold')).toBeInTheDocument()
    })
    // Each gate should have a text label for its status, not just color
    expect(screen.getAllByText(/pass/i).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/fail/i).length).toBeGreaterThan(0)
  })

  it('confirmation dialog has proper role', async () => {
    const user = userEvent.setup()
    renderWithProviders(<DreamPage />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /force run/i })).toBeInTheDocument()
    })
    await user.click(screen.getByRole('button', { name: /force run/i }))
    await waitFor(() => {
      const dialog = screen.getByRole('alertdialog') || screen.getByRole('dialog')
      expect(dialog).toBeInTheDocument()
    })
  })

  it('has no axe-core violations', async () => {
    const { container } = renderWithProviders(<DreamPage />)
    await waitFor(() => {
      expect(screen.getByText('Memory Threshold')).toBeInTheDocument()
    })
    const violations = await checkA11y(container)
    expect(violations).toEqual([])
  })
})
