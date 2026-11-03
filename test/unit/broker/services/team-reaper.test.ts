import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { TestDb } from '../../../helpers/db-harness.js'
import { createBrokerTestDb } from '../../../helpers/broker-db-harness.js'
import { createTeamReaper } from '../../../../src/broker/services/team-reaper.js'
import {
  createTeam,
  addTeamMember,
  findTeamById,
} from '../../../../src/broker/storage/repositories/team-repository.js'
import { createEventLog } from '../../../../src/broker/services/event-log.js'

function backdateTeamCreatedAt(db: TestDb['db'], teamId: string, secondsAgo: number): void {
  db.prepare("UPDATE teams SET created_at = datetime('now', '-' || ? || ' seconds') WHERE id = ?")
    .run(secondsAgo, teamId)
}

function insertSession(db: TestDb['db'], id: string): void {
  db.prepare('INSERT INTO sessions (id, purpose, working_dir) VALUES (?, ?, ?)').run(
    id,
    'agent',
    '/tmp',
  )
}

describe('team-reaper', () => {
  let testDb: TestDb
  let eventLog: ReturnType<typeof createEventLog>

  beforeEach(() => {
    testDb = createBrokerTestDb()
    eventLog = createEventLog(testDb.db)
  })

  afterEach(() => {
    testDb.close()
  })

  it('archives empty active team older than grace', () => {
    createTeam(testDb.db, { id: 't1', name: 'orphan-1' })
    backdateTeamCreatedAt(testDb.db, 't1', 3600) // 1h ago

    const reaper = createTeamReaper({
      db: testDb.db,
      eventLog,
      options: { graceMs: 60_000 },
    })
    const result = reaper.reapOnce()

    expect(result.teams_reaped).toBe(1)
    expect(result.team_ids).toEqual(['t1'])
    const row = findTeamById(testDb.db, 't1')
    expect(row?.archived_at).not.toBeNull()
  })

  it('does NOT archive empty team newer than grace', () => {
    createTeam(testDb.db, { id: 't1', name: 'fresh-1' })
    // created_at defaults to now

    const reaper = createTeamReaper({
      db: testDb.db,
      eventLog,
      options: { graceMs: 300_000 },
    })
    const result = reaper.reapOnce()

    expect(result.teams_reaped).toBe(0)
    const row = findTeamById(testDb.db, 't1')
    expect(row?.archived_at).toBeNull()
  })

  it('does NOT archive team with a working member', () => {
    insertSession(testDb.db, 's1')
    createTeam(testDb.db, { id: 't1', name: 'busy-1' })
    addTeamMember(testDb.db, {
      team_id: 't1',
      session_id: 's1',
      name: 'dev',
      role: 'dev',
    })
    testDb.db
      .prepare("UPDATE team_members SET status = 'working' WHERE team_id = ? AND session_id = ?")
      .run('t1', 's1')
    backdateTeamCreatedAt(testDb.db, 't1', 3600)

    const reaper = createTeamReaper({
      db: testDb.db,
      eventLog,
      options: { graceMs: 60_000 },
    })
    const result = reaper.reapOnce()

    expect(result.teams_reaped).toBe(0)
    expect(findTeamById(testDb.db, 't1')?.archived_at).toBeNull()
  })

  it('does NOT archive brain-solo even when empty and old', () => {
    createTeam(testDb.db, { id: 't-brain', name: 'brain-solo' })
    backdateTeamCreatedAt(testDb.db, 't-brain', 3600)

    const reaper = createTeamReaper({
      db: testDb.db,
      eventLog,
      options: { graceMs: 60_000 },
    })
    const result = reaper.reapOnce()

    expect(result.teams_reaped).toBe(0)
    expect(findTeamById(testDb.db, 't-brain')?.archived_at).toBeNull()
  })

  it('does NOT archive team with only idle members within grace', () => {
    insertSession(testDb.db, 's1')
    createTeam(testDb.db, { id: 't1', name: 'idle-only' })
    addTeamMember(testDb.db, {
      team_id: 't1',
      session_id: 's1',
      name: 'dev',
      role: 'dev',
    })
    // status defaults to 'idle'

    const reaper = createTeamReaper({
      db: testDb.db,
      eventLog,
      options: { graceMs: 300_000 },
    })
    const result = reaper.reapOnce()

    expect(result.teams_reaped).toBe(0)
    expect(findTeamById(testDb.db, 't1')?.archived_at).toBeNull()
  })

  it('does NOT archive team with idle members even past grace (live members present)', () => {
    insertSession(testDb.db, 's1')
    createTeam(testDb.db, { id: 't1', name: 'old-idle' })
    addTeamMember(testDb.db, {
      team_id: 't1',
      session_id: 's1',
      name: 'dev',
      role: 'dev',
    })
    backdateTeamCreatedAt(testDb.db, 't1', 3600)

    const reaper = createTeamReaper({
      db: testDb.db,
      eventLog,
      options: { graceMs: 60_000 },
    })
    const result = reaper.reapOnce()

    expect(result.teams_reaped).toBe(0)
  })

  it('emits team_archived event on reap', () => {
    createTeam(testDb.db, { id: 't1', name: 'orphan-evt' })
    backdateTeamCreatedAt(testDb.db, 't1', 3600)

    const reaper = createTeamReaper({
      db: testDb.db,
      eventLog,
      options: { graceMs: 60_000 },
    })
    reaper.reapOnce()

    const rows = testDb.db
      .prepare("SELECT event_type, payload FROM events WHERE event_type = 'team_archived'")
      .all() as Array<{ event_type: string; payload: string }>
    expect(rows.length).toBe(1)
    const payload = JSON.parse(rows[0]!.payload)
    expect(payload.team_id).toBe('t1')
    expect(payload.team_name).toBe('orphan-evt')
    expect(payload.source).toBe('team-reaper')
  })

  it('does not re-archive already-archived teams', () => {
    createTeam(testDb.db, { id: 't1', name: 'orphan-2' })
    backdateTeamCreatedAt(testDb.db, 't1', 3600)

    const reaper = createTeamReaper({
      db: testDb.db,
      eventLog,
      options: { graceMs: 60_000 },
    })
    const first = reaper.reapOnce()
    const second = reaper.reapOnce()

    expect(first.teams_reaped).toBe(1)
    expect(second.teams_reaped).toBe(0)
  })

  it('does NOT archive team when only member has recent last_activity_at heartbeat but status is outside working/idle', () => {
    // Regression test for premature-archive bug observed on team-sugg-76707c3d
    // (QA-13-12-24a): an ACP agent was actively producing output at +308s
    // but its team_members.status had dipped to 'shutdown' during a long
    // tool call. Reaper must honor the last_activity_at heartbeat
    // regardless of the persisted status bucket.
    insertSession(testDb.db, 's1')
    createTeam(testDb.db, { id: 't1', name: 'long-tool-call' })
    addTeamMember(testDb.db, {
      team_id: 't1',
      session_id: 's1',
      name: 'dev',
      role: 'dev',
    })
    // Member status is outside ('working','idle') AND team created long ago,
    // but the spawner has been touching last_activity_at every ACP update.
    testDb.db
      .prepare(
        "UPDATE team_members SET status = 'shutdown', last_activity_at = datetime('now', '-30 seconds') WHERE team_id = ? AND session_id = ?",
      )
      .run('t1', 's1')
    backdateTeamCreatedAt(testDb.db, 't1', 3600)

    const reaper = createTeamReaper({
      db: testDb.db,
      eventLog,
      options: { graceMs: 60_000 },
    })
    const result = reaper.reapOnce()

    expect(result.teams_reaped).toBe(0)
    expect(findTeamById(testDb.db, 't1')?.archived_at).toBeNull()
  })

  it('archives team when member last_activity_at is older than grace and status is outside working/idle', () => {
    // Counterpart to the regression test above: when the heartbeat is also
    // stale, the team is genuinely orphaned and should be reaped.
    insertSession(testDb.db, 's1')
    createTeam(testDb.db, { id: 't1', name: 'truly-dead' })
    addTeamMember(testDb.db, {
      team_id: 't1',
      session_id: 's1',
      name: 'dev',
      role: 'dev',
    })
    testDb.db
      .prepare(
        "UPDATE team_members SET status = 'shutdown', last_activity_at = datetime('now', '-3600 seconds') WHERE team_id = ? AND session_id = ?",
      )
      .run('t1', 's1')
    backdateTeamCreatedAt(testDb.db, 't1', 3600)

    const reaper = createTeamReaper({
      db: testDb.db,
      eventLog,
      options: { graceMs: 60_000 },
    })
    const result = reaper.reapOnce()

    expect(result.teams_reaped).toBe(1)
    expect(result.team_ids).toEqual(['t1'])
  })

  it('treats recent team message as last_touched, blocking archive', () => {
    insertSession(testDb.db, 's1')
    createTeam(testDb.db, { id: 't1', name: 'chatty' })
    backdateTeamCreatedAt(testDb.db, 't1', 3600)
    // No live members, but a recent team message.
    testDb.db
      .prepare(
        `INSERT INTO messages (id, sender_id, content, team_id, created_at)
         VALUES (?, ?, ?, ?, datetime('now'))`,
      )
      .run('m1', 's1', 'hello', 't1')

    const reaper = createTeamReaper({
      db: testDb.db,
      eventLog,
      options: { graceMs: 60_000 },
    })
    const result = reaper.reapOnce()

    expect(result.teams_reaped).toBe(0)
  })

  describe('WS D: in-progress task exemption', () => {
    function insertTask(
      db: TestDb['db'],
      opts: { teamId: string; subject: string; status: 'pending' | 'in_progress' | 'completed' | 'failed' },
    ): number {
      const info = db
        .prepare(
          "INSERT INTO tasks (team_id, seq, subject, status) VALUES (?, 1, ?, ?)",
        )
        .run(opts.teamId, opts.subject, opts.status)
      return Number(info.lastInsertRowid)
    }

    it('(a) does NOT archive team with an in-progress task and zero live members past grace', () => {
      // Mirrors the team-reaper bug WS D targets: a long ACP tool call drops
      // every member out of working/idle and out of the heartbeat window,
      // but the task is still status='in_progress'. Reaper must keep the
      // team alive on that signal alone.
      createTeam(testDb.db, { id: 't1', name: 'in-progress-host' })
      backdateTeamCreatedAt(testDb.db, 't1', 3600)
      insertTask(testDb.db, { teamId: 't1', subject: 'fix something', status: 'in_progress' })
      // No team members at all -> no live members.

      const reaper = createTeamReaper({
        db: testDb.db,
        eventLog,
        options: { graceMs: 60_000 },
      })
      const result = reaper.reapOnce()

      expect(result.teams_reaped).toBe(0)
      expect(findTeamById(testDb.db, 't1')?.archived_at).toBeNull()
    })

    it('(b) DOES archive team with only pending/completed/failed tasks and no live members past grace', () => {
      createTeam(testDb.db, { id: 't1', name: 'no-live-tasks' })
      backdateTeamCreatedAt(testDb.db, 't1', 3600)
      insertTask(testDb.db, { teamId: 't1', subject: 'queued', status: 'pending' })
      insertTask(testDb.db, { teamId: 't1', subject: 'done', status: 'completed' })
      insertTask(testDb.db, { teamId: 't1', subject: 'gave up', status: 'failed' })

      const reaper = createTeamReaper({
        db: testDb.db,
        eventLog,
        options: { graceMs: 60_000 },
      })
      const result = reaper.reapOnce()

      expect(result.teams_reaped).toBe(1)
      expect(result.team_ids).toEqual(['t1'])
    })

    it('(c) becomes reapable on the next tick once the in-progress task transitions to failed', () => {
      createTeam(testDb.db, { id: 't1', name: 'transition' })
      backdateTeamCreatedAt(testDb.db, 't1', 3600)
      const taskId = insertTask(testDb.db, {
        teamId: 't1',
        subject: 'long-running',
        status: 'in_progress',
      })

      const reaper = createTeamReaper({
        db: testDb.db,
        eventLog,
        options: { graceMs: 60_000 },
      })

      // Tick 1: task still in_progress -> exempt.
      expect(reaper.reapOnce().teams_reaped).toBe(0)
      expect(findTeamById(testDb.db, 't1')?.archived_at).toBeNull()

      // Transition to 'failed' — exemption no longer applies.
      testDb.db.prepare("UPDATE tasks SET status = 'failed' WHERE id = ?").run(taskId)

      // Tick 2: now reapable.
      const result = reaper.reapOnce()
      expect(result.teams_reaped).toBe(1)
      expect(result.team_ids).toEqual(['t1'])
    })
  })

  describe('F6: spawner-active exemption', () => {
    it('skips archival when getActiveTeamIds includes the candidate team id', () => {
      createTeam(testDb.db, { id: 't-live', name: 'long-running-acp' })
      backdateTeamCreatedAt(testDb.db, 't-live', 3600)
      createTeam(testDb.db, { id: 't-dead', name: 'truly-orphan' })
      backdateTeamCreatedAt(testDb.db, 't-dead', 3600)

      const reaper = createTeamReaper({
        db: testDb.db,
        eventLog,
        options: {
          graceMs: 60_000,
          // Spawner reports t-live as still hosting a live ACP member —
          // even though DB heuristics say it's idle (no working/idle member,
          // no recent message), the reaper must leave it alone.
          getActiveTeamIds: () => new Set(['t-live']),
        },
      })
      const result = reaper.reapOnce()

      expect(result.teams_reaped).toBe(1)
      expect(result.team_ids).toEqual(['t-dead'])
      expect(findTeamById(testDb.db, 't-live')?.archived_at).toBeNull()
      expect(findTeamById(testDb.db, 't-dead')?.archived_at).not.toBeNull()
    })

    it('archives normally when getActiveTeamIds is empty', () => {
      createTeam(testDb.db, { id: 't1', name: 'orphan' })
      backdateTeamCreatedAt(testDb.db, 't1', 3600)

      const reaper = createTeamReaper({
        db: testDb.db,
        eventLog,
        options: {
          graceMs: 60_000,
          getActiveTeamIds: () => new Set(),
        },
      })
      expect(reaper.reapOnce().teams_reaped).toBe(1)
    })

    it('overrides a stale exemption once the team passes exemptionMaxAgeMs', () => {
      // A crashed ACP child lingers in the spawner map forever, so without a
      // floor this team is skipped on every pass and its worktree leaks.
      createTeam(testDb.db, { id: 't-husk', name: 'stale-acp-husk' })
      backdateTeamCreatedAt(testDb.db, 't-husk', 7200)

      const reaper = createTeamReaper({
        db: testDb.db,
        eventLog,
        options: {
          graceMs: 60_000,
          exemptionMaxAgeMs: 3_600_000,
          getActiveTeamIds: () => new Set(['t-husk']),
        },
      })
      const result = reaper.reapOnce()

      expect(result.teams_reaped).toBe(1)
      expect(result.team_ids).toEqual(['t-husk'])
      expect(findTeamById(testDb.db, 't-husk')?.archived_at).not.toBeNull()
    })

    it('honors the exemption while the team is younger than exemptionMaxAgeMs', () => {
      createTeam(testDb.db, { id: 't-live', name: 'busy-acp' })
      backdateTeamCreatedAt(testDb.db, 't-live', 600)

      const reaper = createTeamReaper({
        db: testDb.db,
        eventLog,
        options: {
          graceMs: 60_000,
          exemptionMaxAgeMs: 3_600_000,
          getActiveTeamIds: () => new Set(['t-live']),
        },
      })

      expect(reaper.reapOnce().teams_reaped).toBe(0)
      expect(findTeamById(testDb.db, 't-live')?.archived_at).toBeNull()
    })

    it('treats exemptionMaxAgeMs of 0 as an unconditional exemption', () => {
      createTeam(testDb.db, { id: 't-live', name: 'ancient-acp' })
      backdateTeamCreatedAt(testDb.db, 't-live', 864_000)

      const reaper = createTeamReaper({
        db: testDb.db,
        eventLog,
        options: {
          graceMs: 60_000,
          exemptionMaxAgeMs: 0,
          getActiveTeamIds: () => new Set(['t-live']),
        },
      })

      expect(reaper.reapOnce().teams_reaped).toBe(0)
      expect(findTeamById(testDb.db, 't-live')?.archived_at).toBeNull()
    })

    it('defaults the exemption floor to 24h so ordinary live teams are safe', () => {
      createTeam(testDb.db, { id: 't-live', name: 'day-old-acp' })
      backdateTeamCreatedAt(testDb.db, 't-live', 3600)
      createTeam(testDb.db, { id: 't-husk', name: 'week-old-husk' })
      backdateTeamCreatedAt(testDb.db, 't-husk', 604_800)

      const reaper = createTeamReaper({
        db: testDb.db,
        eventLog,
        options: {
          graceMs: 60_000,
          getActiveTeamIds: () => new Set(['t-live', 't-husk']),
        },
      })
      const result = reaper.reapOnce()

      expect(result.team_ids).toEqual(['t-husk'])
      expect(findTeamById(testDb.db, 't-live')?.archived_at).toBeNull()
    })
  })

  describe('Task 43: onTeamArchived hook', () => {
    it('invokes onTeamArchived once per reaped team, after archive', () => {
      createTeam(testDb.db, { id: 't-a', name: 'orphan-a' })
      createTeam(testDb.db, { id: 't-b', name: 'orphan-b' })
      backdateTeamCreatedAt(testDb.db, 't-a', 3600)
      backdateTeamCreatedAt(testDb.db, 't-b', 3600)

      const archivedSeen: string[] = []
      const reaper = createTeamReaper({
        db: testDb.db,
        eventLog,
        options: {
          graceMs: 60_000,
          onTeamArchived: (teamId) => {
            // Sanity: the row MUST already be archived when the hook fires,
            // otherwise the worktree-manager could rm under a still-live
            // team_members row.
            const row = findTeamById(testDb.db, teamId)
            expect(row?.archived_at).not.toBeNull()
            archivedSeen.push(teamId)
          },
        },
      })

      const result = reaper.reapOnce()
      expect(result.teams_reaped).toBe(2)
      expect(archivedSeen.sort()).toEqual(['t-a', 't-b'])
    })

    it('does NOT invoke onTeamArchived for teams that are NOT reaped', () => {
      createTeam(testDb.db, { id: 't-live', name: 'long-running-acp' })
      createTeam(testDb.db, { id: 't-dead', name: 'truly-orphan' })
      backdateTeamCreatedAt(testDb.db, 't-live', 3600)
      backdateTeamCreatedAt(testDb.db, 't-dead', 3600)

      const archivedSeen: string[] = []
      const reaper = createTeamReaper({
        db: testDb.db,
        eventLog,
        options: {
          graceMs: 60_000,
          getActiveTeamIds: () => new Set(['t-live']),
          onTeamArchived: (teamId) => archivedSeen.push(teamId),
        },
      })

      reaper.reapOnce()
      expect(archivedSeen).toEqual(['t-dead'])
    })

    it('swallows hook errors and continues reaping other teams', () => {
      createTeam(testDb.db, { id: 't-1', name: 'first' })
      createTeam(testDb.db, { id: 't-2', name: 'second' })
      backdateTeamCreatedAt(testDb.db, 't-1', 3600)
      backdateTeamCreatedAt(testDb.db, 't-2', 3600)

      const archivedSeen: string[] = []
      const reaper = createTeamReaper({
        db: testDb.db,
        eventLog,
        options: {
          graceMs: 60_000,
          onTeamArchived: (teamId) => {
            archivedSeen.push(teamId)
            if (teamId === 't-1') {
              throw new Error('simulated worktree-manager rm failure')
            }
          },
        },
      })

      const result = reaper.reapOnce()
      // Both teams are still archived (the hook does not gate the reap).
      expect(result.teams_reaped).toBe(2)
      // Both hook calls were attempted despite the first one throwing.
      expect(archivedSeen.sort()).toEqual(['t-1', 't-2'])
      expect(findTeamById(testDb.db, 't-1')?.archived_at).not.toBeNull()
      expect(findTeamById(testDb.db, 't-2')?.archived_at).not.toBeNull()
    })
  })
})
