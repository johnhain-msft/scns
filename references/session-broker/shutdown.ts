import type { Request, Response, NextFunction } from 'express'
import { logger } from './logger.js'

export interface ShutdownConfig {
  readonly drainTimeoutMs: number
}

const DEFAULT_CONFIG: ShutdownConfig = {
  drainTimeoutMs: 30_000,
}

export class ShutdownManager {
  private readonly config: ShutdownConfig
  private readonly cleanups: ReadonlyArray<{ readonly label: string; readonly fn: () => Promise<void> }> = []
  private isShuttingDown = false
  private shutdownPromise: Promise<void> | null = null

  constructor(config?: Partial<ShutdownConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Register a cleanup function with a label (for logging).
   * Cleanups run in registration order during shutdown.
   */
  register(label: string, cleanup: () => Promise<void>): void {
    // Use mutable cast internally, expose readonly externally
    ;(this.cleanups as Array<{ label: string; fn: () => Promise<void> }>).push({
      label,
      fn: cleanup,
    })
  }

  /** Whether the server is currently shutting down. */
  get shuttingDown(): boolean {
    return this.isShuttingDown
  }

  /**
   * Execute all registered cleanup functions sequentially with a drain timeout.
   * Idempotent — calling twice returns the same promise.
   */
  async shutdown(): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise
    }

    this.isShuttingDown = true
    this.shutdownPromise = this.executeShutdown()
    return this.shutdownPromise
  }

  private async executeShutdown(): Promise<void> {
    const { drainTimeoutMs } = this.config
    const cleanupCount = this.cleanups.length

    logger.info({ cleanupCount }, 'Shutdown starting')
    logger.info({ drainTimeoutMs }, 'Shutdown draining — waiting for cleanups')

    const cleanupWork = this.runCleanups()

    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      setTimeout(() => { resolve('timeout') }, drainTimeoutMs)
    })

    const result = await Promise.race([
      cleanupWork.then(() => 'done' as const),
      timeoutPromise,
    ])

    if (result === 'timeout') {
      logger.warn(
        { drainTimeoutMs },
        'Shutdown drain timed out — forcing completion',
      )
    }

    logger.info({ cleanupCount }, 'Shutdown complete')
  }

  private async runCleanups(): Promise<void> {
    for (const { label, fn } of this.cleanups) {
      logger.info({ label }, 'Running cleanup')
      try {
        await fn()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.error({ label, error: message }, 'Cleanup failed')
      }
    }
  }
}

/**
 * Express middleware that returns 503 Service Unavailable when
 * the server is shutting down. Health endpoint is always exempt.
 */
export function shutdownMiddleware(manager: ShutdownManager): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Always allow health checks, even during shutdown
    if (req.path === '/health' || req.path.startsWith('/health/')) {
      next()
      return
    }

    if (manager.shuttingDown) {
      res.status(503).json({ error: 'Server is shutting down' })
      return
    }

    next()
  }
}
