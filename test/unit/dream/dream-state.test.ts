import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { TestDb } from '../../helpers/db-harness.js'
import { createTestDb } from '../../helpers/db-harness.js'
import {
  initDreamState,
  getDreamState,
  recordDreamRun,
  incrementSessionCount,
  acquireDreamLock,
  releaseDreamLock,
  breakStaleDreamLock,
} from '../../../src/dream/dream-state.js'

function createDreamTestDb(): TestDb {
  const testDb = createTestDb()
  initDreamState(testDb.db)
  return testDb
}

describe('dream-state', () => {
  let testDb: TestDb

  beforeEach(() => {
    testDb = createDreamTestDb()
  })

  afterEach(() => {
    testDb.close()
  })

  describe('initDreamState', () => {
    it('creates table and singleton row', () => {
      const state = getDreamState(testDb.db)
      expect(state).not.toBeNull()
      expect(state!.sessions_since_last_run).toBe(0)
      expect(state!.total_runs).toBe(0)
    })

    it('is idempotent (second call is a no-op)', () => {
      initDreamState(testDb.db)
      initDreamState(testDb.db)
      const state = getDreamState(testDb.db)
      expect(state).not.toBeNull()
      expect(state!.total_runs).toBe(0)
    })
  })

  describe('getDreamState', () => {
    it('returns initial state (all nulls/zeros)', () => {
      const state = getDreamState(testDb.db)
      expect(state).not.toBeNull()
      expect(state!.last_run_at).toBeNull()
      expect(state!.sessions_since_last_run).toBe(0)
      expect(state!.total_runs).toBe(0)
      expect(state!.last_run_duration_ms).toBeNull()
      expect(state!.last_run_entries_processed).toBeNull()
      expect(state!.lock_holder).toBeNull()
      expect(state!.locked_at).toBeNull()
    })
  })

  describe('recordDreamRun', () => {
    it('updates last_run_at and resets sessions_since', () => {
      incrementSessionCount(testDb.db)
      incrementSessionCount(testDb.db)
      incrementSessionCount(testDb.db)

      recordDreamRun(testDb.db, { durationMs: 1500, entriesProcessed: 42 })

      const state = getDreamState(testDb.db)
      expect(state!.last_run_at).not.toBeNull()
      expect(state!.sessions_since_last_run).toBe(0)
      expect(state!.last_run_duration_ms).toBe(1500)
      expect(state!.last_run_entries_processed).toBe(42)
    })

    it('increments total_runs', () => {
      recordDreamRun(testDb.db, { durationMs: 100, entriesProcessed: 10 })
      recordDreamRun(testDb.db, { durationMs: 200, entriesProcessed: 20 })

      const state = getDreamState(testDb.db)
      expect(state!.total_runs).toBe(2)
    })
  })

  describe('incrementSessionCount', () => {
    it('increases count by 1', () => {
      incrementSessionCount(testDb.db)
      const state = getDreamState(testDb.db)
      expect(state!.sessions_since_last_run).toBe(1)
    })

    it('from 0 to 5', () => {
      for (let i = 0; i < 5; i++) {
        incrementSessionCount(testDb.db)
      }
      const state = getDreamState(testDb.db)
      expect(state!.sessions_since_last_run).toBe(5)
    })
  })

  describe('acquireDreamLock', () => {
    it('succeeds when unlocked', () => {
      const acquired = acquireDreamLock(testDb.db, 'worker-1')
      expect(acquired).toBe(true)

      const state = getDreamState(testDb.db)
      expect(state!.lock_holder).toBe('worker-1')
      expect(state!.locked_at).not.toBeNull()
    })

    it('fails when already locked', () => {
      acquireDreamLock(testDb.db, 'worker-1')
      const acquired = acquireDreamLock(testDb.db, 'worker-2')
      expect(acquired).toBe(false)

      const state = getDreamState(testDb.db)
      expect(state!.lock_holder).toBe('worker-1')
    })
  })

  describe('releaseDreamLock', () => {
    it('succeeds with matching holder', () => {
      acquireDreamLock(testDb.db, 'worker-1')
      const released = releaseDreamLock(testDb.db, 'worker-1')
      expect(released).toBe(true)

      const state = getDreamState(testDb.db)
      expect(state!.lock_holder).toBeNull()
      expect(state!.locked_at).toBeNull()
    })

    it('fails with wrong holder', () => {
      acquireDreamLock(testDb.db, 'worker-1')
      const released = releaseDreamLock(testDb.db, 'worker-2')
      expect(released).toBe(false)

      const state = getDreamState(testDb.db)
      expect(state!.lock_holder).toBe('worker-1')
    })
  })

  describe('breakStaleDreamLock', () => {
    it('breaks old lock', () => {
      acquireDreamLock(testDb.db, 'stale-worker')
      // Backdate locked_at by 2 hours
      testDb.db
        .prepare(`UPDATE dream_state SET locked_at = datetime('now', '-2 hours') WHERE id = 1`)
        .run()

      const broken = breakStaleDreamLock(testDb.db, 60_000) // 1 minute threshold
      expect(broken).toBe(true)

      const state = getDreamState(testDb.db)
      expect(state!.lock_holder).toBeNull()
      expect(state!.locked_at).toBeNull()
    })

    it('preserves fresh lock', () => {
      acquireDreamLock(testDb.db, 'active-worker')

      const broken = breakStaleDreamLock(testDb.db, 3_600_000) // 1 hour threshold
      expect(broken).toBe(false)

      const state = getDreamState(testDb.db)
      expect(state!.lock_holder).toBe('active-worker')
    })
  })
})
