import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { TestDb } from '../../../helpers/db-harness.js'
import { createBrokerTestDb } from '../../../helpers/broker-db-harness.js'
import {
  declareIntent,
  releaseIntent,
  findConflicts,
  normalizePath,
  findIntentsBySession,
  releaseIntentsBySession,
} from '../../../../src/broker/storage/repositories/intent-repository.js'

describe('IntentRepository', () => {
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

  describe('normalizePath', () => {
    it('strips trailing slash', () => {
      expect(normalizePath('/foo/bar/')).toBe('/foo/bar')
    })

    it('resolves dot segments', () => {
      expect(normalizePath('/foo/./bar/../baz')).toBe('/foo/baz')
    })

    it('preserves root slash', () => {
      expect(normalizePath('/')).toBe('/')
    })
  })

  it('declareIntent creates a file intent', () => {
    const intent = declareIntent(testDb.db, {
      file_path: '/src/main.ts',
      session_id: 's1',
      intent: 'edit',
    })
    expect(intent.file_path).toBe('/src/main.ts')
    expect(intent.session_id).toBe('s1')
    expect(intent.intent).toBe('edit')
  })

  it('declareIntent defaults to edit', () => {
    const intent = declareIntent(testDb.db, {
      file_path: '/src/main.ts',
      session_id: 's1',
    })
    expect(intent.intent).toBe('edit')
  })

  it('declareIntent upserts on conflict', () => {
    declareIntent(testDb.db, {
      file_path: '/src/main.ts',
      session_id: 's1',
      intent: 'edit',
    })
    const updated = declareIntent(testDb.db, {
      file_path: '/src/main.ts',
      session_id: 's1',
      intent: 'read',
    })
    expect(updated.intent).toBe('read')
  })

  it('releaseIntent removes an intent', () => {
    declareIntent(testDb.db, { file_path: '/a.ts', session_id: 's1' })
    expect(releaseIntent(testDb.db, 's1', '/a.ts')).toBe(true)
    expect(releaseIntent(testDb.db, 's1', '/a.ts')).toBe(false)
  })

  it('findConflicts detects multiple sessions on same file', () => {
    declareIntent(testDb.db, { file_path: '/shared.ts', session_id: 's1', intent: 'edit' })
    declareIntent(testDb.db, { file_path: '/shared.ts', session_id: 's2', intent: 'edit' })

    const conflicts = findConflicts(testDb.db)
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]!.file_path).toBe('/shared.ts')
    expect(conflicts[0]!.sessions).toHaveLength(2)
  })

  it('findConflicts returns empty when no conflicts', () => {
    declareIntent(testDb.db, { file_path: '/a.ts', session_id: 's1' })
    declareIntent(testDb.db, { file_path: '/b.ts', session_id: 's2' })

    expect(findConflicts(testDb.db)).toHaveLength(0)
  })

  it('findConflicts with specific file path', () => {
    declareIntent(testDb.db, { file_path: '/x.ts', session_id: 's1' })
    declareIntent(testDb.db, { file_path: '/x.ts', session_id: 's2' })
    declareIntent(testDb.db, { file_path: '/y.ts', session_id: 's1' })
    declareIntent(testDb.db, { file_path: '/y.ts', session_id: 's2' })

    const conflicts = findConflicts(testDb.db, '/x.ts')
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]!.file_path).toBe('/x.ts')
  })

  it('findIntentsBySession returns all intents for a session', () => {
    declareIntent(testDb.db, { file_path: '/a.ts', session_id: 's1' })
    declareIntent(testDb.db, { file_path: '/b.ts', session_id: 's1' })

    const intents = findIntentsBySession(testDb.db, 's1')
    expect(intents).toHaveLength(2)
  })

  it('releaseIntentsBySession removes all intents for a session', () => {
    declareIntent(testDb.db, { file_path: '/a.ts', session_id: 's1' })
    declareIntent(testDb.db, { file_path: '/b.ts', session_id: 's1' })

    const count = releaseIntentsBySession(testDb.db, 's1')
    expect(count).toBe(2)
    expect(findIntentsBySession(testDb.db, 's1')).toHaveLength(0)
  })
})
