import { describe, it, expect, vi, beforeEach } from 'vitest'
import { cleanupStaleSessionsOnStartup } from '../../../src/broker/startup-cleanup.js'

vi.mock('../../../src/shared/logger.js', () => {
  const mock = { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn(), child: vi.fn() }
  mock.child.mockReturnValue(mock)
  return { logger: mock }
})

vi.mock('../../../src/broker/storage/repositories/session-repository.js', () => ({
  findStaleSessions: vi.fn().mockReturnValue([]),
  markSessionsAsZombie: vi.fn().mockReturnValue(0),
  resetHookAndDiscoveredSessions: vi.fn().mockReturnValue(0),
}))

// Issue #70: startup cleanup expires the execution lease via the shared
// retirement service — sessions rows and messages survive a broker restart.
vi.mock('../../../src/broker/services/session-retirement.js', () => ({
  expireSessionLease: vi.fn().mockReturnValue({
    expired: true,
    intents_released: 1,
    state_deleted: 2,
    handoffs_deleted: 0,
    messages_preserved: 3,
  }),
}))

vi.mock('../../../src/broker/storage/repositories/history-repository.js', () => ({
  purgeTeamToHistory: vi.fn().mockReturnValue({
    team_id: 'team-1',
    team_name: 'Test Team',
    members_archived: 2,
    tasks_archived: 1,
    messages_archived: 5,
  }),
}))

vi.mock('../../../src/broker/storage/repositories/team-repository.js', () => ({
  findAllTeams: vi.fn().mockReturnValue([]),
  disbandTeam: vi.fn(),
}))

vi.mock('../../../src/broker/storage/repositories/task-repository.js', () => ({
  countPendingTasksByTeam: vi.fn().mockReturnValue(0),
}))

import {
  findStaleSessions,
  markSessionsAsZombie,
  resetHookAndDiscoveredSessions,
} from '../../../src/broker/storage/repositories/session-repository.js'
import { expireSessionLease } from '../../../src/broker/services/session-retirement.js'
import { purgeTeamToHistory } from '../../../src/broker/storage/repositories/history-repository.js'
import {
  findAllTeams,
  disbandTeam,
} from '../../../src/broker/storage/repositories/team-repository.js'
import { countPendingTasksByTeam } from '../../../src/broker/storage/repositories/task-repository.js'

function createMockEventLog() {
  return {
    zombieCleaned: vi.fn(),
  } as any
}

