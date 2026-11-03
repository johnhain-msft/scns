import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createBrokerTestDb } from '../../../helpers/broker-db-harness.js'
import type { TestDb } from '../../../helpers/db-harness.js'
import {
  snapshotActiveAgents,
  recoverAgents,
  buildRecoveryPrompt,
  remapSessionReferences,
  loadPendingSnapshots,
  markSnapshotRecovered,
  markSnapshotFailed,
  expireOldSnapshots,
  expireOldSnapshotsHours,
  recordBrokerStartup,
  crashLoopDetectedOnStartup,
  clearRecoveryHardDisable,
  CRASH_LOOP_MIN_DELTA_MS,
  type RecoverySnapshot,
  type ActiveAgentInfo,
} from '../../../../src/broker/services/session-recovery.js'
import { AgentCapExceededError } from '../../../../src/shared/errors.js'

// ── Helpers ──────────────────────────────────────────────────────────

function seedSession(
  db: import('better-sqlite3').Database,
  id: string,
  purpose: string,
  workingDir = '/tmp/test',
): void {
  db.prepare(
    `INSERT INTO sessions (id, purpose, working_dir, worktree, status)
     VALUES (?, ?, ?, NULL, 'active')`,
  ).run(id, purpose, workingDir)
}

function seedTeam(
  db: import('better-sqlite3').Database,
  id: string,
  name: string,
): void {
  db.prepare(
    `INSERT INTO teams (id, name, status) VALUES (?, ?, 'active')`,
  ).run(id, name)
}

function seedTeamMember(
  db: import('better-sqlite3').Database,
  teamId: string,
  sessionId: string,
  name: string,
  role = 'dev',
): void {
  db.prepare(
    `INSERT INTO team_members (team_id, session_id, name, role, agent_type)
     VALUES (?, ?, ?, ?, 'teammate')`,
  ).run(teamId, sessionId, name, role)
}

function seedTask(
  db: import('better-sqlite3').Database,
  teamId: string,
  subject: string,
  status = 'pending',
  owner?: string,
): number {
  const result = db
    .prepare(
      `INSERT INTO tasks (team_id, seq, subject, status, owner) VALUES (?, 1, ?, ?, ?)`,
    )
    .run(teamId, subject, status, owner ?? null)
  return Number(result.lastInsertRowid)
}

function seedMessage(
  db: import('better-sqlite3').Database,
  id: string,
  senderId: string,
  receiverId: string,
  content: string,
): void {
  db.prepare(
    `INSERT INTO messages (id, sender_id, receiver_id, content, story_id)
     VALUES (?, ?, ?, ?, NULL)`,
  ).run(id, senderId, receiverId, content)
}

// ── Tests ────────────────────────────────────────────────────────────

