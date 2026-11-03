import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createBrokerTestDb } from '../../../helpers/broker-db-harness.js'
import {
  checkGates,
  withTaskGate,
  initializeTaskGates,
} from '../../../../src/broker/services/background-task-gate.js'
import {
  upsertBackgroundTask,
  acquireLock,
  getBackgroundTask,
  recordRun,
} from '../../../../src/broker/storage/repositories/background-task-repository.js'
import type { TestDb } from '../../../helpers/db-harness.js'
import type { TaskGateConfig } from '../../../../src/broker/types.js'

let testDb: TestDb

beforeEach(() => {
  testDb = createBrokerTestDb()
})

afterEach(() => {
  testDb.close()
})

function makeConfig(overrides: Partial<TaskGateConfig> = {}): TaskGateConfig {
  return {
    taskName: 'test-task',
    intervalMs: 300_000,
    ...overrides,
  }
}

describe('checkGates', () => {
  it('disabled gate: returns false with disabled reason when task does not exist', () => {
    const result = checkGates(testDb.db, makeConfig())
    expect(result.canRun).toBe(false)
    expect(result.failedGate).toBe('disabled')
  })

  it('disabled gate: returns false with disabled reason when task is disabled', () => {
    upsertBackgroundTask(testDb.db, 'test-task', 300_000)
    testDb.db
      .prepare('UPDATE background_tasks SET enabled = 0 WHERE task_name = ?')
      .run('test-task')

    const result = checkGates(testDb.db, makeConfig())
    expect(result.canRun).toBe(false)
    expect(result.failedGate).toBe('disabled')
  })

  it('lock gate: returns false when locked', () => {
    upsertBackgroundTask(testDb.db, 'test-task', 300_000)
    acquireLock(testDb.db, 'test-task', 'other-holder')

    const result = checkGates(testDb.db, makeConfig())
    expect(result.canRun).toBe(false)
    expect(result.failedGate).toBe('lock')
  })

  it('time gate: returns false when too soon', () => {
    upsertBackgroundTask(testDb.db, 'test-task', 300_000)
    // Record a run so last_run_at is now — time gate should fail
    recordRun(testDb.db, 'test-task')

    const result = checkGates(testDb.db, makeConfig())
    expect(result.canRun).toBe(false)
    expect(result.failedGate).toBe('time')
  })

  it('count gate: returns false when countCheck fails', () => {
    upsertBackgroundTask(testDb.db, 'test-task', 300_000)

    const config = makeConfig({ countCheck: () => false })
    const result = checkGates(testDb.db, config)
    expect(result.canRun).toBe(false)
    expect(result.failedGate).toBe('count')
  })

  it('all gates pass: returns true', () => {
    upsertBackgroundTask(testDb.db, 'test-task', 300_000)
    // No lock, never run (time passes), no countCheck

    const result = checkGates(testDb.db, makeConfig())
    expect(result.canRun).toBe(true)
    expect(result.failedGate).toBeUndefined()
  })

  it('stale lock gets broken', () => {
    upsertBackgroundTask(testDb.db, 'test-task', 300_000)
    acquireLock(testDb.db, 'test-task', 'stale-holder')

    // Backdate locked_at so the lock is stale
    testDb.db
      .prepare(
        `UPDATE background_tasks SET locked_at = datetime('now', '-1 hour') WHERE task_name = ?`,
      )
      .run('test-task')

    const config = makeConfig({ staleLockMs: 1000 }) // 1 second stale threshold
    const result = checkGates(testDb.db, config)
    expect(result.canRun).toBe(true)

    // Verify lock was actually broken
    const task = getBackgroundTask(testDb.db, 'test-task')
    expect(task!.lock_holder).toBeNull()
  })
})

describe('withTaskGate', () => {
  it('acquires lock, runs fn, records run, releases lock', () => {
    upsertBackgroundTask(testDb.db, 'test-task', 300_000)

    const fn = vi.fn(() => 42)
    const result = withTaskGate(testDb.db, makeConfig({ lockHolder: 'test-holder' }), fn)

    expect(result).toBe(42)
    expect(fn).toHaveBeenCalledTimes(1)

    // Lock should be released
    const task = getBackgroundTask(testDb.db, 'test-task')
    expect(task!.lock_holder).toBeNull()
    expect(task!.run_count).toBe(1)
  })

  it('returns null when gates fail', () => {
    // Task doesn't exist → disabled gate fails
    const fn = vi.fn(() => 42)
    const result = withTaskGate(testDb.db, makeConfig(), fn)

    expect(result).toBeNull()
    expect(fn).not.toHaveBeenCalled()
  })
})

describe('initializeTaskGates', () => {
  it('seeds known tasks', () => {
    initializeTaskGates(testDb.db)

    const teamGc = getBackgroundTask(testDb.db, 'team-gc')
    expect(teamGc).not.toBeNull()
    expect(teamGc!.interval_ms).toBe(300_000)

    const compaction = getBackgroundTask(testDb.db, 'message-compaction')
    expect(compaction).not.toBeNull()
    expect(compaction!.interval_ms).toBe(600_000)

    const reindex = getBackgroundTask(testDb.db, 'embedding-reindex')
    expect(reindex).not.toBeNull()
    expect(reindex!.interval_ms).toBe(900_000)
  })
})
