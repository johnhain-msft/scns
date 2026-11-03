/**
 * Custom error types for SCNS.
 */

export class ScnsError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message)
    this.name = 'ScnsError'
  }
}

export class NotImplementedError extends ScnsError {
  constructor(feature: string) {
    super(`${feature} is not yet implemented`, 'NOT_IMPLEMENTED')
    this.name = 'NotImplementedError'
  }
}

export class DatabaseError extends ScnsError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'DATABASE_ERROR')
    this.name = 'DatabaseError'
    if (options?.cause) this.cause = options.cause
  }
}

export class ValidationError extends ScnsError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR')
    this.name = 'ValidationError'
  }
}

export class NotFoundError extends ScnsError {
  constructor(resource: string, id: string) {
    super(`${resource} not found: ${id}`, 'NOT_FOUND')
    this.name = 'NotFoundError'
  }
}

export class InvalidStateError extends ScnsError {
  constructor(message: string) {
    super(message, 'INVALID_STATE')
    this.name = 'InvalidStateError'
  }
}

export class ConfigurationError extends ScnsError {
  constructor(message: string) {
    super(message, 'CONFIGURATION_ERROR')
    this.name = 'ConfigurationError'
  }
}

/**
 * Thrown when agent-spawner rejects a spawn because the global concurrent-agent
 * cap (SCNS_MAX_CONCURRENT_AGENTS) has been reached. Callers should treat this
 * as a soft / retryable condition — back off and try again later rather than
 * crashing the caller.
 */
export class AgentCapExceededError extends ScnsError {
  constructor(
    public readonly active: number,
    public readonly max: number,
  ) {
    super(
      `Agent spawn refused: ${active}/${max} concurrent agents active (cap exceeded)`,
      'AGENT_CAP_EXCEEDED',
    )
    this.name = 'AgentCapExceededError'
  }
}
