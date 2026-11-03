import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import CostPage from '../page'

vi.mock('@radix-ui/themes', () => ({
  Heading: ({ children }: { children: React.ReactNode }) => <h1>{children}</h1>,
  Text: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <span className={className}>{children}</span>
  ),
  Card: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
  Flex: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Grid: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Button: ({ children, onClick, disabled }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean }) => (
    <button onClick={onClick} disabled={disabled}>{children}</button>
  ),
  Select: {
    Root: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Trigger: ({ placeholder }: { placeholder?: string }) => <button>{placeholder}</button>,
    Content: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Item: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  },
  Table: {
    Root: ({ children }: { children: React.ReactNode }) => <table>{children}</table>,
    Header: ({ children }: { children: React.ReactNode }) => <thead>{children}</thead>,
    Body: ({ children }: { children: React.ReactNode }) => <tbody>{children}</tbody>,
    Row: ({ children }: { children: React.ReactNode }) => <tr>{children}</tr>,
    ColumnHeaderCell: ({ children }: { children: React.ReactNode }) => <th>{children}</th>,
    Cell: ({ children }: { children: React.ReactNode }) => <td>{children}</td>,
  },
}))

vi.mock('@/lib/sse-client', () => ({ useSSE: vi.fn() }))

const mockListTeams = vi.fn()
const mockGetTeamBudget = vi.fn()
vi.mock('@/lib/api', () => ({
  listTeams: (...args: unknown[]) => mockListTeams(...args),
  getTeamBudget: (...args: unknown[]) => mockGetTeamBudget(...args),
}))

beforeEach(() => {
  mockListTeams.mockReset()
  mockGetTeamBudget.mockReset()
})

describe('CostPage', () => {
  it('renders page heading', async () => {
    mockListTeams.mockResolvedValueOnce([])
    render(<CostPage />)
    expect(screen.getByText('Cost Tracking')).toBeInTheDocument()
  })

  it('shows empty state when no teams', async () => {
    mockListTeams.mockResolvedValueOnce([])
    render(<CostPage />)
    await waitFor(() => {
      expect(screen.getByText(/No active teams/)).toBeInTheDocument()
    })
  })

  it('shows cost breakdown for a team', async () => {
    mockListTeams.mockResolvedValueOnce([
      { id: 't-1', name: 'Alpha', description: '', status: 'active', created_at: new Date().toISOString() },
    ])
    mockGetTeamBudget.mockResolvedValueOnce({
      team_id: 't-1',
      total_tokens_in: 10000,
      total_tokens_out: 5000,
      total_cost_usd: 0.15,
      by_session: { 'sess-1': { tokens_in: 10000, tokens_out: 5000, cost_usd: 0.15 } },
    })

    render(<CostPage />)

    await waitFor(() => {
      expect(screen.getAllByText('$0.15').length).toBeGreaterThanOrEqual(1)
      expect(screen.getAllByText('10,000').length).toBeGreaterThanOrEqual(1)
    })
  })

  it('shows zero cost when no usage recorded', async () => {
    mockListTeams.mockResolvedValueOnce([
      { id: 't-1', name: 'Alpha', description: '', status: 'active', created_at: new Date().toISOString() },
    ])
    mockGetTeamBudget.mockResolvedValueOnce({
      team_id: 't-1', total_tokens_in: 0, total_tokens_out: 0, total_cost_usd: 0, by_session: {},
    })

    render(<CostPage />)

    await waitFor(() => {
      expect(screen.getByText('$0.00')).toBeInTheDocument()
    })
  })
})
