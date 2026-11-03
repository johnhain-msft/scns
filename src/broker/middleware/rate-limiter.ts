/**
 * Simple in-memory rate limiter for the session broker REST API.
 *
 * Health (`/health/*`) and MCP (`/mcp`) endpoints are exempt.
 */

import type { Request, Response, NextFunction } from 'express'

export interface RateLimiterOptions {
  readonly windowMs?: number
  readonly max?: number
}

interface BucketEntry {
  count: number
  resetAt: number
}

function isExempt(req: Request): boolean {
  return (
    req.path === '/health' ||
    req.path.startsWith('/health/') ||
    req.path === '/mcp' ||
    req.path.startsWith('/mcp/')
  )
}

/**
 * Creates an in-memory rate limiter middleware.
 * Default: 100 requests per second per IP.
 */
export function createGlobalLimiter(
  options: RateLimiterOptions = {},
): (req: Request, res: Response, next: NextFunction) => void {
  const windowMs = options.windowMs ?? 1_000
  const max = options.max ?? 100
  const buckets = new Map<string, BucketEntry>()

  return (req: Request, res: Response, next: NextFunction): void => {
    if (isExempt(req)) {
      next()
      return
    }

    const key = req.ip ?? '0.0.0.0'
    const now = Date.now()
    let entry = buckets.get(key)

    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs }
      buckets.set(key, entry)
    }

    entry.count++

    if (entry.count > max) {
      res.status(429).json({
        success: false,
        error: { code: 'RATE_LIMITED', message: 'Too many requests' },
      })
      return
    }

    next()
  }
}

// ---------------------------------------------------------------------------
// Per-session write rate limiter
// ---------------------------------------------------------------------------

const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE'])

/** Paths that should NOT be session-rate-limited even if they are writes. */
function isWriteLimiterExempt(req: Request): boolean {
  const p = req.path
  return (
    p === '/health' ||
    p.startsWith('/health/') ||
    p === '/mcp' ||
    p.startsWith('/mcp/') ||
    p.startsWith('/api/admin/') ||
    p.startsWith('/api/hooks/') ||
    p.startsWith('/api/events/') ||
    p === '/api/telemetry'
  )
}

function extractSessionId(req: Request): string | null {
  const header = req.headers['x-session-id']
  if (typeof header === 'string' && header.length > 0) return header
  const body = req.body as Record<string, unknown> | undefined
  if (body && typeof body === 'object') {
    for (const key of ['session_id', 'sessionId', 'sender_id']) {
      const v = body[key]
      if (typeof v === 'string' && v.length > 0) return v
    }
  }
  return null
}

/**
 * Creates a per-session write rate limiter middleware.
 * Default: 10 writes per 60s per session ID.
 * Applies only to POST/PATCH/PUT/DELETE on /api/* paths (excluding admin/hooks/events/telemetry).
 * Requests without a discoverable session ID bypass this limiter (the global limiter still applies).
 */
export function createSessionWriteLimiter(
  options: RateLimiterOptions = {},
): (req: Request, res: Response, next: NextFunction) => void {
  const windowMs = options.windowMs ?? 60_000
  const max = options.max ?? 10
  const buckets = new Map<string, BucketEntry>()

  return (req: Request, res: Response, next: NextFunction): void => {
    if (!WRITE_METHODS.has(req.method)) {
      next()
      return
    }
    if (isWriteLimiterExempt(req)) {
      next()
      return
    }
    const sessionId = extractSessionId(req)
    if (!sessionId) {
      next()
      return
    }

    const now = Date.now()
    let entry = buckets.get(sessionId)
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs }
      buckets.set(sessionId, entry)
    }
    entry.count++

    if (entry.count > max) {
      const retryAfterSec = Math.max(1, Math.ceil((entry.resetAt - now) / 1000))
      res.setHeader('Retry-After', String(retryAfterSec))
      res.status(429).json({
        success: false,
        error: {
          code: 'SESSION_RATE_LIMITED',
          message: `Too many writes for session ${sessionId} (max ${max} per ${windowMs}ms)`,
          retryAfterSeconds: retryAfterSec,
        },
      })
      return
    }
    next()
  }
}

// ---------------------------------------------------------------------------
// Active request counter
// ---------------------------------------------------------------------------

export interface ActiveRequestCounter {
  readonly middleware: (req: Request, res: Response, next: NextFunction) => void
  count(): number
}

/**
 * Creates a middleware that tracks in-flight non-health/non-admin requests.
 * Health, admin, and MCP paths do not count toward the active total so that
 * drain polling can observe "real" work draining to zero.
 */
export function createActiveRequestCounter(): ActiveRequestCounter {
  let active = 0
  return {
    count: () => active,
    middleware: (req: Request, res: Response, next: NextFunction): void => {
      if (
        req.path === '/health' ||
        req.path.startsWith('/health/') ||
        req.path.startsWith('/api/admin/')
      ) {
        next()
        return
      }
      active++
      let settled = false
      const release = () => {
        if (!settled) {
          settled = true
          active = Math.max(0, active - 1)
        }
      }
      res.on('finish', release)
      res.on('close', release)
      next()
    },
  }
}
