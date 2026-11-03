import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import TaskBoardPage from '../page'

// Mock Radix UI
vi.mock('@radix-ui/themes', () => ({
  Heading: ({ children }: { children: React.ReactNode }) => <h1>{children}</h1>,
  Text: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <span className={className}>{children}</span>
  ),
  Card: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
  Flex: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Button: ({ children, onClick, disabled }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean }) => (
    <button onClick={onClick} disabled={disabled}>{children}</button>
  ),
  Box: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
  Select: {
    Root: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Trigger: ({ placeholder }: { placeholder?: string }) => <button>{placeholder}</button>,
    Content: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Item: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  },
}))

// Mock SSE
vi.mock('@/lib/sse-client', () => ({
  useSSE: vi.fn(),
}))

// Mock API
const mockListTeams = vi.fn()
const mockListTasks = vi.fn()
vi.mock('@/lib/api', () => ({
  listTeams: (...args: unknown[]) => mockListTeams(...args),
  listTasks: (...args: unknown[]) => mockListTasks(...args),
}))

beforeEach(() => {
  mockListTeams.mockReset()
  mockListTasks.mockReset()
})

describe('TaskBoardPage', () => {
  it('renders the page heading', async () => {
    mockListTeams.mockResolvedValueOnce([])
    render(<TaskBoardPage />)
    expect(screen.getByText('Task Board')).toBeInTheDocument()
  })

  it('shows empty state when no teams', async () => {
    mockListTeams.mockResolvedValueOnce([])
    render(<TaskBoardPage />)
    await waitFor(() => {
      expect(screen.getByText(/No active teams/)).toBeInTheDocument()
    })
  })

  it('fetches tasks for the first active team', async () => {
    const teams = [{ id: 't-1', name: 'Alpha', description: '', status: 'active', created_at: new Date().toISOString() }]
    const tasks = [
      { id: 1, team_id: 't-1', subject: 'Write tests', status: 'pending', owner: null, active_form: null, description: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { id: 2, team_id: 't-1', subject: 'Implement feature', status: 'in_progress', owner: 'dev-1', active_form: 'Implementing...', description: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      { id: 3, team_id: 't-1', subject: 'Deploy', status: 'completed', owner: 'dev-2', active_form: null, description: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    ]
    mockListTeams.mockResolvedValueOnce(teams)
    mockListTasks.mockResolvedValueOnce(tasks)

    render(<TaskBoardPage />)

    await waitFor(() => {
      expect(screen.getByText('Write tests')).toBeInTheDocument()
      expect(screen.getByText('Implement feature')).toBeInTheDocument()
      expect(screen.getByText('Deploy')).toBeInTheDocument()
    })
  })

  it('renders Kanban column headers', async () => {
    mockListTeams.mockResolvedValueOnce([{ id: 't-1', name: 'Alpha', description: '', status: 'active', created_at: new Date().toISOString() }])
    mockListTasks.mockResolvedValueOnce([])

    render(<TaskBoardPage />)

    await waitFor(() => {
      expect(screen.getByText('Pending')).toBeInTheDocument()
      expect(screen.getByText('In Progress')).toBeInTheDocument()
      expect(screen.getByText('Completed')).toBeInTheDocument()
    })
  })

  it('shows task owner as badge', async () => {
    mockListTeams.mockResolvedValueOnce([{ id: 't-1', name: 'Alpha', description: '', status: 'active', created_at: new Date().toISOString() }])
    mockListTasks.mockResolvedValueOnce([
      { id: 1, team_id: 't-1', subject: 'Task 1', status: 'in_progress', owner: 'builder', active_form: null, description: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    ])

    render(<TaskBoardPage />)

    await waitFor(() => {
      expect(screen.getByText('builder')).toBeInTheDocument()
    })
  })

  it('shows error on fetch failure', async () => {
    mockListTeams.mockRejectedValueOnce(new Error('Network fail'))

    render(<TaskBoardPage />)

    await waitFor(() => {
      expect(screen.getByText(/Network fail/)).toBeInTheDocument()
    })
  })

  it('filters out disbanded teams from selector', async () => {
    mockListTeams.mockResolvedValueOnce([
      { id: 't-1', name: 'Active Team', description: '', status: 'active', created_at: new Date().toISOString() },
      { id: 't-2', name: 'Old Team', description: '', status: 'disbanded', created_at: new Date().toISOString() },
    ])
    mockListTasks.mockResolvedValueOnce([])

    render(<TaskBoardPage />)

    await waitFor(() => {
      expect(screen.getByText('Active Team')).toBeInTheDocument()
      expect(screen.queryByText('Old Team')).not.toBeInTheDocument()
    })
  })
})
