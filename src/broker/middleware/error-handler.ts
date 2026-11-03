/**
 * Express error-handling middleware for the session broker.
 *
 * Converts thrown errors into a consistent JSON shape:
 *   { success: false, error: { code, message, fields?, retryAfterSeconds? } }
 */

import type { Request, Response, NextFunction } from 'express'
import { ZodError } from 'zod'
import { BrokerError, ValidationError, RateLimitError } from '../errors.js'

interface MinimalLogger {
  warn(obj: Record<string, unknown>, msg: string): void
  error(obj: Record<string, unknown>, msg: string): void
}

/**
 * Creates an Express error-handling middleware that logs with the
 * supplied Pino-compatible logger and returns structured JSON.
 */
export function createErrorHandler(
  log: MinimalLogger,
): (err: unknown, req: Request, res: Response, next: NextFunction) => void {
  return (err: unknown, req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      next(err)
      return
    }

    // SyntaxError from JSON body parsing
    if (err instanceof SyntaxError && 'body' in err) {
      log.warn({ statusCode: 400, path: req.path }, 'Invalid JSON in request body')
      res.status(400).json({
        error: `Invalid JSON in request body: ${err.message}`,
      })
      return
    }

    // Body-parser "entity too large" error (oversized payload)
    if (
      err !== null &&
      typeof err === 'object' &&
      (err as { type?: unknown }).type === 'entity.too.large'
    ) {
      const e = err as { limit?: number; length?: number }
      log.warn(
        { statusCode: 413, path: req.path, limit: e.limit, length: e.length },
        'Request body too large',
      )
      res.status(413).json({
        success: false,
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          message: `Request body exceeds the ${e.limit ?? 'configured'}-byte limit`,
        },
      })
      return
    }

    // ZodError → ValidationError
    if (err instanceof ZodError) {
      const fields: Record<string, string> = {}
      for (const issue of err.issues) {
        const path = issue.path.join('.')
        fields[path || '_root'] = issue.message
      }
      const wrapped = new ValidationError('Validation failed', fields)

      log.warn(
        { err, statusCode: wrapped.statusCode, errorCode: wrapped.errorCode, path: req.path },
        wrapped.message,
      )

      res.status(wrapped.statusCode).json({
        success: false,
        error: wrapped.toJSON(),
      })
      return
    }

    // Known broker errors
    if (err instanceof BrokerError) {
      log.warn(
        { statusCode: err.statusCode, errorCode: err.errorCode, path: req.path },
        err.message,
      )

      if (err instanceof RateLimitError) {
        res.setHeader('Retry-After', String(err.retryAfterSeconds))
      }

      res.status(err.statusCode).json({
        success: false,
        error: err.toJSON(),
      })
      return
    }

    // Unknown / unexpected errors
    log.error({ err, path: req.path }, 'Unhandled error')

    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
      },
    })
  }
}
