import { describe, it, expect, beforeEach, vi } from 'vitest'
import { screen, waitFor, act } from '@testing-library/react'
import { renderWithProviders } from '../../helpers/render'
import axe from 'axe-core'

vi.mock('@/lib/api')

const sseCallbackRef = vi.hoisted(() => ({
  current: null as ((event: Record<string, unknown>) => void) | null,
}))

vi.mock('@/hooks/use-sse', () => ({
  useSSE: (cb: (event: Record<string, unknown>) => void) => {
    sseCallbackRef.current = cb
    return { connected: true }
  },
}))

import SessionsPage from '@/app/sessions/page'
import { listSessions } from '@/lib/api'
import type { Mock } from 'vitest'

function mockSessionsWithHeartbeats() {
  const now = Date.now()
  return [
    {
      id: 'sess-abc-123-def-456',
      status: 'active',
      created_at: '2024-01-01T00:00:00Z',
      intent: 'Code review',
      working_dir: '/home/user/project',
      last_heartbeat: new Date(now - 10_000).toISOString(),
    },
    {
      id: 'sess-ghi-789-jkl-012',
      status: 'idle',
      created_at: '2024-01-01T00:00:00Z',
      intent: 'Testing',
      working_dir: '/home/user/tests',
      last_heartbeat: new Date(now - 45_000).toISOString(),
    },
    {
      id: 'sess-mno-345-pqr-678',
      status: 'zombie',
      created_at: '2024-01-01T00:00:00Z',
      intent: 'Build pipeline',
      working_dir: '/home/user/ci',
      last_heartbeat: new Date(now - 90_000).toISOString(),
    },
  ]
}

describe('SessionsPage', () => {
  beforeEach(() => {
    ;(listSessions as Mock).mockResolvedValue(
      mockSessionsWithHeartbeats(),
    )
  })

  it('renders page heading "Sessions"', () => {
    renderWithProviders(<SessionsPage />)
    expect(
      screen.getByRole('heading', { name: /sessions/i, level: 1 }),
    ).toBeInTheDocument()
  })

  it('renders session table with correct columns', async () => {
    renderWithProviders(<SessionsPage />)
    await waitFor(() => {
      expect(screen.getByText(/code review/i)).toBeInTheDocument()
    })

    const headers = screen.getAllByRole('columnheader')
    const headerTexts = headers.map((h) => h.textContent)
    expect(headerTexts).toEqual([
      'ID',
      'Purpose',
      'Status',
      'Working Dir',
      'Last Heartbeat',
    ])
  })

  it('shows session status as colored badge WITH text', async () => {
    renderWithProviders(<SessionsPage />)
    await waitFor(() => {
      expect(screen.getByText('active')).toBeInTheDocument()
      expect(screen.getByText('idle')).toBeInTheDocument()
      expect(screen.getByText('zombie')).toBeInTheDocument()
    })
  })

  it('shows heartbeat health indicator', async () => {
    renderWithProviders(<SessionsPage />)
    await waitFor(() => {
      expect(screen.getByText('Healthy')).toBeInTheDocument()
      expect(screen.getByText('Warning')).toBeInTheDocument()
      expect(screen.getByText('Stale')).toBeInTheDocument()
    })
  })

  it('shows loading state', () => {
    ;(listSessions as Mock).mockReturnValue(new Promise(() => {}))
    renderWithProviders(<SessionsPage />)
    expect(screen.getByText(/loading/i)).toBeInTheDocument()
  })

  it('shows empty state when no sessions', async () => {
    ;(listSessions as Mock).mockResolvedValue([])
    renderWithProviders(<SessionsPage />)
    await waitFor(() => {
      expect(screen.getByText(/no sessions/i)).toBeInTheDocument()
    })
  })

  it('table has proper <thead> and <th scope="col">', async () => {
    const { container } = renderWithProviders(<SessionsPage />)
    await waitFor(() => {
      expect(screen.getByText(/code review/i)).toBeInTheDocument()
    })

    const thead = container.querySelector('thead')
    expect(thead).toBeInTheDocument()

    const ths = container.querySelectorAll('th[scope="col"]')
    expect(ths.length).toBe(5)
  })

  it('session count shown in header', async () => {
    renderWithProviders(<SessionsPage />)
    await waitFor(() => {
      expect(screen.getByText('3')).toBeInTheDocument()
    })
  })

  it('SSE updates add/remove rows dynamically', async () => {
    ;(listSessions as Mock).mockResolvedValue([
      { id: 'sess-1', status: 'active', created_at: '2024-01-01T00:00:00Z' },
    ])
    renderWithProviders(<SessionsPage />)
    await waitFor(() => {
      expect(screen.getByText(/sess-1/)).toBeInTheDocument()
    })

    // Next call returns 2 sessions
    ;(listSessions as Mock).mockResolvedValue([
      { id: 'sess-1', status: 'active', created_at: '2024-01-01T00:00:00Z' },
      { id: 'sess-new', status: 'idle', created_at: '2024-01-02T00:00:00Z' },
    ])

    // Fire SSE event to trigger query invalidation
    act(() => {
      sseCallbackRef.current?.({
        id: 2,
        type: 'session_registered',
        session_id: 'sess-new',
        payload: {},
        team_id: null,
        created_at: new Date().toISOString(),
      })
    })

    await waitFor(() => {
      expect(screen.getByText(/sess-new/)).toBeInTheDocument()
    })
  })

  it('page has no axe-core violations', async () => {
    const { container } = renderWithProviders(<SessionsPage />)
    await waitFor(() => {
      expect(screen.getByText(/code review/i)).toBeInTheDocument()
    })
    const results = await axe.run(container)
    expect(results.violations).toEqual([])
  })
})
