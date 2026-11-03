import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createBrokerTestDb } from '../../helpers/broker-db-harness.js'
import type { TestDb } from '../../helpers/db-harness.js'
import {
  snapshotActiveAgents,
  recoverAgents,
  loadPendingSnapshots,
  remapSessionReferences,
  expireOldSnapshots,
  type ActiveAgentInfo,
} from '../../../src/broker/services/session-recovery.js'

/**
 * Integration tests for session recovery lifecycle.
 * Uses real SQLite to verify the full snapshot → cleanup → recover → verify flow.
 */
describe('session-recovery integration', () => {
  let testDb: TestDb

  beforeEach(() => {
    testDb = createBrokerTestDb()
  })

  afterEach(() => {
    testDb.close()
  })

  function seedSession(id: string, purpose: string, workingDir = '/project'): void {
    testDb.db
      .prepare(
        `INSERT INTO sessions (id, purpose, working_dir, worktree, status)
         VALUES (?, ?, ?, NULL, 'active')`,
      )
      .run(id, purpose, workingDir)
  }

  function seedTeam(id: string, name: string): void {
    testDb.db
      .prepare("INSERT INTO teams (id, name, status) VALUES (?, ?, 'active')")
      .run(id, name)
  }

  function seedTeamMember(teamId: string, sessionId: string, name: string, role = 'dev'): void {
    testDb.db
      .prepare(
        `INSERT INTO team_members (team_id, session_id, name, role, agent_type)
         VALUES (?, ?, ?, ?, 'teammate')`,
      )
      .run(teamId, sessionId, name, role)
  }

  function seedTask(
    teamId: string,
    subject: string,
    status = 'pending',
    owner?: string,
  ): number {
    const result = testDb.db
      .prepare('INSERT INTO tasks (team_id, seq, subject, status, owner) VALUES (?, 1, ?, ?, ?)')
      .run(teamId, subject, status, owner ?? null)
    return Number(result.lastInsertRowid)
  }

  function seedMessage(
    id: string,
    senderId: string,
    receiverId: string,
    content: string,
  ): void {
    testDb.db
      .prepare(
        `INSERT INTO messages (id, sender_id, receiver_id, content, story_id)
         VALUES (?, ?, ?, ?, NULL)`,
      )
      .run(id, senderId, receiverId, content)
  }

  it('full lifecycle: snapshot → simulate cleanup → recover → verify', async () => {
    // ── Setup: Create a team with 2 agents and tasks ──
    seedTeam('team-alpha', 'Alpha Team')
    seedSession('agent-dev-1', 'dev agent for team-alpha: implement auth', '/project')
    seedSession('agent-qa-1', 'qa agent for team-alpha: test auth', '/project')
    seedTeamMember('team-alpha', 'agent-dev-1', 'dev-worker', 'dev')
    seedTeamMember('team-alpha', 'agent-qa-1', 'qa-worker', 'qa')

    const _task1 = seedTask('team-alpha', 'Implement JWT auth', 'in_progress', 'agent-dev-1')
    const _task2 = seedTask('team-alpha', 'Write auth tests', 'pending', 'agent-qa-1')
    seedMessage('msg-1', 'agent-qa-1', 'agent-dev-1', 'Need the auth API before I can test')
    seedMessage('msg-2', 'agent-dev-1', 'agent-qa-1', 'Almost done, will notify')

    const activeAgents: ActiveAgentInfo[] = [
      {
        sessionId: 'agent-dev-1',
        teamId: 'team-alpha',
        name: 'dev-worker',
        role: 'dev',
        launchMethod: 'acp',
        workingDir: '/project',
      },
      {
        sessionId: 'agent-qa-1',
        teamId: 'team-alpha',
        name: 'qa-worker',
        role: 'qa',
        launchMethod: 'detached',
        workingDir: '/project',
      },
    ]

    // ── Phase 1: Snapshot ──
    const snapshots = snapshotActiveAgents(testDb.db, activeAgents)
    expect(snapshots).toHaveLength(2)

    // Verify snapshots persisted to DB
    const dbSnapshots = loadPendingSnapshots(testDb.db)
    expect(dbSnapshots).toHaveLength(2)

    // ── Phase 2: Simulate broker restart cleanup ──
    // Delete sessions, teams, tasks (mimics cleanupStaleSessionsOnStartup)
    testDb.db.prepare('DELETE FROM team_members').run()
    testDb.db.prepare('DELETE FROM messages').run()
    testDb.db.prepare('DELETE FROM sessions').run()
    testDb.db.prepare('DELETE FROM teams').run()
    // Note: tasks survive because they ref team_id with CASCADE

    // Verify everything is gone
    const remainingSessions = testDb.db.prepare('SELECT COUNT(*) as cnt FROM sessions').get() as {
      cnt: number
    }
    expect(remainingSessions.cnt).toBe(0)

    // BUT recovery snapshots survive!
    const pendingAfterCleanup = loadPendingSnapshots(testDb.db)
    expect(pendingAfterCleanup).toHaveLength(2)

    // ── Phase 3: Recover ──
    let spawnCount = 0
    const mockSpawn = vi.fn().mockImplementation((input) => {
      spawnCount++
      const newId = `recovered-${input.name}-${spawnCount}`
      // Create the session that spawn() would create
      seedSession(newId, input.prompt?.slice(0, 100) ?? 'recovered', input.working_dir ?? '/project')
      // Create team if needed (recoverAgents does this)
      return Promise.resolve({
        sessionId: newId,
        teamId: input.team_id,
        name: input.name,
        role: input.role ?? 'dev',
        launchMethod: input.launch_method ?? 'acp',
        pid: 1000 + spawnCount,
        tmuxSession: null,
        tmuxWindow: null,
        acpSessionId: null,
      })
    })

    const results = await recoverAgents(testDb.db, mockSpawn, pendingAfterCleanup)

    // ── Phase 4: Verify ──
    expect(results).toHaveLength(2)
    expect(results.every((r) => r.success)).toBe(true)
    expect(mockSpawn).toHaveBeenCalledTimes(2)

    // Recovery prompts include original purpose
    const devSpawnCall = mockSpawn.mock.calls.find(
      (c: any[]) => c[0].name === 'dev-worker-recovered',
    )
    expect(devSpawnCall).toBeDefined()
    expect(devSpawnCall![0].prompt).toContain('implement auth')
    expect(devSpawnCall![0].prompt).toContain('resuming work')

    // Snapshots marked as recovered
    const pending = loadPendingSnapshots(testDb.db)
    expect(pending).toHaveLength(0)

    const recovered = testDb.db
      .prepare("SELECT * FROM recovery_snapshots WHERE status = 'recovered'")
      .all()
    expect(recovered).toHaveLength(2)
  })

  it('recovery creates team if it was cleaned up', async () => {
    seedTeam('team-beta', 'Beta Team')
    seedSession('agent-b1', 'dev agent', '/project')
    seedTeamMember('team-beta', 'agent-b1', 'b-worker')
    seedTask('team-beta', 'Some task', 'in_progress', 'agent-b1')

    snapshotActiveAgents(testDb.db, [
      {
        sessionId: 'agent-b1',
        teamId: 'team-beta',
        name: 'b-worker',
        role: 'dev',
        launchMethod: 'acp',
        workingDir: '/project',
      },
    ])

    // Simulate cleanup
    testDb.db.prepare('DELETE FROM team_members').run()
    testDb.db.prepare('DELETE FROM sessions').run()
    testDb.db.prepare('DELETE FROM teams').run()

    const snapshots = loadPendingSnapshots(testDb.db)
    const mockSpawn = vi.fn().mockResolvedValue({
      sessionId: 'new-b1',
      teamId: 'team-beta',
      name: 'b-worker-recovered',
      role: 'dev',
      launchMethod: 'acp',
      pid: 2000,
      tmuxSession: null,
      tmuxWindow: null,
      acpSessionId: null,
    })

    await recoverAgents(testDb.db, mockSpawn, snapshots)

    // Team was re-created
    const team = testDb.db.prepare('SELECT id FROM teams WHERE id = ?').get('team-beta')
    expect(team).toBeDefined()
  })

  it('task ownership is remapped to recovered agent', async () => {
    seedTeam('team-g', 'Gamma')
    seedSession('old-g1', 'dev agent', '/project')
    seedSession('new-g1', 'recovered dev', '/project')
    seedTeamMember('team-g', 'old-g1', 'g-worker')
    const taskId = seedTask('team-g', 'Critical fix', 'in_progress', 'old-g1')

    testDb.db
      .prepare('INSERT INTO shared_state (key, value, session_id) VALUES (?, ?, ?)')
      .run('progress', '"50%"', 'old-g1')

    remapSessionReferences(testDb.db, 'old-g1', 'new-g1')

    const task = testDb.db.prepare('SELECT owner FROM tasks WHERE id = ?').get(taskId) as {
      owner: string
    }
    expect(task.owner).toBe('new-g1')

    const state = testDb.db
      .prepare('SELECT session_id FROM shared_state WHERE key = ?')
      .get('progress') as { session_id: string }
    expect(state.session_id).toBe('new-g1')
  })

  it('expire cleans old snapshots without touching recent ones', () => {
    // Old snapshot (2 days ago)
    testDb.db
      .prepare(
        `INSERT INTO recovery_snapshots
           (session_id, team_id, name, role, working_dir, launch_method, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '-2 days'))`,
      )
      .run('old-1', 't', 'w', 'dev', '/p', 'acp', 'pending')

    // Recent snapshot
    testDb.db
      .prepare(
        `INSERT INTO recovery_snapshots
           (session_id, team_id, name, role, working_dir, launch_method, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('new-1', 't', 'w', 'dev', '/p', 'acp', 'pending')

    const expired = expireOldSnapshots(testDb.db, 1)
    expect(expired).toBe(1)

    const pending = loadPendingSnapshots(testDb.db)
    expect(pending).toHaveLength(1)
    expect(pending[0]!.session_id).toBe('new-1')
  })
})
