import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { TestDb } from '../../../helpers/db-harness.js'
import { createBrokerTestDb } from '../../../helpers/broker-db-harness.js'
import { gcDisbandedTeams } from '../../../../src/broker/services/team-gc.js'
import {
  createTeam,
  updateTeamStatus,
  archiveTeam,
  findTeamById,
  addTeamMember,
} from '../../../../src/broker/storage/repositories/team-repository.js'
import { queryTeamHistory } from '../../../../src/broker/storage/repositories/history-repository.js'
import type { Event } from '../../../../src/broker/types.js'
import type { EventLog } from '../../../../src/broker/services/team-gc.js'

function createMockEventLog(): EventLog & { events: Event[] } {
  const events: Event[] = []
  let nextId = 1

  const log = (
    eventType: string,
    sessionId: string | null,
    data: Record<string, unknown>,
  ): Event => {
    const event: Event = {
      id: nextId++,
      event_type: eventType,
      session_id: sessionId,
      payload: JSON.stringify(data),
      created_at: new Date().toISOString(),
    }
    events.push(event)
    return event
  }

  return {
    events,
    teamPurged: (sid, data) => log('team_purged', sid, data),
    sessionDeregistered: (sid, data) => log('session_deregistered', sid, data),
  } as EventLog & { events: Event[] }
}

describe('TeamGC', () => {
  let testDb: TestDb
  let eventLog: ReturnType<typeof createMockEventLog>

  beforeEach(() => {
    testDb = createBrokerTestDb()
    eventLog = createMockEventLog()
    // Pre-register sessions for FK constraints
    testDb.db
      .prepare('INSERT INTO sessions (id, purpose, working_dir) VALUES (?, ?, ?)')
      .run('s1', 'agent-1', '/workspace/a')
  })

  afterEach(() => {
    testDb.close()
  })

  function createDisbandedTeam(id: string, name: string): void {
    createTeam(testDb.db, { id, name })
    updateTeamStatus(testDb.db, id, 'disbanded')
    archiveTeam(testDb.db, id)
    // Backdate archived_at so it's older than TTL
    testDb.db
      .prepare("UPDATE teams SET archived_at = datetime('now', '-2 days') WHERE id = ?")
      .run(id)
  }

  it('purges disbanded teams older than TTL', () => {
    createDisbandedTeam('t1', 'OldTeam')

    const result = gcDisbandedTeams(testDb.db, eventLog, 60) // 60s TTL
    expect(result.teams_purged).toBe(1)
    expect(findTeamById(testDb.db, 't1')).toBeNull()
  })

  it('does not affect active teams', () => {
    createTeam(testDb.db, { id: 't1', name: 'ActiveTeam' })

    const result = gcDisbandedTeams(testDb.db, eventLog, 60)
    expect(result.teams_purged).toBe(0)
    expect(findTeamById(testDb.db, 't1')).not.toBeNull()
  })

  it('does not purge recently disbanded teams within TTL', () => {
    createTeam(testDb.db, { id: 't1', name: 'RecentTeam' })
    updateTeamStatus(testDb.db, 't1', 'disbanded')
    archiveTeam(testDb.db, 't1')
    // archived_at is now() — within any reasonable TTL

    const result = gcDisbandedTeams(testDb.db, eventLog, 86400) // 24h TTL
    expect(result.teams_purged).toBe(0)
    expect(findTeamById(testDb.db, 't1')).not.toBeNull()
  })

  it('returns correct purge count', () => {
    createDisbandedTeam('t1', 'OldTeam1')
    createDisbandedTeam('t2', 'OldTeam2')
    createTeam(testDb.db, { id: 't3', name: 'ActiveTeam' })

    const result = gcDisbandedTeams(testDb.db, eventLog, 60)
    expect(result.teams_purged).toBe(2)
  })

  it('preserves team data in history tables after purge', () => {
    createDisbandedTeam('t1', 'HistoryTeam')
    addTeamMember(testDb.db, { team_id: 't1', session_id: 's1', name: 'Agent-1', role: 'dev' })

    gcDisbandedTeams(testDb.db, eventLog, 60)

    // Team should be gone from active tables
    expect(findTeamById(testDb.db, 't1')).toBeNull()

    // Team should exist in history
    const history = queryTeamHistory(testDb.db)
    expect(history.length).toBeGreaterThanOrEqual(1)
    const record = history.find((h) => h.id === 't1')
    expect(record).toBeDefined()
    expect(record!.name).toBe('HistoryTeam')
  })
})
