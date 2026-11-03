import { describe, it, expect, beforeAll, afterEach, afterAll, beforeEach } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { server } from '../../mocks/server'
import { renderWithProviders } from '../../helpers/render'
import { checkA11y } from '../../helpers/a11y'
import ObserversPage from '@/app/observers/page'

const BROKER_URL = 'http://localhost:3456'

const mockObservers = {
  state: 'running',
  observationCount: 10,
  startedAt: new Date().toISOString(),
  plugins: [
    { type: 'active-app', name: 'active-app', state: 'running' },
    { type: 'file-change', name: 'file-change-observer', state: 'idle' },
    { type: 'git-activity', name: 'git-activity-observer', state: 'running' },
    { type: 'terminal-history', name: 'terminal-history', state: 'idle' },
    { type: 'browser-tab', name: 'browser-tab', state: 'running' },
    { type: 'session-hook', name: 'session-hook', state: 'idle' },
  ],
  observers: [],
}

beforeAll(() => server.listen({ onUnhandledRequest: 'warn' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('ObserversPage', () => {
  beforeEach(() => {
    server.use(
      http.get(`${BROKER_URL}/api/observers`, () => HttpResponse.json(mockObservers)),
      http.post(`${BROKER_URL}/api/observers/:type/toggle`, ({ params }) => {
        const observer = mockObservers.plugins.find(o => o.type === params.type)
        return HttpResponse.json({
          type: params.type,
          enabled: observer ? observer.state !== 'running' : true,
        })
      }),
    )
  })

  it('renders "Observers" heading', async () => {
    renderWithProviders(<ObserversPage />)
    expect(screen.getByRole('heading', { name: /observers/i, level: 1 })).toBeInTheDocument()
  })

  it('shows 6 observer cards', async () => {
    renderWithProviders(<ObserversPage />)
    await waitFor(() => {
      expect(screen.getByText(/active app/i)).toBeInTheDocument()
    })
    const sections = screen.getAllByRole('region')
    expect(sections.length).toBe(6)
  })

  it('each card has name, description, toggle switch', async () => {
    renderWithProviders(<ObserversPage />)
    await waitFor(() => {
      expect(screen.getByText(/active app/i)).toBeInTheDocument()
    })
    expect(screen.getByText(/track which applications are in focus/i)).toBeInTheDocument()
    expect(screen.getByText(/monitor file system modifications/i)).toBeInTheDocument()
    const switches = screen.getAllByRole('switch')
    expect(switches.length).toBe(6)
  })

  it('toggle calls toggleObserver API', async () => {
    let toggledType: string | undefined
    server.use(
      http.post(`${BROKER_URL}/api/observers/:type/toggle`, ({ params }) => {
        toggledType = params.type as string
        return HttpResponse.json({ type: params.type, enabled: true })
      }),
    )
    const user = userEvent.setup()
    renderWithProviders(<ObserversPage />)
    await waitFor(() => {
      expect(screen.getByText(/active app/i)).toBeInTheDocument()
    })
    const switches = screen.getAllByRole('switch')
    await user.click(switches[0])
    await waitFor(() => {
      expect(toggledType).toBeDefined()
    })
  })

  it('shows observer type labels', async () => {
    renderWithProviders(<ObserversPage />)
    await waitFor(() => {
      expect(screen.getByText(/active app/i)).toBeInTheDocument()
    })
    expect(screen.getByText(/file changes/i)).toBeInTheDocument()
    expect(screen.getByText(/git activity/i)).toBeInTheDocument()
    expect(screen.getByText(/terminal history/i)).toBeInTheDocument()
    expect(screen.getByText(/browser tabs/i)).toBeInTheDocument()
    expect(screen.getByText(/session hooks/i)).toBeInTheDocument()
  })

  it('shows "not available" when observer system unavailable', async () => {
    server.use(
      http.get(`${BROKER_URL}/api/observers`, () =>
        new HttpResponse('Service Unavailable', { status: 503 }),
      ),
    )
    renderWithProviders(<ObserversPage />)
    await waitFor(() => {
      expect(screen.getByText(/not available/i)).toBeInTheDocument()
    })
  })

  it('toggle switches have aria-checked', async () => {
    renderWithProviders(<ObserversPage />)
    await waitFor(() => {
      expect(screen.getByText(/active app/i)).toBeInTheDocument()
    })
    const switches = screen.getAllByRole('switch')
    for (const sw of switches) {
      expect(sw).toHaveAttribute('aria-checked')
    }
  })

  it('each card is a section with aria-labelledby', async () => {
    renderWithProviders(<ObserversPage />)
    await waitFor(() => {
      expect(screen.getByText(/active app/i)).toBeInTheDocument()
    })
    const sections = screen.getAllByRole('region')
    for (const section of sections) {
      expect(section).toHaveAttribute('aria-labelledby')
      const labelId = section.getAttribute('aria-labelledby')!
      const label = document.getElementById(labelId)
      expect(label).not.toBeNull()
    }
  })

  it('has no axe-core violations', async () => {
    const { container } = renderWithProviders(<ObserversPage />)
    await waitFor(() => {
      expect(screen.getByText(/active app/i)).toBeInTheDocument()
    })
    const violations = await checkA11y(container)
    expect(violations).toEqual([])
  })

  it('renders observers with duplicate types using unique keys (regression)', async () => {
    const duplicateTypeResponse = {
      state: 'running',
      plugins: [
        { type: 'file-change', name: 'file-change-observer', state: 'running' },
        { type: 'file-change', name: 'config-change-observer', state: 'idle' },
        { type: 'git-activity', name: 'git-activity-observer', state: 'running' },
      ],
    }
    server.use(
      http.get(`${BROKER_URL}/api/observers`, () =>
        HttpResponse.json(duplicateTypeResponse),
      ),
    )

    renderWithProviders(<ObserversPage />)
    await waitFor(() => {
      expect(screen.getAllByRole('region')).toHaveLength(3)
    })

    // All 3 sections render — no React key collision dropping one
    const sections = screen.getAllByRole('region')
    expect(sections).toHaveLength(3)

    // Each section has a unique aria-labelledby (derived from name, not type)
    const labelIds = sections.map(s => s.getAttribute('aria-labelledby'))
    expect(new Set(labelIds).size).toBe(3)
  })

  it('includes config-change in OBSERVER_META', async () => {
    server.use(
      http.get(`${BROKER_URL}/api/observers`, () =>
        HttpResponse.json({
          state: 'running',
          plugins: [
            { type: 'config-change', name: 'config-change-observer', state: 'running' },
          ],
        }),
      ),
    )

    renderWithProviders(<ObserversPage />)
    await waitFor(() => {
      expect(screen.getByText(/config changes/i)).toBeInTheDocument()
    })
    expect(screen.getByText(/detect changes to mcp/i)).toBeInTheDocument()
  })
})
