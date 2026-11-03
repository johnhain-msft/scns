import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SSEManager } from '../../../src/broker/sse-manager.js'
import type { EventDispatcher, TypedEvent } from '../../../src/broker/event-dispatcher.js'

vi.mock('../../../src/shared/logger.js', () => {
  const mock = { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn(), child: vi.fn() }
  mock.child.mockReturnValue(mock)
  return { logger: mock }
})

function mockResponse(): {
  write: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
  writableEnded: boolean
} {
  return { write: vi.fn(), end: vi.fn(), writableEnded: false }
}

describe('SSEManager', () => {
  let manager: SSEManager

  beforeEach(() => {
    vi.useFakeTimers()
    manager = new SSEManager({
      maxConnectionsPerClient: 2,
      heartbeatIntervalMs: 1000,
      inactiveTimeoutMs: 5000,
    })
  })

  afterEach(() => {
    manager.stop()
    vi.useRealTimers()
  })

  describe('addConnection', () => {
    it('tracks a connection and returns true', () => {
      const res = mockResponse()
      expect(manager.addConnection('127.0.0.1', res as any)).toBe(true)
      expect(manager.getStats().total).toBe(1)
    })

    it('rejects when per-client limit exceeded and returns false', () => {
      const res1 = mockResponse()
      const res2 = mockResponse()
      const res3 = mockResponse()
      manager.addConnection('127.0.0.1', res1 as any)
      manager.addConnection('127.0.0.1', res2 as any)
      expect(manager.addConnection('127.0.0.1', res3 as any)).toBe(false)
      expect(manager.getStats().total).toBe(2)
    })
  })

  describe('removeConnection', () => {
    it('removes a tracked connection', () => {
      const res = mockResponse()
      manager.addConnection('127.0.0.1', res as any)
      expect(manager.getStats().total).toBe(1)
      manager.removeConnection('127.0.0.1', res as any)
      expect(manager.getStats().total).toBe(0)
    })

    it('unsubscribes from dispatcher on remove', () => {
      const res = mockResponse()
      const unsub = vi.fn()
      const dispatcher: EventDispatcher = {
        dispatch: vi.fn(),
        subscribe: vi.fn().mockReturnValue(unsub),
        subscriberCount: vi.fn().mockReturnValue(0),
      }
      manager.addConnection('127.0.0.1', res as any)
      manager.subscribeConnection(res as any, dispatcher)
      manager.removeConnection('127.0.0.1', res as any)
      expect(unsub).toHaveBeenCalled()
    })

    it('is a no-op for unknown client', () => {
      const res = mockResponse()
      expect(() => manager.removeConnection('unknown', res as any)).not.toThrow()
    })
  })

  describe('touchConnection', () => {
    it('updates last activity timestamp', () => {
      const res = mockResponse()
      manager.addConnection('127.0.0.1', res as any)
      vi.advanceTimersByTime(2000)
      manager.touchConnection('127.0.0.1', res as any)
      // Advance past original timeout but not past touched time
      vi.advanceTimersByTime(4000)
      // Connection should still be alive since we touched it 4s ago (timeout=5s)
      manager.cleanupInactive()
      expect(manager.getStats().total).toBe(1)
    })
  })

  describe('getStats', () => {
    it('returns correct total and by-client counts', () => {
      const res1 = mockResponse()
      const res2 = mockResponse()
      const res3 = mockResponse()
      manager.addConnection('10.0.0.1', res1 as any)
      manager.addConnection('10.0.0.2', res2 as any)
      manager.addConnection('10.0.0.2', res3 as any)

      const stats = manager.getStats()
      expect(stats.total).toBe(3)
      expect(stats.byClient).toEqual({ '10.0.0.1': 1, '10.0.0.2': 2 })
    })

    it('returns zero when no connections', () => {
      const stats = manager.getStats()
      expect(stats.total).toBe(0)
      expect(stats.byClient).toEqual({})
    })
  })

  describe('sendHeartbeat', () => {
    it('writes heartbeat comment to all connections', () => {
      const res1 = mockResponse()
      const res2 = mockResponse()
      manager.addConnection('10.0.0.1', res1 as any)
      manager.addConnection('10.0.0.2', res2 as any)

      manager.sendHeartbeat()

      expect(res1.write).toHaveBeenCalledWith(':heartbeat\n\n')
      expect(res2.write).toHaveBeenCalledWith(':heartbeat\n\n')
    })

    it('skips connections with writableEnded', () => {
      const res = mockResponse()
      res.writableEnded = true
      manager.addConnection('127.0.0.1', res as any)

      manager.sendHeartbeat()
      expect(res.write).not.toHaveBeenCalled()
    })
  })

  describe('subscribeConnection', () => {
    it('subscribes to dispatcher and pushes events as SSE data', () => {
      const res = mockResponse()
      let capturedHandler: ((event: TypedEvent) => void) | undefined

      const dispatcher: EventDispatcher = {
        dispatch: vi.fn(),
        subscribe: vi.fn().mockImplementation((_filter, handler) => {
          capturedHandler = handler
          return vi.fn()
        }),
        subscriberCount: vi.fn().mockReturnValue(0),
      }

      manager.addConnection('127.0.0.1', res as any)
      manager.subscribeConnection(res as any, dispatcher)

      expect(dispatcher.subscribe).toHaveBeenCalled()

      const event: TypedEvent = {
        id: 1,
        event_type: 'session.registered',
        session_id: 'sess-1',
        payload: JSON.stringify({ foo: 'bar' }),
        created_at: '2024-01-01T00:00:00Z',
      }
      capturedHandler!(event)

      expect(res.write).toHaveBeenCalledWith(expect.stringContaining('data: '))
      const written = res.write.mock.calls[0]![0] as string
      const parsed = JSON.parse(written.replace('data: ', '').trim())
      expect(parsed.id).toBe(1)
      expect(parsed.type).toBe('session.registered')
      expect(parsed.payload).toEqual({ foo: 'bar' })
    })
  })

  describe('closeAll', () => {
    it('ends all connections with retry hint', () => {
      const res1 = mockResponse()
      const res2 = mockResponse()
      manager.addConnection('10.0.0.1', res1 as any)
      manager.addConnection('10.0.0.2', res2 as any)

      manager.closeAll(5000)

      expect(res1.write).toHaveBeenCalledWith('retry: 5000\n\n')
      expect(res1.end).toHaveBeenCalled()
      expect(res2.write).toHaveBeenCalledWith('retry: 5000\n\n')
      expect(res2.end).toHaveBeenCalled()
      expect(manager.getStats().total).toBe(0)
    })
  })

  describe('start / stop', () => {
    it('start begins heartbeat and cleanup intervals', () => {
      const res = mockResponse()
      manager.addConnection('127.0.0.1', res as any)

      manager.start()
      vi.advanceTimersByTime(1000)

      expect(res.write).toHaveBeenCalledWith(':heartbeat\n\n')
    })

    it('stop clears intervals', () => {
      const res = mockResponse()
      manager.addConnection('127.0.0.1', res as any)

      manager.start()
      manager.stop()

      // Advance past interval — no heartbeat should fire
      vi.advanceTimersByTime(5000)
      expect(res.write).not.toHaveBeenCalled()
    })

    it('start is idempotent (calling twice does not double intervals)', () => {
      const res = mockResponse()
      manager.addConnection('127.0.0.1', res as any)

      manager.start()
      manager.start() // second call should clear previous intervals
      vi.advanceTimersByTime(1000)

      // Should get exactly one heartbeat, not two
      expect(res.write).toHaveBeenCalledTimes(1)
    })
  })

  describe('cleanupInactive', () => {
    it('removes timed-out connections', () => {
      const res = mockResponse()
      manager.addConnection('127.0.0.1', res as any)

      // Advance past inactiveTimeout (5000ms)
      vi.advanceTimersByTime(6000)
      manager.cleanupInactive()

      expect(res.end).toHaveBeenCalled()
      expect(manager.getStats().total).toBe(0)
    })

    it('keeps active connections', () => {
      const res = mockResponse()
      manager.addConnection('127.0.0.1', res as any)

      vi.advanceTimersByTime(2000)
      manager.cleanupInactive()

      expect(res.end).not.toHaveBeenCalled()
      expect(manager.getStats().total).toBe(1)
    })
  })
})
