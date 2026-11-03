import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import ScalingPage from '../page'

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
  Table: {
    Root: ({ children }: { children: React.ReactNode }) => <table>{children}</table>,
    Header: ({ children }: { children: React.ReactNode }) => <thead>{children}</thead>,
    Body: ({ children }: { children: React.ReactNode }) => <tbody>{children}</tbody>,
    Row: ({ children }: { children: React.ReactNode }) => <tr>{children}</tr>,
    ColumnHeaderCell: ({ children }: { children: React.ReactNode }) => <th>{children}</th>,
    Cell: ({ children }: { children: React.ReactNode }) => <td>{children}</td>,
  },
  Select: {
    Root: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Trigger: ({ placeholder }: { placeholder?: string }) => <button>{placeholder}</button>,
    Content: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Item: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  },
}))

vi.mock('@/lib/sse-client', () => ({ useSSE: vi.fn() }))

const mockListTeams = vi.fn()
const mockGetScalingPolicies = vi.fn()
vi.mock('@/lib/api', () => ({
  listTeams: (...args: unknown[]) => mockListTeams(...args),
  getScalingPolicies: (...args: unknown[]) => mockGetScalingPolicies(...args),
}))

beforeEach(() => {
  mockListTeams.mockReset()
  mockGetScalingPolicies.mockReset()
})

describe('ScalingPage', () => {
  it('renders page heading', async () => {
    mockListTeams.mockResolvedValueOnce([])
    render(<ScalingPage />)
    expect(screen.getByText('Scaling')).toBeInTheDocument()
  })

  it('shows empty state when no teams', async () => {
    mockListTeams.mockResolvedValueOnce([])
    render(<ScalingPage />)
    await waitFor(() => {
      expect(screen.getByText(/No active teams/)).toBeInTheDocument()
    })
  })

  it('shows scaling policies for a team', async () => {
    mockListTeams.mockResolvedValueOnce([
      { id: 't-1', name: 'Alpha', description: '', status: 'active', created_at: new Date().toISOString() },
    ])
    mockGetScalingPolicies.mockResolvedValueOnce({
      team_id: 't-1',
      policies: [
        { team_id: 't-1', role: 'dev', min_count: 1, max_count: 5, scale_up_threshold: 3, scale_down_threshold: 0, cooldown_ms: 60000, enabled: true, created_at: '', updated_at: '' },
      ],
    })

    render(<ScalingPage />)

    await waitFor(() => {
      expect(screen.getByText('dev')).toBeInTheDocument()
    })
  })

  it('shows no policies message when team has none', async () => {
    mockListTeams.mockResolvedValueOnce([
      { id: 't-1', name: 'Alpha', description: '', status: 'active', created_at: new Date().toISOString() },
    ])
    mockGetScalingPolicies.mockResolvedValueOnce({ team_id: 't-1', policies: [] })

    render(<ScalingPage />)

    await waitFor(() => {
      expect(screen.getByText(/No scaling policies/)).toBeInTheDocument()
    })
  })
})
