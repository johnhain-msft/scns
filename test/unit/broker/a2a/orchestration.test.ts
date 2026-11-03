import { describe, it, expect } from 'vitest'
import {
  createOrchestrationEngine,
  OrchestrationPhase,
} from '../../../../src/broker/a2a/orchestration.js'
import type { PhaseStatus } from '../../../../src/broker/a2a/orchestration.js'
import type { TeamManifest, TeamState } from '../../../../src/broker/a2a/team-manifest.js'
import { TeamManifestSchema } from '../../../../src/broker/a2a/team-manifest.js'

function makeManifest(overrides: Partial<TeamManifest> = {}): TeamManifest {
  return TeamManifestSchema.parse({
    id: 'manifest-1',
    name: 'Test Manifest',
    description: 'Test',
    roles: [
      { role: 'researcher', count: 2 },
      { role: 'implementer', count: 1 },
    ],
    phases: [
      { name: 'research', roles: ['researcher'], gateCondition: 'all-complete' },
      { name: 'implementation', roles: ['implementer'], gateCondition: 'all-complete' },
    ],
    ...overrides,
  })
}

describe('OrchestrationPhase enum', () => {
  it('has expected phase values', () => {
    expect(OrchestrationPhase.Research).toBe('research')
    expect(OrchestrationPhase.Planning).toBe('planning')
    expect(OrchestrationPhase.Implementation).toBe('implementation')
    expect(OrchestrationPhase.Review).toBe('review')
    expect(OrchestrationPhase.Verification).toBe('verification')
    expect(OrchestrationPhase.Synthesis).toBe('synthesis')
  })
})

