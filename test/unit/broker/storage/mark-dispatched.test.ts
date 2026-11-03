import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { TestDb } from '../../../helpers/db-harness.js'
import { createBrokerTestDb } from '../../../helpers/broker-db-harness.js'
import {
  markDispatched,
  getDispatchInfo,
} from '../../../../src/broker/storage/repositories/task-repository.js'

/**
 * WS P — durable readback flag on the tasks row.
 *
 * The task row IS the dispatch audit trail. `markDispatched` is the
 * synchronous status write that survives messages/messages_history
 * purging, so the manager-exit-monitor can short-circuit no_readback
 * false-positives without depending on still-resident message rows.
 *
 * Idempotency contract: calling markDispatched twice for the same task
 * does NOT overwrite — the first call wins. Second call returns
 * `stamped: false` and the row is unchanged.
 */
describe('markDispatched / getDispatchInfo (WS P durable readback flag)', () => {
  let testDb: TestDb
  let taskId: number

  beforeEach(() => {
    testDb = createBrokerTestDb()
    // Seed team + task (team_id is FK)
    testDb.db
      .prepare(
        "INSERT INTO teams (id, name, description) VALUES ('team-p1', 'team-p1', 'WS-P fixture')",
      )
      .run()
    const r = testDb.db
      .prepare(
        "INSERT INTO tasks (team_id, seq, subject, status) VALUES ('team-p1', 1, 'WS-P fixture task', 'in_progress')",
      )
      .run()
    taskId = Number(r.lastInsertRowid)
  })

  afterEach(() => testDb.close())

  it('first call stamps all five dispatch columns and returns stamped=true', () => {
    const res = markDispatched(testDb.db, {
      taskId,
      dispatchId: 'disp-A',
      readbackAt: '2026-05-12T20:00:00.000Z',
      managerSessionId: 'mgr-A',
      devSessionId: 'dev-A',
      qaSessionId: 'qa-A',
    })

    expect(res.stamped).toBe(true)
    expect(res.existingDispatchId).toBeNull()

    const info = getDispatchInfo(testDb.db, taskId)
    expect(info).not.toBeNull()
    expect(info!.dispatchId).toBe('disp-A')
    expect(info!.dispatchReadbackAt).toBe('2026-05-12T20:00:00.000Z')
    expect(info!.dispatchManagerSessionId).toBe('mgr-A')
    expect(info!.dispatchDevSessionId).toBe('dev-A')
    expect(info!.dispatchQaSessionId).toBe('qa-A')
  })

  it('second call with same dispatch_id is a no-op: stamped=false, row unchanged', () => {
    markDispatched(testDb.db, {
      taskId,
      dispatchId: 'disp-A',
      readbackAt: '2026-05-12T20:00:00.000Z',
      managerSessionId: 'mgr-A',
      devSessionId: 'dev-A',
      qaSessionId: 'qa-A',
    })

    const res2 = markDispatched(testDb.db, {
      taskId,
      dispatchId: 'disp-A',
      readbackAt: '2026-05-12T20:05:00.000Z',
      managerSessionId: 'mgr-A',
      devSessionId: 'dev-A',
      qaSessionId: 'qa-A',
    })

    expect(res2.stamped).toBe(false)
    expect(res2.existingDispatchId).toBe('disp-A')

    const info = getDispatchInfo(testDb.db, taskId)
    expect(info!.dispatchReadbackAt).toBe('2026-05-12T20:00:00.000Z')
  })

  it('second call with different dispatch_id surfaces existingDispatchId for caller warning', () => {
    markDispatched(testDb.db, {
      taskId,
      dispatchId: 'disp-A',
      readbackAt: '2026-05-12T20:00:00.000Z',
      managerSessionId: 'mgr-A',
      devSessionId: 'dev-A',
      qaSessionId: 'qa-A',
    })

    const res2 = markDispatched(testDb.db, {
      taskId,
      dispatchId: 'disp-B',
      readbackAt: '2026-05-12T20:05:00.000Z',
      managerSessionId: 'mgr-A',
      devSessionId: 'dev-A2',
      qaSessionId: 'qa-A2',
    })

    expect(res2.stamped).toBe(false)
    expect(res2.existingDispatchId).toBe('disp-A')

    const info = getDispatchInfo(testDb.db, taskId)
    expect(info!.dispatchId).toBe('disp-A')
    expect(info!.dispatchDevSessionId).toBe('dev-A')
  })

  it('getDispatchInfo returns null for a never-dispatched task', () => {
    expect(getDispatchInfo(testDb.db, taskId)).toBeNull()
  })
})
