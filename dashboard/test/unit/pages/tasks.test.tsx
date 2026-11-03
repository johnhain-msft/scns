import { describe, it, expect, beforeAll, afterEach, afterAll, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { server } from '../../mocks/server'
import { renderWithProviders } from '../../helpers/render'
import { checkA11y } from '../../helpers/a11y'
import TasksPage from '@/app/tasks/page'

const BROKER_URL = 'http://localhost:3456'

// Teams do NOT have a `tasks` field — tasks come from /api/tasks?team_id=X
const mockTeams = [
  { id: 'team-1', name: 'Alpha', status: 'active', created_at: '2024-01-01T00:00:00Z' },
  { id: 'team-2', name: 'Beta', status: 'active', created_at: '2024-01-01T00:00:00Z' },
]

const mockTasksTeam1 = [
  { id: 1, team_id: 'team-1', seq: 1, subject: 'Fix login bug', description: null, status: 'pending', owner: 'agent-1', active_form: null, created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z' },
  { id: 2, team_id: 'team-1', seq: 2, subject: 'Add caching', description: null, status: 'in_progress', owner: 'agent-1', active_form: null, created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z' },
  { id: 3, team_id: 'team-1', seq: 3, subject: 'Update docs', description: null, status: 'completed', owner: 'agent-1', active_form: null, created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z' },
]

const mockTasksTeam2 = [
  { id: 4, team_id: 'team-2', seq: 1, subject: 'Deploy service', description: null, status: 'pending', owner: null, active_form: null, created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z' },
]

beforeAll(() => server.listen({ onUnhandledRequest: 'warn' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

function setupTaskHandlers() {
  server.use(
    http.get(`${BROKER_URL}/api/teams`, () => HttpResponse.json({ teams: mockTeams })),
    http.get(`${BROKER_URL}/api/tasks`, ({ request }) => {
      const url = new URL(request.url)
      const teamId = url.searchParams.get('team_id')
      if (!teamId) return HttpResponse.json({ error: 'team_id required' }, { status: 400 })
      const tasks = teamId === 'team-1' ? mockTasksTeam1
        : teamId === 'team-2' ? mockTasksTeam2
        : []
      return HttpResponse.json({ tasks })
    }),
  )
}

describe('TasksPage', () => {
  beforeEach(() => {
    setupTaskHandlers()
  })

  it('renders "Tasks" heading', async () => {
    renderWithProviders(<TasksPage />)
    expect(screen.getByRole('heading', { name: /tasks/i, level: 1 })).toBeInTheDocument()
  })

  it('shows Kanban columns: Pending, In Progress, Completed', async () => {
    renderWithProviders(<TasksPage />)
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /pending/i })).toBeInTheDocument()
    })
    expect(screen.getByRole('heading', { name: /in progress/i })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /completed/i })).toBeInTheDocument()
  })

  it('fetches tasks from dedicated /api/tasks endpoint per team', async () => {
    renderWithProviders(<TasksPage />)
    await waitFor(() => {
      expect(screen.getByText('Fix login bug')).toBeInTheDocument()
    })
    // Tasks from team-2 should also appear
    expect(screen.getByText('Deploy service')).toBeInTheDocument()
  })

  it('each task card shows subject, owner, team', async () => {
    renderWithProviders(<TasksPage />)
    await waitFor(() => {
      expect(screen.getByText('Fix login bug')).toBeInTheDocument()
    })
    expect(screen.getByText('Add caching')).toBeInTheDocument()
    expect(screen.getByText('Update docs')).toBeInTheDocument()
    // Owner and team shown on cards
    expect(screen.getAllByText(/agent-1/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Alpha/).length).toBeGreaterThan(0)
  })

  it('shows "Unassigned" when owner is null', async () => {
    renderWithProviders(<TasksPage />)
    await waitFor(() => {
      expect(screen.getByText('Deploy service')).toBeInTheDocument()
    })
    expect(screen.getByText(/Unassigned/)).toBeInTheDocument()
  })

  it('shows tasks from multiple teams with correct team names', async () => {
    renderWithProviders(<TasksPage />)
    await waitFor(() => {
      expect(screen.getByText('Deploy service')).toBeInTheDocument()
    })
    expect(screen.getAllByText(/Beta/).length).toBeGreaterThan(0)
  })

  it('shows loading state', () => {
    server.use(
      http.get(`${BROKER_URL}/api/teams`, () => new Promise(() => {})),
    )
    renderWithProviders(<TasksPage />)
    expect(screen.getByText(/loading/i)).toBeInTheDocument()
  })

  it('shows empty state when no tasks', async () => {
    server.use(
      http.get(`${BROKER_URL}/api/teams`, () =>
        HttpResponse.json({ teams: [{ id: 'team-empty', name: 'Empty', status: 'active' }] }),
      ),
      http.get(`${BROKER_URL}/api/tasks`, () =>
        HttpResponse.json({ tasks: [] }),
      ),
    )
    renderWithProviders(<TasksPage />)
    await waitFor(() => {
      expect(screen.getByText(/no tasks/i)).toBeInTheDocument()
    })
  })

  it('column headers use h2 elements', async () => {
    renderWithProviders(<TasksPage />)
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /pending/i })).toBeInTheDocument()
    })
    const pendingH2 = screen.getByRole('heading', { name: /pending/i })
    const inProgressH2 = screen.getByRole('heading', { name: /in progress/i })
    const completedH2 = screen.getByRole('heading', { name: /completed/i })
    expect(pendingH2.tagName).toBe('H2')
    expect(inProgressH2.tagName).toBe('H2')
    expect(completedH2.tagName).toBe('H2')
  })

  it('task cards have proper roles', async () => {
    renderWithProviders(<TasksPage />)
    await waitFor(() => {
      expect(screen.getByText('Fix login bug')).toBeInTheDocument()
    })
    const articles = screen.getAllByRole('article')
    expect(articles.length).toBeGreaterThanOrEqual(3)
  })

  it('has no axe-core violations', async () => {
    const { container } = renderWithProviders(<TasksPage />)
    await waitFor(() => {
      expect(screen.getByText('Fix login bug')).toBeInTheDocument()
    })
    const violations = await checkA11y(container)
    expect(violations).toEqual([])
  })
})