describe('createOrchestrationEngine', () => {
  const engine = createOrchestrationEngine()

  describe('initialize', () => {
    it('creates state with all phases', () => {
      const state = engine.initialize(makeManifest(), 'team-1')
      expect(state.phases).toHaveLength(2)
    })

    it('first phase is active', () => {
      const state = engine.initialize(makeManifest(), 'team-1')
      expect(state.phases[0]!.status).toBe('active')
    })

    it('subsequent phases are pending', () => {
      const state = engine.initialize(makeManifest(), 'team-1')
      expect(state.phases[1]!.status).toBe('pending')
    })

    it('overall status is running', () => {
      const state = engine.initialize(makeManifest(), 'team-1')
      expect(state.overallStatus).toBe('running')
    })

    it('sets teamId and manifestId', () => {
      const state = engine.initialize(makeManifest(), 'team-1')
      expect(state.teamId).toBe('team-1')
      expect(state.manifestId).toBe('manifest-1')
    })

    it('currentPhase is first phase name', () => {
      const state = engine.initialize(makeManifest(), 'team-1')
      expect(state.currentPhase).toBe('research')
    })

    it('phases have tasks based on role counts', () => {
      const state = engine.initialize(makeManifest(), 'team-1')
      // research phase: 2 researchers → 2 tasks
      expect(state.phases[0]!.tasks).toHaveLength(2)
      // implementation phase: 1 implementer → 1 task
      expect(state.phases[1]!.tasks).toHaveLength(1)
    })
  })

  describe('checkGate', () => {
    it('all-complete: true when all tasks completed', () => {
      const phase: PhaseStatus = {
        phase: 'research',
        status: 'active',
        tasks: [
          { taskId: 't1', status: 'completed' },
          { taskId: 't2', status: 'completed' },
        ],
        gateCondition: 'all-complete',
        gateMet: false,
      }
      expect(engine.checkGate(phase)).toBe(true)
    })

    it('all-complete: false when one task pending', () => {
      const phase: PhaseStatus = {
        phase: 'research',
        status: 'active',
        tasks: [
          { taskId: 't1', status: 'completed' },
          { taskId: 't2', status: 'working' },
        ],
        gateCondition: 'all-complete',
        gateMet: false,
      }
      expect(engine.checkGate(phase)).toBe(false)
    })

    it('any-complete: true when one task completed', () => {
      const phase: PhaseStatus = {
        phase: 'research',
        status: 'active',
        tasks: [
          { taskId: 't1', status: 'completed' },
          { taskId: 't2', status: 'working' },
        ],
        gateCondition: 'any-complete',
        gateMet: false,
      }
      expect(engine.checkGate(phase)).toBe(true)
    })

    it('any-complete: false when no tasks completed', () => {
      const phase: PhaseStatus = {
        phase: 'research',
        status: 'active',
        tasks: [
          { taskId: 't1', status: 'working' },
          { taskId: 't2', status: 'working' },
        ],
        gateCondition: 'any-complete',
        gateMet: false,
      }
      expect(engine.checkGate(phase)).toBe(false)
    })

    it('majority-complete: true when >50% completed', () => {
      const phase: PhaseStatus = {
        phase: 'research',
        status: 'active',
        tasks: [
          { taskId: 't1', status: 'completed' },
          { taskId: 't2', status: 'completed' },
          { taskId: 't3', status: 'working' },
        ],
        gateCondition: 'majority-complete',
        gateMet: false,
      }
      expect(engine.checkGate(phase)).toBe(true)
    })

    it('majority-complete: false when <=50% completed', () => {
      const phase: PhaseStatus = {
        phase: 'research',
        status: 'active',
        tasks: [
          { taskId: 't1', status: 'completed' },
          { taskId: 't2', status: 'working' },
          { taskId: 't3', status: 'working' },
        ],
        gateCondition: 'majority-complete',
        gateMet: false,
      }
      expect(engine.checkGate(phase)).toBe(false)
    })
  })

  describe('advance', () => {
    it('gate met → phase completes, next phase activates', () => {
      let state = engine.initialize(makeManifest(), 'team-1')
      // Complete all tasks in first phase
      for (const task of state.phases[0]!.tasks) {
        state = engine.updateTask(state, task.taskId, 'completed')
      }
      const advanced = engine.advance(state)
      expect(advanced.phases[0]!.status).toBe('complete')
      expect(advanced.phases[1]!.status).toBe('active')
      expect(advanced.currentPhase).toBe('implementation')
    })

    it('gate not met → no change', () => {
      const state = engine.initialize(makeManifest(), 'team-1')
      const advanced = engine.advance(state)
      expect(advanced.phases[0]!.status).toBe('active')
      expect(advanced.phases[1]!.status).toBe('pending')
      expect(advanced.currentPhase).toBe('research')
    })

    it('all phases complete → overallStatus completed', () => {
      let state = engine.initialize(makeManifest(), 'team-1')
      // Complete all tasks in all phases
      for (const phase of state.phases) {
        for (const task of phase.tasks) {
          state = engine.updateTask(state, task.taskId, 'completed')
        }
        state = engine.advance(state)
      }
      expect(state.overallStatus).toBe('completed')
    })

    it('phase with all failed tasks → overallStatus failed', () => {
      let state = engine.initialize(makeManifest(), 'team-1')
      // Fail all tasks in first phase
      for (const task of state.phases[0]!.tasks) {
        state = engine.updateTask(state, task.taskId, 'failed')
      }
      const advanced = engine.advance(state)
      expect(advanced.overallStatus).toBe('failed')
    })
  })

  describe('updateTask', () => {
    it('updates correct task status in correct phase', () => {
      const state = engine.initialize(makeManifest(), 'team-1')
      const taskId = state.phases[0]!.tasks[0]!.taskId
      const updated = engine.updateTask(state, taskId, 'completed')
      expect(updated.phases[0]!.tasks[0]!.status).toBe('completed')
    })

    it('does not modify other tasks', () => {
      const state = engine.initialize(makeManifest(), 'team-1')
      const taskId = state.phases[0]!.tasks[0]!.taskId
      const updated = engine.updateTask(state, taskId, 'completed')
      expect(updated.phases[0]!.tasks[1]!.status).toBe('pending')
    })

    it('unknown taskId → no change', () => {
      const state = engine.initialize(makeManifest(), 'team-1')
      const updated = engine.updateTask(state, 'nonexistent', 'completed')
      expect(updated).toEqual(state)
    })
  })

  describe('getCurrentPhase', () => {
    it('returns active phase', () => {
      const state = engine.initialize(makeManifest(), 'team-1')
      const current = engine.getCurrentPhase(state)
      expect(current).not.toBeNull()
      expect(current!.phase).toBe('research')
      expect(current!.status).toBe('active')
    })

    it('returns null when all complete', () => {
      let state = engine.initialize(makeManifest(), 'team-1')
      for (const phase of state.phases) {
        for (const task of phase.tasks) {
          state = engine.updateTask(state, task.taskId, 'completed')
        }
        state = engine.advance(state)
      }
      expect(engine.getCurrentPhase(state)).toBeNull()
    })
  })

  describe('isComplete', () => {
    it('true when all phases complete', () => {
      let state = engine.initialize(makeManifest(), 'team-1')
      for (const phase of state.phases) {
        for (const task of phase.tasks) {
          state = engine.updateTask(state, task.taskId, 'completed')
        }
        state = engine.advance(state)
      }
      expect(engine.isComplete(state)).toBe(true)
    })

    it('false when phases remain', () => {
      const state = engine.initialize(makeManifest(), 'team-1')
      expect(engine.isComplete(state)).toBe(false)
    })

    it('true when overallStatus is failed', () => {
      let state = engine.initialize(makeManifest(), 'team-1')
      for (const task of state.phases[0]!.tasks) {
        state = engine.updateTask(state, task.taskId, 'failed')
      }
      state = engine.advance(state)
      expect(engine.isComplete(state)).toBe(true)
    })
  })

  describe('reconcile', () => {
    it('desired 3 actual 1 → 2 spawn actions', () => {
      const manifest = makeManifest({
        roles: [{ role: 'researcher', count: 3 }],
      })
      const actual: TeamState = {
        teamId: 'team-1',
        members: [{ role: 'researcher', sessionId: 's1', status: 'active' }],
      }
      const actions = engine.reconcile(manifest, actual)
      const spawns = actions.filter((a) => a.type === 'spawn' && a.role === 'researcher')
      expect(spawns).toHaveLength(1)
      expect(spawns[0]!.count).toBe(2)
    })

    it('desired 1 actual 3 → 2 kill actions', () => {
      const manifest = makeManifest({
        roles: [{ role: 'researcher', count: 1 }],
      })
      const actual: TeamState = {
        teamId: 'team-1',
        members: [
          { role: 'researcher', sessionId: 's1', status: 'active' },
          { role: 'researcher', sessionId: 's2', status: 'active' },
          { role: 'researcher', sessionId: 's3', status: 'active' },
        ],
      }
      const actions = engine.reconcile(manifest, actual)
      const kills = actions.filter((a) => a.type === 'kill' && a.role === 'researcher')
      expect(kills).toHaveLength(1)
      expect(kills[0]!.count).toBe(2)
    })

    it('desired matches actual → noop', () => {
      const manifest = makeManifest({
        roles: [{ role: 'researcher', count: 2 }],
      })
      const actual: TeamState = {
        teamId: 'team-1',
        members: [
          { role: 'researcher', sessionId: 's1', status: 'active' },
          { role: 'researcher', sessionId: 's2', status: 'active' },
        ],
      }
      const actions = engine.reconcile(manifest, actual)
      const noops = actions.filter((a) => a.type === 'noop')
      expect(noops).toHaveLength(1)
    })

    it('mixed roles: some spawn, some kill', () => {
      const manifest = makeManifest({
        roles: [
          { role: 'researcher', count: 3 },
          { role: 'implementer', count: 1 },
        ],
      })
      const actual: TeamState = {
        teamId: 'team-1',
        members: [
          { role: 'researcher', sessionId: 's1', status: 'active' },
          { role: 'implementer', sessionId: 's2', status: 'active' },
          { role: 'implementer', sessionId: 's3', status: 'active' },
        ],
      }
      const actions = engine.reconcile(manifest, actual)
      expect(actions.some((a) => a.type === 'spawn' && a.role === 'researcher')).toBe(true)
      expect(actions.some((a) => a.type === 'kill' && a.role === 'implementer')).toBe(true)
    })

    it('empty actual → all spawn', () => {
      const manifest = makeManifest({
        roles: [
          { role: 'researcher', count: 2 },
          { role: 'implementer', count: 1 },
        ],
      })
      const actual: TeamState = { teamId: 'team-1', members: [] }
      const actions = engine.reconcile(manifest, actual)
      const spawns = actions.filter((a) => a.type === 'spawn')
      expect(spawns).toHaveLength(2)
    })
  })
})
