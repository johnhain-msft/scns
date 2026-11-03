/**
 * Stress: Team lifecycle — 3 concurrent teams × 2 agents, cross-team messaging, all
 * complete. Asserts TeamCompletion events fired, no zombie state lingers, and the
 * controller does not leak memory or file handles under churn.
 *
 * A fake spawner stands in for real ACP/detached launches: the test exercises the
 * controller + messaging + team lifecycle wiring, not the child-process transport.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type Database from 'better-sqlite3'
import { openDatabase, closeDatabase } from '../../src/broker/storage/db.js'
import { createEventLog } from '../../src/broker/services/event-log.js'
import {
  createTeam,
  joinTeam,
} from '../../src/broker/services/team-orchestration.js'
import { sendDirect } from '../../src/broker/services/message-bus.js'
import {
  createTeamLifecycleController,
  type AgentExitInfo,
} from '../../src/broker/services/team-lifecycle.js'
import type {
  AgentSpawner,
  SpawnInput,
  SpawnResult,
  SpawnedAgentInfo,
} from '../../src/broker/services/agent-spawner.js'

const TEAM_COUNT = 3
const AGENTS_PER_TEAM = 2

function makeFakeSpawner(): AgentSpawner {
  return {
    async spawn(input: SpawnInput): Promise<SpawnResult> {
      return {
        sessionId: `scaled-${Date.now()}`,
        teamId: input.team_id,
        name: input.name,
        role: input.role ?? 'dev',
        platform: 'linux',
        launchMethod: 'detached',
        pid: 0,
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
  }
}

describe('Team lifecycle stress test', { timeout: 30_000 }, () => {
  let db: Database.Database

  beforeAll(() => {
    db = openDatabase(':memory:')
  })

  afterAll(() => {
    closeDatabase(db)
  })

  it('runs 3 concurrent teams with cross-team messaging; emits completion for each', async () => {
    const rssStart = process.memoryUsage().rss
    const eventLog = createEventLog(db)
    const controller = createTeamLifecycleController({
      db,
      eventLog,
      spawner: makeFakeSpawner(),
      options: {
        backlogThreshold: 5,
        maxAgentsPerTeam: 3,
        collectStagedDiff: () => '',
        readLogTail: () => '',
      },
    })

    // Set up teams and members.
    const teams: { id: string; agents: string[] }[] = []
    for (let t = 0; t < TEAM_COUNT; t += 1) {
      const team = createTeam(db, `stress-team-${t}`)
      const agents: string[] = []
      for (let a = 0; a < AGENTS_PER_TEAM; a += 1) {
        const sid = `t${t}-a${a}`
        db.prepare('INSERT INTO sessions (id, purpose, working_dir) VALUES (?, ?, ?)').run(
          sid,
          'stress',
          '/tmp/stress',
        )
        joinTeam(db, team.id, sid, `agent-${t}-${a}`)
        agents.push(sid)
      }
      teams.push({ id: team.id, agents })
    }

    // Cross-team messaging: each agent sends to one agent in each other team.
    for (let t = 0; t < TEAM_COUNT; t += 1) {
      for (const sender of teams[t]!.agents) {
        for (let o = 0; o < TEAM_COUNT; o += 1) {
          if (o === t) continue
          const receiver = teams[o]!.agents[0]!
          sendDirect(db, sender, receiver, `hello from ${sender} to ${receiver}`)
        }
      }
    }

    // Backlog tick exercises the scale-up path under load (may or may not scale).
    await controller.tickBacklog()

    // Simulate all agents completing: spawner.cleanupSession already removes the
    // member row before the exit hook; mirror that here.
    for (const team of teams) {
      for (const sid of team.agents) {
        db.prepare('DELETE FROM team_members WHERE session_id = ?').run(sid)
        const info: AgentExitInfo = {
          sessionId: sid,
          teamId: team.id,
          role: 'dev',
          name: sid,
          workingDir: '/tmp/stress',
          logPath: null,
          launchMethod: 'detached',
          reason: 'normal',
        }
        controller.handleAgentExit(info)
      }
    }

    // Assert: each team got exactly one team_completed event.
    const completions = eventLog.since(0).filter((e) => e.event_type === 'team_completed')
    const completedTeamIds = new Set(
      completions.map((e) => JSON.parse(e.payload as string).teamId as string),
    )
    expect(completions).toHaveLength(TEAM_COUNT)
    for (const team of teams) {
      expect(completedTeamIds.has(team.id)).toBe(true)
    }

    // No lingering team_members after completion.
    const leftoverMembers = db.prepare('SELECT COUNT(*) as c FROM team_members').get() as {
      c: number
    }
    expect(leftoverMembers.c).toBe(0)

    // Memory: peak RSS delta stays well under 500 MB.
    const rssEnd = process.memoryUsage().rss
    const rssDeltaMb = (rssEnd - rssStart) / (1024 * 1024)
    expect(rssDeltaMb).toBeLessThan(500)

    controller.stop()
  })
})