describe('cleanupStaleSessionsOnStartup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(expireSessionLease).mockReturnValue({
      expired: true,
      intents_released: 1,
      state_deleted: 2,
      handoffs_deleted: 0,
      messages_preserved: 3,
    })
    vi.mocked(findStaleSessions).mockReturnValue([])
    vi.mocked(markSessionsAsZombie).mockReturnValue(0)
    vi.mocked(resetHookAndDiscoveredSessions).mockReturnValue(0)
    vi.mocked(findAllTeams).mockReturnValue([])
    vi.mocked(countPendingTasksByTeam).mockReturnValue(0)
    vi.mocked(purgeTeamToHistory).mockReturnValue({
      team_id: 'team-1',
      team_name: 'Test Team',
      members_archived: 2,
      tasks_archived: 1,
      messages_archived: 5,
    })
  })

  it('retires stale active sessions by expiring their lease — never deleting messages (issue #70)', () => {
    const sessions = [
      { id: 'sess-1', status: 'active' },
      { id: 'sess-2', status: 'active' },
    ] as any[]
    vi.mocked(findStaleSessions).mockReturnValue(sessions)
    const db = {} as any
    const eventLog = createMockEventLog()

    const result = cleanupStaleSessionsOnStartup(db, eventLog)

    expect(result.sessions).toBe(2)
    expect(markSessionsAsZombie).toHaveBeenCalledTimes(1)
    expect(expireSessionLease).toHaveBeenCalledTimes(2)
    expect(expireSessionLease).toHaveBeenCalledWith(db, 'sess-1')
    expect(expireSessionLease).toHaveBeenCalledWith(db, 'sess-2')
  })

  it('logs zombie events reporting preserved (not deleted) messages', () => {
    const sessions = [{ id: 'sess-1', status: 'active' }] as any[]
    vi.mocked(findStaleSessions).mockReturnValue(sessions)
    const db = {} as any
    const eventLog = createMockEventLog()

    cleanupStaleSessionsOnStartup(db, eventLog)

    expect(eventLog.zombieCleaned).toHaveBeenCalledWith(
      'sess-1',
      expect.objectContaining({
        cleanup_source: 'startup_cleanup',
        messages_deleted: 0,
        messages_preserved: 3,
      }),
    )
  })

  it('cleans stale teams via purgeTeamToHistory', () => {
    const teams = [
      { id: 'team-1', name: 'T1', status: 'active' },
      { id: 'team-2', name: 'T2', status: 'paused' },
    ] as any[]
    vi.mocked(findAllTeams).mockImplementation((_db, status) => {
      if (status === 'active') return [teams[0]!]
      if (status === 'paused') return [teams[1]!]
      return []
    })
    vi.mocked(countPendingTasksByTeam).mockImplementation((_db, teamId) => {
      if (teamId === 'team-1') return 3
      if (teamId === 'team-2') return 1
      return 0
    })
    const db = {} as any
    const eventLog = createMockEventLog()

    const result = cleanupStaleSessionsOnStartup(db, eventLog)

    expect(result.teams).toBe(2)
    expect(result.tasks).toBe(4)
    expect(result.teams_archived_to_history).toBe(2)
    expect(purgeTeamToHistory).toHaveBeenCalledTimes(2)
  })

  it('falls back to disband when purge returns null', () => {
    vi.mocked(purgeTeamToHistory).mockReturnValue(null)
    const teams = [{ id: 'team-1', name: 'T1', status: 'active' }] as any[]
    vi.mocked(findAllTeams).mockImplementation((_db, status) => {
      if (status === 'active') return teams
      return []
    })
    const db = {} as any
    const eventLog = createMockEventLog()

    const result = cleanupStaleSessionsOnStartup(db, eventLog)

    expect(result.teams).toBe(1)
    expect(result.teams_archived_to_history).toBe(0)
    expect(disbandTeam).toHaveBeenCalledWith(db, 'team-1')
  })

  it('returns correct counts', () => {
    vi.mocked(purgeTeamToHistory).mockReturnValue({
      team_id: 't1',
      team_name: 'T',
      members_archived: 1,
      tasks_archived: 1,
      messages_archived: 0,
    } as any)
    const sessions = [{ id: 's1', status: 'active' }] as any[]
    vi.mocked(findStaleSessions).mockReturnValue(sessions)
    const teams = [{ id: 't1', name: 'T', status: 'active' }] as any[]
    vi.mocked(findAllTeams).mockImplementation((_db, status) => {
      if (status === 'active') return teams
      return []
    })
    vi.mocked(countPendingTasksByTeam).mockReturnValue(2)
    const db = {} as any
    const eventLog = createMockEventLog()

    const result = cleanupStaleSessionsOnStartup(db, eventLog)

    expect(result).toEqual({
      sessions: 1,
      teams: 1,
      tasks: 2,
      teams_archived_to_history: 1,
      teams_reaped: 0,
      sessions_failed: 0,
      teams_failed: 0,
    })
  })

  it('is a no-op when no stale data exists', () => {
    const db = {} as any
    const eventLog = createMockEventLog()

    const result = cleanupStaleSessionsOnStartup(db, eventLog)

    expect(result).toEqual({
      sessions: 0,
      teams: 0,
      tasks: 0,
      teams_archived_to_history: 0,
      teams_reaped: 0,
      sessions_failed: 0,
      teams_failed: 0,
    })
    expect(expireSessionLease).not.toHaveBeenCalled()
    expect(purgeTeamToHistory).not.toHaveBeenCalled()
  })

  // --- Regression: 2026-04-22 crash trail ----------------------------------
  // The live broker crashed on startup when one stale session row
  // (`handoff-sess-1`) had a lingering FK dependent. Previously the throw
  // from `deleteSession` propagated through `cleanupStaleSessionsOnStartup`
  // and out of `startBroker`, then hit a C++ mutex abort. The fix must:
  //   (a) continue cleanup for remaining sessions after a FK throw,
  //   (b) retry on SQLITE_BUSY in `resetHookAndDiscoveredSessions`,
  //   (c) never rethrow a cleanup failure up to the caller.
  describe('regression: FK / BUSY / error-boundary', () => {
    it('continues cleanup after a failure on one session and reports the failure count', () => {
      const sessions = [
        { id: 'handoff-sess-1', status: 'active' },
        { id: 'sess-2', status: 'active' },
        { id: 'sess-3', status: 'active' },
      ] as any[]
      vi.mocked(findStaleSessions).mockReturnValue(sessions)
      // Only handoff-sess-1 throws (the real prod symptom).
      vi.mocked(expireSessionLease).mockImplementation((_db, id) => {
        if (id === 'handoff-sess-1') {
          const err = new Error(`Failed to retire session '${id}'`) as Error & {
            code?: string
          }
          err.code = 'SQLITE_CONSTRAINT_FOREIGNKEY'
          throw err
        }
        return {
          expired: true,
          intents_released: 1,
          state_deleted: 2,
          handoffs_deleted: 0,
          messages_preserved: 3,
        }
      })
      const db = {} as any
      const eventLog = createMockEventLog()

      const result = cleanupStaleSessionsOnStartup(db, eventLog)

      expect(result.sessions).toBe(3)
      expect(result.sessions_failed).toBe(1)
      // Other two sessions MUST have been processed.
      expect(expireSessionLease).toHaveBeenCalledTimes(3)
      expect(eventLog.zombieCleaned).toHaveBeenCalledTimes(2)
    })

    it('does not propagate a SQLITE_BUSY error from resetHookAndDiscoveredSessions', () => {
      vi.mocked(resetHookAndDiscoveredSessions).mockImplementation(() => {
        const err = new Error('database is locked') as Error & { code?: string }
        err.code = 'SQLITE_BUSY'
        throw err
      })
      const db = {} as any
      const eventLog = createMockEventLog()

      // Must not throw.
      expect(() => cleanupStaleSessionsOnStartup(db, eventLog)).not.toThrow()
    })

    it('does not propagate unexpected errors thrown by the reaper pass', () => {
      // Team purge throws — simulates an unexpected internal error.
      vi.mocked(purgeTeamToHistory).mockImplementation(() => {
        throw new Error('team purge exploded')
      })
      const teams = [{ id: 'team-x', name: 'X', status: 'active' }] as any[]
      vi.mocked(findAllTeams).mockImplementation((_db, status) =>
        status === 'active' ? teams : [],
      )
      const db = {} as any
      const eventLog = createMockEventLog()

      const result = cleanupStaleSessionsOnStartup(db, eventLog)
      expect(result.teams_failed).toBe(1)
      // Still returns a valid result object, did not throw.
      expect(result.sessions).toBe(0)
    })
  })
})
