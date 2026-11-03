import { describe, it, expect, beforeEach, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { renderWithProviders } from '../../helpers/render'

vi.mock('@/lib/api')

import OverviewPage from '@/app/page'
import {
  getHealth,
  getBrainStatus,
  listSessions,
  listTeams,
  getSchedulerTasks,
  getDreamStatus,
  getAutonomy,
  getCostSummary,
} from '@/lib/api'
import type { Mock } from 'vitest'

function setupBaselineMocks() {
  ;(getHealth as Mock).mockResolvedValue({ status: 'ok', uptime_seconds: 1 })
  ;(listSessions as Mock).mockResolvedValue([])
  ;(listTeams as Mock).mockResolvedValue([])
  ;(getSchedulerTasks as Mock).mockResolvedValue([])
  ;(getDreamStatus as Mock).mockResolvedValue({})
  ;(getAutonomy as Mock).mockResolvedValue({ level: 1 })
  ;(getCostSummary as Mock).mockResolvedValue({
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0,
    estimatedTotalCostUSD: 0,
    sessionCount: 0,
    perSession: [],
  })
}

describe('Brain status badge on Overview page (Phase 13.12.14)', () => {
  beforeEach(() => {
    setupBaselineMocks()
  })

  it('renders GREEN when state is idle and lastTickAt is within 5 minutes', async () => {
    ;(getBrainStatus as Mock).mockResolvedValue({
      state: 'idle',
      lastTickAt: new Date(Date.now() - 60_000).toISOString(),
      ticksToday: 5,
      currentDecisionId: 7,
      queueDepth: 2,
      autonomy: 2,
      isWoken: false,
    })

    renderWithProviders(<OverviewPage />)

    const badge = await waitFor(() => screen.getByTestId('brain-status-badge'))
    expect(badge).toHaveTextContent(/Ready/i)
    // Radix Badge maps `color="green"` to the green accent color CSS variable.
    // We assert via the `data-accent-color` attribute Radix puts on the element.
    expect(badge.getAttribute('data-accent-color')).toBe('green')
  })

  it('renders YELLOW when lastTickAt is older than 5 minutes', async () => {
    ;(getBrainStatus as Mock).mockResolvedValue({
      state: 'idle',
      lastTickAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      ticksToday: 5,
      currentDecisionId: 7,
      queueDepth: 2,
      autonomy: 2,
      isWoken: false,
    })

    renderWithProviders(<OverviewPage />)

    const badge = await waitFor(() => screen.getByTestId('brain-status-badge'))
    expect(badge).toHaveTextContent(/Stale/i)
    expect(badge.getAttribute('data-accent-color')).toBe('yellow')
  })

  it('renders RED when state is "starting" (brain not ready)', async () => {
    ;(getBrainStatus as Mock).mockResolvedValue({
      state: 'starting',
      lastTickAt: null,
      ticksToday: 0,
      currentDecisionId: null,
      queueDepth: 0,
      autonomy: 0,
      isWoken: true,
    })

    renderWithProviders(<OverviewPage />)

    const badge = await waitFor(() => screen.getByTestId('brain-status-badge'))
    expect(badge).toHaveTextContent(/Starting/i)
    expect(badge.getAttribute('data-accent-color')).toBe('red')
  })

  it('renders RED Unavailable when the brain status endpoint errors', async () => {
    ;(getBrainStatus as Mock).mockRejectedValue(new Error('404'))

    renderWithProviders(<OverviewPage />)

    const badge = await waitFor(() => screen.getByTestId('brain-status-badge'))
    expect(badge).toHaveTextContent(/Unavailable/i)
    expect(badge.getAttribute('data-accent-color')).toBe('red')
  })

  it('shows queueDepth and ticksToday from snapshot', async () => {
    ;(getBrainStatus as Mock).mockResolvedValue({
      state: 'idle',
      lastTickAt: new Date(Date.now() - 30_000).toISOString(),
      ticksToday: 11,
      currentDecisionId: 99,
      queueDepth: 4,
      autonomy: 1,
      isWoken: false,
    })

    renderWithProviders(<OverviewPage />)

    await waitFor(() => screen.getByTestId('brain-status-badge'))
    // Both values rendered somewhere in the Brain card
    expect(screen.getByText(/11/)).toBeInTheDocument()
    expect(screen.getByText(/4/)).toBeInTheDocument()
  })
})
