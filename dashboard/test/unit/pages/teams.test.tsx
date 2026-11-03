import { describe, it, expect, beforeAll, afterEach, afterAll, beforeEach, vi } from 'vitest'
import { screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { server } from '../../mocks/server'
import { renderWithProviders } from '../../helpers/render'
import { checkA11y } from '../../helpers/a11y'
import TeamsPage from '@/app/teams/page'

const BROKER_URL = 'http://localhost:3456'

const mockTeams = [
  { id: 'team-1', name: 'Alpha', status: 'active', members: ['agent-1', 'agent-2'], tasks: ['t1', 't2'] },
  { id: 'team-2', name: 'Beta', status: 'disbanded', members: ['agent-3'], tasks: [] },
]

beforeAll(() => server.listen({ onUnhandledRequest: 'warn' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('TeamsPage', () => {
  beforeEach(() => {
    server.use(
      http.get(`${BROKER_URL}/api/teams`, () => HttpResponse.json({ teams: mockTeams })),
    )
  })

  it('renders "Teams" heading', async () => {
    renderWithProviders(<TeamsPage />)
    expect(screen.getByRole('heading', { name: /teams/i })).toBeInTheDocument()
  })

  it('shows team table with Name, Status, Members, Tasks columns', async () => {
    renderWithProviders(<TeamsPage />)
    await waitFor(() => {
      expect(screen.getByText('Alpha')).toBeInTheDocument()
    })
    const table = screen.getByRole('table')
    const headers = within(table).getAllByRole('columnheader')
    expect(headers.map(h => h.textContent)).toEqual(['Name', 'Status', 'Members', 'Tasks', 'Actions'])
  })

  it('shows status badge with text (active/disbanded)', async () => {
    renderWithProviders(<TeamsPage />)
    await waitFor(() => {
      expect(screen.getByText('active')).toBeInTheDocument()
      expect(screen.getByText('disbanded')).toBeInTheDocument()
    })
  })

  it('shows member count as number', async () => {
    renderWithProviders(<TeamsPage />)
    await waitFor(() => {
      expect(screen.getByText('Alpha')).toBeInTheDocument()
    })
    const rows = screen.getAllByRole('row')
    const alphaRow = rows[1]
    const betaRow = rows[2]
    const alphaCells = within(alphaRow).getAllByRole('cell')
    const betaCells = within(betaRow).getAllByRole('cell')
    // Members column is the 3rd cell (index 2)
    expect(alphaCells[2]).toHaveTextContent('2')
    expect(betaCells[2]).toHaveTextContent('1')
  })

  it('shows loading state', () => {
    server.use(
      http.get(`${BROKER_URL}/api/teams`, () => new Promise(() => {})),
    )
    renderWithProviders(<TeamsPage />)
    expect(screen.getByText(/loading/i)).toBeInTheDocument()
  })

  it('shows empty state', async () => {
    server.use(
      http.get(`${BROKER_URL}/api/teams`, () => HttpResponse.json({ teams: [] })),
    )
    renderWithProviders(<TeamsPage />)
    await waitFor(() => {
      expect(screen.getByText(/no teams/i)).toBeInTheDocument()
    })
  })

  it('table has proper th scope="col" headers', async () => {
    renderWithProviders(<TeamsPage />)
    await waitFor(() => {
      expect(screen.getByText('Alpha')).toBeInTheDocument()
    })
    const headers = screen.getAllByRole('columnheader')
    for (const header of headers) {
      expect(header).toHaveAttribute('scope', 'col')
    }
  })

  it('has no axe-core violations', async () => {
    const { container } = renderWithProviders(<TeamsPage />)
    await waitFor(() => {
      expect(screen.getByText('Alpha')).toBeInTheDocument()
    })
    const violations = await checkA11y(container)
    expect(violations).toEqual([])
  })

  it('archive button calls DELETE /api/teams/:id and hides row after refetch', async () => {
    const deleteCalls: string[] = []
    let currentTeams = [...mockTeams]

    server.use(
      http.get(`${BROKER_URL}/api/teams`, () =>
        HttpResponse.json({ teams: currentTeams }),
      ),
      http.delete(`${BROKER_URL}/api/teams/:id`, ({ params }) => {
        const id = String(params.id)
        deleteCalls.push(id)
        currentTeams = currentTeams.filter((t) => t.id !== id)
        return HttpResponse.json({ id, name: 'Alpha', status: 'disbanded', archived_at: '2024-01-01T00:00:00Z' })
      }),
    )

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const user = userEvent.setup()

    renderWithProviders(<TeamsPage />)
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument())

    const btn = screen.getByRole('button', { name: /archive team alpha/i })
    await user.click(btn)

    await waitFor(() => expect(deleteCalls).toEqual(['team-1']))
    await waitFor(() => expect(screen.queryByText('Alpha')).not.toBeInTheDocument())

    confirmSpy.mockRestore()
  })

  it('archive button is skipped when confirm() returns false', async () => {
    const deleteCalls: string[] = []
    server.use(
      http.delete(`${BROKER_URL}/api/teams/:id`, ({ params }) => {
        deleteCalls.push(String(params.id))
        return HttpResponse.json({})
      }),
    )
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const user = userEvent.setup()

    renderWithProviders(<TeamsPage />)
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument())

    const btn = screen.getByRole('button', { name: /archive team alpha/i })
    await user.click(btn)

    // Give the runtime a tick to ensure no mutation fires
    await new Promise((r) => setTimeout(r, 20))
    expect(deleteCalls).toEqual([])
    confirmSpy.mockRestore()
  })

  it('"Show archived" toggle re-queries with include_archived=true', async () => {
    const calls: string[] = []
    server.use(
      http.get(`${BROKER_URL}/api/teams`, ({ request }) => {
        const url = new URL(request.url)
        calls.push(url.search)
        return HttpResponse.json({ teams: mockTeams })
      }),
    )
    const user = userEvent.setup()

    renderWithProviders(<TeamsPage />)
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument())

    const checkbox = screen.getByRole('checkbox', { name: /show archived/i })
    await user.click(checkbox)

    await waitFor(() => expect(calls.some((c) => c.includes('include_archived=true'))).toBe(true))
  })
})
