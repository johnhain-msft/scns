import { describe, it, expect, vi } from 'vitest'
import type { Request, Response, NextFunction } from 'express'
import {
  createGlobalLimiter,
  createSessionWriteLimiter,
  createActiveRequestCounter,
} from '../../../../src/broker/middleware/rate-limiter.js'
import { EventEmitter } from 'node:events'

function mockReqRes(path = '/api/test', ip = '127.0.0.1') {
  const req = { path, ip } as unknown as Request
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
  } as unknown as Response
  const next = vi.fn() as NextFunction
  return { req, res, next }
}

function mockWriteReq(opts: {
  path?: string
  method?: string
  sessionId?: string
  headerSessionId?: string
  body?: Record<string, unknown>
}) {
  const req = {
    path: opts.path ?? '/api/declare_intent',
    method: opts.method ?? 'POST',
    headers: opts.headerSessionId ? { 'x-session-id': opts.headerSessionId } : {},
    body: opts.body ?? (opts.sessionId ? { session_id: opts.sessionId } : {}),
    ip: '127.0.0.1',
  } as unknown as Request
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
  } as unknown as Response
  const next = vi.fn() as NextFunction
  return { req, res, next }
}

describe('createGlobalLimiter', () => {
  it('under limit → passes', () => {
    const limiter = createGlobalLimiter({ windowMs: 60_000, max: 5 })
    const { req, res, next } = mockReqRes()

    limiter(req, res, next)

    expect(next).toHaveBeenCalled()
    expect(res.status).not.toHaveBeenCalled()
  })

  it('over limit → 429', () => {
    const limiter = createGlobalLimiter({ windowMs: 60_000, max: 2 })

    // Use up the limit
    for (let i = 0; i < 2; i++) {
      const { req, res, next } = mockReqRes()
      limiter(req, res, next)
    }

    // This should be rate limited
    const { req, res, next } = mockReqRes()
    limiter(req, res, next)

    expect(res.status).toHaveBeenCalledWith(429)
    expect(next).not.toHaveBeenCalled()
  })

  it('health endpoint exempt', () => {
    const limiter = createGlobalLimiter({ windowMs: 60_000, max: 1 })

    // Use up the limit on a regular endpoint
    const { req: r1, res: res1, next: n1 } = mockReqRes('/api/test')
    limiter(r1, res1, n1)

    // Health should still pass
    const { req: r2, res: res2, next: n2 } = mockReqRes('/health')
    limiter(r2, res2, n2)
    expect(n2).toHaveBeenCalled()
    expect(res2.status).not.toHaveBeenCalled()
  })

  it('MCP endpoint exempt', () => {
    const limiter = createGlobalLimiter({ windowMs: 60_000, max: 1 })

    // Use up the limit
    const { req: r1, res: res1, next: n1 } = mockReqRes('/api/test')
    limiter(r1, res1, n1)

    // MCP should still pass
    const { req: r2, res: res2, next: n2 } = mockReqRes('/mcp')
    limiter(r2, res2, n2)
    expect(n2).toHaveBeenCalled()
  })

  it('different IPs have separate counters', () => {
    const limiter = createGlobalLimiter({ windowMs: 60_000, max: 1 })

    const { req: r1, res: res1, next: n1 } = mockReqRes('/api/test', '10.0.0.1')
    limiter(r1, res1, n1)
    expect(n1).toHaveBeenCalled()

    const { req: r2, res: res2, next: n2 } = mockReqRes('/api/test', '10.0.0.2')
    limiter(r2, res2, n2)
    expect(n2).toHaveBeenCalled()
  })
})

