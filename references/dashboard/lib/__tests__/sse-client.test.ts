import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSSE, type BrokerEvent } from '../sse-client'

class MockEventSource {
  static instances: MockEventSource[] = []

  url: string
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  readyState = 0
  closed = false

  constructor(url: string) {
    this.url = url
    MockEventSource.instances.push(this)
  }

  close() {
    this.closed = true
    this.readyState = 2
  }

  simulateOpen() {
    this.readyState = 1
    this.onopen?.(new Event('open'))
  }

  simulateMessage(data: unknown) {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) }))
  }

  simulateError() {
    this.onerror?.(new Event('error'))
  }
}

beforeEach(() => {
  MockEventSource.instances = []
  vi.stubGlobal('EventSource', MockEventSource)
  vi.useFakeTimers()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('useSSE', () => {
  it('connects to the correct broker URL', () => {
    renderHook(() => useSSE())

    expect(MockEventSource.instances).toHaveLength(1)
    expect(MockEventSource.instances[0].url).toBe('http://localhost:3456/events')
  })

  it('calls onConnect when connection opens', () => {
    const onConnect = vi.fn()
    renderHook(() => useSSE({ onConnect }))

    const es = MockEventSource.instances[0]
    es.simulateOpen()

    expect(onConnect).toHaveBeenCalledOnce()
  })

  it('calls onEvent for broker events (not "connected" type)', () => {
    const onEvent = vi.fn()
    renderHook(() => useSSE({ onEvent }))

    const es = MockEventSource.instances[0]
    const brokerEvent: BrokerEvent = {
      id: 1,
      type: 'session_registered',
      session_id: 'sess-1',
      payload: { purpose: 'testing' },
      created_at: new Date().toISOString(),
    }
    es.simulateMessage(brokerEvent)

    expect(onEvent).toHaveBeenCalledOnce()
    expect(onEvent).toHaveBeenCalledWith(brokerEvent)
  })

  it('ignores "connected" events', () => {
    const onEvent = vi.fn()
    renderHook(() => useSSE({ onEvent }))

    const es = MockEventSource.instances[0]
    es.simulateMessage({ type: 'connected' })

    expect(onEvent).not.toHaveBeenCalled()
  })

  it('handles JSON parse errors gracefully', () => {
    const onEvent = vi.fn()
    renderHook(() => useSSE({ onEvent }))

    const es = MockEventSource.instances[0]
    // Send invalid JSON directly through onmessage
    es.onmessage?.(new MessageEvent('message', { data: 'not-json{{{' }))

    expect(onEvent).not.toHaveBeenCalled()
  })

  it('calls onError and closes on error', () => {
    const onError = vi.fn()
    renderHook(() => useSSE({ onError }))

    const es = MockEventSource.instances[0]
    es.simulateError()

    expect(onError).toHaveBeenCalledOnce()
    expect(es.closed).toBe(true)
  })

  it('reconnects after 5 seconds on error', () => {
    renderHook(() => useSSE())

    expect(MockEventSource.instances).toHaveLength(1)

    const es = MockEventSource.instances[0]
    es.simulateError()

    // Before timeout - no new connection
    expect(MockEventSource.instances).toHaveLength(1)

    // After 5s timeout - new connection
    act(() => {
      vi.advanceTimersByTime(5000)
    })

    expect(MockEventSource.instances).toHaveLength(2)
    expect(MockEventSource.instances[1].url).toBe('http://localhost:3456/events')
  })

  it('cleans up EventSource on unmount', () => {
    const { unmount } = renderHook(() => useSSE())

    const es = MockEventSource.instances[0]
    expect(es.closed).toBe(false)

    unmount()
    expect(es.closed).toBe(true)
  })

  it('clears reconnect timeout on unmount', () => {
    const { unmount } = renderHook(() => useSSE())

    const es = MockEventSource.instances[0]
    es.simulateError()

    // Unmount before reconnect fires
    unmount()

    // Advance past reconnect timeout — should NOT create new connection
    act(() => {
      vi.advanceTimersByTime(10_000)
    })

    // Only 1 instance (the original) — reconnect was cancelled
    expect(MockEventSource.instances).toHaveLength(1)
  })

  it('close() method closes and nullifies the EventSource', () => {
    const { result } = renderHook(() => useSSE())

    const es = MockEventSource.instances[0]
    expect(es.closed).toBe(false)

    act(() => {
      result.current.close()
    })

    expect(es.closed).toBe(true)
  })
})
