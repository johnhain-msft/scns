import { describe, it, expect, vi } from 'vitest'
import type { Request, Response, NextFunction } from 'express'
import { ShutdownManager, shutdownMiddleware } from '../../../src/broker/shutdown.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockReqRes(path: string, method = 'GET') {
  const req = { path, method, query: {} } as unknown as Request
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response
  const next = vi.fn() as NextFunction
  return { req, res, next }
}

// ---------------------------------------------------------------------------
// Shutdown middleware (extended with drain support)
// ---------------------------------------------------------------------------

describe('shutdownMiddleware with drain', () => {
  it('passes through normally', () => {
    const mgr = new ShutdownManager()
    const mw = shutdownMiddleware(mgr)
    const { req, res, next } = mockReqRes('/api/list_sessions')

    mw(req, res, next)

    expect(next).toHaveBeenCalled()
    expect(res.status).not.toHaveBeenCalled()
  })

  it('returns 503 when draining', () => {
    const mgr = new ShutdownManager()
    mgr.startDrain()
    const mw = shutdownMiddleware(mgr)
    const { req, res, next } = mockReqRes('/api/list_sessions')

    mw(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(503)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('draining') }),
    )
  })

  it('allows /health during drain', () => {
    const mgr = new ShutdownManager()
    mgr.startDrain()
    const mw = shutdownMiddleware(mgr)
    const { req, res, next } = mockReqRes('/health')

    mw(req, res, next)

    expect(next).toHaveBeenCalled()
  })

  it('allows /health/ready during drain', () => {
    const mgr = new ShutdownManager()
    mgr.startDrain()
    const mw = shutdownMiddleware(mgr)
    const { req, res, next } = mockReqRes('/health/ready')

    mw(req, res, next)

    expect(next).toHaveBeenCalled()
  })

  it('allows /api/admin/health during drain', () => {
    const mgr = new ShutdownManager()
    mgr.startDrain()
    const mw = shutdownMiddleware(mgr)
    const { req, res, next } = mockReqRes('/api/admin/health')

    mw(req, res, next)

    expect(next).toHaveBeenCalled()
  })

  it('returns shutdown error (not drain) when shutting down', async () => {
    const mgr = new ShutdownManager({ drainTimeoutMs: 100 })
    // Start shutdown (which also sets drain implicitly)
    const shutdownPromise = mgr.shutdown()
    const mw = shutdownMiddleware(mgr)
    const { req, res, next } = mockReqRes('/api/list_sessions')

    mw(req, res, next)

    expect(res.status).toHaveBeenCalledWith(503)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('shutting down') }),
    )

    await shutdownPromise
  })
})

// ---------------------------------------------------------------------------
// ShutdownManager drain state
// ---------------------------------------------------------------------------

describe('ShutdownManager drain state', () => {
  it('starts not draining', () => {
    const mgr = new ShutdownManager()
    expect(mgr.draining).toBe(false)
  })

  it('startDrain sets draining', () => {
    const mgr = new ShutdownManager()
    mgr.startDrain()
    expect(mgr.draining).toBe(true)
    expect(mgr.shuttingDown).toBe(false)
  })

  it('shutdown implies draining', async () => {
    const mgr = new ShutdownManager({ drainTimeoutMs: 100 })
    const p = mgr.shutdown()
    expect(mgr.draining).toBe(true)
    expect(mgr.shuttingDown).toBe(true)
    await p
  })
})
