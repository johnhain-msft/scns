import { describe, it, expect } from 'vitest'
import {
  checkAutonomy,
  getAllowedActions,
  getRequiredLevel,
  AutonomyAction,
} from '../../../src/autonomy/index.js'

describe('autonomy guardrails', () => {
  describe('checkAutonomy', () => {
    it('L0 allows observe but blocks spawn-agent', () => {
      expect(checkAutonomy(0, AutonomyAction.Observe)).toMatchObject({
        allowed: true,
        level: 0,
      })
      expect(checkAutonomy(0, AutonomyAction.SpawnAgent)).toMatchObject({
        allowed: false,
        level: 0,
      })
    })

    it('L1 allows generate-suggestion but blocks execute-suggestion', () => {
      expect(checkAutonomy(1, AutonomyAction.GenerateSuggestion)).toMatchObject({
        allowed: true,
      })
      expect(checkAutonomy(1, AutonomyAction.ExecuteSuggestion)).toMatchObject({
        allowed: false,
      })
    })

    it('L2 allows spawn-agent and execute-suggestion', () => {
      expect(checkAutonomy(2, AutonomyAction.SpawnAgent)).toMatchObject({ allowed: true })
      expect(checkAutonomy(2, AutonomyAction.ExecuteSuggestion)).toMatchObject({ allowed: true })
    })

    it('L2 blocks kill-session and restart-broker', () => {
      expect(checkAutonomy(2, AutonomyAction.KillSession)).toMatchObject({ allowed: false })
      expect(checkAutonomy(2, AutonomyAction.RestartBroker)).toMatchObject({ allowed: false })
    })

    it('L3 allows all actions including destructive ones', () => {
      expect(checkAutonomy(3, AutonomyAction.KillSession)).toMatchObject({ allowed: true })
      expect(checkAutonomy(3, AutonomyAction.RestartBroker)).toMatchObject({ allowed: true })
      expect(checkAutonomy(3, AutonomyAction.PromoteAutonomy)).toMatchObject({ allowed: true })
    })

    it('clamps negative levels to 0', () => {
      const result = checkAutonomy(-1, AutonomyAction.Observe)
      expect(result.level).toBe(0)
      expect(result.allowed).toBe(true)
    })

    it('clamps levels above 3 to 3', () => {
      const result = checkAutonomy(5, AutonomyAction.KillSession)
      expect(result.level).toBe(3)
      expect(result.allowed).toBe(true)
    })

    it('includes descriptive reason for blocked actions', () => {
      const result = checkAutonomy(0, AutonomyAction.SpawnAgent)
      expect(result.reason).toContain('requires higher autonomy')
      expect(result.reason).toContain('L0')
    })

    it('includes descriptive reason for allowed actions', () => {
      const result = checkAutonomy(2, AutonomyAction.SpawnAgent)
      expect(result.reason).toContain('permitted at L2')
    })
  })

  describe('getAllowedActions', () => {
    it('L0 has only read-only actions', () => {
      const actions = getAllowedActions(0)
      expect(actions).toContain(AutonomyAction.Observe)
      expect(actions).toContain(AutonomyAction.Search)
      expect(actions).not.toContain(AutonomyAction.SpawnAgent)
      expect(actions.length).toBe(4)
    })

    it('each level includes all actions from lower levels', () => {
      const l0 = new Set(getAllowedActions(0))
      const l1 = new Set(getAllowedActions(1))
      const l2 = new Set(getAllowedActions(2))
      const l3 = new Set(getAllowedActions(3))

      for (const action of l0) expect(l1.has(action)).toBe(true)
      for (const action of l1) expect(l2.has(action)).toBe(true)
      for (const action of l2) expect(l3.has(action)).toBe(true)
    })

    it('L3 has the most actions', () => {
      expect(getAllowedActions(3).length).toBeGreaterThan(getAllowedActions(2).length)
    })
  })

  describe('getRequiredLevel', () => {
    it('observe requires L0', () => {
      expect(getRequiredLevel(AutonomyAction.Observe)).toBe(0)
    })

    it('generate-suggestion requires L1', () => {
      expect(getRequiredLevel(AutonomyAction.GenerateSuggestion)).toBe(1)
    })

    it('spawn-agent requires L2', () => {
      expect(getRequiredLevel(AutonomyAction.SpawnAgent)).toBe(2)
    })

    it('kill-session requires L3', () => {
      expect(getRequiredLevel(AutonomyAction.KillSession)).toBe(3)
    })
  })
})