describe('createSessionWriteLimiter', () => {
  it('allows writes under limit', () => {
    const limiter = createSessionWriteLimiter({ windowMs: 60_000, max: 3 })
    for (let i = 0; i < 3; i++) {
      const { req, res, next } = mockWriteReq({ sessionId: 'sess-1' })
      limiter(req, res, next)
      expect(next).toHaveBeenCalled()
      expect(res.status).not.toHaveBeenCalled()
    }
  })

  it('blocks writes over the per-session limit with 429 + Retry-After', () => {
    const limiter = createSessionWriteLimiter({ windowMs: 60_000, max: 2 })
    for (let i = 0; i < 2; i++) {
      const { req, res, next } = mockWriteReq({ sessionId: 'sess-2' })
      limiter(req, res, next)
      expect(next).toHaveBeenCalled()
    }
    const { req, res, next } = mockWriteReq({ sessionId: 'sess-2' })
    limiter(req, res, next)
    expect(res.status).toHaveBeenCalledWith(429)
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(String))
    expect(next).not.toHaveBeenCalled()
  })

  it('keys per-session (different session IDs do not share buckets)', () => {
    const limiter = createSessionWriteLimiter({ windowMs: 60_000, max: 1 })
    const a = mockWriteReq({ sessionId: 'sess-A' })
    limiter(a.req, a.res, a.next)
    expect(a.next).toHaveBeenCalled()

    const b = mockWriteReq({ sessionId: 'sess-B' })
    limiter(b.req, b.res, b.next)
    expect(b.next).toHaveBeenCalled()

    const a2 = mockWriteReq({ sessionId: 'sess-A' })
    limiter(a2.req, a2.res, a2.next)
    expect(a2.res.status).toHaveBeenCalledWith(429)
  })

  it('skips non-write methods (GET never rate-limited)', () => {
    const limiter = createSessionWriteLimiter({ windowMs: 60_000, max: 1 })
    for (let i = 0; i < 10; i++) {
      const { req, res, next } = mockWriteReq({ method: 'GET', sessionId: 'sess-3' })
      limiter(req, res, next)
      expect(next).toHaveBeenCalled()
    }
  })

  it('exempts /api/admin/*, /api/hooks/*, /api/events/*, /api/telemetry', () => {
    const limiter = createSessionWriteLimiter({ windowMs: 60_000, max: 1 })
    for (const path of [
      '/api/admin/drain',
      '/api/hooks/session-start',
      '/api/events/since/0',
      '/api/telemetry',
    ]) {
      for (let i = 0; i < 5; i++) {
        const { req, res, next } = mockWriteReq({ path, sessionId: 'sess-4' })
        limiter(req, res, next)
        expect(next).toHaveBeenCalled()
      }
    }
  })

  it('bypasses limiter when no session ID can be extracted', () => {
    const limiter = createSessionWriteLimiter({ windowMs: 60_000, max: 1 })
    for (let i = 0; i < 5; i++) {
      const { req, res, next } = mockWriteReq({ body: { foo: 'bar' } })
      limiter(req, res, next)
      expect(next).toHaveBeenCalled()
    }
  })

  it('accepts sessionId from x-session-id header', () => {
    const limiter = createSessionWriteLimiter({ windowMs: 60_000, max: 1 })
    const a = mockWriteReq({ headerSessionId: 'sess-H', body: {} })
    limiter(a.req, a.res, a.next)
    expect(a.next).toHaveBeenCalled()

    const b = mockWriteReq({ headerSessionId: 'sess-H', body: {} })
    limiter(b.req, b.res, b.next)
    expect(b.res.status).toHaveBeenCalledWith(429)
  })

  it('accepts sender_id as a session identifier', () => {
    const limiter = createSessionWriteLimiter({ windowMs: 60_000, max: 1 })
    const a = mockWriteReq({ body: { sender_id: 'agent-1' } })
    limiter(a.req, a.res, a.next)
    expect(a.next).toHaveBeenCalled()
    const b = mockWriteReq({ body: { sender_id: 'agent-1' } })
    limiter(b.req, b.res, b.next)
    expect(b.res.status).toHaveBeenCalledWith(429)
  })
})

describe('createActiveRequestCounter', () => {
  function makeReqRes(path = '/api/test') {
    const req = { path } as unknown as Request
    const res = new EventEmitter() as unknown as Response
    const next = vi.fn() as NextFunction
    return { req, res, next }
  }

  it('starts at zero', () => {
    const counter = createActiveRequestCounter()
    expect(counter.count()).toBe(0)
  })

  it('increments on request, decrements on response finish', () => {
    const counter = createActiveRequestCounter()
    const { req, res, next } = makeReqRes('/api/list_sessions')
    counter.middleware(req, res, next)
    expect(counter.count()).toBe(1)
    ;(res as unknown as EventEmitter).emit('finish')
    expect(counter.count()).toBe(0)
  })

  it('decrements on close if finish never fires', () => {
    const counter = createActiveRequestCounter()
    const { req, res, next } = makeReqRes('/api/list_sessions')
    counter.middleware(req, res, next)
    expect(counter.count()).toBe(1)
    ;(res as unknown as EventEmitter).emit('close')
    expect(counter.count()).toBe(0)
  })

  it('only decrements once when both finish and close fire', () => {
    const counter = createActiveRequestCounter()
    const { req, res, next } = makeReqRes('/api/list_sessions')
    counter.middleware(req, res, next)
    ;(res as unknown as EventEmitter).emit('finish')
    ;(res as unknown as EventEmitter).emit('close')
    expect(counter.count()).toBe(0)
  })

  it('does not count /health or /api/admin/* requests', () => {
    const counter = createActiveRequestCounter()
    const { req: r1, res: res1, next: n1 } = makeReqRes('/health/ready')
    counter.middleware(r1, res1, n1)
    const { req: r2, res: res2, next: n2 } = makeReqRes('/api/admin/health')
    counter.middleware(r2, res2, n2)
    expect(counter.count()).toBe(0)
    expect(n1).toHaveBeenCalled()
    expect(n2).toHaveBeenCalled()
  })

  it('tracks multiple concurrent requests', () => {
    const counter = createActiveRequestCounter()
    const r1 = makeReqRes()
    const r2 = makeReqRes()
    const r3 = makeReqRes()
    counter.middleware(r1.req, r1.res, r1.next)
    counter.middleware(r2.req, r2.res, r2.next)
    counter.middleware(r3.req, r3.res, r3.next)
    expect(counter.count()).toBe(3)
    ;(r2.res as unknown as EventEmitter).emit('finish')
    expect(counter.count()).toBe(2)
  })
})
