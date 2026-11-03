/**
 * Structured error hierarchy for the session broker.
 *
 * All domain-specific errors extend BrokerError which carries
 * a numeric HTTP status code and a machine-readable error code.
 * The toJSON() method produces a stack-free serialization suitable
 * for API responses.
 */

// ---------------------------------------------------------------------------
// Base error
// ---------------------------------------------------------------------------

export interface BrokerErrorJSON {
  readonly code: string
  readonly message: string
  readonly [key: string]: unknown
}

export interface BrokerErrorOptions {
  readonly retryable?: boolean
  readonly retryAfterMs?: number | null
}

export class BrokerError extends Error {
  readonly statusCode: number
  readonly errorCode: string
  readonly retryable: boolean
  readonly retryAfterMs: number | null

  constructor(
    message: string,
    statusCode: number,
    errorCode: string,
    options?: BrokerErrorOptions,
  ) {
    super(message)
    this.name = 'BrokerError'
    this.statusCode = statusCode
    this.errorCode = errorCode
    this.retryable = options?.retryable ?? false
    this.retryAfterMs = options?.retryAfterMs ?? null
    // Fix prototype chain for instanceof checks with TypeScript targets < ES2022
    Object.setPrototypeOf(this, new.target.prototype)
  }

  /** Returns whether this error represents a retryable condition. */
  isRetryable(): boolean {
    return this.retryable
  }

  /** Stack-free JSON representation safe for HTTP responses. */
  toJSON(): BrokerErrorJSON {
    const json: Record<string, unknown> = {
      code: this.errorCode,
      message: this.message,
    }
    if (this.retryable) {
      json['retryable'] = true
    }
    if (this.retryAfterMs !== null) {
      json['retryAfterMs'] = this.retryAfterMs
    }
    return json as BrokerErrorJSON
  }
}

// ---------------------------------------------------------------------------
// Validation – 400
// ---------------------------------------------------------------------------

export class ValidationError extends BrokerError {
  readonly fields: Readonly<Record<string, string>>

  constructor(message: string, fields?: Record<string, string>) {
    super(message, 400, 'VALIDATION_ERROR')
    this.name = 'ValidationError'
    this.fields = Object.freeze({ ...fields })
  }

  override toJSON(): BrokerErrorJSON {
    const base = super.toJSON()
    const hasFields = Object.keys(this.fields).length > 0
    return hasFields ? { ...base, fields: this.fields } : base
  }
}

// ---------------------------------------------------------------------------
// Not found – 404
// ---------------------------------------------------------------------------

export class NotFoundError extends BrokerError {
  readonly resource: string

  constructor(resource: string, id?: string) {
    const message = id
      ? `${resource} '${id}' not found`
      : `${resource} not found`
    super(message, 404, 'NOT_FOUND')
    this.name = 'NotFoundError'
    this.resource = resource
  }
}

// ---------------------------------------------------------------------------
// Conflict – 409
// ---------------------------------------------------------------------------

export class ConflictError extends BrokerError {
  constructor(message: string) {
    super(message, 409, 'CONFLICT')
    this.name = 'ConflictError'
  }
}

// ---------------------------------------------------------------------------
// Auth – 401
// ---------------------------------------------------------------------------

export class AuthError extends BrokerError {
  constructor(message?: string) {
    super(message ?? 'Authentication required', 401, 'AUTH_ERROR')
    this.name = 'AuthError'
  }
}

// ---------------------------------------------------------------------------
// Rate limit – 429
// ---------------------------------------------------------------------------

export class RateLimitError extends BrokerError {
  readonly retryAfterSeconds: number

  constructor(retryAfterSeconds: number) {
    super(
      `Rate limit exceeded. Retry after ${retryAfterSeconds} seconds`,
      429,
      'RATE_LIMITED',
      { retryable: true, retryAfterMs: retryAfterSeconds * 1000 },
    )
    this.name = 'RateLimitError'
    this.retryAfterSeconds = retryAfterSeconds
  }

  override toJSON(): BrokerErrorJSON {
    return {
      ...super.toJSON(),
      retryAfterSeconds: this.retryAfterSeconds,
    }
  }
}

// ---------------------------------------------------------------------------
// Internal server error – 500
// ---------------------------------------------------------------------------

export class InternalError extends BrokerError {
  constructor(message?: string, retryAfterMs?: number) {
    super(
      message ?? 'Internal server error',
      500,
      'INTERNAL_ERROR',
      { retryable: true, retryAfterMs: retryAfterMs ?? 1000 },
    )
    this.name = 'InternalError'
  }
}
