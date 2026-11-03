/**
 * Phase 13.9.1 — E2E: brain wake at L2 spawns a real team from a team-complexity
 * suggestion. Uses a real broker server (in-memory SQLite + Express), real
 * event log, real suggestion store (file-backed), and a real brain agent.
 *
 * Verifies the full bridge:
 *   suggestion → promoter auto-approves → ApprovedSuggestions action →
 *   onSpawnTeam creates a team row → GET /api/teams returns it →
 *   suggestion_spawned_team event persisted in event log.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type Database from 'better-sqlite3'
import { openDatabase, closeDatabase } from '../../src/broker/storage/db.js'
import { createEventLog } from '../../src/broker/services/event-log.js'
import { createEventDispatcher } from '../../src/broker/event-dispatcher.js'
import { createBrokerServer, type BrokerServer } from '../../src/broker/server.js'
import { createSuggestionStore } from '../../src/suggest/suggestion-store.js'
import { createBrainAgent } from '../../src/brain/agent-loop.js'
import { createTaskQueue } from '../../src/brain/task-queue.js'
import { createDecisionTree } from '../../src/brain/decision-tree.js'
import { createTaskClassifier } from '../../src/brain/classifier.js'
import { createTemplateEngine } from '../../src/brain/templates.js'
import { createHealthMonitor } from '../../src/context/health-monitor.js'
import type { Suggestion } from '../../src/suggest/types.js'

function makeTeamSuggestion(): Suggestion {
  const now = new Date().toISOString()
  return {
    id: randomUUID(),
    type: 'workflow',
    title: 'Live test: team-spawn bridge e2e',
    description: 'End-to-end verification of executor → team spawn bridge.',
    status: 'pending',
    confidence: 0.95,
    evidence: [
      {
        source: 'e2e',
        detail: 'synthetic',
        observedAt: now,
        weight: 0.9,
      },
    ],
    tags: ['phase-13-9-1'],
    createdAt: now,
    updatedAt: now,
    actionable: true,
    estimatedComplexity: 'team',
    suggestedRoles: ['dev', 'reviewer'],
  } as Suggestion
}

describe('Phase 13.9.1 E2E — brain spawns team from suggestion', () => {
  let tmpRoot: string
  let suggestionsDir: string
  let db: Database.Database
  let broker: BrokerServer
  let server: Server
  let baseUrl: string
  let eventLog: ReturnType<typeof createEventLog>
  let suggestionStore: ReturnType<typeof createSuggestionStore>

  beforeAll(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'scns-13-9-1-e2e-'))
    suggestionsDir = join(tmpRoot, 'suggestions')

    db = openDatabase(':memory:')
    const dispatcher = createEventDispatcher()
    eventLog = createEventLog(db, dispatcher)
    broker = createBrokerServer(db, eventLog, undefined, dispatcher, { authToken: null })
    server = createServer(broker.app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${addr.port}`

    suggestionStore = createSuggestionStore({ rootDir: suggestionsDir })
  })

  afterAll(async () => {
    await broker.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    closeDatabase(db)
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('team-complexity suggestion → brain wake → team appears at /api/teams + event persisted', async () => {
    // Baseline: no teams before.
    const before = await fetch(`${baseUrl}/api/teams`).then((r) => r.json())
    expect(before).toEqual({ teams: [] })

    // Inject suggestion.
    const suggestion = makeTeamSuggestion()
    suggestionStore.save(suggestion)

    // Build a brain agent with a real team-spawn adapter writing into the
    // broker DB (what cli.ts does in production, minus the agent spawner —
    // we don't want to fork real agents in an e2e test).
    const spawnedAgents: Array<{ role: string; teamId: string }> = []
    const onSpawnTeam = async (input: {
      readonly suggestionId: string
      readonly goal: string
      readonly roles: readonly string[]
    }) => {
      const teamId = `team-sugg-${input.suggestionId.slice(0, 8)}`
      const existing = db.prepare('SELECT id FROM teams WHERE id = ?').get(teamId)
      if (!existing) {
        db.prepare(
          'INSERT INTO teams (id, name, description) VALUES (@id, @name, @description)',
        ).run({ id: teamId, name: teamId, description: `Goal: ${input.goal}` })
        eventLog.teamCreated(null, { team_id: teamId, name: teamId })
      }
      const memberSessionIds: string[] = []
      for (const role of input.roles) {
        spawnedAgents.push({ role, teamId })
        memberSessionIds.push(`session-${role}-${randomUUID().slice(0, 8)}`)
      }
      return { teamId, memberSessionIds }
    }

    const agent = createBrainAgent(
      {
        classifier: createTaskClassifier(),
        decisionTree: createDecisionTree(),
        templateEngine: createTemplateEngine(),
        healthMonitor: createHealthMonitor(),
        taskQueue: createTaskQueue(),
        suggestionStore: {
          list: (filter) => suggestionStore.list(filter.status as Suggestion['status']),
          updateStatus: (id, status) =>
            suggestionStore.updateStatus(id, status as Suggestion['status']),
          // Phase 13.12.20: brain transitions to in-progress after spawn,
          // not to implemented. Proxy to the real store so the e2e
          // matches production wiring.
          markInProgress: (id, teamId) => {
            suggestionStore.markInProgress(id, teamId)
          },
          get: (id) => suggestionStore.get(id),
          recordFailure: (id, reason) => suggestionStore.recordFailure(id, reason),
        },
        suggestionExecutor: {
          execute: () => {
            throw new Error('executor must NOT be called for team-complexity suggestion')
          },
        },
        onSpawnTeam,
        onSuggestionSpawnedTeam: ({ suggestionId, teamId, timestamp }) => {
          eventLog.suggestionSpawnedTeam(null, {
            type: 'suggestion-spawned-team',
            suggestionId,
            teamId,
            timestamp,
          })
        },
      },
      { autonomyLevel: 2 },
    )

    // First wake: promoter auto-approves the suggestion (status → approved).
    await agent.wake()

    // Second wake: ApprovedSuggestions action runs and routes to onSpawnTeam.
    await agent.wake()

    // Verify team row via real HTTP endpoint.
    const res = await fetch(`${baseUrl}/api/teams`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { teams: Array<{ id: string; description: string }> }
    expect(body.teams.length).toBe(1)
    const team = body.teams[0]!
    expect(team.id).toBe(`team-sugg-${suggestion.id.slice(0, 8)}`)
    expect(team.description).toContain('Live test: team-spawn bridge e2e')

    // Verify both roles were spawned.
    expect(spawnedAgents.map((s) => s.role)).toEqual(['dev', 'reviewer'])

    // Phase 13.12.20: suggestion moves to `in-progress` (not `implemented`)
    // after spawn. The quality-gate arbiter transitions to `implemented`
    // only after team_completed + tests/lint pass — that live path is
    // covered by quality-gate-arbiter.test.ts, not here.
    const finalStatus = suggestionStore.get(suggestion.id)?.status
    expect(finalStatus).toBe('in-progress')

    // Verify suggestion_spawned_team event persisted and references both ids.
    const events = eventLog.since(0)
    const bridgeEvent = events.find((e) => e.event_type === 'suggestion_spawned_team')
    expect(bridgeEvent).toBeDefined()
    const payload = JSON.parse(bridgeEvent!.payload) as {
      type: string
      suggestionId: string
      teamId: string
      timestamp: string
    }
    expect(payload.type).toBe('suggestion-spawned-team')
    expect(payload.suggestionId).toBe(suggestion.id)
    expect(payload.teamId).toBe(`team-sugg-${suggestion.id.slice(0, 8)}`)
    expect(typeof payload.timestamp).toBe('string')
  })
})
