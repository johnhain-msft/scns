/**
 * Phase 13.9.1 — Executor → team-spawn bridge integration test.
 *
 * Uses the real suggestion store (in-memory), the real broker DB + event log,
 * and a real onSpawnTeam implementation that creates a row in `teams`. Asserts
 * the team is visible via repository queries and the suggestion is marked
 * implemented, and that the suggestion_spawned_team event is persisted.
 */

import { describe, it, expect } from 'vitest'
import { createBrainAgent } from '../../../src/brain/agent-loop.js'
import { createTaskQueue } from '../../../src/brain/task-queue.js'
import { createDecisionTree } from '../../../src/brain/decision-tree.js'
import { createTaskClassifier } from '../../../src/brain/classifier.js'
import { createTemplateEngine } from '../../../src/brain/templates.js'
import { createHealthMonitor } from '../../../src/context/health-monitor.js'
import { createBrokerTestDb } from '../../helpers/broker-db-harness.js'
import { createEventLog } from '../../../src/broker/services/event-log.js'
import { findAllTeams } from '../../../src/broker/storage/repositories/team-repository.js'
import type { Suggestion } from '../../../src/suggest/types.js'

function makeSuggestion(overrides: Partial<Suggestion> = {}): Suggestion {
  const now = new Date().toISOString()
  return {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    type: 'workflow',
    title: 'Integration: executor → team bridge',
    description: 'Team-complexity suggestion that should spawn a team.',
    status: 'approved',
    confidence: 0.95,
    evidence: [],
    tags: [],
    createdAt: now,
    updatedAt: now,
    actionable: true,
    estimatedComplexity: 'team',
    suggestedRoles: ['dev', 'reviewer'],
    ...overrides,
  } as Suggestion
}

describe('Phase 13.9.1 integration — executor → team-spawn bridge', () => {
  it('spawns a real team row for a team-complexity suggestion and persists the event', async () => {
    const testDb = createBrokerTestDb()
    const { db } = testDb
    try {
      const eventLog = createEventLog(db)
      const suggestion = makeSuggestion()
      const statuses = new Map<string, string>([[suggestion.id, suggestion.status as string]])
      const store = {
        list: (filter: { status: string }) =>
          [suggestion].filter((s) => statuses.get(s.id) === filter.status),
        updateStatus: (id: string, status: string) => {
          statuses.set(id, status)
        },
        markInProgress: (id: string, _teamId: string) => {
          statuses.set(id, 'in-progress')
        },
        get: (id: string) => (id === suggestion.id ? suggestion : null),
        recordFailure: () => {
          /* noop */
        },
      }
      const executor = { execute: () => ({ success: true }) }

      const spawnedAgents: Array<{ role: string; teamId: string }> = []
      const onSpawnTeam = async (input: {
        readonly suggestionId: string
        readonly goal: string
        readonly roles: readonly string[]
      }) => {
        const teamId = `team-sugg-${input.suggestionId.slice(0, 8)}`
        db.prepare(
          'INSERT INTO teams (id, name, description) VALUES (@id, @name, @description)',
        ).run({ id: teamId, name: teamId, description: `Goal: ${input.goal}` })
        eventLog.teamCreated(null, { team_id: teamId, name: teamId, source: 'brain-suggestion' })
        const memberSessionIds: string[] = []
        for (const role of input.roles) {
          spawnedAgents.push({ role, teamId })
          memberSessionIds.push(`session-${role}`)
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
          suggestionStore: store,
          suggestionExecutor: executor,
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

      await agent.wake()

      // Team row exists
      const teams = findAllTeams(db)
      expect(teams.length).toBe(1)
      expect(teams[0]!.id).toBe('team-sugg-aaaaaaaa')
      expect(teams[0]!.description).toContain('Integration: executor → team bridge')

      // Phase 13.12.20: Suggestion now transitions to in-progress (not
      // implemented) after successful team spawn. It becomes 'implemented'
      // later, when team_completed fires and the quality-gate arbiter passes.
      expect(statuses.get(suggestion.id)).toBe('in-progress')

      // Agents spawned per role
      expect(spawnedAgents.map((s) => s.role)).toEqual(['dev', 'reviewer'])

      // Event persisted
      const events = eventLog.since(0)
      const bridgeEvent = events.find((e) => e.event_type === 'suggestion_spawned_team')
      expect(bridgeEvent).toBeDefined()
      const payload = JSON.parse(bridgeEvent!.payload) as {
        type: string
        suggestionId: string
        teamId: string
      }
      expect(payload.type).toBe('suggestion-spawned-team')
      expect(payload.suggestionId).toBe(suggestion.id)
      expect(payload.teamId).toBe('team-sugg-aaaaaaaa')
    } finally {
      testDb.close()
    }
  })

  it('13.12.24a: solo-complexity REPO-WORK suggestion routes to single scns-dev via onSpawnTeam', async () => {
    const testDb = createBrokerTestDb()
    const { db } = testDb
    try {
      // `github-action` artifacts are repo content, so solo repo work keeps the spawn
      // path; direct-artifact types (lsp/instruction/…) take the executor path now.
      const suggestion = makeSuggestion({
        id: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
        type: 'github-action',
        estimatedComplexity: 'solo',
        suggestedRoles: undefined,
      })
      const statuses = new Map<string, string>([[suggestion.id, 'approved']])
      const store = {
        list: (filter: { status: string }) =>
          [suggestion].filter((s) => statuses.get(s.id) === filter.status),
        updateStatus: (id: string, status: string) => {
          statuses.set(id, status)
        },
        markInProgress: (id: string, _teamId: string) => {
          statuses.set(id, 'in-progress')
        },
      }
      let executorCalls = 0
      const executor = {
        execute: () => {
          executorCalls += 1
          return { success: true }
        },
      }
      let spawnTeamCalls = 0
      let lastRoles: readonly string[] = []
      const onSpawnTeam = async (input: { roles: readonly string[] }) => {
        spawnTeamCalls += 1
        lastRoles = input.roles
        return { teamId: 'team-sugg-bbbbbbbb', memberSessionIds: ['s1'] }
      }

      const agent = createBrainAgent(
        {
          classifier: createTaskClassifier(),
          decisionTree: createDecisionTree(),
          templateEngine: createTemplateEngine(),
          healthMonitor: createHealthMonitor(),
          taskQueue: createTaskQueue(),
          suggestionStore: store,
          suggestionExecutor: executor,
          onSpawnTeam,
        },
        { autonomyLevel: 2 },
      )

      await agent.wake()

      // Unified solo path: onSpawnTeam invoked with exactly one role (scns-dev),
      // executor untouched, suggestion moves to in-progress pending team_completed.
      expect(spawnTeamCalls).toBe(1)
      expect(lastRoles).toEqual(['scns-dev'])
      expect(executorCalls).toBe(0)
      expect(findAllTeams(db).length).toBe(0) // still 0: test's onSpawnTeam doesn't touch db
      expect(statuses.get(suggestion.id)).toBe('in-progress')
    } finally {
      testDb.close()
    }
  })
})
