import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { TestDb } from '../../../helpers/db-harness.js'
import { createBrokerTestDb } from '../../../helpers/broker-db-harness.js'
import { createTeamTaskAutospawner } from '../../../../src/broker/services/team-task-autospawner.js'
import { createTeam, addTeamMember } from '../../../../src/broker/storage/repositories/team-repository.js'
import { createTask, findTaskById } from '../../../../src/broker/storage/repositories/task-repository.js'

interface SpawnCall {
  team_id: string
  role: string
  task_id?: number
}

function makeFakeSpawner(overrides?: { fail?: boolean; sessionId?: string }) {
  const calls: SpawnCall[] = []
  let resolve: ((v: { sessionId: string }) => void) | null = null
  let reject: ((e: Error) => void) | null = null
  const spawn = async (input: {
    team_id: string
    role: string
    task?: { id: number }
  }): Promise<{
    sessionId: string
    acpSessionId: string
    role: string
    teamId: string
    name: string
    launchMethod: string
  }> => {
    calls.push({ team_id: input.team_id, role: input.role, task_id: input.task?.id })
    if (overrides?.fail) throw new Error('spawn failed')
    return {
      sessionId: overrides?.sessionId ?? `session-${calls.length}`,
      acpSessionId: 'acp-x',
      role: input.role,
      teamId: input.team_id,
      name: 'n',
      launchMethod: 'acp',
    }
  }
  const slowSpawn = (
    delayResolve: (v: { sessionId: string }) => void,
  ): typeof spawn => {
    return async (input) => {
      calls.push({ team_id: input.team_id, role: input.role, task_id: input.task?.id })
      return new Promise((res, rej) => {
        resolve = (v) => {
          delayResolve(v)
          res({
            sessionId: v.sessionId,
            acpSessionId: 'acp-x',
            role: input.role,
            teamId: input.team_id,
            name: 'n',
            launchMethod: 'acp',
          })
        }
        reject = rej
      })
    }
  }
  return { spawn, calls, slowSpawn, resolveSlow: () => resolve, rejectSlow: () => reject }
}

function insertActiveSession(db: TestDb['db'], id: string, status: string): void {
  db.prepare(
    `INSERT INTO sessions (id, purpose, working_dir, status) VALUES (?, ?, ?, ?)`,
  ).run(id, 'agent', '/tmp', status)
}

