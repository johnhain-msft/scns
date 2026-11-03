/**
 * Integration test for team-reaper: runs against a real SQLite broker DB
 * (in-memory), verifies archived_at is set, status is preserved, and
 * teams_history is NOT touched (reaper archives, does not purge).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createBrokerTestDb } from '../../helpers/broker-db-harness.js'
import type { TestDb } from '../../helpers/db-harness.js'
import { createEventLog } from '../../../src/broker/services/event-log.js'
import { createTeamReaper } from '../../../src/broker/services/team-reaper.js'
import {
  createTeam,
  findTeamById,
} from '../../../src/broker/storage/repositories/team-repository.js'

describe('team-reaper integration', () => {
  let testDb: TestDb

  beforeEach(() => {
    testDb = createBrokerTestDb()
  })

  afterEach(() => {
    testDb.close()
  })

  it('archives orphan active teams without touching teams_history', () => {
    const eventLog = createEventLog(testDb.db)

    // Seed: 3 orphan teams + 1 brain-solo exempt team
    for (const id of ['o1', 'o2', 'o3']) {
      createTeam(testDb.db, { id, name: `orphan-${id}` })
    }
    createTeam(testDb.db, { id: 'b', name: 'brain-solo' })
    testDb.db
      .prepare("UPDATE teams SET created_at = datetime('now', '-1 hour')")
      .run()

    // Baseline: teams_history is empty
    const historyBefore = (
      testDb.db.prepare('SELECT COUNT(*) AS c FROM teams_history').get() as { c: number }
    ).c
    expect(historyBefore).toBe(0)

    // Run reaper
    const reaper = createTeamReaper({
      db: testDb.db,
      eventLog,
      options: { graceMs: 60_000 },
    })
    const result = reaper.reapOnce()

    expect(result.teams_reaped).toBe(3)
    expect(result.team_ids.sort()).toEqual(['o1', 'o2', 'o3'])

    // Archived teams: archived_at set, status unchanged (reaper does not disband)
    for (const id of ['o1', 'o2', 'o3']) {
      const t = findTeamById(testDb.db, id)
      expect(t).not.toBeNull()
      expect(t?.archived_at).not.toBeNull()
      expect(t?.status).toBe('active')
    }

    // brain-solo untouched
    const brain = findTeamById(testDb.db, 'b')
    expect(brain?.archived_at).toBeNull()

    // teams_history is STILL empty — reaper archives, does not purge
    const historyAfter = (
      testDb.db.prepare('SELECT COUNT(*) AS c FROM teams_history').get() as { c: number }
    ).c
    expect(historyAfter).toBe(0)

    // team_archived events emitted
    const events = testDb.db
      .prepare("SELECT payload FROM events WHERE event_type = 'team_archived' ORDER BY id")
      .all() as Array<{ payload: string }>
    expect(events.length).toBe(3)
  })

  it('start()/stop() are idempotent and do not throw', () => {
    const eventLog = createEventLog(testDb.db)
    const reaper = createTeamReaper({
      db: testDb.db,
      eventLog,
      options: { graceMs: 60_000, intervalMs: 60_000 },
    })

    reaper.start()
    reaper.start() // idempotent
    reaper.stop()
    reaper.stop() // idempotent
  })
})
