/**
 * Rate-limiting middleware for the session broker REST API.
 *
 * Three tiers of protection:
 *   1. **globalLimiter** – 100 req/s per IP across all routes
 *   2. **writeLimiter**  – 30 req/min per IP for POST/PATCH/DELETE
 *   3. **searchLimiter** – 10 req/min per IP for search endpoints
 *
 * Health (`/health/*`) and MCP (`/mcp`) endpoints are exempt from
 * all limiters — health checks must never be throttled and MCP has
 * its own session management.
 *
 * All limiters use the standard `RateLimit-*` headers (RFC draft)
 * instead of the legacy `X-RateLimit-*` headers.
 */

import rateLimit, { type Options } from 'express-rate-limit'
import type { Request, Response, RequestHandler } from 'express'

// ---------------------------------------------------------------------------
// Shared skip predicate – exempt health & MCP
// ---------------------------------------------------------------------------

function isExempt(req: Request): boolean {
  return (
    req.path === '/health' ||
    req.path.startsWith('/health/') ||
    req.path === '/mcp' ||
    req.path.startsWith('/mcp/')
  )
}

// ---------------------------------------------------------------------------
// Factory helpers (accept partial overrides for testing)
// ---------------------------------------------------------------------------

/** Overridable options exposed to callers (primarily for tests). */
export interface RateLimiterOverrides {
  readonly windowMs?: number
  readonly max?: number
}

/**
 * Creates the global rate limiter.
 *
 * Default: 100 requests per second per IP.
 */
export function createGlobalLimiter(
  overrides: RateLimiterOverrides = {},
): RequestHandler {
  const opts: Partial<Options> = {
    windowMs: overrides.windowMs ?? 1_000,
    max: overrides.max ?? 100,
    standardHeaders: true,
    legacyHeaders: false,
    skip: isExempt,
    handler: (_req: Request, res: Response): void => {
      res.status(429).json({
        success: false,
        error: { code: 'RATE_LIMITED', message: 'Too many requests' },
      })
    },
  }

  return rateLimit(opts)
}

/**
 * Creates the write-endpoint rate limiter.
 *
 * Default: 30 requests per minute per IP.
 * Intended for POST, PATCH, and DELETE routes.
 */
export function createWriteLimiter(
  overrides: RateLimiterOverrides = {},
): RequestHandler {
  const opts: Partial<Options> = {
    windowMs: overrides.windowMs ?? 60_000,
    max: overrides.max ?? 30,
    standardHeaders: true,
    legacyHeaders: false,
    skip: isExempt,
    handler: (_req: Request, res: Response): void => {
      res.status(429).json({
        success: false,
        error: { code: 'RATE_LIMITED', message: 'Too many write requests' },
      })
    },
  }

  return rateLimit(opts)
}

/**
 * Creates the search-endpoint rate limiter.
 *
 * Default: 10 requests per minute per IP.
 * Intended for semantic search routes (`/api/search_sessions`, etc.).
 */
export function createSearchLimiter(
  overrides: RateLimiterOverrides = {},
): RequestHandler {
  const opts: Partial<Options> = {
    windowMs: overrides.windowMs ?? 60_000,
    max: overrides.max ?? 10,
    standardHeaders: true,
    legacyHeaders: false,
    skip: isExempt,
    handler: (_req: Request, res: Response): void => {
      res.status(429).json({
        success: false,
        error: { code: 'RATE_LIMITED', message: 'Too many search requests' },
      })
    },
  }

  return rateLimit(opts)
}
