import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// We capture the handlers registered via process.on so we can invoke them directly
// without actually triggering uncaughtException in the test runner.

describe('global-error-handlers', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handlers = new Map<string, (...args: any[]) => void>()
  let processOnSpy: ReturnType<typeof vi.spyOn>
  let loggerFatalSpy: ReturnType<typeof vi.fn>
  let loggerErrorSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    handlers.clear()
    processOnSpy = vi.spyOn(process, 'on').mockImplementation((event, handler) => {
      if (event === 'uncaughtException' || event === 'unhandledRejection') {
        handlers.set(event as string, handler as (...args: unknown[]) => void)
      }
      return process
    })

    loggerFatalSpy = vi.fn()
    loggerErrorSpy = vi.fn()

    vi.doMock('../../../src/shared/logger.js', () => ({
      logger: {
        fatal: loggerFatalSpy,
        error: loggerErrorSpy,
      },
    }))
  })

  afterEach(() => {
    processOnSpy.mockRestore()
    vi.restoreAllMocks()
    vi.resetModules()
  })

  async function loadAndRegister(options?: { onShutdown?: () => Promise<void> }) {
    const mod = await import('../../../src/shared/global-error-handlers.js')
    mod.registerGlobalErrorHandlers(options)
  }

  it('registers uncaughtException and unhandledRejection handlers', async () => {
    await loadAndRegister()

    expect(handlers.has('uncaughtException')).toBe(true)
    expect(handlers.has('unhandledRejection')).toBe(true)
  })

  it('logs fatal on uncaught exception', async () => {
    await loadAndRegister()

    const error = new Error('boom')
    const handler = handlers.get('uncaughtException')!
    handler(error)

    // Allow microtask to settle
    await vi.waitFor(() => {
      expect(loggerFatalSpy).toHaveBeenCalledWith({ err: error }, 'Uncaught exception')
    })
  })

  it('logs fatal on unhandled rejection', async () => {
    await loadAndRegister()

    const error = new Error('rejected')
    const handler = handlers.get('unhandledRejection')!
    handler(error)

    await vi.waitFor(() => {
      expect(loggerFatalSpy).toHaveBeenCalledWith({ err: error }, 'Unhandled rejection')
    })
  })

  it('wraps non-Error rejection reasons in an Error', async () => {
    await loadAndRegister()

    const handler = handlers.get('unhandledRejection')!
    handler('string reason')

    await vi.waitFor(() => {
      expect(loggerFatalSpy).toHaveBeenCalledWith(
        { err: expect.objectContaining({ message: 'string reason' }) },
        'Unhandled rejection',
      )
    })
  })

  it('calls onShutdown callback', async () => {
    const onShutdown = vi.fn().mockResolvedValue(undefined)
    await loadAndRegister({ onShutdown })

    const handler = handlers.get('uncaughtException')!
    handler(new Error('boom'))

    await vi.waitFor(() => {
      expect(onShutdown).toHaveBeenCalledOnce()
    })
  })

  it('sets process.exitCode to 1', async () => {
    const originalExitCode = process.exitCode
    await loadAndRegister()

    const handler = handlers.get('uncaughtException')!
    handler(new Error('boom'))

    await vi.waitFor(() => {
      expect(process.exitCode).toBe(1)
    })

    // Restore
    process.exitCode = originalExitCode
  })

  it('only shuts down once when both handlers fire', async () => {
    const onShutdown = vi.fn().mockResolvedValue(undefined)
    await loadAndRegister({ onShutdown })

    const uncaughtHandler = handlers.get('uncaughtException')!
    const rejectionHandler = handlers.get('unhandledRejection')!

    uncaughtHandler(new Error('exception'))
    rejectionHandler(new Error('rejection'))

    // Give both handlers time to run
    await new Promise((r) => setTimeout(r, 50))

    // Both should log fatal, but onShutdown called only once
    expect(loggerFatalSpy).toHaveBeenCalledTimes(2)
    expect(onShutdown).toHaveBeenCalledOnce()
  })

  it('does not hang on slow shutdown (timeout after 5s)', async () => {
    vi.useFakeTimers()

    const onShutdown = vi.fn().mockImplementation(
      () =>
        new Promise(() => {
          /* never resolves */
        }),
    )
    await loadAndRegister({ onShutdown })

    const handler = handlers.get('uncaughtException')!
    handler(new Error('boom'))

    // Advance past the 5s timeout
    await vi.advanceTimersByTimeAsync(5_100)

    expect(onShutdown).toHaveBeenCalledOnce()
    expect(loggerErrorSpy).toHaveBeenCalledWith(
      { err: expect.objectContaining({ message: 'Shutdown timed out' }) },
      'Shutdown callback failed or timed out',
    )

    vi.useRealTimers()
  })
})
