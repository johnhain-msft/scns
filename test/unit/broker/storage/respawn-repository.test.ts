import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { TestDb } from '../../../helpers/db-harness.js'
import { createBrokerTestDb } from '../../../helpers/broker-db-harness.js'
import {
  upsertRespawnPolicy,
  findRespawnPolicy,
  findRespawnPoliciesByTeam,
  deleteRespawnPolicy,
  recordRespawnAttempt,
  updateRespawnStatus,
  findRespawnHistory,
  findRespawnHistoryBySession,
} from '../../../../src/broker/storage/repositories/respawn-repository.js'
import type {
  _RespawnPolicy,
  _RespawnHistoryRecord,
} from '../../../../src/broker/storage/repositories/respawn-repository.js'

describe('RespawnRepository', () => {
  let testDb: TestDb
  const TEAM_ID = 'team-heal-1'

  beforeEach(() => {
    testDb = createBrokerTestDb()
    // Insert a team so FK constraints are satisfied for respawn_policies
    testDb.db.prepare('INSERT INTO teams (id, name) VALUES (?, ?)').run(TEAM_ID, 'heal-team')
  })

  afterEach(() => {
    testDb.close()
  })

  // ── Respawn Policies ──────────────────────────────────────────

  describe('upsertRespawnPolicy', () => {
    it('inserts a new policy with defaults', () => {
      const policy = upsertRespawnPolicy(testDb.db, {
        team_id: TEAM_ID,
        role: 'worker',
      })

      expect(policy.team_id).toBe(TEAM_ID)
      expect(policy.role).toBe('worker')
      expect(policy.min_count).toBe(1)
      expect(policy.max_retries).toBe(3)
      expect(policy.backoff_base_ms).toBe(5000)
      expect(policy.enabled).toBe(1)
      expect(policy.id).toBeTypeOf('number')
      expect(policy.created_at).toBeTypeOf('string')
      expect(policy.updated_at).toBeTypeOf('string')
    })

    it('inserts a policy with custom values', () => {
      const policy = upsertRespawnPolicy(testDb.db, {
        team_id: TEAM_ID,
        role: 'leader',
        min_count: 2,
        max_retries: 5,
        backoff_base_ms: 10000,
        enabled: 0,
      })

      expect(policy.min_count).toBe(2)
      expect(policy.max_retries).toBe(5)
      expect(policy.backoff_base_ms).toBe(10000)
      expect(policy.enabled).toBe(0)
    })

    it('upserts on conflict, preserving id and created_at', () => {
      const first = upsertRespawnPolicy(testDb.db, {
        team_id: TEAM_ID,
        role: 'worker',
        min_count: 1,
      })

      const second = upsertRespawnPolicy(testDb.db, {
        team_id: TEAM_ID,
        role: 'worker',
        min_count: 3,
        max_retries: 10,
      })

      expect(second.id).toBe(first.id)
      expect(second.created_at).toBe(first.created_at)
      expect(second.min_count).toBe(3)
      expect(second.max_retries).toBe(10)
    })
  })

  describe('findRespawnPolicy', () => {
    it('returns the policy when found', () => {
      upsertRespawnPolicy(testDb.db, { team_id: TEAM_ID, role: 'worker' })

      const policy = findRespawnPolicy(testDb.db, TEAM_ID, 'worker')
      expect(policy).not.toBeNull()
      expect(policy!.team_id).toBe(TEAM_ID)
      expect(policy!.role).toBe('worker')
    })

    it('returns null when not found', () => {
      const policy = findRespawnPolicy(testDb.db, TEAM_ID, 'nonexistent')
      expect(policy).toBeNull()
    })
  })

  describe('findRespawnPoliciesByTeam', () => {
    it('returns all policies for a team', () => {
      upsertRespawnPolicy(testDb.db, { team_id: TEAM_ID, role: 'worker' })
      upsertRespawnPolicy(testDb.db, { team_id: TEAM_ID, role: 'leader' })

      const policies = findRespawnPoliciesByTeam(testDb.db, TEAM_ID)
      expect(policies).toHaveLength(2)
      const roles = policies.map((p) => p.role).sort()
      expect(roles).toEqual(['leader', 'worker'])
    })

    it('returns empty array for unknown team', () => {
      const policies = findRespawnPoliciesByTeam(testDb.db, 'no-such-team')
      expect(policies).toEqual([])
    })
  })

  describe('deleteRespawnPolicy', () => {
    it('deletes an existing policy and returns true', () => {
      upsertRespawnPolicy(testDb.db, { team_id: TEAM_ID, role: 'worker' })

      expect(deleteRespawnPolicy(testDb.db, TEAM_ID, 'worker')).toBe(true)
      expect(findRespawnPolicy(testDb.db, TEAM_ID, 'worker')).toBeNull()
    })

    it('returns false when policy does not exist', () => {
      expect(deleteRespawnPolicy(testDb.db, TEAM_ID, 'nope')).toBe(false)
    })
  })

  // ── Respawn History ───────────────────────────────────────────

  describe('recordRespawnAttempt', () => {
    it('records a pending attempt with required fields', () => {
      const record = recordRespawnAttempt(testDb.db, {
        team_id: TEAM_ID,
        original_session_id: 'sess-dead-1',
        role: 'worker',
        name: 'worker-1',
        attempt: 1,
        status: 'pending',
      })

      expect(record.id).toBeTypeOf('number')
      expect(record.team_id).toBe(TEAM_ID)
      expect(record.original_session_id).toBe('sess-dead-1')
      expect(record.new_session_id).toBeNull()
      expect(record.role).toBe('worker')
      expect(record.name).toBe('worker-1')
      expect(record.agent_type).toBeNull()
      expect(record.attempt).toBe(1)
      expect(record.status).toBe('pending')
      expect(record.error_message).toBeNull()
      expect(record.created_at).toBeTypeOf('string')
    })

    it('records an attempt with all optional fields', () => {
      const record = recordRespawnAttempt(testDb.db, {
        team_id: TEAM_ID,
        original_session_id: 'sess-dead-2',
        new_session_id: 'sess-new-2',
        role: 'leader',
        name: 'leader-1',
        agent_type: 'claude-sonnet',
        attempt: 2,
        status: 'spawned',
        error_message: null,
      })

      expect(record.new_session_id).toBe('sess-new-2')
      expect(record.agent_type).toBe('claude-sonnet')
      expect(record.status).toBe('spawned')
    })
  })

  describe('updateRespawnStatus', () => {
    it('updates status only', () => {
      const record = recordRespawnAttempt(testDb.db, {
        team_id: TEAM_ID,
        original_session_id: 'sess-1',
        role: 'worker',
        name: 'worker-1',
        attempt: 1,
        status: 'pending',
      })

      const updated = updateRespawnStatus(testDb.db, record.id, 'failed', {})
      expect(updated).not.toBeNull()
      expect(updated!.status).toBe('failed')
      expect(updated!.new_session_id).toBeNull()
    })

    it('updates status with new_session_id', () => {
      const record = recordRespawnAttempt(testDb.db, {
        team_id: TEAM_ID,
        original_session_id: 'sess-1',
        role: 'worker',
        name: 'worker-1',
        attempt: 1,
        status: 'pending',
      })

      const updated = updateRespawnStatus(testDb.db, record.id, 'spawned', {
        new_session_id: 'sess-new-1',
      })
      expect(updated!.status).toBe('spawned')
      expect(updated!.new_session_id).toBe('sess-new-1')
    })

    it('updates status with error_message', () => {
      const record = recordRespawnAttempt(testDb.db, {
        team_id: TEAM_ID,
        original_session_id: 'sess-1',
        role: 'worker',
        name: 'worker-1',
        attempt: 1,
        status: 'pending',
      })

      const updated = updateRespawnStatus(testDb.db, record.id, 'failed', {
        error_message: 'spawn timed out',
      })
      expect(updated!.status).toBe('failed')
      expect(updated!.error_message).toBe('spawn timed out')
    })

    it('returns null for non-existent id', () => {
      const updated = updateRespawnStatus(testDb.db, 99999, 'failed', {})
      expect(updated).toBeNull()
    })
  })

  describe('findRespawnHistory', () => {
    it('returns history ordered by created_at DESC, id DESC', () => {
      recordRespawnAttempt(testDb.db, {
        team_id: TEAM_ID,
        original_session_id: 'sess-1',
        role: 'worker',
        name: 'worker-1',
        attempt: 1,
        status: 'pending',
      })
      recordRespawnAttempt(testDb.db, {
        team_id: TEAM_ID,
        original_session_id: 'sess-2',
        role: 'leader',
        name: 'leader-1',
        attempt: 1,
        status: 'spawned',
      })

      const history = findRespawnHistory(testDb.db, TEAM_ID)
      expect(history).toHaveLength(2)
      // Most recent first (higher id = inserted later in same second)
      expect(history[0]!.id).toBeGreaterThan(history[1]!.id)
    })

    it('respects limit option', () => {
      for (let i = 0; i < 5; i++) {
        recordRespawnAttempt(testDb.db, {
          team_id: TEAM_ID,
          original_session_id: `sess-${i}`,
          role: 'worker',
          name: `worker-${i}`,
          attempt: 1,
          status: 'pending',
        })
      }

      const history = findRespawnHistory(testDb.db, TEAM_ID, { limit: 3 })
      expect(history).toHaveLength(3)
    })

    it('returns empty array for unknown team', () => {
      const history = findRespawnHistory(testDb.db, 'no-such-team')
      expect(history).toEqual([])
    })
  })

  describe('findRespawnHistoryBySession', () => {
    it('returns history for a specific original session', () => {
      recordRespawnAttempt(testDb.db, {
        team_id: TEAM_ID,
        original_session_id: 'sess-dead',
        role: 'worker',
        name: 'worker-1',
        attempt: 1,
        status: 'pending',
      })
      recordRespawnAttempt(testDb.db, {
        team_id: TEAM_ID,
        original_session_id: 'sess-dead',
        role: 'worker',
        name: 'worker-1',
        attempt: 2,
        status: 'spawned',
      })
      recordRespawnAttempt(testDb.db, {
        team_id: TEAM_ID,
        original_session_id: 'other-sess',
        role: 'leader',
        name: 'leader-1',
        attempt: 1,
        status: 'pending',
      })

      const history = findRespawnHistoryBySession(testDb.db, 'sess-dead')
      expect(history).toHaveLength(2)
      expect(history.every((r) => r.original_session_id === 'sess-dead')).toBe(true)
    })

    it('returns empty array for unknown session', () => {
      const history = findRespawnHistoryBySession(testDb.db, 'unknown')
      expect(history).toEqual([])
    })
  })
})
