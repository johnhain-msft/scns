import { describe, it, expect, vi, _beforeEach, afterEach } from 'vitest'
import { ShutdownManager, shutdownMiddleware } from '../../../src/broker/shutdown.js'

vi.mock('../../../src/shared/logger.js', () => {
  const mock = { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn(), child: vi.fn() }
  mock.child.mockReturnValue(mock)
  return { logger: mock }
})

describe('ShutdownManager', () => {
  let manager: ShutdownManager

  beforeEach(() => {
    vi.useFakeTimers()
    manager = new ShutdownManager({ drainTimeoutMs: 500 })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shuttingDown is false initially', () => {
    expect(manager.shuttingDown).toBe(false)
  })

  it('register adds cleanup functions', async () => {
    const fn = vi.fn().mockResolvedValue(undefined)
    manager.register('test-cleanup', fn)

    const p = manager.shutdown()
    await vi.advanceTimersByTimeAsync(0)
    await p

    expect(fn).toHaveBeenCalled()
  })

  it('shutdown runs cleanups in registration order', async () => {
    const order: string[] = []
    manager.register('first', async () => {
      order.push('first')
    })
    manager.register('second', async () => {
      order.push('second')
    })
    manager.register('third', async () => {
      order.push('third')
    })

    const p = manager.shutdown()
    await vi.advanceTimersByTimeAsync(0)
    await p

    expect(order).toEqual(['first', 'second', 'third'])
  })

  it('shutdown is idempotent — second call returns same promise', () => {
    manager.register('noop', async () => {})
    const p1 = manager.shutdown()
    const p2 = manager.shutdown()
    expect(p1).toBe(p2)
  })

  it('shuttingDown is true after shutdown begins', () => {
    manager.register('slow', async () => {
      await new Promise((r) => setTimeout(r, 1000))
    })
    void manager.shutdown()
    expect(manager.shuttingDown).toBe(true)
  })

  it('cleanup errors do not stop other cleanups', async () => {
    const order: string[] = []
    manager.register('will-fail', async () => {
      throw new Error('boom')
    })
    manager.register('will-succeed', async () => {
      order.push('succeeded')
    })

    const p = manager.shutdown()
    await vi.advanceTimersByTimeAsync(0)
    await p

    expect(order).toEqual(['succeeded'])
  })

  it('drain timeout forces completion', async () => {
    manager.register('stuck', async () => {
      // This cleanup never resolves (within the test)
      await new Promise((r) => setTimeout(r, 60_000))
    })

    const p = manager.shutdown()
    // Advance past drain timeout (500ms)
    await vi.advanceTimersByTimeAsync(600)
    await p
    // Shutdown completes despite stuck cleanup
    expect(manager.shuttingDown).toBe(true)
  })
})

describe('shutdownMiddleware', () => {
  it('returns 503 during shutdown', () => {
    const manager = new ShutdownManager()
    void manager.shutdown()

    const middleware = shutdownMiddleware(manager)
    const req = { path: '/api/sessions' } as any
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any
    const next = vi.fn()

    middleware(req, res, next)

    expect(res.status).toHaveBeenCalledWith(503)
    expect(res.json).toHaveBeenCalledWith({ error: 'Server is shutting down' })
    expect(next).not.toHaveBeenCalled()
  })

  it('allows health endpoint during shutdown', () => {
    const manager = new ShutdownManager()
    void manager.shutdown()

    const middleware = shutdownMiddleware(manager)
    const req = { path: '/health' } as any
    const res = {} as any
    const next = vi.fn()

    middleware(req, res, next)
    expect(next).toHaveBeenCalled()
  })

  it('allows health sub-paths during shutdown', () => {
    const manager = new ShutdownManager()
    void manager.shutdown()

    const middleware = shutdownMiddleware(manager)
    const req = { path: '/health/ready' } as any
    const res = {} as any
    const next = vi.fn()

    middleware(req, res, next)
    expect(next).toHaveBeenCalled()
  })

  it('passes through when not shutting down', () => {
    const manager = new ShutdownManager()
    const middleware = shutdownMiddleware(manager)

    const req = { path: '/api/sessions' } as any
    const res = {} as any
    const next = vi.fn()

    middleware(req, res, next)
    expect(next).toHaveBeenCalled()
  })
})
