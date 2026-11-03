import { describe, it, expect, vi } from 'vitest'
import {
  createRestartManager,
  type RestartManagerDeps,
} from '../../../src/broker/restart-manager.js'

function makeDeps(overrides: Partial<RestartManagerDeps> = {}): RestartManagerDeps {
  return {
    dreamDaemon: {
      triggerRun: vi.fn().mockResolvedValue({
        success: true,
        skipped: false,
        consolidation: { entriesProcessed: 5, entriesKept: 5 },
        durationMs: 100,
      }),
    },
    runHousekeeping: vi.fn().mockReturnValue({
      success: true,
      otelSpansPruned: 10,
      otelMetricsPruned: 20,
      eventsPruned: 5,
      taskRunHistoryPruned: 0,
      messagesHistoryPruned: 0,
      vacuumed: false,
      walTruncated: true,
      walFramesCheckpointed: 42,
      durationMs: 50,
    }),
    ...overrides,
  }
}

describe('createRestartManager', () => {
  describe('prepareForRestart', () => {
    it('runs dream consolidation and housekeeping', async () => {
      const deps = makeDeps()
      const mgr = createRestartManager(deps)

      const result = await mgr.prepareForRestart()

      expect(result.success).toBe(true)
      expect(deps.dreamDaemon!.triggerRun).toHaveBeenCalledWith(true)
      expect(deps.runHousekeeping).toHaveBeenCalled()
      expect(result.dreamResult).not.toBeNull()
      expect(result.housekeepingResult).not.toBeNull()
      expect(result.durationMs).toBeGreaterThanOrEqual(0)
    })

    it('succeeds with dream-only when no housekeeping function', async () => {
      const deps = makeDeps({ runHousekeeping: undefined })
      const mgr = createRestartManager(deps)

      const result = await mgr.prepareForRestart()

      expect(result.success).toBe(true)
      expect(result.dreamResult).not.toBeNull()
      expect(result.housekeepingResult).toBeNull()
    })

    it('succeeds when no dream daemon available', async () => {
      const deps = makeDeps({ dreamDaemon: undefined })
      const mgr = createRestartManager(deps)

      const result = await mgr.prepareForRestart()

      expect(result.success).toBe(true)
      expect(result.dreamResult).toBeNull()
      expect(result.housekeepingResult).not.toBeNull()
    })

    it('succeeds when both deps are missing', async () => {
      const mgr = createRestartManager({})

      const result = await mgr.prepareForRestart()

      expect(result.success).toBe(true)
      expect(result.dreamResult).toBeNull()
      expect(result.housekeepingResult).toBeNull()
    })

    it('handles dream failure gracefully', async () => {
      const deps = makeDeps({
        dreamDaemon: {
          triggerRun: vi.fn().mockRejectedValue(new Error('dream exploded')),
        },
      })
      const mgr = createRestartManager(deps)

      const result = await mgr.prepareForRestart()

      expect(result.success).toBe(false)
      expect(result.error).toContain('dream exploded')
      // Housekeeping should still run
      expect(deps.runHousekeeping).toHaveBeenCalled()
    })

    it('handles housekeeping failure gracefully', async () => {
      const deps = makeDeps({
        runHousekeeping: vi.fn().mockImplementation(() => {
          throw new Error('housekeeping broke')
        }),
      })
      const mgr = createRestartManager(deps)

      const result = await mgr.prepareForRestart()

      // Dream succeeded, housekeeping failed — partial success
      expect(result.success).toBe(true)
      expect(result.dreamResult).not.toBeNull()
      expect(result.housekeepingResult).toBeNull()
    })

    it('passes vacuum:false to housekeeping', async () => {
      const deps = makeDeps()
      const mgr = createRestartManager(deps)

      await mgr.prepareForRestart()

      expect(deps.runHousekeeping).toHaveBeenCalledWith(
        expect.objectContaining({ vacuum: false }),
      )
    })
  })

  describe('drain mode', () => {
    it('starts not draining', () => {
      const mgr = createRestartManager({})
      expect(mgr.isDraining()).toBe(false)
    })

    it('enters drain mode', () => {
      const mgr = createRestartManager({})
      mgr.enterDrainMode()
      expect(mgr.isDraining()).toBe(true)
    })

    it('enterDrainMode is idempotent', () => {
      const mgr = createRestartManager({})
      mgr.enterDrainMode()
      mgr.enterDrainMode()
      expect(mgr.isDraining()).toBe(true)
    })
  })

  describe('getHealth', () => {
    it('returns health status with uptime', () => {
      const mgr = createRestartManager({})
      const health = mgr.getHealth()

      expect(health.status).toBe('ok')
      expect(health.draining).toBe(false)
      expect(health.uptimeSeconds).toBeGreaterThanOrEqual(0)
      expect(health.startedAt).toBeDefined()
      expect(health.hasDreamDaemon).toBe(false)
      expect(health.hasHousekeeping).toBe(false)
      expect(health.activeRequestCount).toBe(0)
    })

    it('reflects dep availability', () => {
      const deps = makeDeps()
      const mgr = createRestartManager(deps)
      const health = mgr.getHealth()

      expect(health.hasDreamDaemon).toBe(true)
      expect(health.hasHousekeeping).toBe(true)
    })

    it('shows draining status', () => {
      const mgr = createRestartManager({})
      mgr.enterDrainMode()
      const health = mgr.getHealth()

      expect(health.status).toBe('draining')
      expect(health.draining).toBe(true)
    })

    it('surfaces activeRequestCount from dep', () => {
      let count = 7
      const mgr = createRestartManager({ getActiveRequestCount: () => count })
      expect(mgr.getHealth().activeRequestCount).toBe(7)
      count = 0
      expect(mgr.getHealth().activeRequestCount).toBe(0)
    })
  })

  describe('requestRollback', () => {
    it('returns failure when no handler is configured', async () => {
      const mgr = createRestartManager({})
      const result = await mgr.requestRollback('no reason')
      expect(result.success).toBe(false)
      expect(result.triggered).toBe(false)
      expect(result.error).toContain('No rollback handler')
    })

    it('invokes onRollback with reason', async () => {
      const onRollback = vi.fn().mockResolvedValue(undefined)
      const mgr = createRestartManager({ onRollback })
      const result = await mgr.requestRollback('green failed health check')
      expect(result.success).toBe(true)
      expect(result.triggered).toBe(true)
      expect(onRollback).toHaveBeenCalledWith('green failed health check')
    })

    it('returns error when handler throws', async () => {
      const onRollback = vi.fn().mockRejectedValue(new Error('launchctl missing'))
      const mgr = createRestartManager({ onRollback })
      const result = await mgr.requestRollback()
      expect(result.success).toBe(false)
      expect(result.triggered).toBe(true)
      expect(result.error).toContain('launchctl missing')
    })
  })
})
