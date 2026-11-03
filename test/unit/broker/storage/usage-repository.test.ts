import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { TestDb } from '../../../helpers/db-harness.js'
import { createBrokerTestDb } from '../../../helpers/broker-db-harness.js'
import {
  recordUsage,
  findUsageBySession,
  findUsageByTeam,
  getSessionCostSummary,
  getCostSummary,
  findUsageSince,
  deleteUsageBySession,
} from '../../../../src/broker/storage/repositories/usage-repository.js'

describe('UsageRepository', () => {
  let testDb: TestDb

  beforeEach(() => {
    testDb = createBrokerTestDb()
  })

  afterEach(() => {
    testDb.close()
  })

  describe('recordUsage', () => {
    it('inserts a usage record with all fields', () => {
      const record = recordUsage(testDb.db, {
        session_id: 's1',
        team_id: 'team-a',
        task_id: 42,
        tokens_in: 1000,
        tokens_out: 500,
        model: 'claude-sonnet-4',
        cost_usd: 0.015,
      })

      expect(record.id).toBeTypeOf('number')
      expect(record.session_id).toBe('s1')
      expect(record.team_id).toBe('team-a')
      expect(record.task_id).toBe(42)
      expect(record.tokens_in).toBe(1000)
      expect(record.tokens_out).toBe(500)
      expect(record.model).toBe('claude-sonnet-4')
      expect(record.cost_usd).toBe(0.015)
      expect(record.recorded_at).toBeTypeOf('string')
    })

    it('inserts a record with only required fields', () => {
      const record = recordUsage(testDb.db, {
        session_id: 's1',
        tokens_in: 200,
        tokens_out: 100,
        cost_usd: 0.005,
      })

      expect(record.session_id).toBe('s1')
      expect(record.team_id).toBeNull()
      expect(record.task_id).toBeNull()
      expect(record.model).toBeNull()
      expect(record.tokens_in).toBe(200)
      expect(record.tokens_out).toBe(100)
      expect(record.cost_usd).toBe(0.005)
    })

    it('auto-increments id', () => {
      const r1 = recordUsage(testDb.db, {
        session_id: 's1',
        tokens_in: 10,
        tokens_out: 5,
        cost_usd: 0.001,
      })
      const r2 = recordUsage(testDb.db, {
        session_id: 's1',
        tokens_in: 20,
        tokens_out: 10,
        cost_usd: 0.002,
      })

      expect(r2.id).toBeGreaterThan(r1.id)
    })
  })

  describe('findUsageBySession', () => {
    it('returns all records for a session ordered by recorded_at DESC', () => {
      recordUsage(testDb.db, {
        session_id: 's1',
        tokens_in: 100,
        tokens_out: 50,
        cost_usd: 0.01,
      })
      recordUsage(testDb.db, {
        session_id: 's1',
        tokens_in: 200,
        tokens_out: 100,
        cost_usd: 0.02,
      })
      recordUsage(testDb.db, {
        session_id: 's2',
        tokens_in: 300,
        tokens_out: 150,
        cost_usd: 0.03,
      })

      const records = findUsageBySession(testDb.db, 's1')
      expect(records).toHaveLength(2)
      expect(records[0]!.tokens_in).toBe(200)
      expect(records[1]!.tokens_in).toBe(100)
    })

    it('returns empty array when no records exist', () => {
      const records = findUsageBySession(testDb.db, 'nonexistent')
      expect(records).toEqual([])
    })
  })

  describe('findUsageByTeam', () => {
    it('returns all records for a team', () => {
      recordUsage(testDb.db, {
        session_id: 's1',
        team_id: 'team-a',
        tokens_in: 100,
        tokens_out: 50,
        cost_usd: 0.01,
      })
      recordUsage(testDb.db, {
        session_id: 's2',
        team_id: 'team-a',
        tokens_in: 200,
        tokens_out: 100,
        cost_usd: 0.02,
      })
      recordUsage(testDb.db, {
        session_id: 's3',
        team_id: 'team-b',
        tokens_in: 300,
        tokens_out: 150,
        cost_usd: 0.03,
      })

      const records = findUsageByTeam(testDb.db, 'team-a')
      expect(records).toHaveLength(2)
      expect(records.every((r) => r.team_id === 'team-a')).toBe(true)
    })

    it('returns empty array when no records for team', () => {
      const records = findUsageByTeam(testDb.db, 'no-team')
      expect(records).toEqual([])
    })
  })

  describe('getSessionCostSummary', () => {
    it('returns aggregated cost summary for a session', () => {
      recordUsage(testDb.db, {
        session_id: 's1',
        tokens_in: 1000,
        tokens_out: 500,
        cost_usd: 0.01,
      })
      recordUsage(testDb.db, {
        session_id: 's1',
        tokens_in: 2000,
        tokens_out: 1000,
        cost_usd: 0.02,
      })

      const summary = getSessionCostSummary(testDb.db, 's1')
      expect(summary.total_tokens_in).toBe(3000)
      expect(summary.total_tokens_out).toBe(1500)
      expect(summary.total_cost_usd).toBeCloseTo(0.03)
      expect(summary.record_count).toBe(2)
    })

    it('returns zeros when no records exist for session', () => {
      const summary = getSessionCostSummary(testDb.db, 'empty')
      expect(summary.total_tokens_in).toBe(0)
      expect(summary.total_tokens_out).toBe(0)
      expect(summary.total_cost_usd).toBe(0)
      expect(summary.record_count).toBe(0)
    })
  })

  describe('getCostSummary', () => {
    it('returns overall aggregated cost summary', () => {
      recordUsage(testDb.db, {
        session_id: 's1',
        tokens_in: 1000,
        tokens_out: 500,
        cost_usd: 0.01,
      })
      recordUsage(testDb.db, {
        session_id: 's2',
        tokens_in: 2000,
        tokens_out: 1000,
        cost_usd: 0.02,
      })
      recordUsage(testDb.db, {
        session_id: 's1',
        tokens_in: 500,
        tokens_out: 250,
        cost_usd: 0.005,
      })

      const summary = getCostSummary(testDb.db)
      expect(summary.total_tokens_in).toBe(3500)
      expect(summary.total_tokens_out).toBe(1750)
      expect(summary.total_cost_usd).toBeCloseTo(0.035)
      expect(summary.session_count).toBe(2)
      expect(summary.record_count).toBe(3)
    })

    it('returns zeros when no records exist', () => {
      const summary = getCostSummary(testDb.db)
      expect(summary.total_tokens_in).toBe(0)
      expect(summary.total_tokens_out).toBe(0)
      expect(summary.total_cost_usd).toBe(0)
      expect(summary.session_count).toBe(0)
      expect(summary.record_count).toBe(0)
    })
  })

  describe('findUsageSince', () => {
    it('returns records since a given timestamp', () => {
      // Insert with explicit timestamps to control ordering
      testDb.db
        .prepare(
          `INSERT INTO usage_records (session_id, tokens_in, tokens_out, cost_usd, recorded_at)
           VALUES ('s1', 100, 50, 0.01, '2025-01-01T00:00:00')`,
        )
        .run()
      testDb.db
        .prepare(
          `INSERT INTO usage_records (session_id, tokens_in, tokens_out, cost_usd, recorded_at)
           VALUES ('s1', 200, 100, 0.02, '2025-06-01T00:00:00')`,
        )
        .run()
      testDb.db
        .prepare(
          `INSERT INTO usage_records (session_id, tokens_in, tokens_out, cost_usd, recorded_at)
           VALUES ('s2', 300, 150, 0.03, '2025-06-15T00:00:00')`,
        )
        .run()

      const records = findUsageSince(testDb.db, '2025-05-01T00:00:00')
      expect(records).toHaveLength(2)
      expect(records.every((r) => r.recorded_at >= '2025-05-01T00:00:00')).toBe(true)
    })

    it('returns empty array when no records since timestamp', () => {
      recordUsage(testDb.db, {
        session_id: 's1',
        tokens_in: 100,
        tokens_out: 50,
        cost_usd: 0.01,
      })

      const records = findUsageSince(testDb.db, '2099-01-01T00:00:00')
      expect(records).toEqual([])
    })
  })

  describe('deleteUsageBySession', () => {
    it('deletes all records for a session and returns count', () => {
      recordUsage(testDb.db, {
        session_id: 's1',
        tokens_in: 100,
        tokens_out: 50,
        cost_usd: 0.01,
      })
      recordUsage(testDb.db, {
        session_id: 's1',
        tokens_in: 200,
        tokens_out: 100,
        cost_usd: 0.02,
      })
      recordUsage(testDb.db, {
        session_id: 's2',
        tokens_in: 300,
        tokens_out: 150,
        cost_usd: 0.03,
      })

      const deleted = deleteUsageBySession(testDb.db, 's1')
      expect(deleted).toBe(2)
      expect(findUsageBySession(testDb.db, 's1')).toHaveLength(0)
      expect(findUsageBySession(testDb.db, 's2')).toHaveLength(1)
    })

    it('returns 0 when no records to delete', () => {
      const deleted = deleteUsageBySession(testDb.db, 'nonexistent')
      expect(deleted).toBe(0)
    })
  })
})
