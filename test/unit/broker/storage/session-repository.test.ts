import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { TestDb } from '../../../helpers/db-harness.js'
import { createBrokerTestDb } from '../../../helpers/broker-db-harness.js'
import {
  createSession,
  findSessionById,
  findAllSessions,
  findZombieSessions,
  updateSessionStatus,
  updateHeartbeat,
  deleteSession,
  countSessionsByStatus,
  findByRepoContext,
  findSessionChildren,
  archiveSession,
  findStaleSessions,
} from '../../../../src/broker/storage/repositories/session-repository.js'

describe('SessionRepository', () => {
  let testDb: TestDb

  beforeEach(() => {
    testDb = createBrokerTestDb()
  })

  afterEach(() => {
    testDb.close()
  })

  const makeSession = (id = 'sess-1', overrides?: Record<string, unknown>) =>
    createSession(testDb.db, {
      id,
      purpose: 'unit test',
      working_dir: '/home/test',
      worktree: null,
      ...overrides,
    })

  it('creates and retrieves a session', () => {
    const session = makeSession()
    expect(session.id).toBe('sess-1')
    expect(session.purpose).toBe('unit test')
    expect(session.status).toBe('active')

    const found = findSessionById(testDb.db, 'sess-1')
    expect(found).not.toBeNull()
    expect(found!.id).toBe('sess-1')
  })

  it('returns null for non-existent session', () => {
    expect(findSessionById(testDb.db, 'nope')).toBeNull()
  })

  it('findAllSessions returns all non-archived sessions', () => {
    makeSession('s1')
    makeSession('s2')
    const all = findAllSessions(testDb.db)
    expect(all).toHaveLength(2)
  })

  it('findAllSessions filters by status', () => {
    makeSession('s1')
    makeSession('s2')
    updateSessionStatus(testDb.db, 's2', 'paused')

    const active = findAllSessions(testDb.db, 'active')
    expect(active).toHaveLength(1)
    expect(active[0]!.id).toBe('s1')
  })

  it('updateSessionStatus changes status', () => {
    makeSession()
    const updated = updateSessionStatus(testDb.db, 'sess-1', 'paused')
    expect(updated!.status).toBe('paused')
  })

  it('updateSessionStatus to completed sets archived_at', () => {
    makeSession()
    const updated = updateSessionStatus(testDb.db, 'sess-1', 'completed')
    expect(updated!.status).toBe('completed')
    // Verify session is filtered from findAllSessions (non-archived)
    // The completed status sets archived_at, but it is still found if we look specifically
    const found = findSessionById(testDb.db, 'sess-1')
    expect(found).not.toBeNull()
  })

  it('findZombieSessions finds sessions with stale heartbeat', () => {
    makeSession('z1')
    // Manually set heartbeat far in the past
    testDb.db
      .prepare("UPDATE sessions SET last_heartbeat = datetime('now', '-600 seconds') WHERE id = ?")
      .run('z1')

    const zombies = findZombieSessions(testDb.db, 300)
    expect(zombies).toHaveLength(1)
    expect(zombies[0]!.id).toBe('z1')
  })

  it('findZombieSessions excludes sessions with fresh heartbeat', () => {
    makeSession('fresh')
    const zombies = findZombieSessions(testDb.db, 300)
    expect(zombies).toHaveLength(0)
  })

  it('findZombieSessions includes sessions already marked status=zombie (13.10.2)', () => {
    // Regression: a session stuck with status='zombie' was never reaped because
    // the query only matched live statuses. This row should now be picked up so
    // the heartbeat poller can delete it on the next tick.
    makeSession('stuck-zombie')
    testDb.db
      .prepare("UPDATE sessions SET status = 'zombie' WHERE id = ?")
      .run('stuck-zombie')

    const zombies = findZombieSessions(testDb.db, 300)
    expect(zombies.map((z) => z.id)).toContain('stuck-zombie')
  })

  it('findZombieSessions returns zombie rows regardless of heartbeat age', () => {
    makeSession('fresh-zombie')
    // Fresh heartbeat but status=zombie — must still be reaped.
    testDb.db
      .prepare("UPDATE sessions SET status = 'zombie', last_heartbeat = datetime('now') WHERE id = ?")
      .run('fresh-zombie')

    const zombies = findZombieSessions(testDb.db, 300)
    expect(zombies.map((z) => z.id)).toContain('fresh-zombie')
  })

  it('findZombieSessions still excludes completed sessions', () => {
    makeSession('done')
    updateSessionStatus(testDb.db, 'done', 'completed')
    const zombies = findZombieSessions(testDb.db, 300)
    expect(zombies.map((z) => z.id)).not.toContain('done')
  })

  it('findStaleSessions includes sessions already marked status=zombie (13.10.2)', () => {
    // Regression: startup cleanup must also reap sessions that were left in
    // status='zombie' from a previous broker run.
    makeSession('stuck-zombie', { purpose: 'handoff test' })
    testDb.db
      .prepare("UPDATE sessions SET status = 'zombie' WHERE id = ?")
      .run('stuck-zombie')

    const stale = findStaleSessions(testDb.db, ['copilot-hook', 'discovered'])
    expect(stale.map((s) => s.id)).toContain('stuck-zombie')
  })

  it('findStaleSessions preserves hook/discovered sessions even when zombie', () => {
    makeSession('hook-zombie', { purpose: 'copilot-hook' })
    testDb.db
      .prepare("UPDATE sessions SET status = 'zombie' WHERE id = ?")
      .run('hook-zombie')

    const stale = findStaleSessions(testDb.db, ['copilot-hook', 'discovered'])
    expect(stale.map((s) => s.id)).not.toContain('hook-zombie')
  })

  it('findStaleSessions still excludes completed sessions', () => {
    makeSession('done')
    updateSessionStatus(testDb.db, 'done', 'completed')
    const stale = findStaleSessions(testDb.db, ['copilot-hook', 'discovered'])
    expect(stale.map((s) => s.id)).not.toContain('done')
  })

  it('updateHeartbeat refreshes the heartbeat', () => {
    makeSession()
    // Set heartbeat old
    testDb.db
      .prepare("UPDATE sessions SET last_heartbeat = datetime('now', '-600 seconds') WHERE id = ?")
      .run('sess-1')
    // Should now be zombie
    expect(findZombieSessions(testDb.db, 300)).toHaveLength(1)

    updateHeartbeat(testDb.db, 'sess-1')
    // Should no longer be zombie
    expect(findZombieSessions(testDb.db, 300)).toHaveLength(0)
  })

  it('deleteSession removes a session', () => {
    makeSession()
    expect(deleteSession(testDb.db, 'sess-1')).toBe(true)
    expect(findSessionById(testDb.db, 'sess-1')).toBeNull()
  })

  it('deleteSession returns false for non-existent', () => {
    expect(deleteSession(testDb.db, 'nope')).toBe(false)
  })

  it('countSessionsByStatus counts correctly', () => {
    makeSession('s1')
    makeSession('s2')
    makeSession('s3')
    updateSessionStatus(testDb.db, 's3', 'paused')

    expect(countSessionsByStatus(testDb.db, 'active')).toBe(2)
    expect(countSessionsByStatus(testDb.db, 'paused')).toBe(1)
  })

  it('findByRepoContext finds sessions by repo context', () => {
    makeSession('s1', { repo_context: 'org/repo' })
    makeSession('s2', { repo_context: 'org/repo' })
    makeSession('s3', { repo_context: 'org/other' })

    const found = findByRepoContext(testDb.db, 'org/repo')
    expect(found).toHaveLength(2)
  })

  it('findSessionChildren returns child sessions', () => {
    makeSession('parent')
    makeSession('child1', { parent_session_id: 'parent' })
    makeSession('child2', { parent_session_id: 'parent' })

    const children = findSessionChildren(testDb.db, 'parent')
    expect(children).toHaveLength(2)
  })

  it('archiveSession sets archived_at', () => {
    makeSession()
    const result = archiveSession(testDb.db, 'sess-1')
    expect(result).toBe(true)

    // Archived sessions are excluded from findAllSessions by default
    const all = findAllSessions(testDb.db)
    expect(all).toHaveLength(0)

    // But can be found when includeArchived = true
    const withArchived = findAllSessions(testDb.db, undefined, true)
    expect(withArchived).toHaveLength(1)
  })

  // --- runWithBusyRetry (2026-04-22 regression) ---------------------------
  // Startup-cleanup crashed the broker with a SQLITE_BUSY at
  // resetHookAndDiscoveredSessions. The retry helper must recover from
  // transient BUSY/LOCKED and rethrow all other errors immediately.
  describe('runWithBusyRetry', () => {
    it('retries SQLITE_BUSY and eventually succeeds', async () => {
      const { runWithBusyRetry } = await import(
        '../../../../src/broker/storage/repositories/session-repository.js'
      )
      let calls = 0
      const result = runWithBusyRetry(
        () => {
          calls += 1
          if (calls < 3) {
            const err = new Error('database is locked') as Error & { code?: string }
            err.code = 'SQLITE_BUSY'
            throw err
          }
          return 'ok'
        },
        { attempts: 5, baseMs: 1 },
      )
      expect(result).toBe('ok')
      expect(calls).toBe(3)
    })

    it('rethrows non-transient errors immediately without retry', async () => {
      const { runWithBusyRetry } = await import(
        '../../../../src/broker/storage/repositories/session-repository.js'
      )
      let calls = 0
      expect(() =>
        runWithBusyRetry(
          () => {
            calls += 1
            const err = new Error('fk violation') as Error & { code?: string }
            err.code = 'SQLITE_CONSTRAINT_FOREIGNKEY'
            throw err
          },
          { attempts: 5, baseMs: 1 },
        ),
      ).toThrow(/fk violation/)
      expect(calls).toBe(1)
    })

    it('rethrows final SQLITE_BUSY after exhausting attempts', async () => {
      const { runWithBusyRetry } = await import(
        '../../../../src/broker/storage/repositories/session-repository.js'
      )
      let calls = 0
      expect(() =>
        runWithBusyRetry(
          () => {
            calls += 1
            const err = new Error('still locked') as Error & { code?: string }
            err.code = 'SQLITE_BUSY'
            throw err
          },
          { attempts: 3, baseMs: 1 },
        ),
      ).toThrow(/still locked/)
      expect(calls).toBe(3)
    })
  })
})
