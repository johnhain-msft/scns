import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ConflictCard } from '../conflict-card'

// Mock Radix UI components with simple HTML equivalents
vi.mock('@radix-ui/themes', () => ({
  Card: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="card" className={className}>{children}</div>
  ),
  Flex: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Text: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <span className={className}>{children}</span>
  ),
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}))

describe('ConflictCard', () => {
  it('renders the file path', () => {
    render(
      <ConflictCard
        filePath="/src/index.ts"
        sessions={[{ session_id: 'abcd1234-5678', purpose: 'editing' }]}
      />
    )

    expect(screen.getByText('/src/index.ts')).toBeInTheDocument()
  })

  it('displays the session count badge', () => {
    render(
      <ConflictCard
        filePath="/src/index.ts"
        sessions={[
          { session_id: 'abcd1234-5678', purpose: 'editing' },
          { session_id: 'efgh5678-1234', purpose: 'refactoring' },
        ]}
      />
    )

    expect(screen.getByText('2 sessions')).toBeInTheDocument()
  })

  it('shows truncated session IDs', () => {
    render(
      <ConflictCard
        filePath="/src/index.ts"
        sessions={[{ session_id: 'abcdefgh-1234-5678', purpose: 'editing' }]}
      />
    )

    expect(screen.getByText('abcdefgh')).toBeInTheDocument()
  })

  it('shows session purpose', () => {
    render(
      <ConflictCard
        filePath="/src/index.ts"
        sessions={[{ session_id: 'abcd1234-5678', purpose: 'implementing feature X' }]}
      />
    )

    expect(screen.getByText(/implementing feature X/)).toBeInTheDocument()
  })

  it('shows fallback when purpose is empty', () => {
    render(
      <ConflictCard
        filePath="/src/index.ts"
        sessions={[{ session_id: 'abcd1234-5678', purpose: '' }]}
      />
    )

    expect(screen.getByText(/No purpose specified/)).toBeInTheDocument()
  })

  it('renders multiple sessions', () => {
    render(
      <ConflictCard
        filePath="/src/index.ts"
        sessions={[
          { session_id: 'aaaaaaaa-1111', purpose: 'editing' },
          { session_id: 'bbbbbbbb-2222', purpose: 'reviewing' },
          { session_id: 'cccccccc-3333', purpose: 'testing' },
        ]}
      />
    )

    expect(screen.getByText('aaaaaaaa')).toBeInTheDocument()
    expect(screen.getByText('bbbbbbbb')).toBeInTheDocument()
    expect(screen.getByText('cccccccc')).toBeInTheDocument()
    expect(screen.getByText('3 sessions')).toBeInTheDocument()
  })
})
