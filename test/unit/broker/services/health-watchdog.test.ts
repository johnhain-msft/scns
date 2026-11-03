import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../../src/shared/logger.js', () => {
  const child = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  }
  child.child.mockReturnValue(child)
  return {
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn().mockReturnValue(child),
    },
  }
})

import { createHealthWatchdog } from '../../../../src/broker/services/health-watchdog.js'

describe('health watchdog', () => {
  let mockDb: { prepare: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    mockDb = {
      prepare: vi.fn(() => ({
        get: vi.fn(() => ({ '1': 1 })),
      })),
    }
  })

  it('reports healthy when all checks pass', () => {
    const watchdog = createHealthWatchdog(mockDb as any)
    const checks = watchdog.check()

    expect(checks.length).toBe(3)
    expect(checks.every((c) => c.healthy)).toBe(true)
  })

  it('tracks consecutive failures', () => {
    // Make DB check fail
    mockDb.prepare.mockReturnValue({
      get: vi.fn(() => {
        throw new Error('DB unavailable')
      }),
    })

    const watchdog = createHealthWatchdog(mockDb as any)

    watchdog.check()
    expect(watchdog.getStatus().consecutiveFailures).toBe(1)

    watchdog.check()
    expect(watchdog.getStatus().consecutiveFailures).toBe(2)
  })

  it('resets failures when health is restored', () => {
    // Start unhealthy
    const failGet = vi.fn(() => {
      throw new Error('fail')
    })
    mockDb.prepare.mockReturnValue({ get: failGet })

    const watchdog = createHealthWatchdog(mockDb as any)
    watchdog.check()
    expect(watchdog.getStatus().consecutiveFailures).toBe(1)

    // Restore health
    mockDb.prepare.mockReturnValue({ get: vi.fn(() => ({ '1': 1 })) })
    watchdog.check()
    expect(watchdog.getStatus().consecutiveFailures).toBe(0)
  })

  it('calls onUnhealthy after maxConsecutiveFailures', () => {
    mockDb.prepare.mockReturnValue({
      get: vi.fn(() => {
        throw new Error('fail')
      }),
    })

    const onUnhealthy = vi.fn()
    const watchdog = createHealthWatchdog(mockDb as any, {
      maxConsecutiveFailures: 2,
      onUnhealthy,
    })

    watchdog.check() // 1st failure
    expect(onUnhealthy).not.toHaveBeenCalled()

    watchdog.check() // 2nd failure — threshold met
    expect(onUnhealthy).toHaveBeenCalledWith(2, expect.any(Array))
  })

  it('updates lastCheckAt on each check', () => {
    const watchdog = createHealthWatchdog(mockDb as any)
    expect(watchdog.getStatus().lastCheckAt).toBeNull()

    watchdog.check()
    expect(watchdog.getStatus().lastCheckAt).not.toBeNull()
  })

  it('start and stop manage the timer', () => {
    const watchdog = createHealthWatchdog(mockDb as any, { intervalMs: 100_000 })

    expect(watchdog.getStatus().running).toBe(false)
    watchdog.start()
    expect(watchdog.getStatus().running).toBe(true)
    watchdog.stop()
    expect(watchdog.getStatus().running).toBe(false)
  })

  it('memory check reports RSS value', () => {
    const watchdog = createHealthWatchdog(mockDb as any)
    const checks = watchdog.check()
    const memCheck = checks.find((c) => c.name === 'memory-rss')

    expect(memCheck).toBeDefined()
    expect(memCheck!.value).toBeGreaterThan(0)
    expect(memCheck!.unit).toBe('MB')
  })
})
