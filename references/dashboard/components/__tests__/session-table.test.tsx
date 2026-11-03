import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SessionTable } from '../session-table'
import type { Session } from '@/lib/api'

// Mock Radix UI Table and other components
vi.mock('@radix-ui/themes', () => ({
  Table: {
    Root: ({ children }: { children: React.ReactNode }) => (
      <table>{children}</table>
    ),
    Header: ({ children }: { children: React.ReactNode }) => (
      <thead>{children}</thead>
    ),
    Body: ({ children }: { children: React.ReactNode }) => (
      <tbody>{children}</tbody>
    ),
    Row: ({ children }: { children: React.ReactNode }) => (
      <tr>{children}</tr>
    ),
    ColumnHeaderCell: ({ children }: { children: React.ReactNode }) => (
      <th>{children}</th>
    ),
    Cell: ({ children }: { children: React.ReactNode }) => (
      <td>{children}</td>
    ),
  },
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  Text: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <span className={className}>{children}</span>
  ),
  Flex: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-abcdef123456',
    purpose: 'testing feature X',
    working_dir: '/home/user/project',
    worktree: null,
    status: 'active',
    last_heartbeat: new Date().toISOString(),
    created_at: new Date().toISOString(),
    team: null,
    ...overrides,
  }
}

describe('SessionTable', () => {
  it('shows empty state when no sessions', () => {
    render(<SessionTable sessions={[]} />)

    expect(
      screen.getByText(/No active sessions/)
    ).toBeInTheDocument()
  })

  it('renders table headers', () => {
    render(<SessionTable sessions={[makeSession()]} />)

    expect(screen.getByText('Session ID')).toBeInTheDocument()
    expect(screen.getByText('Purpose')).toBeInTheDocument()
    expect(screen.getByText('Status')).toBeInTheDocument()
    expect(screen.getByText('Heartbeat')).toBeInTheDocument()
    expect(screen.getByText('Last Heartbeat')).toBeInTheDocument()
  })

  it('renders truncated session ID', () => {
    render(<SessionTable sessions={[makeSession({ id: 'abcdefghijklmnop' })]} />)

    expect(screen.getByText('abcdefghijkl...')).toBeInTheDocument()
  })

  it('renders session purpose', () => {
    render(
      <SessionTable
        sessions={[makeSession({ purpose: 'implementing auth' })]}
      />
    )

    expect(screen.getByText('implementing auth')).toBeInTheDocument()
  })

  it('renders session status badge', () => {
    render(
      <SessionTable
        sessions={[makeSession({ status: 'active' })]}
      />
    )

    expect(screen.getByText('active')).toBeInTheDocument()
  })

  it('renders multiple sessions', () => {
    const sessions = [
      makeSession({ id: 'session-aaaa1111bbbb', purpose: 'editing' }),
      makeSession({ id: 'session-cccc2222dddd', purpose: 'reviewing' }),
    ]

    render(<SessionTable sessions={sessions} />)

    expect(screen.getByText('editing')).toBeInTheDocument()
    expect(screen.getByText('reviewing')).toBeInTheDocument()
  })

  it('shows dash when purpose is empty', () => {
    render(
      <SessionTable
        sessions={[makeSession({ purpose: '' })]}
      />
    )

    // The component renders "—" (em dash) for empty purpose
    const cells = screen.getAllByText('—')
    expect(cells.length).toBeGreaterThanOrEqual(1)
  })
})
