import type { Request, Response, NextFunction } from 'express'

/**
 * Creates Express middleware that enforces Bearer token authentication.
 *
 * - If `token` is null/undefined: all requests pass through
 * - If `token` is set: requires `Authorization: Bearer <token>` header
 * - The `/health` endpoint is always exempt from auth
 */
export function createAuthMiddleware(
  token: string | null,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!token) {
      next()
      return
    }

    if (req.path === '/health' || req.path.startsWith('/health/')) {
      next()
      return
    }

    if (req.path.startsWith('/api/hooks/')) {
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