describe('team-task-autospawner', () => {
  let testDb: TestDb
  beforeEach(() => {
    testDb = createBrokerTestDb()
  })
  afterEach(() => testDb.close())

  it('spawns a manager when a team has a pending unowned task and no active manager', async () => {
    createTeam(testDb.db, { id: 'team-a', name: 'team-a' })
    const task = createTask(testDb.db, { team_id: 'team-a', subject: 'work' })
    const fake = makeFakeSpawner()

    const sp = createTeamTaskAutospawner(
      { db: testDb.db, agentSpawner: { spawn: fake.spawn } },
      { intervalMs: 1000, cooldownMs: 60_000, enabled: true, workingDir: '/tmp' },
    )
    await sp.tickOnce()

    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]).toMatchObject({ team_id: 'team-a', role: 'scns-manager', task_id: task.id })
    const after = findTaskById(testDb.db, task.id)
    expect(after?.status).toBe('in_progress')
    expect(after?.owner).toBe('session-1')
  })

  it('does not spawn when the team already has an active scns-manager', async () => {
    createTeam(testDb.db, { id: 'team-b', name: 'team-b' })
    insertActiveSession(testDb.db, 'mgr-1', 'working')
    addTeamMember(testDb.db, {
      team_id: 'team-b',
      session_id: 'mgr-1',
      name: 'mgr-1',
      role: 'scns-manager',
    })
    createTask(testDb.db, { team_id: 'team-b', subject: 'work' })
    const fake = makeFakeSpawner()
    const sp = createTeamTaskAutospawner(
      { db: testDb.db, agentSpawner: { spawn: fake.spawn } },
      { intervalMs: 1000, cooldownMs: 60_000, enabled: true, workingDir: '/tmp' },
    )
    await sp.tickOnce()
    expect(fake.calls).toHaveLength(0)
  })

  it('ignores managers whose session is archived or in a non-live status', async () => {
    createTeam(testDb.db, { id: 'team-c', name: 'team-c' })
    // Zombie + archived sessions should not count.
    insertActiveSession(testDb.db, 'mgr-zombie', 'zombie')
    testDb.db
      .prepare("UPDATE sessions SET archived_at = datetime('now') WHERE id = 'mgr-zombie'")
      .run()
    addTeamMember(testDb.db, {
      team_id: 'team-c',
      session_id: 'mgr-zombie',
      name: 'mgr',
      role: 'scns-manager',
    })
    createTask(testDb.db, { team_id: 'team-c', subject: 'work' })
    const fake = makeFakeSpawner()
    const sp = createTeamTaskAutospawner(
      { db: testDb.db, agentSpawner: { spawn: fake.spawn } },
      { intervalMs: 1000, cooldownMs: 60_000, enabled: true, workingDir: '/tmp' },
    )
    await sp.tickOnce()
    expect(fake.calls).toHaveLength(1)
  })

  describe('multi-project (P3) scoping', () => {
    it('only spawns for teams in the configured project (other projects ignored)', async () => {
      createTeam(testDb.db, { id: 'team-a', name: 'team-a', project_id: 'proj-a' })
      createTeam(testDb.db, { id: 'team-b', name: 'team-b', project_id: 'proj-b' })
      createTask(testDb.db, { team_id: 'team-a', subject: 'a-work' })
      createTask(testDb.db, { team_id: 'team-b', subject: 'b-work' })
      const fake = makeFakeSpawner()
      const sp = createTeamTaskAutospawner(
        { db: testDb.db, agentSpawner: { spawn: fake.spawn } },
        {
          intervalMs: 1000,
          cooldownMs: 60_000,
          enabled: true,
          workingDir: '/tmp',
          projectId: 'proj-a',
        },
      )
      await sp.tickOnce()
      expect(fake.calls).toHaveLength(1)
      expect(fake.calls[0]).toMatchObject({ team_id: 'team-a' })
    })

    it('excludes legacy NULL-project teams when a projectId is configured', async () => {
      createTeam(testDb.db, { id: 'legacy', name: 'legacy' }) // project_id NULL
      createTask(testDb.db, { team_id: 'legacy', subject: 'work' })
      const fake = makeFakeSpawner()
      const sp = createTeamTaskAutospawner(
        { db: testDb.db, agentSpawner: { spawn: fake.spawn } },
        {
          intervalMs: 1000,
          cooldownMs: 60_000,
          enabled: true,
          workingDir: '/tmp',
          projectId: 'proj-a',
        },
      )
      await sp.tickOnce()
      expect(fake.calls).toHaveLength(0)
    })

    it('spawns for all teams when no projectId is configured (legacy behaviour)', async () => {
      createTeam(testDb.db, { id: 'team-a', name: 'team-a', project_id: 'proj-a' })
      createTask(testDb.db, { team_id: 'team-a', subject: 'a-work' })
      const fake = makeFakeSpawner()
      const sp = createTeamTaskAutospawner(
        { db: testDb.db, agentSpawner: { spawn: fake.spawn } },
        { intervalMs: 1000, cooldownMs: 60_000, enabled: true, workingDir: '/tmp' },
      )
      await sp.tickOnce()
      expect(fake.calls).toHaveLength(1)
    })
  })

  it('spawns at most one manager per team per tick when multiple tasks are pending', async () => {
    createTeam(testDb.db, { id: 'team-d', name: 'team-d' })
    createTask(testDb.db, { team_id: 'team-d', subject: 'first' })
    createTask(testDb.db, { team_id: 'team-d', subject: 'second' })
    const fake = makeFakeSpawner()
    const sp = createTeamTaskAutospawner(
      { db: testDb.db, agentSpawner: { spawn: fake.spawn } },
      { intervalMs: 1000, cooldownMs: 60_000, enabled: true, workingDir: '/tmp' },
    )
    await sp.tickOnce()
    expect(fake.calls).toHaveLength(1)
    // Targets the oldest task (lowest id).
    expect(fake.calls[0].task_id).toBe(1)
  })

  it('rolls back the claim and respects cooldown when spawn fails', async () => {
    createTeam(testDb.db, { id: 'team-e', name: 'team-e' })
    const task = createTask(testDb.db, { team_id: 'team-e', subject: 'flaky' })
    const fake = makeFakeSpawner({ fail: true })
    let nowMs = 1_000_000
    const sp = createTeamTaskAutospawner(
      {
        db: testDb.db,
        agentSpawner: { spawn: fake.spawn },
        now: () => nowMs,
      },
      { intervalMs: 1000, cooldownMs: 60_000, enabled: true, workingDir: '/tmp' },
    )
    await sp.tickOnce()
    expect(fake.calls).toHaveLength(1)
    const rolledBack = findTaskById(testDb.db, task.id)
    expect(rolledBack?.status).toBe('pending')
    expect(rolledBack?.owner).toBeNull()

    // Second tick within cooldown window — no new spawn.
    await sp.tickOnce()
    expect(fake.calls).toHaveLength(1)

    // Advance past cooldown and confirm retry.
    nowMs += 60_001
    await sp.tickOnce()
    expect(fake.calls).toHaveLength(2)
  })

  it('atomic claim survives concurrent ticks (only one spawn for a single task)', async () => {
    createTeam(testDb.db, { id: 'team-f', name: 'team-f' })
    const task = createTask(testDb.db, { team_id: 'team-f', subject: 'race' })
    const fake = makeFakeSpawner()
    const sp = createTeamTaskAutospawner(
      { db: testDb.db, agentSpawner: { spawn: fake.spawn } },
      { intervalMs: 1000, cooldownMs: 60_000, enabled: true, workingDir: '/tmp' },
    )
    // tickInProgress guard: a second tick during an in-flight tick is a no-op.
    const first = sp.tickOnce()
    const second = sp.tickOnce()
    await Promise.all([first, second])
    expect(fake.calls).toHaveLength(1)
    expect(findTaskById(testDb.db, task.id)?.status).toBe('in_progress')
  })

  it('no-op when disabled', async () => {
    createTeam(testDb.db, { id: 'team-g', name: 'team-g' })
    createTask(testDb.db, { team_id: 'team-g', subject: 'x' })
    const fake = makeFakeSpawner()
    const sp = createTeamTaskAutospawner(
      { db: testDb.db, agentSpawner: { spawn: fake.spawn } },
      { intervalMs: 1000, cooldownMs: 60_000, enabled: false, workingDir: '/tmp' },
    )
    await sp.tickOnce()
    expect(fake.calls).toHaveLength(0)
  })

  it('skips archived/disbanded teams', async () => {
    createTeam(testDb.db, { id: 'team-h', name: 'team-h' })
    createTask(testDb.db, { team_id: 'team-h', subject: 'x' })
    testDb.db
      .prepare("UPDATE teams SET archived_at = datetime('now'), status = 'disbanded' WHERE id = 'team-h'")
      .run()
    const fake = makeFakeSpawner()
    const sp = createTeamTaskAutospawner(
      { db: testDb.db, agentSpawner: { spawn: fake.spawn } },
      { intervalMs: 1000, cooldownMs: 60_000, enabled: true, workingDir: '/tmp' },
    )
    await sp.tickOnce()
    expect(fake.calls).toHaveLength(0)
  })
})