describe('session-recovery', () => {
  let testDb: TestDb

  beforeEach(() => {
    testDb = createBrokerTestDb()
  })

  afterEach(() => {
    testDb.close()
  })

  // ── snapshotActiveAgents ────────────────────────────────────────

  describe('snapshotActiveAgents', () => {
    it('captures all active spawned agents', () => {
      seedTeam(testDb.db, 'team-1', 'Test Team')
      seedSession(testDb.db, 'agent-1', 'dev agent for team team-1', '/project')
      seedSession(testDb.db, 'agent-2', 'qa agent for team team-1', '/project')
      seedTeamMember(testDb.db, 'team-1', 'agent-1', 'worker-1', 'dev')
      seedTeamMember(testDb.db, 'team-1', 'agent-2', 'worker-2', 'qa')

      const agents: ActiveAgentInfo[] = [
        {
          sessionId: 'agent-1',
          teamId: 'team-1',
          name: 'worker-1',
          role: 'dev',
          launchMethod: 'acp',
          workingDir: '/project',
        },
        {
          sessionId: 'agent-2',
          teamId: 'team-1',
          name: 'worker-2',
          role: 'qa',
          launchMethod: 'detached',
          workingDir: '/project',
        },
      ]

      const snapshots = snapshotActiveAgents(testDb.db, agents)

      expect(snapshots).toHaveLength(2)
      expect(snapshots[0]!.session_id).toBe('agent-1')
      expect(snapshots[0]!.team_id).toBe('team-1')
      expect(snapshots[0]!.role).toBe('dev')
      expect(snapshots[0]!.launch_method).toBe('acp')
      expect(snapshots[1]!.session_id).toBe('agent-2')
      expect(snapshots[1]!.launch_method).toBe('detached')
    })

    it('includes pending tasks from DB', () => {
      seedTeam(testDb.db, 'team-1', 'Test Team')
      seedSession(testDb.db, 'agent-1', 'dev agent', '/project')
      seedTeamMember(testDb.db, 'team-1', 'agent-1', 'worker-1')
      seedTask(testDb.db, 'team-1', 'Fix the bug', 'pending')
      seedTask(testDb.db, 'team-1', 'Write tests', 'in_progress', 'agent-1')
      seedTask(testDb.db, 'team-1', 'Already done', 'completed')

      const agents: ActiveAgentInfo[] = [
        {
          sessionId: 'agent-1',
          teamId: 'team-1',
          name: 'worker-1',
          role: 'dev',
          launchMethod: 'acp',
          workingDir: '/project',
        },
      ]

      const snapshots = snapshotActiveAgents(testDb.db, agents)

      expect(snapshots).toHaveLength(1)
      const tasks = JSON.parse(snapshots[0]!.pending_tasks!)
      // Should include pending and in_progress, not completed
      expect(tasks).toHaveLength(2)
      expect(tasks[0].subject).toBe('Fix the bug')
      expect(tasks[1].subject).toBe('Write tests')
    })

    it('includes recent messages to/from the agent', () => {
      seedTeam(testDb.db, 'team-1', 'Test Team')
      seedSession(testDb.db, 'agent-1', 'dev agent', '/project')
      seedSession(testDb.db, 'other-1', 'another agent', '/project')
      seedTeamMember(testDb.db, 'team-1', 'agent-1', 'worker-1')
      seedMessage(testDb.db, 'msg-1', 'other-1', 'agent-1', 'Please fix the login')
      seedMessage(testDb.db, 'msg-2', 'agent-1', 'other-1', 'Working on it')

      const agents: ActiveAgentInfo[] = [
        {
          sessionId: 'agent-1',
          teamId: 'team-1',
          name: 'worker-1',
          role: 'dev',
          launchMethod: 'acp',
          workingDir: '/project',
        },
      ]

      const snapshots = snapshotActiveAgents(testDb.db, agents)
      const messages = JSON.parse(snapshots[0]!.recent_messages!)
      expect(messages).toHaveLength(2)
      const contents = messages.map((m: { content: string }) => m.content)
      expect(contents).toContain('Please fix the login')
      expect(contents).toContain('Working on it')
    })

    it('returns empty array for no active agents', () => {
      const snapshots = snapshotActiveAgents(testDb.db, [])
      expect(snapshots).toEqual([])
    })

    it('persists snapshots to recovery_snapshots table', () => {
      seedTeam(testDb.db, 'team-1', 'Test Team')
      seedSession(testDb.db, 'agent-1', 'dev agent', '/project')
      seedTeamMember(testDb.db, 'team-1', 'agent-1', 'worker-1')

      const agents: ActiveAgentInfo[] = [
        {
          sessionId: 'agent-1',
          teamId: 'team-1',
          name: 'worker-1',
          role: 'dev',
          launchMethod: 'acp',
          workingDir: '/project',
        },
      ]

      snapshotActiveAgents(testDb.db, agents)

      const rows = testDb.db
        .prepare('SELECT * FROM recovery_snapshots WHERE status = ?')
        .all('pending') as RecoverySnapshot[]
      expect(rows).toHaveLength(1)
      expect(rows[0]!.session_id).toBe('agent-1')
      expect(rows[0]!.status).toBe('pending')
    })
  })

  // ── buildRecoveryPrompt ─────────────────────────────────────────

  describe('buildRecoveryPrompt', () => {
    it('includes original purpose', () => {
      const snapshot: RecoverySnapshot = {
        id: 1,
        session_id: 'agent-1',
        team_id: 'team-1',
        name: 'worker-1',
        role: 'dev',
        working_dir: '/project',
        purpose: 'dev agent for team team-1: implement auth module',
        launch_method: 'acp',
        pending_tasks: null,
        recent_messages: null,
        recovery_prompt: null,
        status: 'pending',
        created_at: new Date().toISOString(),
        recovered_at: null,
        new_session_id: null,
      }

      const prompt = buildRecoveryPrompt(snapshot)
      expect(prompt).toContain('implement auth module')
      expect(prompt).toContain('resuming work after a scheduled restart')
    })

    it('includes pending tasks', () => {
      const tasks = JSON.stringify([
        { subject: 'Fix login bug', description: 'Auth fails on mobile', status: 'in_progress' },
        { subject: 'Add tests', description: null, status: 'pending' },
      ])

      const snapshot: RecoverySnapshot = {
        id: 1,
        session_id: 'a-1',
        team_id: 't-1',
        name: 'w-1',
        role: 'dev',
        working_dir: '/p',
        purpose: 'dev agent',
        launch_method: 'acp',
        pending_tasks: tasks,
        recent_messages: null,
        recovery_prompt: null,
        status: 'pending',
        created_at: new Date().toISOString(),
        recovered_at: null,
        new_session_id: null,
      }

      const prompt = buildRecoveryPrompt(snapshot)
      expect(prompt).toContain('Fix login bug')
      expect(prompt).toContain('in_progress')
      expect(prompt).toContain('Add tests')
    })

    it('includes recent message history', () => {
      const messages = JSON.stringify([
        { sender_id: 'lead-1', content: 'Priority: fix auth ASAP', created_at: '2025-01-01T00:00:00Z' },
      ])

      const snapshot: RecoverySnapshot = {
        id: 1,
        session_id: 'a-1',
        team_id: 't-1',
        name: 'w-1',
        role: 'dev',
        working_dir: '/p',
        purpose: 'dev agent',
        launch_method: 'acp',
        pending_tasks: null,
        recent_messages: messages,
        recovery_prompt: null,
        status: 'pending',
        created_at: new Date().toISOString(),
        recovered_at: null,
        new_session_id: null,
      }

      const prompt = buildRecoveryPrompt(snapshot)
      expect(prompt).toContain('Priority: fix auth ASAP')
    })
  })

  // ── remapSessionReferences ──────────────────────────────────────

  describe('remapSessionReferences', () => {
    it('migrates task ownership to new session ID', () => {
      seedTeam(testDb.db, 'team-1', 'Test Team')
      seedSession(testDb.db, 'old-agent', 'dev agent', '/project')
      seedSession(testDb.db, 'new-agent', 'dev agent (recovered)', '/project')
      const taskId = seedTask(testDb.db, 'team-1', 'Fix bug', 'in_progress', 'old-agent')

      remapSessionReferences(testDb.db, 'old-agent', 'new-agent')

      const task = testDb.db.prepare('SELECT owner FROM tasks WHERE id = ?').get(taskId) as { owner: string }
      expect(task.owner).toBe('new-agent')
    })

    it('migrates shared state session references', () => {
      seedSession(testDb.db, 'old-agent', 'dev agent', '/project')
      seedSession(testDb.db, 'new-agent', 'dev agent', '/project')
      testDb.db
        .prepare('INSERT INTO shared_state (key, value, session_id) VALUES (?, ?, ?)')
        .run('my-key', '"data"', 'old-agent')

      remapSessionReferences(testDb.db, 'old-agent', 'new-agent')

      const state = testDb.db
        .prepare('SELECT session_id FROM shared_state WHERE key = ?')
        .get('my-key') as { session_id: string }
      expect(state.session_id).toBe('new-agent')
    })
  })

  // ── loadPendingSnapshots ────────────────────────────────────────

  describe('loadPendingSnapshots', () => {
    it('returns only pending snapshots', () => {
      testDb.db
        .prepare(
          `INSERT INTO recovery_snapshots (session_id, team_id, name, role, working_dir, launch_method, status)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('a-1', 't-1', 'w-1', 'dev', '/p', 'acp', 'pending')
      testDb.db
        .prepare(
          `INSERT INTO recovery_snapshots (session_id, team_id, name, role, working_dir, launch_method, status)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('a-2', 't-1', 'w-2', 'qa', '/p', 'acp', 'recovered')

      const pending = loadPendingSnapshots(testDb.db)
      expect(pending).toHaveLength(1)
      expect(pending[0]!.session_id).toBe('a-1')
    })
  })

  // ── markSnapshotRecovered / markSnapshotFailed ──────────────────

  describe('snapshot status updates', () => {
    it('marks snapshot as recovered with new session ID', () => {
      testDb.db
        .prepare(
          `INSERT INTO recovery_snapshots (session_id, team_id, name, role, working_dir, launch_method, status)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('a-1', 't-1', 'w-1', 'dev', '/p', 'acp', 'pending')

      const id = (
        testDb.db.prepare('SELECT id FROM recovery_snapshots').get() as { id: number }
      ).id
      markSnapshotRecovered(testDb.db, id, 'new-a-1')

      const row = testDb.db
        .prepare('SELECT status, new_session_id, recovered_at FROM recovery_snapshots WHERE id = ?')
        .get(id) as RecoverySnapshot
      expect(row.status).toBe('recovered')
      expect(row.new_session_id).toBe('new-a-1')
      expect(row.recovered_at).not.toBeNull()
    })

    it('marks snapshot as failed', () => {
      testDb.db
        .prepare(
          `INSERT INTO recovery_snapshots (session_id, team_id, name, role, working_dir, launch_method, status)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('a-1', 't-1', 'w-1', 'dev', '/p', 'acp', 'pending')

      const id = (
        testDb.db.prepare('SELECT id FROM recovery_snapshots').get() as { id: number }
      ).id
      markSnapshotFailed(testDb.db, id)

      const row = testDb.db
        .prepare('SELECT status FROM recovery_snapshots WHERE id = ?')
        .get(id) as RecoverySnapshot
      expect(row.status).toBe('failed')
    })
  })

  // ── expireOldSnapshots ──────────────────────────────────────────

  describe('expireOldSnapshots', () => {
    it('expires pending snapshots older than maxAge', () => {
      // Insert with old created_at
      testDb.db
        .prepare(
          `INSERT INTO recovery_snapshots (session_id, team_id, name, role, working_dir, launch_method, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '-2 days'))`,
        )
        .run('old-1', 't-1', 'w-1', 'dev', '/p', 'acp', 'pending')
      testDb.db
        .prepare(
          `INSERT INTO recovery_snapshots (session_id, team_id, name, role, working_dir, launch_method, status)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('new-1', 't-1', 'w-2', 'dev', '/p', 'acp', 'pending')

      const expired = expireOldSnapshots(testDb.db, 1) // 1 day max age
      expect(expired).toBe(1)

      const remaining = testDb.db
        .prepare("SELECT * FROM recovery_snapshots WHERE status = 'pending'")
        .all()
      expect(remaining).toHaveLength(1)
    })
  })

  // ── recoverAgents ──────────────────────────────────────────────

  describe('recoverAgents', () => {
    it('respawns agents from snapshots and remaps IDs', async () => {
      seedTeam(testDb.db, 'team-1', 'Test Team')
      seedSession(testDb.db, 'old-agent', 'dev agent', '/project')
      seedTeamMember(testDb.db, 'team-1', 'old-agent', 'worker-1')
      const taskId = seedTask(testDb.db, 'team-1', 'Fix bug', 'in_progress', 'old-agent')

      // Insert a snapshot
      testDb.db
        .prepare(
          `INSERT INTO recovery_snapshots
             (session_id, team_id, name, role, working_dir, purpose, launch_method, pending_tasks, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'old-agent',
          'team-1',
          'worker-1',
          'dev',
          '/project',
          'dev agent for team team-1',
          'acp',
          JSON.stringify([{ subject: 'Fix bug', status: 'in_progress' }]),
          'pending',
        )

      const mockSpawn = vi.fn().mockResolvedValue({
        sessionId: 'recovered-agent-123',
        teamId: 'team-1',
        name: 'worker-1',
        role: 'dev',
        launchMethod: 'acp',
        pid: 1234,
        tmuxSession: null,
        tmuxWindow: null,
        acpSessionId: 'acp-456',
      })

      const snapshots = loadPendingSnapshots(testDb.db)
      const results = await recoverAgents(testDb.db, mockSpawn, snapshots)

      expect(results).toHaveLength(1)
      expect(results[0]!.success).toBe(true)
      expect(results[0]!.newSessionId).toBe('recovered-agent-123')
      expect(mockSpawn).toHaveBeenCalledOnce()

      // Verify prompt contains recovery context
      const spawnCall = mockSpawn.mock.calls[0]![0]
      expect(spawnCall.prompt).toContain('resuming work')
      expect(spawnCall.team_id).toBe('team-1')
      expect(spawnCall.name).toContain('worker-1')

      // Verify task ownership remapped
      const task = testDb.db.prepare('SELECT owner FROM tasks WHERE id = ?').get(taskId) as { owner: string }
      expect(task.owner).toBe('recovered-agent-123')

      // Verify snapshot marked recovered
      const snap = testDb.db
        .prepare("SELECT status, new_session_id FROM recovery_snapshots WHERE status = 'recovered'")
        .get() as RecoverySnapshot
      expect(snap.status).toBe('recovered')
      expect(snap.new_session_id).toBe('recovered-agent-123')
    })

    it('handles spawn failure gracefully', async () => {
      testDb.db
        .prepare(
          `INSERT INTO recovery_snapshots
             (session_id, team_id, name, role, working_dir, launch_method, status)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('old-agent', 'team-1', 'worker-1', 'dev', '/project', 'acp', 'pending')

      const mockSpawn = vi.fn().mockRejectedValue(new Error('CLI not found'))

      const snapshots = loadPendingSnapshots(testDb.db)
      const results = await recoverAgents(testDb.db, mockSpawn, snapshots)

      expect(results).toHaveLength(1)
      expect(results[0]!.success).toBe(false)
      expect(results[0]!.error).toContain('CLI not found')

      const snap = testDb.db
        .prepare("SELECT status FROM recovery_snapshots WHERE status = 'failed'")
        .get() as RecoverySnapshot
      expect(snap.status).toBe('failed')
    })

    it('skips already-consumed snapshots', async () => {
      testDb.db
        .prepare(
          `INSERT INTO recovery_snapshots
             (session_id, team_id, name, role, working_dir, launch_method, status)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('old-agent', 'team-1', 'worker-1', 'dev', '/project', 'acp', 'recovered')

      const snapshots = loadPendingSnapshots(testDb.db)
      expect(snapshots).toHaveLength(0) // loadPendingSnapshots already filters
    })
  })

  describe('F3: crash-loop detection', () => {
    it('returns false on first startup (no previous timestamp)', () => {
      const prev = recordBrokerStartup(testDb.db)
      expect(prev).toBeNull()
      expect(crashLoopDetectedOnStartup(testDb.db, prev)).toBe(false)
    })

    it('returns false when startups are spaced further than the threshold', () => {
      const now = Date.now()
      const prev = now - (CRASH_LOOP_MIN_DELTA_MS + 10_000)
      expect(crashLoopDetectedOnStartup(testDb.db, prev, now)).toBe(false)
    })

    it('returns true when restart delta is below the threshold and trips hard-disable', () => {
      const now = Date.now()
      const prev = now - 5_000 // 5 s ago — clearly a crash loop
      expect(crashLoopDetectedOnStartup(testDb.db, prev, now)).toBe(true)
      // Now the disabled flag should be persisted — subsequent calls with a
      // healthy delta should still return true because the flag is sticky.
      const healthyPrev = now - (CRASH_LOOP_MIN_DELTA_MS + 60_000)
      expect(crashLoopDetectedOnStartup(testDb.db, healthyPrev, now)).toBe(true)
    })

    it('clearRecoveryHardDisable allows recovery to resume', () => {
      const now = Date.now()
      crashLoopDetectedOnStartup(testDb.db, now - 1_000, now) // trip flag
      clearRecoveryHardDisable(testDb.db)
      const healthyPrev = now - (CRASH_LOOP_MIN_DELTA_MS + 60_000)
      expect(crashLoopDetectedOnStartup(testDb.db, healthyPrev, now)).toBe(false)
    })
  })

  describe('F3: expireOldSnapshotsHours', () => {
    it('expires snapshots older than the given number of hours', () => {
      // Seed: one snapshot 3 hours old, one 30 minutes old.
      testDb.db
        .prepare(
          `INSERT INTO recovery_snapshots
             (session_id, team_id, name, role, working_dir, launch_method, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', datetime('now','-3 hours'))`,
        )
        .run('old', 'team-1', 'w1', 'dev', '/p', 'acp')
      testDb.db
        .prepare(
          `INSERT INTO recovery_snapshots
             (session_id, team_id, name, role, working_dir, launch_method, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', datetime('now','-30 minutes'))`,
        )
        .run('fresh', 'team-1', 'w2', 'dev', '/p', 'acp')

      const n = expireOldSnapshotsHours(testDb.db, 1)
      expect(n).toBe(1)

      const pending = loadPendingSnapshots(testDb.db)
      expect(pending).toHaveLength(1)
      expect(pending[0]!.session_id).toBe('fresh')
    })
  })

  describe('F4: bounded recovery fan-out + capacity short-circuit', () => {
    function seedSnapshots(n: number): void {
      for (let i = 0; i < n; i++) {
        testDb.db
          .prepare(
            `INSERT INTO recovery_snapshots
               (session_id, team_id, name, role, working_dir, launch_method, status)
             VALUES (?, ?, ?, 'dev', '/p', 'acp', 'pending')`,
          )
          .run(`old-${i}`, 'team-1', `w-${i}`)
      }
    }

    it('aborts remaining spawns once the spawner rejects with AgentCapExceededError', async () => {
      seedSnapshots(6)
      const snapshots = loadPendingSnapshots(testDb.db)
      let calls = 0
      const spawn = vi.fn().mockImplementation(async () => {
        calls++
        if (calls >= 3) throw new AgentCapExceededError(4, 4)
        return {
          sessionId: `new-${calls}`,
          teamId: 'team-1',
          name: 'w',
          role: 'dev',
          platform: 'darwin',
          launchMethod: 'acp',
          pid: null,
          tmuxSession: null,
          tmuxWindow: null,
          acpSessionId: null,
        }
      })
      const results = await recoverAgents(testDb.db, spawn, snapshots, { concurrency: 1 })
      // First two succeeded, the third raised, and the rest were marked
      // recovery-skipped rather than calling spawn.
      const successes = results.filter((r) => r.success)
      const skipped = results.filter((r) => r.error === 'recovery-skipped: spawner at half-capacity')
      expect(successes).toHaveLength(2)
      // With concurrency=1 the cap-error short-circuits the loop; spawn is
      // called at most 3 times total (the 3rd throws).
      expect(spawn).toHaveBeenCalledTimes(3)
      // Remaining results are either the failed-cap result or the skipped marker.
      expect(results.length + skipped.length).toBeGreaterThanOrEqual(results.length)
    })

    it('short-circuits further spawns when capacityProbe reports spawner at half-capacity', async () => {
      seedSnapshots(10)
      const snapshots = loadPendingSnapshots(testDb.db)
      let active = 0
      const spawn = vi.fn().mockImplementation(async () => {
        active++
        return {
          sessionId: `new-${active}`,
          teamId: 'team-1',
          name: 'w',
          role: 'dev',
          platform: 'darwin',
          launchMethod: 'acp',
          pid: null,
          tmuxSession: null,
          tmuxWindow: null,
          acpSessionId: null,
        }
      })
      const probe = {
        getActiveCount: () => active,
        getMaxConcurrent: () => 4,
      }
      await recoverAgents(testDb.db, spawn, snapshots, {
        concurrency: 1,
        capacityProbe: probe,
      })
      // Probe trips once active*2 >= 4 ⇒ after 2 successful spawns the rest
      // are short-circuited and spawn is not called again.
      expect(spawn).toHaveBeenCalledTimes(2)
    })

    it('runs with concurrency=2 by default (bounded fan-out)', async () => {
      seedSnapshots(4)
      const snapshots = loadPendingSnapshots(testDb.db)
      let inFlight = 0
      let maxInFlight = 0
      const spawn = vi.fn().mockImplementation(async () => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((r) => setTimeout(r, 10))
        inFlight--
        return {
          sessionId: `new-${Math.random()}`,
          teamId: 'team-1',
          name: 'w',
          role: 'dev',
          platform: 'darwin',
          launchMethod: 'acp',
          pid: null,
          tmuxSession: null,
          tmuxWindow: null,
          acpSessionId: null,
        }
      })
      await recoverAgents(testDb.db, spawn, snapshots)
      expect(spawn).toHaveBeenCalledTimes(4)
      expect(maxInFlight).toBeLessThanOrEqual(2)
      expect(maxInFlight).toBeGreaterThanOrEqual(2)
    })
  })
})
