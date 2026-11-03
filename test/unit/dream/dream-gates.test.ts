import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { TestDb } from '../../helpers/db-harness.js'
import { createTestDb } from '../../helpers/db-harness.js'
import {
  initDreamState,
  getDreamState,
  incrementSessionCount,
  acquireDreamLock,
} from '../../../src/dream/dream-state.js'
import { checkDreamGates, withDreamGate } from '../../../src/dream/dream-gates.js'
import type { DreamGateConfig } from '../../../src/dream/dream-gates.js'

function createDreamTestDb(): TestDb {
  const testDb = createTestDb()
  initDreamState(testDb.db)
  return testDb
}

describe('dream-gates', () => {
  let testDb: TestDb

  beforeEach(() => {
    testDb = createDreamTestDb()
  })

  afterEach(() => {
    testDb.close()
  })

  const defaultConfig: DreamGateConfig = {
    minTimeSinceLastRunMs: 86_400_000, // 24h
    minSessionsSinceLastRun: 5,
    staleLockMs: 5 * 86_400_000,
  }

  function seedReadyState(): void {
    // Never run before (time gate passes), 5 sessions (count gate passes), no lock
    for (let i = 0; i < 5; i++) {
      incrementSessionCount(testDb.db)
    }
  }

  describe('checkDreamGates', () => {
    it('all gates pass: canRun = true', () => {
      seedReadyState()
      const result = checkDreamGates(testDb.db, defaultConfig)
      expect(result.canRun).toBe(true)
      expect(result.failedGate).toBeUndefined()
    })

    it('time gate fails: last run was 1 hour ago', () => {
      seedReadyState()
      // Simulate a run 1 hour ago
      testDb.db
        .prepare(`UPDATE dream_state SET last_run_at = datetime('now', '-1 hour') WHERE id = 1`)
        .run()

      const result = checkDreamGates(testDb.db, defaultConfig)
      expect(result.canRun).toBe(false)
      expect(result.failedGate).toBe('time')
    })

    it('time gate passes: last run was 25 hours ago', () => {
      seedReadyState()
      testDb.db
        .prepare(`UPDATE dream_state SET last_run_at = datetime('now', '-25 hours') WHERE id = 1`)
        .run()

      const result = checkDreamGates(testDb.db, defaultConfig)
      expect(result.canRun).toBe(true)
    })

    it('time gate passes: never run before (last_run_at = null)', () => {
      seedReadyState()
      const result = checkDreamGates(testDb.db, defaultConfig)
      expect(result.canRun).toBe(true)
    })

    it('count gate fails: only 3 sessions (need 5)', () => {
      for (let i = 0; i < 3; i++) {
        incrementSessionCount(testDb.db)
      }

      const result = checkDreamGates(testDb.db, defaultConfig)
      expect(result.canRun).toBe(false)
      expect(result.failedGate).toBe('count')
    })

    it('count gate passes: exactly 5 sessions', () => {
      seedReadyState()
      const result = checkDreamGates(testDb.db, defaultConfig)
      expect(result.canRun).toBe(true)
    })

    it('lock gate fails: lock held by another', () => {
      seedReadyState()
      acquireDreamLock(testDb.db, 'other-worker')

      const result = checkDreamGates(testDb.db, defaultConfig)
      expect(result.canRun).toBe(false)
      expect(result.failedGate).toBe('lock')
    })

    it('lock gate passes: stale lock gets broken', () => {
      seedReadyState()
      acquireDreamLock(testDb.db, 'stale-worker')
      // Backdate lock beyond stale threshold
      testDb.db
        .prepare(`UPDATE dream_state SET locked_at = datetime('now', '-6 days') WHERE id = 1`)
        .run()

      const result = checkDreamGates(testDb.db, defaultConfig)
      expect(result.canRun).toBe(true)

      const state = getDreamState(testDb.db)
      expect(state!.lock_holder).toBeNull()
    })
  })

  describe('withDreamGate', () => {
    it('runs fn when gates pass', () => {
      seedReadyState()
      const fn = vi.fn(() => 42)
      const result = withDreamGate(testDb.db, defaultConfig, fn)

      expect(result).toBe(42)
      expect(fn).toHaveBeenCalledTimes(1)
    })

    it('returns null when gates fail', () => {
      // No sessions → count gate fails
      const fn = vi.fn(() => 42)
      const result = withDreamGate(testDb.db, defaultConfig, fn)

      expect(result).toBeNull()
      expect(fn).not.toHaveBeenCalled()
    })

    it('does not record run metrics (caller is responsible)', () => {
      seedReadyState()
      const fn = vi.fn(() => ({ durationMs: 500, entriesProcessed: 10 }))
      withDreamGate(testDb.db, defaultConfig, fn)

      // withDreamGate no longer records metrics — caller must call recordDreamRun
      const state = getDreamState(testDb.db)
      expect(state!.total_runs).toBe(0)
    })

    it('releases lock even on fn error', () => {
      seedReadyState()
      const fn = vi.fn(() => {
        throw new Error('boom')
      })

      expect(() => withDreamGate(testDb.db, defaultConfig, fn)).toThrow('boom')

      const state = getDreamState(testDb.db)
      expect(state!.lock_holder).toBeNull()
      expect(state!.locked_at).toBeNull()
    })
  })
})
