import { describe, it, expect, beforeEach, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { renderWithProviders } from '../../helpers/render'
import axe from 'axe-core'

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

function setupDefaultMocks() {
  ;(getHealth as Mock).mockResolvedValue({
    status: 'ok',
    uptime_seconds: 12345,
  })
  ;(getBrainStatus as Mock).mockResolvedValue({
    state: 'idle',
    lastTickAt: new Date(Date.now() - 30_000).toISOString(),
    ticksToday: 1,
    currentDecisionId: null,
    queueDepth: 0,
    autonomy: 1,
    isWoken: false,
  })
  ;(listSessions as Mock).mockResolvedValue([
    { id: 'sess-1', status: 'active', created_at: '2024-01-01T00:00:00Z' },
  ])
  ;(listTeams as Mock).mockResolvedValue([
    { id: 'team-1', name: 'Alpha' },
  ])
  ;(getSchedulerTasks as Mock).mockResolvedValue([
    { id: 'task-1', name: 'cleanup', cron_expression: '0 * * * *', enabled: true, category: 'cron' },
  ])
  ;(getDreamStatus as Mock).mockResolvedValue({
    gateCheck: { allPassed: false },
    lastRunAt: new Date(Date.now() - 3_600_000).toISOString(),
    totalRuns: 42,
  })
  ;(getAutonomy as Mock).mockResolvedValue({
    level: 1,
    changedAt: '2024-01-01T00:00:00Z',
    changedBy: 'user',
  })
  ;(getCostSummary as Mock).mockResolvedValue({
    totalInputTokens: 1000,
    totalOutputTokens: 500,
    totalTokens: 1500,
    estimatedTotalCostUSD: 12.34,
    sessionCount: 5,
    perSession: [],
  })
}

describe('OverviewPage', () => {
  beforeEach(() => {
    setupDefaultMocks()
  })

  it('renders page heading "Overview"', () => {
    renderWithProviders(<OverviewPage />)
    expect(
      screen.getByRole('heading', { name: /overview/i, level: 1 }),
    ).toBeInTheDocument()
  })

  it('shows health status card with uptime and version', async () => {
    ;(getHealth as Mock).mockResolvedValue({
      status: 'ok',
      uptime_seconds: 3661,
      version: '1.2.3',
    })
    renderWithProviders(<OverviewPage />)
    await waitFor(() => {
      expect(screen.getByText(/1h 1m/)).toBeInTheDocument()
      expect(screen.getByText('1.2.3')).toBeInTheDocument()
    })
  })

  it('shows session summary card with counts by status', async () => {
    ;(listSessions as Mock).mockResolvedValue([
      { id: 's1', status: 'active', created_at: '2024-01-01T00:00:00Z' },
      { id: 's2', status: 'active', created_at: '2024-01-01T00:00:00Z' },
      { id: 's3', status: 'idle', created_at: '2024-01-01T00:00:00Z' },
    ])
    renderWithProviders(<OverviewPage />)

    const heading = await screen.findByRole('heading', {
      name: /^sessions$/i,
      level: 2,
    })
    const card = within(heading.closest('section')!)

    await waitFor(() => {
      expect(card.getByText('3')).toBeInTheDocument()
    })
    expect(card.getByText(/active/i)).toBeInTheDocument()
    expect(card.getByText(/idle/i)).toBeInTheDocument()
  })

  it('shows team count', async () => {
    renderWithProviders(<OverviewPage />)

    const heading = await screen.findByRole('heading', {
      name: /teams/i,
      level: 2,
    })
    const card = within(heading.closest('section')!)

    await waitFor(() => {
      expect(card.getByText('Teams')).toBeInTheDocument()
    })
    const teamsLabel = card.getByText('Teams')
    expect(teamsLabel.parentElement).toHaveTextContent('1')
  })

  it('shows task counts (pending, in_progress)', async () => {
    ;(getSchedulerTasks as Mock).mockResolvedValue([
      { id: 't1', name: 'cleanup', cron_expression: '0 * * * *', enabled: true, category: 'cron' },
      { id: 't2', name: 'backup', cron_expression: '0 0 * * *', enabled: false, category: 'cron' },
      { id: 't3', name: 'sync', cron_expression: '*/5 * * * *', enabled: true, category: 'cron' },
    ])
    renderWithProviders(<OverviewPage />)

    const heading = await screen.findByRole('heading', {
      name: /teams/i,
      level: 2,
    })
    const card = within(heading.closest('section')!)

    await waitFor(() => {
      const activeLabel = card.getByText('Active Tasks')
      expect(activeLabel.parentElement).toHaveTextContent('2')
    })
    const pendingLabel = card.getByText('Pending Tasks')
    expect(pendingLabel.parentElement).toHaveTextContent('1')
  })

  it('shows autonomy level badge', async () => {
    renderWithProviders(<OverviewPage />)
    await waitFor(() => {
      expect(screen.getByText(/L1/)).toBeInTheDocument()
      expect(screen.getByText(/Advisor/)).toBeInTheDocument()
    })
  })

  it('shows dream status (last run time)', async () => {
    renderWithProviders(<OverviewPage />)
    await waitFor(() => {
      expect(screen.getByText(/1h ago/)).toBeInTheDocument()
    })
  })

  it('shows cost summary (total tokens)', async () => {
    renderWithProviders(<OverviewPage />)
    await waitFor(() => {
      expect(screen.getByText('$12.34')).toBeInTheDocument()
    })
  })

  it('shows loading state while data fetches', () => {
    ;(getHealth as Mock).mockReturnValue(new Promise(() => {}))
    ;(listSessions as Mock).mockReturnValue(new Promise(() => {}))
    ;(listTeams as Mock).mockReturnValue(new Promise(() => {}))
    ;(getSchedulerTasks as Mock).mockReturnValue(new Promise(() => {}))
    ;(getDreamStatus as Mock).mockReturnValue(new Promise(() => {}))
    ;(getAutonomy as Mock).mockReturnValue(new Promise(() => {}))
    ;(getCostSummary as Mock).mockReturnValue(new Promise(() => {}))

    renderWithProviders(<OverviewPage />)
    expect(screen.getAllByText(/loading/i).length).toBeGreaterThan(0)
  })

  it('shows error state when API fails', async () => {
    ;(getHealth as Mock).mockRejectedValue(new Error('Server error'))
    renderWithProviders(<OverviewPage />)
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument()
    })
  })

  it('health card shows "Healthy" when status is "ok"', async () => {
    renderWithProviders(<OverviewPage />)
    await waitFor(() => {
      expect(screen.getByText('Healthy')).toBeInTheDocument()
    })
  })

  it('health card shows "Degraded" when status is "degraded"', async () => {
    ;(getHealth as Mock).mockResolvedValue({
      status: 'degraded',
      uptime_seconds: 100,
    })
    renderWithProviders(<OverviewPage />)
    await waitFor(() => {
      expect(screen.getByText('Degraded')).toBeInTheDocument()
    })
  })

  it('all cards have proper heading hierarchy (h2)', () => {
    renderWithProviders(<OverviewPage />)
    const h2s = screen.getAllByRole('heading', { level: 2 })
    expect(h2s).toHaveLength(7)
    const titles = h2s.map((h) => h.textContent)
    expect(titles).toEqual([
      'System Health',
      'Brain',
      'Sessions',
      'Teams & Tasks',
      'Autonomy',
      'Dream',
      'Cost',
    ])
  })

  it('page has no axe-core violations', async () => {
    const { container } = renderWithProviders(<OverviewPage />)
    await waitFor(() => {
      expect(screen.getByText('Healthy')).toBeInTheDocument()
    })
    const results = await axe.run(container)
    expect(results.violations).toEqual([])
  })
})
