import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createBrokerTestDb } from '../../../helpers/broker-db-harness.js'
import type { TestDb } from '../../../helpers/db-harness.js'
import { createSessionHandoffService } from '../../../../src/broker/services/session-handoff.js'

let testDb: TestDb

beforeEach(() => {
  testDb = createBrokerTestDb()
  // Insert a session for FK compliance
  testDb.db
    .prepare("INSERT INTO sessions (id, purpose, working_dir) VALUES ('sess-1', 'test', '/tmp')")
    .run()
  testDb.db
    .prepare("INSERT INTO sessions (id, purpose, working_dir) VALUES ('sess-2', 'test2', '/tmp')")
    .run()
})

afterEach(() => {
  testDb.close()
})

describe('SessionHandoffService', () => {
  describe('create()', () => {
    it('creates a handoff document with all fields', () => {
      const svc = createSessionHandoffService(testDb.db)
      const handoff = svc.create({
        sessionId: 'sess-1',
        progress: 'Completed auth module',
        filesModified: ['src/auth.ts', 'src/login.ts'],
        testsStatus: '48/50 pass',
        remainingWork: 'Fix 2 failing tests',
        context: 'Auth uses JWT with bcrypt',
      })

      expect(handoff.id).toBeDefined()
      expect(handoff.session_id).toBe('sess-1')
      expect(handoff.status).toBe('ready')
      expect(handoff.progress).toBe('Completed auth module')
      expect(JSON.parse(handoff.files_modified)).toEqual(['src/auth.ts', 'src/login.ts'])
      expect(handoff.tests_status).toBe('48/50 pass')
      expect(handoff.remaining_work).toBe('Fix 2 failing tests')
      expect(handoff.context).toBe('Auth uses JWT with bcrypt')
    })

    it('persists handoff to database', () => {
      const svc = createSessionHandoffService(testDb.db)
      const handoff = svc.create({
        sessionId: 'sess-1',
        progress: 'In progress',
      })

      const row = testDb.db
        .prepare('SELECT * FROM session_handoffs WHERE id = ?')
        .get(handoff.id) as Record<string, unknown>
      expect(row).toBeDefined()
      expect(row.session_id).toBe('sess-1')
      expect(row.status).toBe('ready')
    })

    it('creates handoff with minimal fields', () => {
      const svc = createSessionHandoffService(testDb.db)
      const handoff = svc.create({
        sessionId: 'sess-1',
        progress: 'Started work',
      })

      expect(handoff.id).toBeDefined()
      expect(handoff.progress).toBe('Started work')
      expect(JSON.parse(handoff.files_modified)).toEqual([])
    })
  })

  describe('get()', () => {
    it('returns latest unconsumed handoff for session', () => {
      const svc = createSessionHandoffService(testDb.db)
      svc.create({ sessionId: 'sess-1', progress: 'First' })
      svc.create({ sessionId: 'sess-1', progress: 'Second' })

      const latest = svc.get('sess-1')
      expect(latest).not.toBeNull()
      expect(latest!.progress).toBe('Second')
      expect(latest!.status).toBe('ready')
    })

    it('returns null when no handoff exists', () => {
      const svc = createSessionHandoffService(testDb.db)
      const result = svc.get('nonexistent')
      expect(result).toBeNull()
    })

    it('returns null when all handoffs are consumed', () => {
      const svc = createSessionHandoffService(testDb.db)
      const handoff = svc.create({ sessionId: 'sess-1', progress: 'Done' })
      svc.consume(handoff.id, 'sess-2')

      const result = svc.get('sess-1')
      expect(result).toBeNull()
    })
  })

  describe('consume()', () => {
    it('marks handoff as consumed atomically', () => {
      const svc = createSessionHandoffService(testDb.db)
      const handoff = svc.create({ sessionId: 'sess-1', progress: 'Work done' })

      const consumed = svc.consume(handoff.id, 'sess-2')
      expect(consumed).toBe(true)

      const row = testDb.db
        .prepare('SELECT * FROM session_handoffs WHERE id = ?')
        .get(handoff.id) as Record<string, unknown>
      expect(row.status).toBe('consumed')
      expect(row.claimed_by).toBe('sess-2')
      expect(row.consumed_at).toBeDefined()
    })

    it('prevents double consumption', () => {
      const svc = createSessionHandoffService(testDb.db)
      const handoff = svc.create({ sessionId: 'sess-1', progress: 'Work done' })

      expect(svc.consume(handoff.id, 'sess-2')).toBe(true)
      expect(svc.consume(handoff.id, 'sess-2')).toBe(false)
    })

    it('returns false for nonexistent handoff', () => {
      const svc = createSessionHandoffService(testDb.db)
      expect(svc.consume('nonexistent', 'sess-2')).toBe(false)
    })
  })

  describe('claim()', () => {
    it('claims a ready handoff', () => {
      const svc = createSessionHandoffService(testDb.db)
      const handoff = svc.create({ sessionId: 'sess-1', progress: 'Ready' })

      const claimed = svc.claim(handoff.id, 'sess-2')
      expect(claimed).toBe(true)

      const row = testDb.db
        .prepare('SELECT * FROM session_handoffs WHERE id = ?')
        .get(handoff.id) as Record<string, unknown>
      expect(row.status).toBe('claimed')
      expect(row.claimed_by).toBe('sess-2')
    })

    it('cannot claim already claimed handoff', () => {
      const svc = createSessionHandoffService(testDb.db)
      const handoff = svc.create({ sessionId: 'sess-1', progress: 'Ready' })

      expect(svc.claim(handoff.id, 'sess-2')).toBe(true)
      expect(svc.claim(handoff.id, 'sess-3')).toBe(false)
    })
  })

  describe('expire()', () => {
    it('expires all ready handoffs for a session', () => {
      const svc = createSessionHandoffService(testDb.db)
      svc.create({ sessionId: 'sess-1', progress: 'First' })
      svc.create({ sessionId: 'sess-1', progress: 'Second' })

      const count = svc.expire('sess-1')
      expect(count).toBe(2)

      const result = svc.get('sess-1')
      expect(result).toBeNull()
    })
  })

  describe('getAll()', () => {
    it('returns all handoffs for a session', () => {
      const svc = createSessionHandoffService(testDb.db)
      svc.create({ sessionId: 'sess-1', progress: 'First' })
      svc.create({ sessionId: 'sess-1', progress: 'Second' })
      svc.create({ sessionId: 'sess-2', progress: 'Other' })

      const all = svc.getAll('sess-1')
      expect(all).toHaveLength(2)
    })
  })
})
