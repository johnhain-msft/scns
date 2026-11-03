import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MessageTimeline } from '../message-timeline'
import type { Message } from '@/lib/api'

// Mock Radix UI components
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

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    sender_id: 'sender01-abcd',
    receiver_id: 'recv0001-efgh',
    content: 'Hello there',
    story_id: null,
    read_at: null,
    created_at: '2026-02-09T10:30:00Z',
    ...overrides,
  }
}

describe('MessageTimeline', () => {
  it('shows empty state when no messages', () => {
    render(<MessageTimeline messages={[]} />)

    expect(
      screen.getByText(/No messages yet/)
    ).toBeInTheDocument()
  })

  it('renders a message with sender and receiver IDs', () => {
    render(<MessageTimeline messages={[makeMessage()]} />)

    expect(screen.getByText('sender01')).toBeInTheDocument()
    expect(screen.getByText('recv0001')).toBeInTheDocument()
  })

  it('renders message content', () => {
    render(
      <MessageTimeline
        messages={[makeMessage({ content: 'Task completed successfully' })]}
      />
    )

    expect(screen.getByText('Task completed successfully')).toBeInTheDocument()
  })

  it('shows "broadcast" badge when receiver_id is null', () => {
    render(
      <MessageTimeline
        messages={[makeMessage({ receiver_id: null })]}
      />
    )

    expect(screen.getByText('broadcast')).toBeInTheDocument()
  })

  it('shows "read" badge when read_at is set', () => {
    render(
      <MessageTimeline
        messages={[makeMessage({ read_at: '2026-02-09T10:31:00Z' })]}
      />
    )

    expect(screen.getByText('read')).toBeInTheDocument()
  })

  it('does not show "read" badge when read_at is null', () => {
    render(
      <MessageTimeline
        messages={[makeMessage({ read_at: null })]}
      />
    )

    expect(screen.queryByText('read')).not.toBeInTheDocument()
  })

  it('renders multiple messages', () => {
    const messages = [
      makeMessage({ id: 'msg-1', content: 'First message' }),
      makeMessage({ id: 'msg-2', content: 'Second message' }),
    ]

    render(<MessageTimeline messages={messages} />)

    expect(screen.getByText('First message')).toBeInTheDocument()
    expect(screen.getByText('Second message')).toBeInTheDocument()
  })
})
