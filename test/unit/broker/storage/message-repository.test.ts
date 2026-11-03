import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { TestDb } from '../../../helpers/db-harness.js'
import { createBrokerTestDb } from '../../../helpers/broker-db-harness.js'
import {
  createMessage,
  findMessageById,
  findMessagesByReceiver,
  markMessageRead,
  deleteMessagesByStory,
  deleteMessagesBySession,
  findAllMessages,
  archiveMessages,
} from '../../../../src/broker/storage/repositories/message-repository.js'

describe('MessageRepository', () => {
  let testDb: TestDb

  beforeEach(() => {
    testDb = createBrokerTestDb()
    // Create a session for FK constraints
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

  it('creates and retrieves a message', () => {
    const msg = createMessage(testDb.db, {
      id: 'm1',
      sender_id: 's1',
      receiver_id: 's2',
      content: 'hello',
      story_id: null,
    })
    expect(msg.id).toBe('m1')
    expect(msg.content).toBe('hello')
    expect(msg.read_at).toBeNull()

    const found = findMessageById(testDb.db, 'm1')
    expect(found).not.toBeNull()
    expect(found!.sender_id).toBe('s1')
  })

  it('returns null for non-existent message', () => {
    expect(findMessageById(testDb.db, 'nope')).toBeNull()
  })

  it('findMessagesByReceiver returns messages for receiver', () => {
    createMessage(testDb.db, {
      id: 'm1',
      sender_id: 's1',
      receiver_id: 's2',
      content: 'hi',
      story_id: null,
    })
    createMessage(testDb.db, {
      id: 'm2',
      sender_id: 's2',
      receiver_id: 's1',
      content: 'hey',
      story_id: null,
    })

    const msgs = findMessagesByReceiver(testDb.db, 's2')
    // Should include m1 (direct to s2) and m2 (receiver is null = broadcast? No, m2 has receiver s1)
    // Actually: condition is (receiver_id = ? OR receiver_id IS NULL)
    // m1 has receiver_id='s2' -> matches receiver_id = 's2'
    // m2 has receiver_id='s1' -> does NOT match
    expect(msgs.some((m) => m.id === 'm1')).toBe(true)
  })

  it('findMessagesByReceiver with unreadOnly filter', () => {
    createMessage(testDb.db, {
      id: 'm1',
      sender_id: 's1',
      receiver_id: 's2',
      content: 'a',
      story_id: null,
    })
    createMessage(testDb.db, {
      id: 'm2',
      sender_id: 's1',
      receiver_id: 's2',
      content: 'b',
      story_id: null,
    })
    markMessageRead(testDb.db, 'm1')

    const unread = findMessagesByReceiver(testDb.db, 's2', { unreadOnly: true })
    expect(unread).toHaveLength(1)
    expect(unread[0]!.id).toBe('m2')
  })

  it('markMessageRead sets read_at timestamp', () => {
    createMessage(testDb.db, {
      id: 'm1',
      sender_id: 's1',
      receiver_id: 's2',
      content: 'x',
      story_id: null,
    })
    const read = markMessageRead(testDb.db, 'm1')
    expect(read).not.toBeNull()
    expect(read!.read_at).not.toBeNull()

    // Marking again should be a no-op (read_at already set)
    const readAgain = markMessageRead(testDb.db, 'm1')
    expect(readAgain!.read_at).toBe(read!.read_at)
  })

  it('deleteMessagesByStory removes messages with matching story', () => {
    createMessage(testDb.db, {
      id: 'm1',
      sender_id: 's1',
      receiver_id: null,
      content: 'a',
      story_id: 'story-1',
    })
    createMessage(testDb.db, {
      id: 'm2',
      sender_id: 's1',
      receiver_id: null,
      content: 'b',
      story_id: 'story-1',
    })
    createMessage(testDb.db, {
      id: 'm3',
      sender_id: 's1',
      receiver_id: null,
      content: 'c',
      story_id: null,
    })

    const deleted = deleteMessagesByStory(testDb.db, 'story-1')
    expect(deleted).toBe(2)
    expect(findMessageById(testDb.db, 'm3')).not.toBeNull()
  })

  it('deleteMessagesBySession removes sender/receiver messages', () => {
    createMessage(testDb.db, {
      id: 'm1',
      sender_id: 's1',
      receiver_id: 's2',
      content: 'x',
      story_id: null,
    })
    const deleted = deleteMessagesBySession(testDb.db, 's1')
    expect(deleted).toBe(1)
  })

  it('findAllMessages returns messages with limit', () => {
    for (let i = 0; i < 5; i++) {
      createMessage(testDb.db, {
        id: `m${i}`,
        sender_id: 's1',
        receiver_id: null,
        content: `msg ${i}`,
        story_id: null,
      })
    }
    const msgs = findAllMessages(testDb.db, { limit: 3 })
    expect(msgs).toHaveLength(3)
  })

  it('archiveMessages moves messages to history', () => {
    createMessage(testDb.db, {
      id: 'm1',
      sender_id: 's1',
      receiver_id: null,
      content: 'archive me',
      story_id: null,
    })
    createMessage(testDb.db, {
      id: 'm2',
      sender_id: 's1',
      receiver_id: null,
      content: 'keep me',
      story_id: null,
    })

    const count = archiveMessages(testDb.db, ['m1'])
    expect(count).toBe(1)

    // m1 should be gone from messages
    expect(findMessageById(testDb.db, 'm1')).toBeNull()
    // m2 should still exist
    expect(findMessageById(testDb.db, 'm2')).not.toBeNull()

    // m1 should be in messages_history
    const historyRow = testDb.db
      .prepare('SELECT * FROM messages_history WHERE id = ?')
      .get('m1') as Record<string, unknown> | undefined
    expect(historyRow).not.toBeUndefined()
    expect(historyRow!.content).toBe('archive me')
  })
})
