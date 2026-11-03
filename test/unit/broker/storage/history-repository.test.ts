import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { TestDb } from '../../../helpers/db-harness.js'
import { createBrokerTestDb } from '../../../helpers/broker-db-harness.js'
import {
  purgeTeamToHistory,
  purgeSessionToHistory,
  queryTeamHistory,
  querySessionHistory,
  queryTaskHistory,
  queryMessageHistory,
  deleteExpiredHistory,
  countHistoryRecords,
} from '../../../../src/broker/storage/repositories/history-repository.js'

describe('HistoryRepository', () => {
  let testDb: TestDb

  beforeEach(() => {
    testDb = createBrokerTestDb()
  })

  afterEach(() => {
    testDb.close()
  })

  // ── Seed helpers ───────────────────────────────────────────────────

  function seedSession(id: string, purpose = 'test') {
    testDb.db
      .prepare("INSERT INTO sessions (id, purpose, working_dir) VALUES (?, ?, '/')")
      .run(id, purpose)
  }

  function seedTeam(id: string, name: string, description: string | null = null) {
    testDb.db
      .prepare('INSERT INTO teams (id, name, description) VALUES (?, ?, ?)')
      .run(id, name, description)
  }

  function seedTeamMember(
    teamId: string,
    sessionId: string,
    name: string,
    role = 'dev',
    agentType = 'claude',
  ) {
    testDb.db
      .prepare(
        'INSERT INTO team_members (team_id, session_id, name, role, agent_type) VALUES (?, ?, ?, ?, ?)',
      )
      .run(teamId, sessionId, name, role, agentType)
  }

  function seedTask(teamId: string, subject: string, opts?: { owner?: string; status?: string }) {
    return testDb.db
      .prepare('INSERT INTO tasks (team_id, subject, owner, status) VALUES (?, ?, ?, ?)')
      .run(teamId, subject, opts?.owner ?? null, opts?.status ?? 'pending')
  }

  function seedMessage(
    id: string,
    senderId: string,
    receiverId: string,
    content: string,
    storyId: string | null = null,
    opts?: { read?: boolean },
  ) {
    testDb.db
      .prepare(
        'INSERT INTO messages (id, sender_id, receiver_id, content, story_id, read_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, senderId, receiverId, content, storyId, opts?.read ? new Date().toISOString() : null)
  }

  function seedFullTeam() {
    seedSession('s1', 'worker-1')
    seedSession('s2', 'worker-2')
    seedTeam('t1', 'alpha-team', 'The alpha team')
    seedTeamMember('t1', 's1', 'alice', 'lead', 'claude')
    seedTeamMember('t1', 's2', 'bob', 'dev', 'claude')
    seedTask('t1', 'Build API', { owner: 's1', status: 'completed' })
    seedTask('t1', 'Write tests', { owner: 's2', status: 'in_progress' })
    // Read (settled) correspondence — issue #70: a team purge only settles
    // read/disposed or team-scoped messages; unread directed mail stays live.
    seedMessage('m1', 's1', 's2', 'Hello bob', null, { read: true })
    seedMessage('m2', 's2', 's1', 'Hello alice', null, { read: true })
    seedMessage('m3', 's1', 's2', 'Status update', null, { read: true })
  }

  // ── purgeTeamToHistory ─────────────────────────────────────────────

  describe('purgeTeamToHistory', () => {
    it('returns null for non-existent team', () => {
      expect(purgeTeamToHistory(testDb.db, 'no-such-team')).toBeNull()
    })

    it('archives team, members, tasks, and messages to history', () => {
      seedFullTeam()

      const result = purgeTeamToHistory(testDb.db, 't1')

      expect(result).not.toBeNull()
      expect(result!.team_id).toBe('t1')
      expect(result!.team_name).toBe('alpha-team')
      expect(result!.members_archived).toBe(2)
      expect(result!.tasks_archived).toBe(2)
      expect(result!.messages_archived).toBe(3)
    })

    it('inserts team record into teams_history with member and task summaries', () => {
      seedFullTeam()

      purgeTeamToHistory(testDb.db, 't1')

      const row = testDb.db.prepare('SELECT * FROM teams_history WHERE id = ?').get('t1') as Record<
        string,
        unknown
      >
      expect(row).toBeDefined()
      expect(row.name).toBe('alpha-team')
      expect(row.description).toBe('The alpha team')
      expect(row.purged_at).toBeTruthy()

      const memberSummary = JSON.parse(row.member_summary as string) as unknown[]
      expect(memberSummary).toHaveLength(2)

      const taskSummary = JSON.parse(row.task_summary as string) as unknown[]
      expect(taskSummary).toHaveLength(2)
    })

    it('inserts tasks into tasks_history with team_name', () => {
      seedFullTeam()

      purgeTeamToHistory(testDb.db, 't1')

      const rows = testDb.db
        .prepare('SELECT * FROM tasks_history WHERE team_id = ?')
        .all('t1') as Array<Record<string, unknown>>
      expect(rows).toHaveLength(2)
      expect(rows[0]!.team_name).toBe('alpha-team')
    })

    it('inserts messages into messages_history', () => {
      seedFullTeam()

      purgeTeamToHistory(testDb.db, 't1')

      const rows = testDb.db.prepare('SELECT * FROM messages_history').all()
      expect(rows).toHaveLength(3)
    })

    it('removes team and related data from active tables', () => {
      seedFullTeam()

      purgeTeamToHistory(testDb.db, 't1')

      const team = testDb.db.prepare('SELECT * FROM teams WHERE id = ?').get('t1')
      expect(team).toBeUndefined()

      const members = testDb.db.prepare('SELECT * FROM team_members WHERE team_id = ?').all('t1')
      expect(members).toHaveLength(0)

      const tasks = testDb.db.prepare('SELECT * FROM tasks WHERE team_id = ?').all('t1')
      expect(tasks).toHaveLength(0)

      const msgs = testDb.db.prepare('SELECT * FROM messages').all()
      expect(msgs).toHaveLength(0)
    })

    it('deletes task_dependencies for purged tasks', () => {
      seedFullTeam()
      // Grab task IDs and create a dependency
      const allTasks = testDb.db
        .prepare('SELECT id FROM tasks WHERE team_id = ?')
        .all('t1') as Array<{ id: number }>
      testDb.db
        .prepare('INSERT INTO task_dependencies (task_id, depends_on) VALUES (?, ?)')
        .run(allTasks[1]!.id, allTasks[0]!.id)

      purgeTeamToHistory(testDb.db, 't1')

      const deps = testDb.db.prepare('SELECT * FROM task_dependencies').all()
      expect(deps).toHaveLength(0)
    })

    it('deletes respawn_policies for purged team', () => {
      seedFullTeam()
      testDb.db
        .prepare('INSERT INTO respawn_policies (team_id, role) VALUES (?, ?)')
        .run('t1', 'dev')

      purgeTeamToHistory(testDb.db, 't1')

      const rows = testDb.db.prepare('SELECT * FROM respawn_policies WHERE team_id = ?').all('t1')
      expect(rows).toHaveLength(0)
    })

    it('deletes scaling_policies and usage_records for purged team', () => {
      seedFullTeam()
      testDb.db
        .prepare('INSERT INTO scaling_policies (team_id, role) VALUES (?, ?)')
        .run('t1', 'dev')
      testDb.db
        .prepare(
          'INSERT INTO usage_records (session_id, team_id, tokens_in, tokens_out) VALUES (?, ?, 100, 50)',
        )
        .run('s1', 't1')

      purgeTeamToHistory(testDb.db, 't1')

      expect(
        testDb.db.prepare('SELECT * FROM scaling_policies WHERE team_id = ?').all('t1'),
      ).toHaveLength(0)
      expect(
        testDb.db.prepare('SELECT * FROM usage_records WHERE team_id = ?').all('t1'),
      ).toHaveLength(0)
    })

    it('deduplicates messages shared between members', () => {
      seedSession('s1')
      seedSession('s2')
      seedTeam('t1', 'dup-team')
      seedTeamMember('t1', 's1', 'alice')
      seedTeamMember('t1', 's2', 'bob')
      // m1 involves both s1 (sender) and s2 (receiver); read so it settles
      seedMessage('m1', 's1', 's2', 'shared msg', null, { read: true })

      const result = purgeTeamToHistory(testDb.db, 't1')

      // m1 should only be archived once despite matching both member sessions
      expect(result!.messages_archived).toBe(1)
      const historyMsgs = testDb.db.prepare('SELECT * FROM messages_history').all()
      expect(historyMsgs).toHaveLength(1)
    })

    it('retains unread directed member mail — a team purge never empties a live inbox (issue #70)', () => {
      seedSession('s1')
      seedSession('s2')
      seedSession('outsider')
      seedTeam('t1', 'retain-team')
      seedTeamMember('t1', 's1', 'alice')
      seedTeamMember('t1', 's2', 'bob')
      seedMessage('unread-internal', 's1', 's2', 'not yet read')
      seedMessage('unread-outbound', 's1', 'outsider', 'for the outsider')
      seedMessage('settled', 's1', 's2', 'already read', null, { read: true })

      const result = purgeTeamToHistory(testDb.db, 't1')

      expect(result!.messages_archived).toBe(1)
      // Both unread directed messages survive in the live queue, private to
      // their recipients (member sessions are NOT deleted by a team purge).
      const live = testDb.db
        .prepare('SELECT id, receiver_id FROM messages ORDER BY id')
        .all() as Array<{ id: string; receiver_id: string }>
      expect(live.map((m) => m.id)).toEqual(['unread-internal', 'unread-outbound'])
      expect(live[0]!.receiver_id).toBe('s2')
      expect(live[1]!.receiver_id).toBe('outsider')
    })

    it('handles team with no members, tasks, or messages', () => {
      seedTeam('t-empty', 'empty-team')

      const result = purgeTeamToHistory(testDb.db, 't-empty')

      expect(result).not.toBeNull()
      expect(result!.team_name).toBe('empty-team')
      expect(result!.members_archived).toBe(0)
      expect(result!.tasks_archived).toBe(0)
      expect(result!.messages_archived).toBe(0)

      const teamHist = testDb.db.prepare('SELECT * FROM teams_history WHERE id = ?').get('t-empty')
      expect(teamHist).toBeDefined()
    })

    it('does not affect other teams', () => {
      seedFullTeam()
      seedSession('s3')
      seedTeam('t2', 'beta-team')
      seedTeamMember('t2', 's3', 'charlie')
      seedTask('t2', 'Other task')

      purgeTeamToHistory(testDb.db, 't1')

      expect(testDb.db.prepare('SELECT * FROM teams WHERE id = ?').get('t2')).toBeDefined()
      expect(
        testDb.db.prepare('SELECT * FROM team_members WHERE team_id = ?').all('t2'),
      ).toHaveLength(1)
      expect(testDb.db.prepare('SELECT * FROM tasks WHERE team_id = ?').all('t2')).toHaveLength(1)
    })
  })

  // ── purgeSessionToHistory ──────────────────────────────────────────

  describe('purgeSessionToHistory', () => {
    it('returns null for non-existent session', () => {
      expect(purgeSessionToHistory(testDb.db, 'no-such')).toBeNull()
    })

    it('archives session messages and inserts into sessions_history', () => {
      seedSession('s1')
      seedSession('s2')
      seedMessage('m1', 's1', 's2', 'hello', null, { read: true })
      seedMessage('m2', 's2', 's1', 'reply')

      const result = purgeSessionToHistory(testDb.db, 's1')

      expect(result).not.toBeNull()
      expect(result!.session_id).toBe('s1')
      expect(result!.messages_archived).toBe(2)
      expect(result!.deferred).toBe(false)
    })

    it('inserts session record into sessions_history', () => {
      seedSession('s1')

      purgeSessionToHistory(testDb.db, 's1')

      const row = testDb.db
        .prepare('SELECT * FROM sessions_history WHERE id = ?')
        .get('s1') as Record<string, unknown>
      expect(row).toBeDefined()
      expect(row.purpose).toBe('test')
      expect(row.purged_at).toBeTruthy()
    })

    it('includes team_name in sessions_history when session belongs to a team', () => {
      seedSession('s1')
      seedTeam('t1', 'gamma-team')
      seedTeamMember('t1', 's1', 'dev-1')

      purgeSessionToHistory(testDb.db, 's1')

      const row = testDb.db
        .prepare('SELECT * FROM sessions_history WHERE id = ?')
        .get('s1') as Record<string, unknown>
      expect(row.team_name).toBe('gamma-team')
    })

    it('sets team_name to null when session has no team', () => {
      seedSession('s1')

      purgeSessionToHistory(testDb.db, 's1')

      const row = testDb.db
        .prepare('SELECT * FROM sessions_history WHERE id = ?')
        .get('s1') as Record<string, unknown>
      expect(row.team_name).toBeNull()
    })

    it('removes session and settled messages from active tables', () => {
      seedSession('s1')
      seedSession('s2')
      seedMessage('m1', 's1', 's2', 'bye', null, { read: true })

      purgeSessionToHistory(testDb.db, 's1')

      expect(testDb.db.prepare('SELECT * FROM sessions WHERE id = ?').get('s1')).toBeUndefined()
      expect(
        testDb.db
          .prepare('SELECT * FROM messages WHERE sender_id = ? OR receiver_id = ?')
          .all('s1', 's1'),
      ).toHaveLength(0)
    })

    it('cleans up file_intents and shared_state for the session', () => {
      seedSession('s1')
      testDb.db
        .prepare(
          "INSERT INTO file_intents (file_path, session_id, intent) VALUES ('/a.ts', 's1', 'edit')",
        )
        .run()
      testDb.db
        .prepare("INSERT INTO shared_state (key, value, session_id) VALUES ('k1', '\"v1\"', 's1')")
        .run()

      purgeSessionToHistory(testDb.db, 's1')

      expect(
        testDb.db.prepare("SELECT * FROM file_intents WHERE session_id = 's1'").all(),
      ).toHaveLength(0)
      expect(
        testDb.db.prepare("SELECT * FROM shared_state WHERE session_id = 's1'").all(),
      ).toHaveLength(0)
    })

    it('defers the purge while unread directed mail to a live participant exists (issue #70)', () => {
      seedSession('s1')
      seedSession('s2')
      seedMessage('pending', 's1', 's2', 'unread finding')

      const result = purgeSessionToHistory(testDb.db, 's1')

      expect(result!.deferred).toBe(true)
      expect(result!.messages_retained).toBe(1)
      // Identity row retained (expired) so the mail keeps its sender and
      // stays private to s2 — never leaked to broadcast via SET NULL.
      const session = testDb.db.prepare("SELECT status FROM sessions WHERE id = 's1'").get() as {
        status: string
      }
      expect(session.status).toBe('expired')
      const live = testDb.db
        .prepare("SELECT sender_id, receiver_id FROM messages WHERE id = 'pending'")
        .get() as { sender_id: string; receiver_id: string }
      expect(live).toEqual({ sender_id: 's1', receiver_id: 's2' })
      expect(
        testDb.db.prepare("SELECT id FROM sessions_history WHERE id = 's1'").all(),
      ).toHaveLength(0)
    })

    it('handles session with no messages', () => {
      seedSession('s1')

      const result = purgeSessionToHistory(testDb.db, 's1')

      expect(result!.messages_archived).toBe(0)
    })

    it('does not affect other sessions', () => {
      seedSession('s1')
      seedSession('s2')
      seedMessage('m1', 's2', 's2', 'self-msg')

      purgeSessionToHistory(testDb.db, 's1')

      expect(testDb.db.prepare('SELECT * FROM sessions WHERE id = ?').get('s2')).toBeDefined()
      expect(testDb.db.prepare('SELECT * FROM messages WHERE id = ?').get('m1')).toBeDefined()
    })

    it('archives messages even when history already has same id (no unique constraint)', () => {
      seedSession('s1')
      seedSession('s2')
      seedMessage('m1', 's1', 's2', 'hello', null, { read: true })

      // Pre-insert into history — messages_history.id is NOT UNIQUE
      testDb.db
        .prepare(
          "INSERT INTO messages_history (id, sender_id, receiver_id, content, created_at) VALUES ('m1', 's1', 's2', 'hello', datetime('now'))",
        )
        .run()

      const result = purgeSessionToHistory(testDb.db, 's1')

      // Insert succeeds since there's no unique constraint on messages_history.id
      expect(result!.messages_archived).toBe(1)
      const rows = testDb.db.prepare('SELECT * FROM messages_history').all()
      expect(rows).toHaveLength(2)
    })
  })

  // ── queryTeamHistory ───────────────────────────────────────────────

  describe('queryTeamHistory', () => {
    function insertTeamHistory(id: string, name: string, purgedAt?: string) {
      testDb.db
        .prepare(
          `INSERT INTO teams_history (id, name, purged_at) VALUES (?, ?, ${purgedAt ? '?' : "datetime('now')"})`,
        )
        .run(...(purgedAt ? [id, name, purgedAt] : [id, name]))
    }

    it('returns empty array when no history exists', () => {
      expect(queryTeamHistory(testDb.db)).toEqual([])
    })

    it('returns all team history records', () => {
      insertTeamHistory('t1', 'alpha')
      insertTeamHistory('t2', 'beta')

      const rows = queryTeamHistory(testDb.db)
      expect(rows).toHaveLength(2)
    })

    it('respects limit option', () => {
      insertTeamHistory('t1', 'a')
      insertTeamHistory('t2', 'b')
      insertTeamHistory('t3', 'c')

      expect(queryTeamHistory(testDb.db, { limit: 2 })).toHaveLength(2)
    })

    it('defaults to limit of 50', () => {
      for (let i = 0; i < 55; i++) {
        insertTeamHistory(`t${i}`, `team-${i}`)
      }
      expect(queryTeamHistory(testDb.db)).toHaveLength(50)
    })

    it('filters by name (LIKE)', () => {
      insertTeamHistory('t1', 'alpha-team')
      insertTeamHistory('t2', 'beta-team')

      const rows = queryTeamHistory(testDb.db, { name: 'alpha' })
      expect(rows).toHaveLength(1)
      expect(rows[0]!.name).toBe('alpha-team')
    })

    it('filters by since date', () => {
      insertTeamHistory('t-old', 'old', '2020-01-01 00:00:00')
      insertTeamHistory('t-new', 'new', '2025-06-01 00:00:00')

      const rows = queryTeamHistory(testDb.db, { since: '2024-01-01' })
      expect(rows).toHaveLength(1)
      expect(rows[0]!.name).toBe('new')
    })

    it('combines name and since filters', () => {
      insertTeamHistory('t1', 'alpha-old', '2020-01-01 00:00:00')
      insertTeamHistory('t2', 'alpha-new', '2025-06-01 00:00:00')
      insertTeamHistory('t3', 'beta-new', '2025-06-01 00:00:00')

      const rows = queryTeamHistory(testDb.db, { since: '2024-01-01', name: 'alpha' })
      expect(rows).toHaveLength(1)
      expect(rows[0]!.name).toBe('alpha-new')
    })

    it('returns immutable copies', () => {
      insertTeamHistory('t1', 'test')
      const rows = queryTeamHistory(testDb.db)
      expect(rows[0]).toBeDefined()
      expect(rows[0]!.id).toBe('t1')
    })
  })

  // ── querySessionHistory ────────────────────────────────────────────

  describe('querySessionHistory', () => {
    function insertSessionHistory(id: string, purpose: string, purgedAt?: string) {
      testDb.db
        .prepare(
          `INSERT INTO sessions_history (id, purpose, purged_at) VALUES (?, ?, ${purgedAt ? '?' : "datetime('now')"})`,
        )
        .run(...(purgedAt ? [id, purpose, purgedAt] : [id, purpose]))
    }

    it('returns empty array when no history exists', () => {
      expect(querySessionHistory(testDb.db)).toEqual([])
    })

    it('returns all session history records', () => {
      insertSessionHistory('s1', 'dev')
      insertSessionHistory('s2', 'qa')

      expect(querySessionHistory(testDb.db)).toHaveLength(2)
    })

    it('respects limit option', () => {
      insertSessionHistory('s1', 'a')
      insertSessionHistory('s2', 'b')
      insertSessionHistory('s3', 'c')

      expect(querySessionHistory(testDb.db, { limit: 1 })).toHaveLength(1)
    })

    it('filters by since date', () => {
      insertSessionHistory('s-old', 'old', '2020-01-01 00:00:00')
      insertSessionHistory('s-new', 'new', '2025-06-01 00:00:00')

      const rows = querySessionHistory(testDb.db, { since: '2024-01-01' })
      expect(rows).toHaveLength(1)
      expect(rows[0]!.purpose).toBe('new')
    })

    it('ignores name filter (not used for sessions)', () => {
      insertSessionHistory('s1', 'test')
      // querySessionHistory doesn't have name filter — should return all
      const rows = querySessionHistory(testDb.db, { name: 'anything' })
      expect(rows).toHaveLength(1)
    })
  })

  // ── queryTaskHistory ───────────────────────────────────────────────

  describe('queryTaskHistory', () => {
    function insertTaskHistory(teamId: string, subject: string) {
      testDb.db
        .prepare(
          "INSERT INTO tasks_history (id, team_id, subject, team_name) VALUES (abs(random()), ?, ?, 'team')",
        )
        .run(teamId, subject)
    }

    it('returns empty array when no history', () => {
      expect(queryTaskHistory(testDb.db)).toEqual([])
    })

    it('returns all task history', () => {
      insertTaskHistory('t1', 'task-a')
      insertTaskHistory('t2', 'task-b')

      expect(queryTaskHistory(testDb.db)).toHaveLength(2)
    })

    it('filters by teamId', () => {
      insertTaskHistory('t1', 'task-a')
      insertTaskHistory('t2', 'task-b')

      const rows = queryTaskHistory(testDb.db, 't1')
      expect(rows).toHaveLength(1)
      expect(rows[0]!.subject).toBe('task-a')
    })

    it('respects limit', () => {
      insertTaskHistory('t1', 'task-a')
      insertTaskHistory('t1', 'task-b')
      insertTaskHistory('t1', 'task-c')

      expect(queryTaskHistory(testDb.db, 't1', 2)).toHaveLength(2)
    })

    it('defaults to limit of 50', () => {
      for (let i = 0; i < 55; i++) {
        insertTaskHistory('t1', `task-${i}`)
      }
      expect(queryTaskHistory(testDb.db, 't1')).toHaveLength(50)
    })

    it('returns all teams when teamId is undefined', () => {
      insertTaskHistory('t1', 'a')
      insertTaskHistory('t2', 'b')

      expect(queryTaskHistory(testDb.db, undefined, 100)).toHaveLength(2)
    })
  })

  // ── queryMessageHistory ────────────────────────────────────────────

  describe('queryMessageHistory', () => {
    function insertMsgHistory(id: string, senderId: string, receiverId: string, content: string) {
      testDb.db
        .prepare(
          'INSERT INTO messages_history (id, sender_id, receiver_id, content) VALUES (?, ?, ?, ?)',
        )
        .run(id, senderId, receiverId, content)
    }

    it('returns empty array when no history', () => {
      expect(queryMessageHistory(testDb.db)).toEqual([])
    })

    it('returns all message history', () => {
      insertMsgHistory('m1', 's1', 's2', 'hello')
      insertMsgHistory('m2', 's2', 's1', 'world')

      expect(queryMessageHistory(testDb.db)).toHaveLength(2)
    })

    it('filters by sessionId (sender or receiver)', () => {
      insertMsgHistory('m1', 's1', 's2', 'from s1')
      insertMsgHistory('m2', 's3', 's1', 'to s1')
      insertMsgHistory('m3', 's2', 's3', 'no s1')

      const rows = queryMessageHistory(testDb.db, 's1')
      expect(rows).toHaveLength(2)
    })

    it('respects limit', () => {
      insertMsgHistory('m1', 's1', 's2', 'a')
      insertMsgHistory('m2', 's1', 's2', 'b')
      insertMsgHistory('m3', 's1', 's2', 'c')

      expect(queryMessageHistory(testDb.db, 's1', 2)).toHaveLength(2)
    })

    it('defaults to limit of 50', () => {
      for (let i = 0; i < 55; i++) {
        insertMsgHistory(`m${i}`, 's1', 's2', `msg-${i}`)
      }
      expect(queryMessageHistory(testDb.db)).toHaveLength(50)
    })
  })

  // ── deleteExpiredHistory ───────────────────────────────────────────

  describe('deleteExpiredHistory', () => {
    function insertOldHistory(daysAgo: number) {
      const sql = (table: string, cols: string, vals: string) =>
        `INSERT INTO ${table} (${cols}, purged_at) VALUES (${vals}, datetime('now', '-${daysAgo} days', '-1 hour'))`

      testDb.db.exec(sql('teams_history', 'id, name', "'t-old', 'old-team'"))
      testDb.db.exec(sql('sessions_history', 'id, purpose', "'s-old', 'old-session'"))
      testDb.db.exec(sql('tasks_history', 'id, team_id, subject', "999, 't-old', 'old-task'"))
      testDb.db.exec(sql('messages_history', 'id, content', "'m-old', 'old-msg'"))
    }

    function insertRecentHistory() {
      testDb.db.exec("INSERT INTO teams_history (id, name) VALUES ('t-new', 'new-team')")
      testDb.db.exec("INSERT INTO sessions_history (id, purpose) VALUES ('s-new', 'new-session')")
      testDb.db.exec(
        "INSERT INTO tasks_history (id, team_id, subject) VALUES (888, 't-new', 'new-task')",
      )
      testDb.db.exec("INSERT INTO messages_history (id, content) VALUES ('m-new', 'new-msg')")
    }

    it('deletes records older than retention days', () => {
      insertOldHistory(10)
      insertRecentHistory()

      const result = deleteExpiredHistory(testDb.db, 7)

      expect(result.teams_deleted).toBe(1)
      expect(result.sessions_deleted).toBe(1)
      expect(result.tasks_deleted).toBe(1)
      expect(result.messages_deleted).toBe(1)

      // Recent records are untouched
      const counts = countHistoryRecords(testDb.db)
      expect(counts.teams).toBe(1)
      expect(counts.sessions).toBe(1)
      expect(counts.tasks).toBe(1)
      expect(counts.messages).toBe(1)
    })

    it('returns zeros when nothing is expired', () => {
      insertRecentHistory()

      const result = deleteExpiredHistory(testDb.db, 7)

      expect(result.teams_deleted).toBe(0)
      expect(result.sessions_deleted).toBe(0)
      expect(result.tasks_deleted).toBe(0)
      expect(result.messages_deleted).toBe(0)
    })

    it('returns zeros on empty tables', () => {
      const result = deleteExpiredHistory(testDb.db)

      expect(result.teams_deleted).toBe(0)
      expect(result.sessions_deleted).toBe(0)
    })

    it('uses default retention of 7 days when not specified', () => {
      insertOldHistory(8)

      const result = deleteExpiredHistory(testDb.db)

      expect(result.teams_deleted).toBe(1)
    })

    it('respects custom retention period', () => {
      insertOldHistory(3)

      // 7 days retention — 3-day-old records should survive
      const result7 = deleteExpiredHistory(testDb.db, 7)
      expect(result7.teams_deleted).toBe(0)

      // 2 days retention — 3-day-old records should be deleted
      const result2 = deleteExpiredHistory(testDb.db, 2)
      expect(result2.teams_deleted).toBe(1)
    })
  })

  // ── countHistoryRecords ────────────────────────────────────────────

  describe('countHistoryRecords', () => {
    it('returns zeros for empty tables', () => {
      const counts = countHistoryRecords(testDb.db)
      expect(counts).toEqual({ teams: 0, sessions: 0, tasks: 0, messages: 0 })
    })

    it('counts records across all history tables', () => {
      testDb.db.exec("INSERT INTO teams_history (id, name) VALUES ('t1', 'a')")
      testDb.db.exec("INSERT INTO teams_history (id, name) VALUES ('t2', 'b')")
      testDb.db.exec("INSERT INTO sessions_history (id) VALUES ('s1')")
      testDb.db.exec("INSERT INTO tasks_history (id, team_id, subject) VALUES (1, 't1', 'x')")
      testDb.db.exec("INSERT INTO tasks_history (id, team_id, subject) VALUES (2, 't1', 'y')")
      testDb.db.exec("INSERT INTO tasks_history (id, team_id, subject) VALUES (3, 't2', 'z')")
      testDb.db.exec("INSERT INTO messages_history (id, content) VALUES ('m1', 'hi')")

      const counts = countHistoryRecords(testDb.db)
      expect(counts.teams).toBe(2)
      expect(counts.sessions).toBe(1)
      expect(counts.tasks).toBe(3)
      expect(counts.messages).toBe(1)
    })
  })

  // ── Integration: purge then query ──────────────────────────────────

  describe('end-to-end: purge → query → count', () => {
    it('purged data is queryable from history', () => {
      seedFullTeam()

      purgeTeamToHistory(testDb.db, 't1')

      const teams = queryTeamHistory(testDb.db)
      expect(teams).toHaveLength(1)
      expect(teams[0]!.name).toBe('alpha-team')

      const tasks = queryTaskHistory(testDb.db, 't1')
      expect(tasks).toHaveLength(2)

      const msgs = queryMessageHistory(testDb.db)
      expect(msgs).toHaveLength(3)

      const counts = countHistoryRecords(testDb.db)
      expect(counts.teams).toBe(1)
      expect(counts.tasks).toBe(2)
      expect(counts.messages).toBe(3)
    })

    it('purged session is queryable from session history', () => {
      seedSession('s1')
      seedSession('s2')
      seedMessage('m1', 's1', 's2', 'msg', null, { read: true })

      purgeSessionToHistory(testDb.db, 's1')

      const sessions = querySessionHistory(testDb.db)
      expect(sessions).toHaveLength(1)
      expect(sessions[0]!.id).toBe('s1')

      const msgs = queryMessageHistory(testDb.db, 's1')
      expect(msgs).toHaveLength(1)
    })
  })
})
