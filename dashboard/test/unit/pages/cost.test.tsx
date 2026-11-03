import { describe, it, expect, beforeAll, afterEach, afterAll, beforeEach } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { server } from '../../mocks/server'
import { renderWithProviders } from '../../helpers/render'
import { checkA11y } from '../../helpers/a11y'
import CostPage from '@/app/cost/page'

const BROKER_URL = 'http://localhost:3456'

const mockCostSummary = {
  totalInputTokens: 1500000,
  totalOutputTokens: 500000,
  totalTokens: 2000000,
  estimatedTotalCostUSD: 12.3456,
  sessionCount: 3,
  perSession: [
    { sessionId: 'sess-1', inputTokens: 500000, outputTokens: 200000, totalTokens: 700000, estimatedCostUSD: 4.5678 },
    { sessionId: 'sess-2', inputTokens: 600000, outputTokens: 150000, totalTokens: 750000, estimatedCostUSD: 4.1234 },
    { sessionId: 'sess-3', inputTokens: 400000, outputTokens: 150000, totalTokens: 550000, estimatedCostUSD: 3.6544 },
  ],
}

beforeAll(() => server.listen({ onUnhandledRequest: 'warn' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('CostPage', () => {
  beforeEach(() => {
    server.use(
      http.get(`${BROKER_URL}/api/cost/summary`, () => HttpResponse.json(mockCostSummary)),
    )
  })

  it('renders "Cost" heading', async () => {
    renderWithProviders(<CostPage />)
    expect(screen.getByRole('heading', { name: /cost/i, level: 1 })).toBeInTheDocument()
  })

  it('shows total tokens (input + output)', async () => {
    renderWithProviders(<CostPage />)
    await waitFor(() => {
      expect(screen.getByRole('table')).toBeInTheDocument()
    })
    expect(screen.getByText('1,500,000')).toBeInTheDocument()
    expect(screen.getAllByText('500,000').length).toBeGreaterThanOrEqual(1)
  })

  it('shows estimated total cost USD', async () => {
    renderWithProviders(<CostPage />)
    await waitFor(() => {
      expect(screen.getByText('$12.3456')).toBeInTheDocument()
    })
  })

  it('shows per-session cost table', async () => {
    renderWithProviders(<CostPage />)
    await waitFor(() => {
      expect(screen.getByRole('table')).toBeInTheDocument()
    })
    expect(screen.getByText('sess-1')).toBeInTheDocument()
    expect(screen.getByText('sess-2')).toBeInTheDocument()
    expect(screen.getByText('sess-3')).toBeInTheDocument()
  })

  it('table has proper headers (Session, Input Tokens, Output Tokens, Total, Cost)', async () => {
    renderWithProviders(<CostPage />)
    await waitFor(() => {
      expect(screen.getByRole('table')).toBeInTheDocument()
    })
    const table = screen.getByRole('table')
    const headers = within(table).getAllByRole('columnheader')
    expect(headers.map(h => h.textContent)).toEqual([
      'Session', 'Input Tokens', 'Output Tokens', 'Total', 'Cost',
    ])
    for (const header of headers) {
      expect(header).toHaveAttribute('scope', 'col')
    }
  })

  it('large numbers formatted with commas', async () => {
    renderWithProviders(<CostPage />)
    await waitFor(() => {
      expect(screen.getByText('700,000')).toBeInTheDocument()
    })
    expect(screen.getByText('750,000')).toBeInTheDocument()
    expect(screen.getByText('550,000')).toBeInTheDocument()
  })

  it('cost formatted as USD with 4 decimal places', async () => {
    renderWithProviders(<CostPage />)
    await waitFor(() => {
      expect(screen.getByText('$4.5678')).toBeInTheDocument()
    })
    expect(screen.getByText('$4.1234')).toBeInTheDocument()
    expect(screen.getByText('$3.6544')).toBeInTheDocument()
  })

  it('shows loading state', () => {
    server.use(
      http.get(`${BROKER_URL}/api/cost/summary`, () => new Promise(() => {})),
    )
    renderWithProviders(<CostPage />)
    expect(screen.getByText(/loading/i)).toBeInTheDocument()
  })

  it('shows empty state', async () => {
    server.use(
      http.get(`${BROKER_URL}/api/cost/summary`, () =>
        HttpResponse.json({
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalTokens: 0,
          estimatedTotalCostUSD: 0,
          sessionCount: 0,
          perSession: [],
        }),
      ),
    )
    renderWithProviders(<CostPage />)
    await waitFor(() => {
      expect(screen.getByText(/no session/i)).toBeInTheDocument()
    })
  })

  it('has no axe-core violations', async () => {
    const { container } = renderWithProviders(<CostPage />)
    await waitFor(() => {
      expect(screen.getByRole('table')).toBeInTheDocument()
    })
    const violations = await checkA11y(container)
    expect(violations).toEqual([])
  })
})
