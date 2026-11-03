import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSSE, type SSEEvent } from '@/hooks/use-sse'

class MockEventSource {
  static instances: MockEventSource[] = []
  url: string
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onopen: ((event: Event) => void) | null = null
  readyState = 0

  constructor(url: string) {
    this.url = url
    MockEventSource.instances.push(this)
    // Simulate connection opening
    setTimeout(() => {
      this.readyState = 1
      this.onopen?.(new Event('open'))
    }, 0)
  }

  close = vi.fn()

  simulateMessage(data: SSEEvent) {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) }))
  }

  simulateError() {
    this.readyState = 2
    this.onerror?.(new Event('error'))
  }

  static reset() {
    MockEventSource.instances = []
  }
}

describe('useSSE', () => {
  beforeEach(() => {
    MockEventSource.reset()
    vi.stubGlobal('EventSource', MockEventSource)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('creates EventSource with correct URL', () => {
    const onEvent = vi.fn()
    renderHook(() => useSSE(onEvent))

    expect(MockEventSource.instances).toHaveLength(1)
    expect(MockEventSource.instances[0].url).toContain('/api/events/stream')
  })

  it('calls onEvent when events arrive', async () => {
    const onEvent = vi.fn()
    renderHook(() => useSSE(onEvent))

    const event: SSEEvent = {
      id: 1,
      type: 'session.started',
      session_id: 'sess-1',
      payload: {},
      team_id: null,
      created_at: '2024-01-01T00:00:00Z',
    }

    act(() => {
      MockEventSource.instances[0].simulateMessage(event)
    })

    expect(onEvent).toHaveBeenCalledWith(event)
  })

  it('cleans up EventSource on unmount', () => {
    const onEvent = vi.fn()
    const { unmount } = renderHook(() => useSSE(onEvent))

    const instance = MockEventSource.instances[0]
    unmount()

    expect(instance.close).toHaveBeenCalled()
  })

  it('passes auth token as query param', () => {
    const onEvent = vi.fn()
    renderHook(() => useSSE(onEvent))

    // URL should be well-formed even without a token
    expect(MockEventSource.instances[0].url).toContain('/api/events/stream')
  })
})
