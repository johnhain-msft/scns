import { describe, it, expect, vi, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { EventEmitter } from 'node:events'

vi.mock('../../../src/shared/logger.js', () => {
  const child = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  }
  child.child.mockReturnValue(child)
  return {
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn().mockReturnValue(child),
    },
  }
})

import { listenWithRetry, parseListenFd, listenOnFd } from '../../../src/broker/listen-retry.js'

// ── Helpers ──────────────────────────────────────────────────

function createRealListenFn(): (port: number) => Server {
  return (port: number) => {
    const srv = createServer((_req, res) => {
      res.writeHead(200)
      res.end('ok')
    })
    srv.listen(port)
    return srv
  }
}

function createFailingListenFn(
  code: string,
  failCount: number,
): { fn: (port: number) => Server; attempts: number[] } {
  const tracker = { fn: null as unknown as (port: number) => Server, attempts: [] as number[] }
  let callCount = 0

  tracker.fn = (_port: number) => {
    callCount++
    tracker.attempts.push(callCount)

    if (callCount <= failCount) {
      const emitter = new EventEmitter() as unknown as Server
      // Simulate EADDRINUSE error
      process.nextTick(() => {
        const err: NodeJS.ErrnoException = new Error(`listen ${code}: address already in use`)
        err.code = code
        emitter.emit('error', err)
      })
      // Add close() stub
      ;(emitter as any).close = vi.fn()
      return emitter
    }

    // After failures, succeed with a real server
    const srv = createServer((_req, res) => {
      res.writeHead(200)
      res.end('ok')
    })
    srv.listen(0) // Use port 0 to avoid real conflicts
    return srv
  }

  return tracker
}

// ── Tests ────────────────────────────────────────────────────

describe('listenWithRetry', () => {
  const servers: Server[] = []

  afterEach(async () => {
    for (const srv of servers) {
      await new Promise<void>((resolve) => srv.close(() => resolve()))
    }
    servers.length = 0
  })

  it('succeeds on first attempt when port is available', async () => {
    const srv = await listenWithRetry(createRealListenFn(), 0, {
      maxRetries: 3,
      killStale: false,
    })
    servers.push(srv)

    expect(srv.listening).toBe(true)
  })

  it('retries on EADDRINUSE and succeeds after failures clear', async () => {
    const tracker = createFailingListenFn('EADDRINUSE', 2)

    const srv = await listenWithRetry(tracker.fn, 0, {
      maxRetries: 3,
      baseDelayMs: 10, // fast for tests
      killStale: false,
    })
    servers.push(srv)

    expect(srv.listening).toBe(true)
    expect(tracker.attempts).toHaveLength(3) // 2 fails + 1 success
  })

  it('throws after maxRetries exhausted', async () => {
    const tracker = createFailingListenFn('EADDRINUSE', 10) // always fails

    await expect(
      listenWithRetry(tracker.fn, 0, {
        maxRetries: 2,
        baseDelayMs: 10,
        killStale: false,
      }),
    ).rejects.toThrow('EADDRINUSE')

    // 1 initial + 2 retries = 3 attempts
    expect(tracker.attempts).toHaveLength(3)
  })

  it('does not retry on non-EADDRINUSE errors', async () => {
    const tracker = createFailingListenFn('EACCES', 1)

    await expect(
      listenWithRetry(tracker.fn, 0, {
        maxRetries: 3,
        baseDelayMs: 10,
        killStale: false,
      }),
    ).rejects.toThrow('EACCES')

    expect(tracker.attempts).toHaveLength(1) // no retries
  })

  it('uses exponential backoff between retries', async () => {
    const tracker = createFailingListenFn('EADDRINUSE', 2)
    const startTime = Date.now()

    const srv = await listenWithRetry(tracker.fn, 0, {
      maxRetries: 3,
      baseDelayMs: 50,
      killStale: false,
    })
    servers.push(srv)

    const elapsed = Date.now() - startTime
    // baseDelay * 2^0 + baseDelay * 2^1 = 50 + 100 = 150ms minimum
    expect(elapsed).toBeGreaterThanOrEqual(100) // allow some timing slack
  })

  it('closes failed server on error to free resources', async () => {
    const closeFns: ReturnType<typeof vi.fn>[] = []
    let callCount = 0

    const fn = (_port: number) => {
      callCount++
      const emitter = new EventEmitter() as unknown as Server
      const closeFn = vi.fn()
      closeFns.push(closeFn)
      ;(emitter as any).close = closeFn

      if (callCount <= 1) {
        process.nextTick(() => {
          const err: NodeJS.ErrnoException = new Error('EADDRINUSE')
          err.code = 'EADDRINUSE'
          emitter.emit('error', err)
        })
        return emitter
      }

      // Succeed on second attempt
      process.nextTick(() => emitter.emit('listening'))
      return emitter
    }

    const srv = await listenWithRetry(fn, 0, {
      maxRetries: 1,
      baseDelayMs: 10,
      killStale: false,
    })
    // Don't add to servers since it's a fake emitter
    void srv

    // First attempt's server should have been closed
    expect(closeFns[0]).toHaveBeenCalled()
  })
})

// ── parseListenFd (launchd socket activation, Phase 1) ──────────

describe('parseListenFd', () => {
  it('returns null for absent/empty/whitespace', () => {
    expect(parseListenFd(undefined)).toBeNull()
    expect(parseListenFd('')).toBeNull()
    expect(parseListenFd('   ')).toBeNull()
  })

  it('returns null for the stdio fds 0/1/2 and invalid values', () => {
    expect(parseListenFd('0')).toBeNull()
    expect(parseListenFd('1')).toBeNull()
    expect(parseListenFd('2')).toBeNull()
    expect(parseListenFd('-1')).toBeNull()
    expect(parseListenFd('abc')).toBeNull()
  })

  it('returns the fd for a real inherited socket (>= 3), trimming whitespace', () => {
    expect(parseListenFd('3')).toBe(3)
    expect(parseListenFd('4')).toBe(4)
    expect(parseListenFd(' 5 ')).toBe(5)
  })
})

// ── listenOnFd (no EADDRINUSE retry; launchd owns the socket) ───

describe('listenOnFd', () => {
  function fdListenFn(mode: 'listening' | 'error'): (h: { fd: number }) => Server {
    return () => {
      const emitter = new EventEmitter() as unknown as Server
      ;(emitter as any).close = vi.fn()
      process.nextTick(() => {
        if (mode === 'listening') {
          emitter.emit('listening')
        } else {
          const err: NodeJS.ErrnoException = new Error('listen EBADF')
          err.code = 'EBADF'
          emitter.emit('error', err)
        }
      })
      return emitter
    }
  }

  it('resolves with the server once it emits "listening" and passes { fd }', async () => {
    let seen: { fd: number } | null = null
    const srv = await listenOnFd((h) => {
      seen = h
      return fdListenFn('listening')(h)
    }, 3)
    expect(srv).toBeDefined()
    expect(seen).toEqual({ fd: 3 })
  })

  it('rejects and closes the server if it errors before listening (no retry)', async () => {
    const fn = fdListenFn('error')
    let created: Server | null = null
    await expect(
      listenOnFd((h) => {
        created = fn(h)
        return created
      }, 3),
    ).rejects.toThrow(/EBADF/)
    expect((created as any).close).toHaveBeenCalled()
  })
})
