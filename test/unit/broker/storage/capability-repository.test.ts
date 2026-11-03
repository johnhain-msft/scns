import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { TestDb } from '../../../helpers/db-harness.js'
import { createBrokerTestDb } from '../../../helpers/broker-db-harness.js'
import {
  registerCapability,
  registerCapabilities,
  unregisterCapability,
  clearSessionCapabilities,
  findSessionsByCapability,
  findCapabilitiesBySession,
  findAllCapabilities,
} from '../../../../src/broker/storage/repositories/capability-repository.js'

describe('CapabilityRepository', () => {
  let testDb: TestDb

  beforeEach(() => {
    testDb = createBrokerTestDb()
    testDb.db
      .prepare("INSERT INTO sessions (id, purpose, working_dir) VALUES ('s1', 'test', '/')")
      .run()
    testDb.db
      .prepare("INSERT INTO sessions (id, purpose, working_dir) VALUES ('s2', 'test2', '/')")
      .run()
  })

  afterEach(() => {
    testDb.close()
  })

  describe('registerCapability', () => {
    it('registers a capability for a session', () => {
      registerCapability(testDb.db, 's1', 'code-review')
      const caps = findCapabilitiesBySession(testDb.db, 's1')
      expect(caps).toEqual(['code-review'])
    })

    it('is idempotent (INSERT OR IGNORE)', () => {
      registerCapability(testDb.db, 's1', 'code-review')
      registerCapability(testDb.db, 's1', 'code-review')
      const caps = findCapabilitiesBySession(testDb.db, 's1')
      expect(caps).toEqual(['code-review'])
    })

    it('registers multiple different capabilities for a session', () => {
      registerCapability(testDb.db, 's1', 'code-review')
      registerCapability(testDb.db, 's1', 'testing')
      const caps = findCapabilitiesBySession(testDb.db, 's1')
      expect(caps).toHaveLength(2)
      expect(caps).toContain('code-review')
      expect(caps).toContain('testing')
    })
  })

  describe('registerCapabilities', () => {
    it('batch registers multiple capabilities', () => {
      registerCapabilities(testDb.db, 's1', ['code-review', 'testing', 'deployment'])
      const caps = findCapabilitiesBySession(testDb.db, 's1')
      expect(caps).toHaveLength(3)
      expect(caps).toContain('code-review')
      expect(caps).toContain('testing')
      expect(caps).toContain('deployment')
    })

    it('handles empty array gracefully', () => {
      registerCapabilities(testDb.db, 's1', [])
      const caps = findCapabilitiesBySession(testDb.db, 's1')
      expect(caps).toHaveLength(0)
    })

    it('is idempotent for duplicates in array', () => {
      registerCapabilities(testDb.db, 's1', ['code-review', 'code-review', 'testing'])
      const caps = findCapabilitiesBySession(testDb.db, 's1')
      expect(caps).toHaveLength(2)
    })

    it('is idempotent for already-registered capabilities', () => {
      registerCapability(testDb.db, 's1', 'code-review')
      registerCapabilities(testDb.db, 's1', ['code-review', 'testing'])
      const caps = findCapabilitiesBySession(testDb.db, 's1')
      expect(caps).toHaveLength(2)
    })
  })

  describe('unregisterCapability', () => {
    it('removes a capability and returns true', () => {
      registerCapability(testDb.db, 's1', 'code-review')
      const removed = unregisterCapability(testDb.db, 's1', 'code-review')
      expect(removed).toBe(true)
      expect(findCapabilitiesBySession(testDb.db, 's1')).toHaveLength(0)
    })

    it('returns false when capability does not exist', () => {
      const removed = unregisterCapability(testDb.db, 's1', 'nonexistent')
      expect(removed).toBe(false)
    })
  })

  describe('clearSessionCapabilities', () => {
    it('removes all capabilities for a session and returns count', () => {
      registerCapabilities(testDb.db, 's1', ['code-review', 'testing', 'deployment'])
      const count = clearSessionCapabilities(testDb.db, 's1')
      expect(count).toBe(3)
      expect(findCapabilitiesBySession(testDb.db, 's1')).toHaveLength(0)
    })

    it('returns 0 when session has no capabilities', () => {
      const count = clearSessionCapabilities(testDb.db, 's1')
      expect(count).toBe(0)
    })

    it('does not affect other sessions', () => {
      registerCapability(testDb.db, 's1', 'code-review')
      registerCapability(testDb.db, 's2', 'testing')
      clearSessionCapabilities(testDb.db, 's1')
      expect(findCapabilitiesBySession(testDb.db, 's2')).toEqual(['testing'])
    })
  })

  describe('findSessionsByCapability', () => {
    it('finds all sessions with a given capability', () => {
      registerCapability(testDb.db, 's1', 'code-review')
      registerCapability(testDb.db, 's2', 'code-review')
      const results = findSessionsByCapability(testDb.db, 'code-review')
      expect(results).toHaveLength(2)
      const sessionIds = results.map((r) => r.session_id)
      expect(sessionIds).toContain('s1')
      expect(sessionIds).toContain('s2')
    })

    it('returns rows with correct shape', () => {
      registerCapability(testDb.db, 's1', 'code-review')
      const results = findSessionsByCapability(testDb.db, 'code-review')
      expect(results).toHaveLength(1)
      expect(results[0]).toHaveProperty('session_id', 's1')
      expect(results[0]).toHaveProperty('capability', 'code-review')
      expect(results[0]).toHaveProperty('created_at')
      expect(typeof results[0]!.created_at).toBe('string')
    })

    it('returns empty array when no sessions have the capability', () => {
      expect(findSessionsByCapability(testDb.db, 'nonexistent')).toEqual([])
    })

    it('returns immutable copies', () => {
      registerCapability(testDb.db, 's1', 'code-review')
      const [a] = findSessionsByCapability(testDb.db, 'code-review')
      const [b] = findSessionsByCapability(testDb.db, 'code-review')
      expect(a).toEqual(b)
      expect(a).not.toBe(b)
    })
  })

  describe('findCapabilitiesBySession', () => {
    it('returns capability strings for a session', () => {
      registerCapabilities(testDb.db, 's1', ['code-review', 'testing'])
      const caps = findCapabilitiesBySession(testDb.db, 's1')
      expect(caps).toHaveLength(2)
      expect(caps).toContain('code-review')
      expect(caps).toContain('testing')
    })

    it('returns empty array for session with no capabilities', () => {
      expect(findCapabilitiesBySession(testDb.db, 's1')).toEqual([])
    })
  })

  describe('findAllCapabilities', () => {
    it('returns unique capabilities with session counts', () => {
      registerCapability(testDb.db, 's1', 'code-review')
      registerCapability(testDb.db, 's2', 'code-review')
      registerCapability(testDb.db, 's1', 'testing')

      const all = findAllCapabilities(testDb.db)
      expect(all).toHaveLength(2)

      const codeReview = all.find((c) => c.capability === 'code-review')
      expect(codeReview).toBeDefined()
      expect(codeReview!.session_count).toBe(2)

      const testing = all.find((c) => c.capability === 'testing')
      expect(testing).toBeDefined()
      expect(testing!.session_count).toBe(1)
    })

    it('returns empty array when no capabilities exist', () => {
      expect(findAllCapabilities(testDb.db)).toEqual([])
    })

    it('returns immutable copies', () => {
      registerCapability(testDb.db, 's1', 'code-review')
      const [a] = findAllCapabilities(testDb.db)
      const [b] = findAllCapabilities(testDb.db)
      expect(a).toEqual(b)
      expect(a).not.toBe(b)
    })
  })
})
