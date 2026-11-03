import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { TestDb } from '../../../helpers/db-harness.js'
import { createBrokerTestDb } from '../../../helpers/broker-db-harness.js'
import { createEventLog } from '../../../../src/broker/services/event-log.js'
import { createTeam, joinTeam } from '../../../../src/broker/services/team-orchestration.js'
import {
  createTeamLifecycleController,
  type AgentExitInfo,
} from '../../../../src/broker/services/team-lifecycle.js'
import type {
  AgentSpawner,
  SpawnInput,
  SpawnResult,
  SpawnedAgentInfo,
} from '../../../../src/broker/services/agent-spawner.js'

function makeFakeSpawner(): AgentSpawner & { spawned: SpawnInput[] } {
  const spawned: SpawnInput[] = []
  return {
    spawned,
    async spawn(input: SpawnInput): Promise<SpawnResult> {
      spawned.push(input)
      return {
        sessionId: `sess-${spawned.length}`,
        teamId: input.team_id,
        name: input.name,
        role: input.role ?? 'dev',
        platform: 'linux',
        launchMethod: input.launch_method ?? 'detached',
        pid: 1234,
        tmuxSession: null,
        tmuxWindow: null,
        acpSessionId: null,
      }
    },
    async sendMessage() {
      return { accepted: true }
    },
    getActiveAgents(): ReadonlyMap<string, SpawnedAgentInfo> {
      return new Map()
    },
    async cleanup() {
      /* noop */
    },
    async shutdownAll() {
      /* noop */
    },
  } as AgentSpawner & { spawned: SpawnInput[] }
}

function registerSession(db: TestDb['db'], id: string, cwd = '/tmp/wd'): void {
  db.prepare('INSERT INTO sessions (id, purpose, working_dir) VALUES (?, ?, ?)').run(id, 'agent', cwd)
}

function exitOf(overrides: Partial<AgentExitInfo>): AgentExitInfo {
  return {
    sessionId: 'sess-x',
    teamId: 'team-x',
    role: 'dev',
    name: 'agent-x',
    workingDir: '/tmp/wd',
    logPath: null,
    launchMethod: 'detached',
    reason: 'normal',
    ...overrides,
  }
}

