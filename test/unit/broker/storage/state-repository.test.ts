import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { TestDb } from '../../../helpers/db-harness.js'
import { createBrokerTestDb } from '../../../helpers/broker-db-harness.js'
import {
  setState,
  getState,
  deleteState,
  getStateByStory,
  deleteStateByStory,
  deleteStateBySession,
} from '../../../../src/broker/storage/repositories/state-repository.js'

describe('StateRepository', () => {
  let testDb: TestDb

  beforeEach(() => {
    testDb = createBrokerTestDb()
    testDb.db
      .prepare("INSERT INTO sessions (id, purpose, working_dir) VALUES ('s1', 'test', '/')")
      .run()
  })

  afterEach(() => {
    testDb.close()
  })

  it('setState creates a new entry', () => {
    const entry = setState(testDb.db, {
      key: 'project.status',
      value: '{"phase":"testing"}',
      story_id: null,
      session_id: 's1',
    })
    expect(entry.key).toBe('project.status')
    expect(entry.value).toBe('{"phase":"testing"}')
  })

  it('setState upserts on key conflict', () => {
    setState(testDb.db, { key: 'k1', value: 'v1', story_id: null, session_id: null })
    const updated = setState(testDb.db, {
      key: 'k1',
      value: 'v2',
      story_id: null,
      session_id: null,
    })
    expect(updated.value).toBe('v2')
  })

  it('getState retrieves by key', () => {
    setState(testDb.db, { key: 'k', value: 'v', story_id: null, session_id: null })
    const entry = getState(testDb.db, 'k')
    expect(entry).not.toBeNull()
    expect(entry!.value).toBe('v')
  })

  it('getState returns null for non-existent key', () => {
    expect(getState(testDb.db, 'nope')).toBeNull()
  })

  it('deleteState removes an entry', () => {
    setState(testDb.db, { key: 'k', value: 'v', story_id: null, session_id: null })
    expect(deleteState(testDb.db, 'k')).toBe(true)
    expect(getState(testDb.db, 'k')).toBeNull()
  })

  it('deleteState returns false for non-existent key', () => {
    expect(deleteState(testDb.db, 'nope')).toBe(false)
  })

  it('getStateByStory returns entries for a story', () => {
    setState(testDb.db, { key: 'a', value: '1', story_id: 'story-1', session_id: null })
    setState(testDb.db, { key: 'b', value: '2', story_id: 'story-1', session_id: null })
    setState(testDb.db, { key: 'c', value: '3', story_id: 'story-2', session_id: null })

    const entries = getStateByStory(testDb.db, 'story-1')
    expect(entries).toHaveLength(2)
  })

  it('deleteStateByStory removes all entries for a story', () => {
    setState(testDb.db, { key: 'a', value: '1', story_id: 'story-1', session_id: null })
    setState(testDb.db, { key: 'b', value: '2', story_id: 'story-1', session_id: null })

    const count = deleteStateByStory(testDb.db, 'story-1')
    expect(count).toBe(2)
  })

  it('deleteStateBySession removes all entries for a session', () => {
    setState(testDb.db, { key: 'a', value: '1', story_id: null, session_id: 's1' })
    setState(testDb.db, { key: 'b', value: '2', story_id: null, session_id: 's1' })

    const count = deleteStateBySession(testDb.db, 's1')
    expect(count).toBe(2)
  })
})
