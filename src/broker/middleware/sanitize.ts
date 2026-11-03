/**
 * Input sanitization middleware — strips prompt-injection patterns
 * from all string values in request bodies before they reach route handlers.
 */

import type { Request, Response, NextFunction } from 'express'
import { sanitizeExternalText } from '../../shared/sanitize.js'

function sanitizeDeep(value: unknown): unknown {
  if (typeof value === 'string') {
    return sanitizeExternalText(value)
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeDeep)
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      result[k] = sanitizeDeep(v)
    }
    return result
  }
  return value
}

export function createSanitizeMiddleware(): (
  req: Request,
  res: Response,
  next: NextFunction,
) => void {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (req.body && typeof req.body === 'object') {
      req.body = sanitizeDeep(req.body)
    }
    next()
  }
}