describe('TeamLifecycleController', () => {
  let testDb: TestDb

  beforeEach(() => {
    testDb = createBrokerTestDb()
  })

  afterEach(() => {
    testDb.close()
  })

  describe('handleAgentExit', () => {
    it('emits team_completed when the last member of a team exits', () => {
      const team = createTeam(testDb.db, 'Alpha')
      registerSession(testDb.db, 's1')
      registerSession(testDb.db, 's2')
      joinTeam(testDb.db, team.id, 's1', 'agent-1', 'dev')
      joinTeam(testDb.db, team.id, 's2', 'agent-2', 'reviewer')

      const eventLog = createEventLog(testDb.db)
      const spawner = makeFakeSpawner()
      const controller = createTeamLifecycleController({
        db: testDb.db,
        eventLog,
        spawner,
        options: {
          collectStagedDiff: () => 'diff --git fake\n',
          readLogTail: () => 'log-tail-content',
        },
      })

      // Simulate spawner's cleanup: remove member, then fire exit.
      testDb.db.prepare('DELETE FROM team_members WHERE session_id = ?').run('s1')
      controller.handleAgentExit(
        exitOf({ sessionId: 's1', teamId: team.id, name: 'agent-1', role: 'dev' }),
      )
      let completions = eventLog.since(0).filter((e) => e.event_type === 'team_completed')
      expect(completions).toHaveLength(0)

      testDb.db.prepare('DELETE FROM team_members WHERE session_id = ?').run('s2')
      controller.handleAgentExit(
        exitOf({ sessionId: 's2', teamId: team.id, name: 'agent-2', role: 'reviewer' }),
      )
      completions = eventLog.since(0).filter((e) => e.event_type === 'team_completed')
      expect(completions).toHaveLength(1)

      const payload = JSON.parse(completions[0]!.payload as string)
      expect(payload.teamId).toBe(team.id)
      expect(payload.memberSessionIds).toEqual(['s1', 's2'])
      expect(payload.stagedDiff).toContain('diff --git')
      expect(payload.artifacts).toHaveLength(2)
      expect(payload.logs).toHaveLength(2)
      expect(payload.aggregateOutcome).toBe('success')
      expect(typeof payload.completedAt).toBe('string')
    })

    it('is idempotent: a repeat last-exit does not emit a second completion', () => {
      const team = createTeam(testDb.db, 'Beta')
      registerSession(testDb.db, 's1')
      joinTeam(testDb.db, team.id, 's1', 'agent-1')

      const eventLog = createEventLog(testDb.db)
      const spawner = makeFakeSpawner()
      const controller = createTeamLifecycleController({
        db: testDb.db,
        eventLog,
        spawner,
        options: { collectStagedDiff: () => '', readLogTail: () => '' },
      })

      testDb.db.prepare('DELETE FROM team_members WHERE session_id = ?').run('s1')
      controller.handleAgentExit(exitOf({ sessionId: 's1', teamId: team.id }))
      controller.handleAgentExit(exitOf({ sessionId: 's1', teamId: team.id }))

      expect(eventLog.since(0).filter((e) => e.event_type === 'team_completed')).toHaveLength(1)
    })

    it('re-emits team_completed on a fresh cycle when new agents join the same team after the prior emission and exit (Phase 13.12.33)', () => {
      // Reproduces the overnight dormancy bug observed 2026-05-14: the
      // self-improve-followup-creator queues a NEW task on the same
      // team after a quality_gate_verdict. The autospawner spawns
      // manager/dev/qa anew; they run and exit cleanly; but because
      // `completionEmitted` was sticky per-team for the broker's
      // lifetime, no second `team_completed` ever fired, so the QG
      // arbiter never ran on the follow-up's staged diff and the
      // loop went dormant until the daily blue/green restart.
      //
      // Contract: each completion cycle is bounded by "agents joined
      // → all those agents exited → completion emitted". A new join
      // after an emission starts a fresh cycle, and that cycle MUST
      // also emit when its members all exit.
      const team = createTeam(testDb.db, 'Echo')
      registerSession(testDb.db, 's1')
      registerSession(testDb.db, 's2')
      joinTeam(testDb.db, team.id, 's1', 'cycle1-agent', 'dev')
      joinTeam(testDb.db, team.id, 's2', 'cycle1-helper', 'helper')

      const eventLog = createEventLog(testDb.db)
      const controller = createTeamLifecycleController({
        db: testDb.db,
        eventLog,
        spawner: makeFakeSpawner(),
        options: {
          collectStagedDiff: () => 'diff --git fake\n',
          readLogTail: () => '',
        },
      })

      // Cycle 1: both members exit, completion fires.
      testDb.db.prepare('DELETE FROM team_members WHERE session_id = ?').run('s1')
      controller.handleAgentExit(
        exitOf({ sessionId: 's1', teamId: team.id, name: 'cycle1-agent' }),
      )
      testDb.db.prepare('DELETE FROM team_members WHERE session_id = ?').run('s2')
      controller.handleAgentExit(
        exitOf({ sessionId: 's2', teamId: team.id, name: 'cycle1-helper' }),
      )
      expect(
        eventLog.since(0).filter((e) => e.event_type === 'team_completed'),
      ).toHaveLength(1)

      // Cycle 2: follow-up task spawns NEW members on the SAME team.
      registerSession(testDb.db, 's3')
      registerSession(testDb.db, 's4')
      joinTeam(testDb.db, team.id, 's3', 'cycle2-agent', 'dev')
      joinTeam(testDb.db, team.id, 's4', 'cycle2-helper', 'helper')

      testDb.db.prepare('DELETE FROM team_members WHERE session_id = ?').run('s3')
      controller.handleAgentExit(
        exitOf({ sessionId: 's3', teamId: team.id, name: 'cycle2-agent' }),
      )
      let completions = eventLog.since(0).filter((e) => e.event_type === 'team_completed')
      expect(completions).toHaveLength(1) // cycle 2 hasn't ended yet

      testDb.db.prepare('DELETE FROM team_members WHERE session_id = ?').run('s4')
      controller.handleAgentExit(
        exitOf({ sessionId: 's4', teamId: team.id, name: 'cycle2-helper' }),
      )
      completions = eventLog.since(0).filter((e) => e.event_type === 'team_completed')
      expect(completions).toHaveLength(2)

      const cycle2 = JSON.parse(completions[1]!.payload as string)
      expect(cycle2.teamId).toBe(team.id)
      // The second emission carries ONLY the new cycle's session IDs
      // — not a union with cycle 1's members.
      expect(cycle2.memberSessionIds.sort()).toEqual(['s3', 's4'])
      expect(cycle2.artifacts).toHaveLength(2)
    })

    it('still suppresses duplicate emissions when the SAME session\'s exit is replayed after a completion (Phase 13.12.33 — idempotence preserved)', () => {
      // Belt-and-braces for the re-emission fix: the new "fresh cycle
      // on unseen session" branch must NOT accidentally fire a second
      // event when a duplicate exit for the SAME session arrives. The
      // existing "is idempotent" test covers replays before any new
      // members join; this one covers replays after a real cycle 2 has
      // also completed — i.e., the most paranoid replay scenario.
      const team = createTeam(testDb.db, 'Foxtrot')
      registerSession(testDb.db, 's1')
      joinTeam(testDb.db, team.id, 's1', 'a1')

      const eventLog = createEventLog(testDb.db)
      const controller = createTeamLifecycleController({
        db: testDb.db,
        eventLog,
        spawner: makeFakeSpawner(),
        options: { collectStagedDiff: () => '', readLogTail: () => '' },
      })

      testDb.db.prepare('DELETE FROM team_members WHERE session_id = ?').run('s1')
      controller.handleAgentExit(exitOf({ sessionId: 's1', teamId: team.id }))
      expect(
        eventLog.since(0).filter((e) => e.event_type === 'team_completed'),
      ).toHaveLength(1)

      // Replay s1 — must NOT produce a second event despite the fresh-
      // cycle reset logic. Guarded by state.exits.has(info.sessionId).
      controller.handleAgentExit(exitOf({ sessionId: 's1', teamId: team.id }))
      controller.handleAgentExit(exitOf({ sessionId: 's1', teamId: team.id }))
      expect(
        eventLog.since(0).filter((e) => e.event_type === 'team_completed'),
      ).toHaveLength(1)
    })

    it('reports partial outcome when some members exited abnormally', () => {
      const team = createTeam(testDb.db, 'Gamma')
      registerSession(testDb.db, 's1')
      registerSession(testDb.db, 's2')
      joinTeam(testDb.db, team.id, 's1', 'a1')
      joinTeam(testDb.db, team.id, 's2', 'a2')

      const eventLog = createEventLog(testDb.db)
      const controller = createTeamLifecycleController({
        db: testDb.db,
        eventLog,
        spawner: makeFakeSpawner(),
        options: { collectStagedDiff: () => '', readLogTail: () => '' },
      })

      testDb.db.prepare('DELETE FROM team_members WHERE session_id = ?').run('s1')
      controller.handleAgentExit(exitOf({ sessionId: 's1', teamId: team.id, reason: 'normal' }))
      testDb.db.prepare('DELETE FROM team_members WHERE session_id = ?').run('s2')
      controller.handleAgentExit(exitOf({ sessionId: 's2', teamId: team.id, reason: 'killed' }))

      const payload = JSON.parse(
        eventLog.since(0).filter((e) => e.event_type === 'team_completed')[0]!.payload as string,
      )
      expect(payload.aggregateOutcome).toBe('partial')
    })

    it('reports failed outcome when all members exited abnormally', () => {
      const team = createTeam(testDb.db, 'Delta')
      registerSession(testDb.db, 's1')
      joinTeam(testDb.db, team.id, 's1', 'a1')

      const eventLog = createEventLog(testDb.db)
      const controller = createTeamLifecycleController({
        db: testDb.db,
        eventLog,
        spawner: makeFakeSpawner(),
        options: { collectStagedDiff: () => '', readLogTail: () => '' },
      })

      testDb.db.prepare('DELETE FROM team_members WHERE session_id = ?').run('s1')
      controller.handleAgentExit(exitOf({ sessionId: 's1', teamId: team.id, reason: 'error' }))

      const payload = JSON.parse(
        eventLog.since(0).filter((e) => e.event_type === 'team_completed')[0]!.payload as string,
      )
      expect(payload.aggregateOutcome).toBe('failed')
    })
  })

  describe('tickBacklog', () => {
    it('scales up a team when unread backlog exceeds threshold', async () => {
      const team = createTeam(testDb.db, 'Backlog')
      registerSession(testDb.db, 's1', '/tmp/w')
      joinTeam(testDb.db, team.id, 's1', 'a1')

      // Insert 15 unread messages addressed to s1 from some other sender.
      const insert = testDb.db.prepare(
        'INSERT INTO messages (id, sender_id, receiver_id, content) VALUES (?, ?, ?, ?)',
      )
      registerSession(testDb.db, 'sender-ext', '/tmp/w')
      for (let i = 0; i < 15; i += 1) {
        insert.run(`m${i}`, 'sender-ext', 's1', `msg ${i}`)
      }

      const eventLog = createEventLog(testDb.db)
      const spawner = makeFakeSpawner()
      const controller = createTeamLifecycleController({
        db: testDb.db,
        eventLog,
        spawner,
        options: { backlogThreshold: 10, maxAgentsPerTeam: 4, scaleRole: 'helper' },
      })

      await controller.tickBacklog()
      expect(spawner.spawned).toHaveLength(1)
      expect(spawner.spawned[0]!.team_id).toBe(team.id)
      expect(spawner.spawned[0]!.role).toBe('helper')

      // Second tick within the latch window does not double-spawn.
      await controller.tickBacklog()
      expect(spawner.spawned).toHaveLength(1)
    })

    it('does not scale up when member count already at cap', async () => {
      const team = createTeam(testDb.db, 'Capped')
      for (const id of ['a', 'b', 'c', 'd']) {
        registerSession(testDb.db, id, '/tmp/w')
        joinTeam(testDb.db, team.id, id, `agent-${id}`)
      }
      registerSession(testDb.db, 'ext', '/tmp/w')
      const insert = testDb.db.prepare(
        'INSERT INTO messages (id, sender_id, receiver_id, content) VALUES (?, ?, ?, ?)',
      )
      for (let i = 0; i < 50; i += 1) insert.run(`m${i}`, 'ext', 'a', `msg ${i}`)

      const eventLog = createEventLog(testDb.db)
      const spawner = makeFakeSpawner()
      const controller = createTeamLifecycleController({
        db: testDb.db,
        eventLog,
        spawner,
        options: { backlogThreshold: 10, maxAgentsPerTeam: 4 },
      })

      await controller.tickBacklog()
      expect(spawner.spawned).toHaveLength(0)
    })
  })
})
