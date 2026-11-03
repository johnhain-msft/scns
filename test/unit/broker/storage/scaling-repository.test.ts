import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { TestDb } from '../../../helpers/db-harness.js'
import { createBrokerTestDb } from '../../../helpers/broker-db-harness.js'
import {
  upsertScalingPolicy,
  findScalingPolicy,
  findScalingPoliciesByTeam,
  deleteScalingPolicy,
  recordScaleAction,
} from '../../../../src/broker/storage/repositories/scaling-repository.js'
import type { _ScalingPolicy } from '../../../../src/broker/storage/repositories/scaling-repository.js'

describe('ScalingRepository', () => {
  let testDb: TestDb
  const TEAM_ID = 'team-scale-1'

  beforeEach(() => {
    testDb = createBrokerTestDb()
    testDb.db.prepare('INSERT INTO teams (id, name) VALUES (?, ?)').run(TEAM_ID, 'scale-team')
  })

  afterEach(() => {
    testDb.close()
  })

  // ── Scaling Policies ──────────────────────────────────────────

  describe('upsertScalingPolicy', () => {
    it('inserts a new policy with defaults', () => {
      const policy = upsertScalingPolicy(testDb.db, {
        team_id: TEAM_ID,
        role: 'worker',
      })

      expect(policy.team_id).toBe(TEAM_ID)
      expect(policy.role).toBe('worker')
      expect(policy.min_count).toBe(1)
      expect(policy.max_count).toBe(5)
      expect(policy.scale_up_threshold).toBe(3)
      expect(policy.scale_down_threshold).toBe(0)
      expect(policy.cooldown_ms).toBe(60000)
      expect(policy.enabled).toBe(1)
      expect(policy.last_scale_action_at).toBeNull()
      expect(policy.id).toBeTypeOf('number')
    })

    it('inserts a policy with custom values', () => {
      const policy = upsertScalingPolicy(testDb.db, {
        team_id: TEAM_ID,
        role: 'leader',
        min_count: 2,
        max_count: 10,
        scale_up_threshold: 5,
        scale_down_threshold: 1,
        cooldown_ms: 30000,
        enabled: 0,
      })

      expect(policy.min_count).toBe(2)
      expect(policy.max_count).toBe(10)
      expect(policy.scale_up_threshold).toBe(5)
      expect(policy.scale_down_threshold).toBe(1)
      expect(policy.cooldown_ms).toBe(30000)
      expect(policy.enabled).toBe(0)
    })

    it('upserts on conflict, preserving id', () => {
      const first = upsertScalingPolicy(testDb.db, {
        team_id: TEAM_ID,
        role: 'worker',
        min_count: 1,
      })

      const second = upsertScalingPolicy(testDb.db, {
        team_id: TEAM_ID,
        role: 'worker',
        min_count: 3,
        max_count: 8,
      })

      expect(second.id).toBe(first.id)
      expect(second.min_count).toBe(3)
      expect(second.max_count).toBe(8)
    })

    it('preserves last_scale_action_at on upsert', () => {
      upsertScalingPolicy(testDb.db, { team_id: TEAM_ID, role: 'worker' })
      recordScaleAction(testDb.db, TEAM_ID, 'worker')

      const before = findScalingPolicy(testDb.db, TEAM_ID, 'worker')
      expect(before!.last_scale_action_at).not.toBeNull()

      // Upsert should preserve last_scale_action_at
      const after = upsertScalingPolicy(testDb.db, {
        team_id: TEAM_ID,
        role: 'worker',
        min_count: 5,
      })
      expect(after.last_scale_action_at).toBe(before!.last_scale_action_at)
    })
  })

  describe('findScalingPolicy', () => {
    it('returns the policy when found', () => {
      upsertScalingPolicy(testDb.db, { team_id: TEAM_ID, role: 'worker' })

      const policy = findScalingPolicy(testDb.db, TEAM_ID, 'worker')
      expect(policy).not.toBeNull()
      expect(policy!.team_id).toBe(TEAM_ID)
      expect(policy!.role).toBe('worker')
    })

    it('returns null when not found', () => {
      const policy = findScalingPolicy(testDb.db, TEAM_ID, 'nonexistent')
      expect(policy).toBeNull()
    })
  })

  describe('findScalingPoliciesByTeam', () => {
    it('returns all policies for a team', () => {
      upsertScalingPolicy(testDb.db, { team_id: TEAM_ID, role: 'worker' })
      upsertScalingPolicy(testDb.db, { team_id: TEAM_ID, role: 'leader' })

      const policies = findScalingPoliciesByTeam(testDb.db, TEAM_ID)
      expect(policies).toHaveLength(2)
      const roles = policies.map((p) => p.role).sort()
      expect(roles).toEqual(['leader', 'worker'])
    })

    it('returns empty array for unknown team', () => {
      const policies = findScalingPoliciesByTeam(testDb.db, 'no-such-team')
      expect(policies).toEqual([])
    })
  })

  describe('deleteScalingPolicy', () => {
    it('deletes an existing policy and returns true', () => {
      upsertScalingPolicy(testDb.db, { team_id: TEAM_ID, role: 'worker' })

      expect(deleteScalingPolicy(testDb.db, TEAM_ID, 'worker')).toBe(true)
      expect(findScalingPolicy(testDb.db, TEAM_ID, 'worker')).toBeNull()
    })

    it('returns false when policy does not exist', () => {
      expect(deleteScalingPolicy(testDb.db, TEAM_ID, 'nope')).toBe(false)
    })
  })

  describe('recordScaleAction', () => {
    it('sets last_scale_action_at to current time', () => {
      upsertScalingPolicy(testDb.db, { team_id: TEAM_ID, role: 'worker' })

      const before = findScalingPolicy(testDb.db, TEAM_ID, 'worker')
      expect(before!.last_scale_action_at).toBeNull()

      recordScaleAction(testDb.db, TEAM_ID, 'worker')

      const after = findScalingPolicy(testDb.db, TEAM_ID, 'worker')
      expect(after!.last_scale_action_at).not.toBeNull()
      expect(after!.last_scale_action_at).toBeTypeOf('string')
    })

    it('returns false when no matching policy exists', () => {
      const result = recordScaleAction(testDb.db, TEAM_ID, 'nonexistent')
      expect(result).toBe(false)
    })

    it('returns true when policy exists', () => {
      upsertScalingPolicy(testDb.db, { team_id: TEAM_ID, role: 'worker' })
      const result = recordScaleAction(testDb.db, TEAM_ID, 'worker')
      expect(result).toBe(true)
    })
  })
})
