import { describe, it, expect, beforeAll, afterEach, afterAll, beforeEach } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { server } from '../../mocks/server'
import { renderWithProviders } from '../../helpers/render'
import { checkA11y } from '../../helpers/a11y'
import AutonomyPage from '@/app/autonomy/page'

const BROKER_URL = 'http://localhost:3456'

const mockAutonomy = {
  level: 1,
  changedAt: '2024-01-15T10:30:00Z',
  changedBy: 'user',
}

beforeAll(() => server.listen({ onUnhandledRequest: 'warn' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('AutonomyPage', () => {
  beforeEach(() => {
    server.use(
      http.get(`${BROKER_URL}/api/autonomy`, () => HttpResponse.json(mockAutonomy)),
      http.post(`${BROKER_URL}/api/autonomy/promote`, () =>
        HttpResponse.json({ level: 2, changedAt: '2024-01-15T11:00:00Z', changedBy: 'user' }),
      ),
      http.post(`${BROKER_URL}/api/autonomy/demote`, () =>
        HttpResponse.json({ level: 0, changedAt: '2024-01-15T11:00:00Z', changedBy: 'user' }),
      ),
    )
  })

  it('renders "Autonomy" heading', async () => {
    renderWithProviders(<AutonomyPage />)
    expect(screen.getByRole('heading', { name: /autonomy/i, level: 1 })).toBeInTheDocument()
  })

  it('shows current level with label (L1 Advisor)', async () => {
    renderWithProviders(<AutonomyPage />)
    await waitFor(() => {
      expect(screen.getByRole('status')).toBeInTheDocument()
    })
    const status = screen.getByRole('status')
    expect(within(status).getByText(/L1/)).toBeInTheDocument()
    expect(within(status).getByText(/advisor/i)).toBeInTheDocument()
  })

  it('shows level description explaining what it allows', async () => {
    renderWithProviders(<AutonomyPage />)
    await waitFor(() => {
      expect(screen.getByText(/can generate suggestions/i)).toBeInTheDocument()
    })
  })

  it('promote button calls promoteAutonomy API', async () => {
    let apiCalled = false
    server.use(
      http.post(`${BROKER_URL}/api/autonomy/promote`, () => {
        apiCalled = true
        return HttpResponse.json({ level: 2, changedAt: '2024-01-15T11:00:00Z', changedBy: 'user' })
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(<AutonomyPage />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /promote/i })).toBeInTheDocument()
    })
    await user.click(screen.getByRole('button', { name: /promote/i }))
    await waitFor(() => {
      expect(apiCalled).toBe(true)
    })
  })

  it('demote button calls demoteAutonomy API', async () => {
    let apiCalled = false
    server.use(
      http.post(`${BROKER_URL}/api/autonomy/demote`, () => {
        apiCalled = true
        return HttpResponse.json({ level: 0, changedAt: '2024-01-15T11:00:00Z', changedBy: 'user' })
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(<AutonomyPage />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /demote/i })).toBeInTheDocument()
    })
    await user.click(screen.getByRole('button', { name: /demote/i }))
    await waitFor(() => {
      expect(apiCalled).toBe(true)
    })
  })

  it('promote disabled at L3 (max)', async () => {
    server.use(
      http.get(`${BROKER_URL}/api/autonomy`, () =>
        HttpResponse.json({ level: 3, changedAt: '2024-01-15T10:30:00Z', changedBy: 'user' }),
      ),
    )
    renderWithProviders(<AutonomyPage />)
    await waitFor(() => {
      expect(screen.getByRole('status')).toBeInTheDocument()
    })
    const status = screen.getByRole('status')
    expect(within(status).getByText(/L3/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /promote/i })).toBeDisabled()
  })

  it('demote disabled at L0 (min)', async () => {
    server.use(
      http.get(`${BROKER_URL}/api/autonomy`, () =>
        HttpResponse.json({ level: 0, changedAt: '2024-01-15T10:30:00Z', changedBy: 'user' }),
      ),
    )
    renderWithProviders(<AutonomyPage />)
    await waitFor(() => {
      expect(screen.getByRole('status')).toBeInTheDocument()
    })
    const status = screen.getByRole('status')
    expect(within(status).getByText(/L0/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /demote/i })).toBeDisabled()
  })

  it('level indicator uses proper semantics', async () => {
    renderWithProviders(<AutonomyPage />)
    await waitFor(() => {
      expect(screen.getByRole('status')).toBeInTheDocument()
    })
    const status = screen.getByRole('status')
    expect(within(status).getByText(/L1/)).toBeInTheDocument()
  })

  it('buttons have descriptive labels', async () => {
    renderWithProviders(<AutonomyPage />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /promote/i })).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: /promote/i })).toHaveAccessibleName()
    expect(screen.getByRole('button', { name: /demote/i })).toHaveAccessibleName()
  })

  it('shows last changed timestamp', async () => {
    renderWithProviders(<AutonomyPage />)
    await waitFor(() => {
      expect(screen.getByText(/last changed/i)).toBeInTheDocument()
    })
  })

  it('has no axe-core violations', async () => {
    const { container } = renderWithProviders(<AutonomyPage />)
    await waitFor(() => {
      expect(screen.getByRole('status')).toBeInTheDocument()
    })
    const violations = await checkA11y(container)
    expect(violations).toEqual([])
  })
})
