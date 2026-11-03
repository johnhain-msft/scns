import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import CapabilitiesPage from '../page'

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
}))

vi.mock('@/lib/sse-client', () => ({ useSSE: vi.fn() }))

const mockListSessions = vi.fn()
const mockGetSessionCapabilities = vi.fn()
vi.mock('@/lib/api', () => ({
  listSessions: (...args: unknown[]) => mockListSessions(...args),
  getSessionCapabilities: (...args: unknown[]) => mockGetSessionCapabilities(...args),
}))

beforeEach(() => {
  mockListSessions.mockReset()
  mockGetSessionCapabilities.mockReset()
})

describe('CapabilitiesPage', () => {
  it('renders page heading', async () => {
    mockListSessions.mockResolvedValueOnce([])
    render(<CapabilitiesPage />)
    expect(screen.getByText('Capabilities')).toBeInTheDocument()
  })

  it('shows empty state when no sessions', async () => {
    mockListSessions.mockResolvedValueOnce([])
    render(<CapabilitiesPage />)
    await waitFor(() => {
      expect(screen.getByText(/No active sessions/)).toBeInTheDocument()
    })
  })

  it('shows capability matrix for sessions', async () => {
    mockListSessions.mockResolvedValueOnce([
      { id: 's-1', purpose: 'dev work', status: 'active', working_dir: '/tmp', worktree: null, last_heartbeat: new Date().toISOString(), created_at: new Date().toISOString(), team: null },
    ])
    mockGetSessionCapabilities.mockResolvedValueOnce(['typescript', 'testing'])

    render(<CapabilitiesPage />)

    await waitFor(() => {
      expect(screen.getAllByText('typescript').length).toBeGreaterThanOrEqual(1)
      expect(screen.getAllByText('testing').length).toBeGreaterThanOrEqual(1)
    })
  })
})
