import type { Request, Response, NextFunction } from 'express'

/**
 * Creates Express middleware that enforces Bearer token authentication.
 *
 * - If `token` is null/undefined: all requests pass through (backwards compatible)
 * - If `token` is set: requires `Authorization: Bearer <token>` header
 * - The `/health` endpoint is always exempt from auth
 */
export function createAuthMiddleware(token: string | null): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    // No token configured — allow everything (zero-config default)
    if (!token) {
      next()
      return
    }

    // /health and all sub-paths (/health/live, /health/ready) are always public
    if (req.path === '/health' || req.path.startsWith('/health/')) {
      next()
      return
    }

    const authHeader = req.headers.authorization
    if (!authHeader || authHeader !== `Bearer ${token}`) {
      res.status(401).json({ error: 'Missing or invalid authorization token' })
      return
    }

    next()
  }
}
