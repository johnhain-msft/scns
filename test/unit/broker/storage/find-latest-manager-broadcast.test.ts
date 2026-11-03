import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { TestDb } from '../../../helpers/db-harness.js'
import { createBrokerTestDb } from '../../../helpers/broker-db-harness.js'
import {
  createMessage,
  findLatestManagerBroadcast,
} from '../../../../src/broker/storage/repositories/message-repository.js'
import { purgeSessionToHistory } from '../../../../src/broker/storage/repositories/history-repository.js'

/**
 * WS J — readback-race regression coverage.
 *
 * Repro of the race documented in the `readback race` repo memory: WS F's
 * INSERT into `messages` for the manager's broadcast happens, but the
 * `purgeSessionToHistory` cleanup that fires on session deregistration moves
 * the row into `messages_history` before manager-exit-monitor's lookup runs.
 * The pre-fix lookup queried only `messages`, so it returned null and the
 * monitor falsely emitted `manager_dispatch_incomplete=no_readback`.
 *
 * Live evidence (re-dogfood task #13, 2026-05-09):
 *   22:04:32  message_sent sender=manager id=9df118f2
 *   22:05:16  manager_dispatch_incomplete reason=no_readback
 *             (rows already absent from messages + messages_history due to
 *              purge ordering)
 */
describe('findLatestManagerBroadcast (WS J readback-race fix)', () => {
  let testDb: TestDb

  beforeEach(() => {
    testDb = createBrokerTestDb()
    testDb.db
      .prepare("INSERT INTO sessions (id, purpose, working_dir) VALUES ('mgr-1', 'manager', '/')")
      .run()
    testDb.db
      .prepare("INSERT INTO sessions (id, purpose, working_dir) VALUES ('dev-1', 'dev', '/')")
      .run()
    testDb.db
      .prepare("INSERT INTO teams (id, name, description) VALUES ('team-A', 'alpha', null)")
      .run()
    testDb.db
      .prepare(
        "INSERT INTO team_members (team_id, session_id, name, role, agent_type) VALUES ('team-A', 'mgr-1', 'manager', 'scns-manager', 'claude')",
      )
      .run()
    testDb.db
      .prepare(
        "INSERT INTO team_members (team_id, session_id, name, role, agent_type) VALUES ('team-A', 'dev-1', 'dev', 'scns-dev', 'claude')",
      )
      .run()
  })

  afterEach(() => {
    testDb.close()
  })

  const broadcastBody = [
    'Dispatch Readback:',
    '  dev_session_id: dev-1',
    '  qa_session_id: qa-1',
    '  notes: dev on parser, qa review-only',
  ].join('\n')

  it('finds a broadcast that is still in messages (pre-purge)', () => {
    createMessage(testDb.db, {
      id: 'msg-live',
      sender_id: 'mgr-1',
      receiver_id: null,
      content: broadcastBody,
      story_id: null,
      team_id: 'team-A',
    })

    const found = findLatestManagerBroadcast(testDb.db, 'team-A', 'mgr-1')
    expect(found).toBe(broadcastBody)
  })

  it('finds a broadcast that has been purged into messages_history (RED before WS J)', () => {
    // Manager broadcast is recorded normally...
    createMessage(testDb.db, {
      id: 'msg-purged',
      sender_id: 'mgr-1',
      receiver_id: null,
      content: broadcastBody,
      story_id: null,
      team_id: 'team-A',
    })

    // ...then the session-GC purge runs (mirroring what happens when the
    // manager session deregisters before manager-exit-monitor's lookup).
    const purge = purgeSessionToHistory(testDb.db, 'mgr-1')
    expect(purge).not.toBeNull()
    expect(purge!.messages_archived).toBeGreaterThan(0)

    // Sanity: row is gone from `messages`, present in `messages_history`.
    const liveRow = testDb.db
      .prepare('SELECT 1 AS hit FROM messages WHERE id = ?')
      .get('msg-purged')
    expect(liveRow).toBeUndefined()
    const histRow = testDb.db
      .prepare('SELECT content FROM messages_history WHERE id = ?')
      .get('msg-purged') as { content?: string } | undefined
    expect(histRow?.content).toBe(broadcastBody)

    // The fix: the lookup must still find the broadcast.
    const found = findLatestManagerBroadcast(testDb.db, 'team-A', 'mgr-1')
    expect(found).toBe(broadcastBody)
  })

  it('returns null when no broadcast exists in either table (no over-fix)', () => {
    const found = findLatestManagerBroadcast(testDb.db, 'team-A', 'mgr-1')
    expect(found).toBeNull()
  })

  it('prefers the live messages row when both live and history rows exist', () => {
    // History has an older broadcast...
    testDb.db
      .prepare(
        `INSERT INTO messages_history (id, sender_id, receiver_id, content, story_id, reply_to, created_at, read_at, purged_at)
         VALUES ('msg-old', 'mgr-1', null, 'OLD readback', null, null, datetime('now', '-1 hour'), null, datetime('now', '-30 minutes'))`,
      )
      .run()

    // ...live messages has the newer one.
    createMessage(testDb.db, {
      id: 'msg-new',
      sender_id: 'mgr-1',
      receiver_id: null,
      content: broadcastBody,
      story_id: null,
      team_id: 'team-A',
    })

    const found = findLatestManagerBroadcast(testDb.db, 'team-A', 'mgr-1')
    expect(found).toBe(broadcastBody)
  })
})
