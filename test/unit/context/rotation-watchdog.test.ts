import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createWatchdogDaemon } from '../../../src/context/rotation-watchdog.js'
import type {
  RotationController,
  RotationResult,
} from '../../../src/context/rotation-controller.js'

// ── Helpers ────────────────────────────────────────────────────────────────

function makeFakeController(overrides: Partial<RotationController> = {}): RotationController {
  return {
    rotateSession: vi.fn().mockResolvedValue({
      sourceSessionId: 'sess-1',
      targetSessionId: 'sess-2',
      handoffId: 'h-1',
      success: true,
      durationMs: 100,
    } satisfies RotationResult),
    startWatchdog: vi.fn(),
    stopWatchdog: vi.fn(),
    isWatchdogRunning: vi.fn().mockReturnValue(false),
    tick: vi.fn().mockResolvedValue([] as readonly RotationResult[]),
    getActiveRotations: vi.fn().mockReturnValue([]),
    getRotationHistory: vi.fn().mockReturnValue([]),
    getStats: vi.fn().mockReturnValue({
      totalRotations: 0,
      successfulRotations: 0,
      failedRotations: 0,
      activeRotations: 0,
      averageDurationMs: 0,
      watchdogRunning: false,
      lastWatchdogTick: null,
    }),
    ...overrides,
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('createWatchdogDaemon', () => {
  let controller: RotationController

  beforeEach(() => {
    vi.useFakeTimers()
    controller = makeFakeController()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('creates a daemon with default interval', () => {
    const daemon = createWatchdogDaemon(controller)
    expect(daemon).toBeDefined()
    expect(daemon.isRunning()).toBe(false)
  })

  it('start begins the interval loop', () => {
    const daemon = createWatchdogDaemon(controller)
    daemon.start()
    expect(daemon.isRunning()).toBe(true)
  })

  it('stop ends the interval loop', () => {
    const daemon = createWatchdogDaemon(controller)
    daemon.start()
    daemon.stop()
    expect(daemon.isRunning()).toBe(false)
  })

  it('isRunning reflects state correctly', () => {
    const daemon = createWatchdogDaemon(controller)
    expect(daemon.isRunning()).toBe(false)
    daemon.start()
    expect(daemon.isRunning()).toBe(true)
    daemon.stop()
    expect(daemon.isRunning()).toBe(false)
  })

  it('forceCheck delegates to controller.tick', async () => {
    const mockResults: readonly RotationResult[] = [
      {
        sourceSessionId: 's1',
        targetSessionId: 's2',
        handoffId: 'h1',
        success: true,
        durationMs: 50,
      },
    ]
    ;(controller.tick as ReturnType<typeof vi.fn>).mockResolvedValue(mockResults)

    const daemon = createWatchdogDaemon(controller)
    const results = await daemon.forceCheck()

    expect(controller.tick).toHaveBeenCalled()
    expect(results).toBe(mockResults)
  })

  it('lastCheckAt is null initially', () => {
    const daemon = createWatchdogDaemon(controller)
    expect(daemon.getLastCheckAt()).toBeNull()
  })

  it('lastCheckAt updated after forceCheck', async () => {
    const daemon = createWatchdogDaemon(controller)
    await daemon.forceCheck()
    expect(daemon.getLastCheckAt()).not.toBeNull()
  })

  it('checkCount starts at zero', () => {
    const daemon = createWatchdogDaemon(controller)
    expect(daemon.getCheckCount()).toBe(0)
  })

  it('checkCount incremented after forceCheck', async () => {
    const daemon = createWatchdogDaemon(controller)
    await daemon.forceCheck()
    expect(daemon.getCheckCount()).toBe(1)
    await daemon.forceCheck()
    expect(daemon.getCheckCount()).toBe(2)
  })

  it('interval fires tick periodically', async () => {
    const daemon = createWatchdogDaemon(controller, { intervalMs: 1000 })
    daemon.start()

    // Advance time by 3.5 seconds — should fire ~3 ticks
    await vi.advanceTimersByTimeAsync(3500)

    expect(controller.tick).toHaveBeenCalledTimes(3)
    expect(daemon.getCheckCount()).toBe(3)

    daemon.stop()
  })

  it('start is idempotent', () => {
    const daemon = createWatchdogDaemon(controller, { intervalMs: 1000 })
    daemon.start()
    daemon.start()
    expect(daemon.isRunning()).toBe(true)

    // Advance — should only tick at normal rate, not double
    vi.advanceTimersByTime(1500)
    daemon.stop()
  })

  it('accepts custom intervalMs', () => {
    const daemon = createWatchdogDaemon(controller, { intervalMs: 5000 })
    expect(daemon).toBeDefined()
  })
})
