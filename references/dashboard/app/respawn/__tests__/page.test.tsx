import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import RespawnPage from '../page'

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
const mockGetRespawnPolicies = vi.fn()
const mockGetRespawnHistory = vi.fn()
vi.mock('@/lib/api', () => ({
  listTeams: (...args: unknown[]) => mockListTeams(...args),
  getRespawnPolicies: (...args: unknown[]) => mockGetRespawnPolicies(...args),
  getRespawnHistory: (...args: unknown[]) => mockGetRespawnHistory(...args),
}))

beforeEach(() => {
  mockListTeams.mockReset()
  mockGetRespawnPolicies.mockReset()
  mockGetRespawnHistory.mockReset()
})

describe('RespawnPage', () => {
  it('renders page heading', async () => {
    mockListTeams.mockResolvedValueOnce([])
    render(<RespawnPage />)
    expect(screen.getByText('Respawn')).toBeInTheDocument()
  })

  it('shows empty state when no teams', async () => {
    mockListTeams.mockResolvedValueOnce([])
    render(<RespawnPage />)
    await waitFor(() => {
      expect(screen.getByText(/No active teams/)).toBeInTheDocument()
    })
  })

  it('shows respawn policies and history', async () => {
    mockListTeams.mockResolvedValueOnce([
      { id: 't-1', name: 'Alpha', description: '', status: 'active', created_at: new Date().toISOString() },
    ])
    mockGetRespawnPolicies.mockResolvedValueOnce({
      team_id: 't-1',
      policies: [
        { team_id: 't-1', role: 'dev', min_count: 1, max_retries: 3, backoff_base_ms: 5000, enabled: true, created_at: '', updated_at: '' },
      ],
    })
    mockGetRespawnHistory.mockResolvedValueOnce({
      team_id: 't-1',
      history: [
        { id: 1, team_id: 't-1', role: 'dev', session_id: 's-1', status: 'spawned', attempt: 1, error: null, created_at: new Date().toISOString() },
      ],
    })

    render(<RespawnPage />)

    await waitFor(() => {
      expect(screen.getAllByText('dev').length).toBeGreaterThanOrEqual(1)
      expect(screen.getByText('spawned')).toBeInTheDocument()
    })
  })

  it('shows no history message when team has no respawn events', async () => {
    mockListTeams.mockResolvedValueOnce([
      { id: 't-1', name: 'Alpha', description: '', status: 'active', created_at: new Date().toISOString() },
    ])
    mockGetRespawnPolicies.mockResolvedValueOnce({ team_id: 't-1', policies: [] })
    mockGetRespawnHistory.mockResolvedValueOnce({ team_id: 't-1', history: [] })

    render(<RespawnPage />)

    await waitFor(() => {
      expect(screen.getByText(/No respawn history/)).toBeInTheDocument()
    })
  })
})
