import { describe, it, expect, vi } from 'vitest'
import type { Request, Response, NextFunction } from 'express'
import { createAuthMiddleware } from '../../../../src/broker/middleware/auth.js'

function mockReqRes(path = '/api/test', authHeader?: string) {
  const req = {
    path,
    headers: authHeader ? { authorization: authHeader } : {},
  } as unknown as Request
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response
  const next = vi.fn() as NextFunction
  return { req, res, next }
}

describe('createAuthMiddleware', () => {
  it('no token configured → all requests pass', () => {
    const mw = createAuthMiddleware(null)
    const { req, res, next } = mockReqRes()

    mw(req, res, next)

    expect(next).toHaveBeenCalled()
    expect(res.status).not.toHaveBeenCalled()
  })

  it('valid bearer token → passes', () => {
    const mw = createAuthMiddleware('secret-123')
    const { req, res, next } = mockReqRes('/api/test', 'Bearer secret-123')

    mw(req, res, next)

    expect(next).toHaveBeenCalled()
    expect(res.status).not.toHaveBeenCalled()
  })

  it('invalid token → 401', () => {
    const mw = createAuthMiddleware('secret-123')
    const { req, res, next } = mockReqRes('/api/test', 'Bearer wrong-token')

    mw(req, res, next)

    expect(res.status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('missing token header → 401', () => {
    const mw = createAuthMiddleware('secret-123')
    const { req, res, next } = mockReqRes('/api/test')

    mw(req, res, next)

    expect(res.status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('health endpoint is exempt', () => {
    const mw = createAuthMiddleware('secret-123')

    const { req: req1, res: res1, next: next1 } = mockReqRes('/health')
    mw(req1, res1, next1)
    expect(next1).toHaveBeenCalled()

    const { req: req2, res: res2, next: next2 } = mockReqRes('/health/live')
    mw(req2, res2, next2)
    expect(next2).toHaveBeenCalled()

    const { req: req3, res: res3, next: next3 } = mockReqRes('/health/ready')
    mw(req3, res3, next3)
    expect(next3).toHaveBeenCalled()
  })
})
