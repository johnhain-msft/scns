import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { TestDb } from '../../../helpers/db-harness.js'
import { createBrokerTestDb } from '../../../helpers/broker-db-harness.js'
import {
  upsertBackgroundTask,
  getBackgroundTask,
  acquireLock,
  releaseLock,
  recordRun,
  isTimePassed,
  breakStaleLock,
} from '../../../../src/broker/storage/repositories/background-task-repository.js'

describe('BackgroundTaskRepository', () => {
  let testDb: TestDb

  beforeEach(() => {
    testDb = createBrokerTestDb()
  })

  afterEach(() => {
    testDb.close()
  })

  it('upsertBackgroundTask creates a new task', () => {
    const task = upsertBackgroundTask(testDb.db, 'heartbeat-check', 10_000)
    expect(task.task_name).toBe('heartbeat-check')
    expect(task.interval_ms).toBe(10_000)
    expect(task.run_count).toBe(0)
    expect(task.enabled).toBe(true)
    expect(task.lock_holder).toBeNull()
  })

  it('upsertBackgroundTask updates interval on conflict', () => {
    upsertBackgroundTask(testDb.db, 'check', 10_000)
    const updated = upsertBackgroundTask(testDb.db, 'check', 20_000)
    expect(updated.interval_ms).toBe(20_000)
  })

  it('getBackgroundTask returns null for non-existent', () => {
    expect(getBackgroundTask(testDb.db, 'nope')).toBeNull()
  })

  it('acquireLock succeeds when no lock held', () => {
    upsertBackgroundTask(testDb.db, 'task', 5000)
    expect(acquireLock(testDb.db, 'task', 'holder-1')).toBe(true)

    const task = getBackgroundTask(testDb.db, 'task')
    expect(task!.lock_holder).toBe('holder-1')
    expect(task!.locked_at).not.toBeNull()
  })

  it('acquireLock fails when lock already held', () => {
    upsertBackgroundTask(testDb.db, 'task', 5000)
    acquireLock(testDb.db, 'task', 'holder-1')
    expect(acquireLock(testDb.db, 'task', 'holder-2')).toBe(false)
  })

  it('releaseLock succeeds for the lock holder', () => {
    upsertBackgroundTask(testDb.db, 'task', 5000)
    acquireLock(testDb.db, 'task', 'holder-1')
    expect(releaseLock(testDb.db, 'task', 'holder-1')).toBe(true)

    const task = getBackgroundTask(testDb.db, 'task')
    expect(task!.lock_holder).toBeNull()
  })

  it('releaseLock fails for wrong holder', () => {
    upsertBackgroundTask(testDb.db, 'task', 5000)
    acquireLock(testDb.db, 'task', 'holder-1')
    expect(releaseLock(testDb.db, 'task', 'wrong-holder')).toBe(false)
  })

  it('recordRun increments run_count and sets last_run_at', () => {
    upsertBackgroundTask(testDb.db, 'task', 5000)
    recordRun(testDb.db, 'task')

    const task = getBackgroundTask(testDb.db, 'task')
    expect(task!.run_count).toBe(1)
    expect(task!.last_run_at).not.toBeNull()
  })

  it('isTimePassed returns true when never run', () => {
    upsertBackgroundTask(testDb.db, 'task', 5000)
    expect(isTimePassed(testDb.db, 'task')).toBe(true)
  })

  it('isTimePassed returns false immediately after a run', () => {
    upsertBackgroundTask(testDb.db, 'task', 300_000)
    recordRun(testDb.db, 'task')
    expect(isTimePassed(testDb.db, 'task')).toBe(false)
  })

  it('isTimePassed returns false for non-existent task', () => {
    expect(isTimePassed(testDb.db, 'nope')).toBe(false)
  })

  it('breakStaleLock clears old locks', () => {
    upsertBackgroundTask(testDb.db, 'task', 5000)
    acquireLock(testDb.db, 'task', 'old-holder')

    // Manually set locked_at to far in the past
    testDb.db
      .prepare(
        "UPDATE background_tasks SET locked_at = datetime('now', '-3600 seconds') WHERE task_name = ?",
      )
      .run('task')

    expect(breakStaleLock(testDb.db, 'task', 60_000)).toBe(true)

    const task = getBackgroundTask(testDb.db, 'task')
    expect(task!.lock_holder).toBeNull()
  })

  it('breakStaleLock does not clear fresh locks', () => {
    upsertBackgroundTask(testDb.db, 'task', 5000)
    acquireLock(testDb.db, 'task', 'holder')

    expect(breakStaleLock(testDb.db, 'task', 3_600_000)).toBe(false)
  })
})
