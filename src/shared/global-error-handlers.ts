import { logger } from './logger.js'

export interface GlobalErrorHandlerOptions {
  readonly onShutdown?: () => Promise<void>
}

const SHUTDOWN_TIMEOUT_MS = 5_000

export function registerGlobalErrorHandlers(options?: GlobalErrorHandlerOptions): void {
  let shutdownInProgress = false

  const handleFatal = async (origin: string, err: unknown) => {
    logger.fatal({ err }, origin)

    if (shutdownInProgress) return
    shutdownInProgress = true

    if (options?.onShutdown) {
      try {
        await Promise.race([
          options.onShutdown(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Shutdown timed out')), SHUTDOWN_TIMEOUT_MS),
          ),
        ])
      } catch (timeoutErr) {
        logger.error({ err: timeoutErr }, 'Shutdown callback failed or timed out')
      }
    }

    process.exitCode = 1
  }

  process.on('uncaughtException', (err) => {
    void handleFatal('Uncaught exception', err)
  })

  process.on('unhandledRejection', (reason) => {
    void handleFatal(
      'Unhandled rejection',
      reason instanceof Error ? reason : new Error(String(reason)),
    )
  })
}
