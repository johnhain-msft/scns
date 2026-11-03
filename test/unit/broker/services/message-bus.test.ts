import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { TestDb } from '../../../helpers/db-harness.js'
import { createBrokerTestDb } from '../../../helpers/broker-db-harness.js'
import {
  sendDirect,
  broadcast,
  getMessages,
  markRead,
  getThread,
  getUnreadCount,
} from '../../../../src/broker/services/message-bus.js'

describe('MessageBus', () => {
  let testDb: TestDb

  beforeEach(() => {
    testDb = createBrokerTestDb()
    // Pre-register sessions for FK constraints
    testDb.db
      .prepare('INSERT INTO sessions (id, purpose, working_dir) VALUES (?, ?, ?)')
      .run('session-a', 'test', '/workspace/a')
    testDb.db
      .prepare('INSERT INTO sessions (id, purpose, working_dir) VALUES (?, ?, ?)')
      .run('session-b', 'test', '/workspace/b')
    testDb.db
      .prepare('INSERT INTO sessions (id, purpose, working_dir) VALUES (?, ?, ?)')
      .run('session-c', 'test', '/workspace/c')
  })

  afterEach(() => {
    testDb.close()
  })

  describe('sendDirect', () => {
    it('sends a message from A to B that B receives', () => {
      const msg = sendDirect(testDb.db, 'session-a', 'session-b', 'hello B')
      expect(msg.sender_id).toBe('session-a')
      expect(msg.receiver_id).toBe('session-b')
      expect(msg.content).toBe('hello B')
      expect(msg.id).toBeTruthy()

      const bMessages = getMessages(testDb.db, 'session-b')
      expect(bMessages).toHaveLength(1)
      expect(bMessages[0].content).toBe('hello B')
    })

    it('A does not see the direct message as a receiver', () => {
      sendDirect(testDb.db, 'session-a', 'session-b', 'hello B')
      const aMessages = getMessages(testDb.db, 'session-a')
      expect(aMessages).toHaveLength(0)
    })

    it('supports story_id option', () => {
      const msg = sendDirect(testDb.db, 'session-a', 'session-b', 'story msg', {
        story_id: 'story-1',
      })
      expect(msg.story_id).toBe('story-1')
    })

    it('supports reply_to option', () => {
      const original = sendDirect(testDb.db, 'session-a', 'session-b', 'original')
      const reply = sendDirect(testDb.db, 'session-b', 'session-a', 'reply', {
        reply_to: original.id,
      })
      expect(reply.reply_to).toBe(original.id)
    })
  })

  describe('broadcast', () => {
    it('sends a message with null receiver visible to all sessions', () => {
      const msg = broadcast(testDb.db, 'session-a', 'announcement')
      expect(msg.receiver_id).toBeNull()
      expect(msg.content).toBe('announcement')

      const bMessages = getMessages(testDb.db, 'session-b')
      expect(bMessages).toHaveLength(1)
      expect(bMessages[0].content).toBe('announcement')

      const cMessages = getMessages(testDb.db, 'session-c')
      expect(cMessages).toHaveLength(1)
      expect(cMessages[0].content).toBe('announcement')
    })

    it('supports story_id and reply_to options', () => {
      const first = broadcast(testDb.db, 'session-a', 'first broadcast')
      const reply = broadcast(testDb.db, 'session-b', 'reply broadcast', {
        story_id: 'story-x',
        reply_to: first.id,
      })
      expect(reply.story_id).toBe('story-x')
      expect(reply.reply_to).toBe(first.id)
    })
  })

  describe('getMessages — unread filtering', () => {
    it('returns unread messages then empty after marking read', () => {
      const msg = sendDirect(testDb.db, 'session-a', 'session-b', 'unread msg')

      const unread = getMessages(testDb.db, 'session-b', { unreadOnly: true })
      expect(unread).toHaveLength(1)

      markRead(testDb.db, [msg.id])

      const unreadAfter = getMessages(testDb.db, 'session-b', { unreadOnly: true })
      expect(unreadAfter).toHaveLength(0)
    })
  })

  describe('getMessages — story grouping', () => {
    it('filters messages by story_id', () => {
      sendDirect(testDb.db, 'session-a', 'session-b', 'story-1 msg', { story_id: 'story-1' })
      sendDirect(testDb.db, 'session-a', 'session-b', 'story-2 msg', { story_id: 'story-2' })
      sendDirect(testDb.db, 'session-a', 'session-b', 'no story msg')

      const story1 = getMessages(testDb.db, 'session-b', { story_id: 'story-1' })
      expect(story1).toHaveLength(1)
      expect(story1[0].content).toBe('story-1 msg')
    })
  })

  describe('getThread', () => {
    it('returns the original message and all replies', () => {
      const original = sendDirect(testDb.db, 'session-a', 'session-b', 'original msg')
      sendDirect(testDb.db, 'session-b', 'session-a', 'reply 1', { reply_to: original.id })
      sendDirect(testDb.db, 'session-a', 'session-b', 'reply 2', { reply_to: original.id })

      const thread = getThread(testDb.db, original.id)
      expect(thread).toHaveLength(3)
      expect(thread[0].content).toBe('original msg')
      expect(thread[1].content).toBe('reply 1')
      expect(thread[2].content).toBe('reply 2')
    })
  })

  describe('markRead', () => {
    it('marks multiple messages as read in one call', () => {
      const m1 = sendDirect(testDb.db, 'session-a', 'session-b', 'msg 1')
      const m2 = sendDirect(testDb.db, 'session-a', 'session-b', 'msg 2')
      const m3 = sendDirect(testDb.db, 'session-a', 'session-b', 'msg 3')

      markRead(testDb.db, [m1.id, m2.id, m3.id])

      const unread = getMessages(testDb.db, 'session-b', { unreadOnly: true })
      expect(unread).toHaveLength(0)
    })
  })

  describe('getUnreadCount', () => {
    it('returns correct count of unread messages', () => {
      sendDirect(testDb.db, 'session-a', 'session-b', 'msg 1')
      sendDirect(testDb.db, 'session-a', 'session-b', 'msg 2')
      broadcast(testDb.db, 'session-c', 'broadcast msg')

      expect(getUnreadCount(testDb.db, 'session-b')).toBe(3)
    })

    it('decreases after markRead', () => {
      const m1 = sendDirect(testDb.db, 'session-a', 'session-b', 'msg 1')
      sendDirect(testDb.db, 'session-a', 'session-b', 'msg 2')

      expect(getUnreadCount(testDb.db, 'session-b')).toBe(2)

      markRead(testDb.db, [m1.id])

      expect(getUnreadCount(testDb.db, 'session-b')).toBe(1)
    })
  })

  describe('message ordering', () => {
    it('returns messages in chronological order', () => {
      sendDirect(testDb.db, 'session-a', 'session-b', 'first')
      sendDirect(testDb.db, 'session-a', 'session-b', 'second')
      sendDirect(testDb.db, 'session-a', 'session-b', 'third')

      const messages = getMessages(testDb.db, 'session-b')
      expect(messages).toHaveLength(3)
      expect(messages[0].content).toBe('first')
      expect(messages[1].content).toBe('second')
      expect(messages[2].content).toBe('third')
    })
  })

  describe('receiver sees broadcasts AND direct messages', () => {
    it('combines broadcast and direct messages in results', () => {
      sendDirect(testDb.db, 'session-a', 'session-b', 'direct msg')
      broadcast(testDb.db, 'session-c', 'broadcast msg')

      const messages = getMessages(testDb.db, 'session-b')
      expect(messages).toHaveLength(2)

      const contents = messages.map((m) => m.content)
      expect(contents).toContain('direct msg')
      expect(contents).toContain('broadcast msg')
    })
  })
})
