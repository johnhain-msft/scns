/**
 * Express middleware for Zod-based request validation.
 *
 * Three helpers validate different parts of an incoming request:
 *   - validateBody   → req.body  → req.validatedBody
 *   - validateQuery  → req.query → req.validatedQuery
 *   - validateParams → req.params → req.validatedParams
 *
 * On failure they throw a ValidationError (from errors.ts) which
 * the error-handler middleware already knows how to serialize.
 */

import type { Request, Response, NextFunction } from 'express'
import { type ZodError, type ZodSchema } from 'zod'
import { ValidationError } from '../errors.js'

// ── Public types ──────────────────────────────────────────────────────────

/** Extended request with parsed body attached by validateBody. */
export interface ValidatedBodyRequest<T> extends Request {
  validatedBody: T
}

/** Extended request with parsed query attached by validateQuery. */
export interface ValidatedQueryRequest<T> extends Request {
  validatedQuery: T
}

/** Extended request with parsed params attached by validateParams. */
export interface ValidatedParamsRequest<T> extends Request {
  validatedParams: T
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Convert a ZodError into a flat Record mapping
 * dot-joined field paths → human-readable messages.
 */
export function zodFieldErrors(error: ZodError): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const issue of error.issues) {
    const path = issue.path.join('.')
    fields[path || '_root'] = issue.message
  }
  return fields
}

// ── Middleware factories ──────────────────────────────────────────────────

/**
 * Validate `req.body` against a Zod schema.
 * Parsed (and stripped) data is attached as `req.validatedBody`.
 */
export function validateBody<T>(
  schema: ZodSchema<T>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body)
    if (!result.success) {
      throw new ValidationError(
        'Invalid request body',
        zodFieldErrors(result.error),
      )
    }
    ;(req as Request & { validatedBody: T }).validatedBody = result.data
    next()
  }
}

/**
 * Validate `req.query` against a Zod schema.
 * Parsed data is attached as `req.validatedQuery`.
 */
export function validateQuery<T>(
  schema: ZodSchema<T>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.query)
    if (!result.success) {
      throw new ValidationError(
        'Invalid query parameters',
        zodFieldErrors(result.error),
      )
    }
    ;(req as Request & { validatedQuery: T }).validatedQuery = result.data
    next()
  }
}

/**
 * Validate `req.params` against a Zod schema.
 * Parsed data is attached as `req.validatedParams`.
 */
export function validateParams<T>(
  schema: ZodSchema<T>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.params)
    if (!result.success) {
      throw new ValidationError(
        'Invalid path parameters',
        zodFieldErrors(result.error),
      )
    }
    ;(req as Request & { validatedParams: T }).validatedParams = result.data
    next()
  }
}
