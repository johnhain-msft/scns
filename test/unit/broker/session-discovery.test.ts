import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  parseCopilotProcesses,
  startSessionDiscovery,
} from '../../../src/broker/session-discovery.js'
import { openDatabase, closeDatabase } from '../../../src/broker/storage/db.js'
import { createEventLog } from '../../../src/broker/services/event-log.js'
import { createEventDispatcher } from '../../../src/broker/event-dispatcher.js'
import {
  findSessionById,
  findAllSessions,
} from '../../../src/broker/storage/repositories/session-repository.js'
import type Database from 'better-sqlite3'
import type { EventLog } from '../../../src/broker/services/event-log.js'

describe('parseCopilotProcesses', () => {
  it('extracts session IDs from --resume <uuid> format', () => {
    const output = [
      '  12345 /usr/local/Caskroom/copilot-cli/1.0.18/copilot --resume 25c4508b-ae41-4346-aad5-6c8b54fe5b22',
      '  67890 /usr/local/Caskroom/copilot-cli/1.0.18/copilot --resume d5039899-d484-499e-bf70-3aa47c040241',
      '  11111 node /some/other/process',
    ].join('\n')
    const result = parseCopilotProcesses(output)
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({
      pid: 12345,
      sessionId: '25c4508b-ae41-4346-aad5-6c8b54fe5b22',
    })
    expect(result[1]).toEqual({
      pid: 67890,
      sessionId: 'd5039899-d484-499e-bf70-3aa47c040241',
    })
  })

  it('extracts session IDs from --resume=<uuid> format', () => {
    const result = parseCopilotProcesses(
      '  12345 /usr/local/copilot --resume=abcdef01-2345-6789-abcd-ef0123456789\n',
    )
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      pid: 12345,
      sessionId: 'abcdef01-2345-6789-abcd-ef0123456789',
    })
  })

  it('ignores non-copilot processes', () => {
    expect(
      parseCopilotProcesses('  111 node server.js --resume abc\n  222 python app.py\n'),
    ).toHaveLength(0)
  })

  it('ignores copilot processes without --resume', () => {
    expect(parseCopilotProcesses('  111 copilot init\n  222 copilot --help\n')).toHaveLength(0)
  })

  it('deduplicates session IDs', () => {
    const output = [
      '  111 copilot --resume aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      '  222 copilot --resume aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    ].join('\n')
    const result = parseCopilotProcesses(output)
    expect(result).toHaveLength(1)
    expect(result[0]!.pid).toBe(111)
  })

  it('handles empty output', () => {
    expect(parseCopilotProcesses('')).toHaveLength(0)
  })

  it('ignores malformed UUIDs', () => {
    expect(
      parseCopilotProcesses('  111 copilot --resume not-a-uuid\n  222 copilot --resume 12345\n'),
    ).toHaveLength(0)
  })
})

describe('startSessionDiscovery', () => {
  let db: Database.Database
  let eventLog: EventLog

  beforeEach(() => {
    db = openDatabase(':memory:')
    const dispatcher = createEventDispatcher()
    eventLog = createEventLog(db, dispatcher)
  })

  afterEach(() => {
    closeDatabase(db)
  })

  function makeDiscovery(psProvider: () => Promise<string>) {
    return startSessionDiscovery(db, eventLog, {
      intervalMs: 999_999,
      psProvider,
      skipInitialTick: true,
    })
  }

  it('discovers new sessions via tick()', async () => {
    const psProvider = vi
      .fn()
      .mockResolvedValue('  12345 copilot --resume aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\n')
    const discovery = makeDiscovery(psProvider)

    await discovery.tick()
    const session = findSessionById(db, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
    expect(session).not.toBeNull()
    expect(session!.purpose).toBe('discovered')
    expect(session!.status).toBe('active')
    discovery.stop()
  })

  it('refreshes heartbeat for known sessions', async () => {
    const sid = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'
    const psProvider = vi.fn().mockResolvedValue(`  99999 copilot --resume ${sid}\n`)
    const discovery = makeDiscovery(psProvider)

    const r1 = await discovery.tick()
    expect(r1.discovered).toBe(1)

    const r2 = await discovery.tick()
    expect(r2.refreshed).toBeGreaterThanOrEqual(1)
    expect(findSessionById(db, sid)!.status).toBe('active')
    discovery.stop()
  })

  it('marks sessions completed only after 3 consecutive misses', async () => {
    const sid = 'cccccccc-dddd-eeee-ffff-111111111111'
    const psProvider = vi
      .fn()
      .mockResolvedValueOnce(`  12345 copilot --resume ${sid}\n`)
      .mockResolvedValue('')

    const discovery = makeDiscovery(psProvider)
    await discovery.tick() // discover
    expect(findSessionById(db, sid)!.status).toBe('active')

    await discovery.tick() // miss 1
    expect(findSessionById(db, sid)!.status).toBe('active')

    await discovery.tick() // miss 2
    expect(findSessionById(db, sid)!.status).toBe('active')

    await discovery.tick() // miss 3 → completed
    expect(findSessionById(db, sid)!.status).toBe('completed')
    discovery.stop()
  })

  it('resurrects zombie sessions whose process is still running', async () => {
    const sid = 'dddddddd-eeee-ffff-1111-222222222222'
    db.prepare(
      `INSERT INTO sessions (id, purpose, working_dir, status, last_heartbeat)
       VALUES (?, 'copilot-hook', '/tmp', 'zombie', datetime('now', '-600 seconds'))`,
    ).run(sid)

    const psProvider = vi.fn().mockResolvedValue(`  77777 copilot --resume ${sid}\n`)
    const discovery = makeDiscovery(psProvider)

    await discovery.tick()
    expect(findSessionById(db, sid)!.status).toBe('active')
    discovery.stop()
  })

  it('resurrects EXPIRED sessions whose process is still running (issue #70 S1)', async () => {
    // 'expired' is the normal post-grace state now; a live discovered
    // process must revive it — not leave it stranded non-routable with
    // archived_at cleared (which would also hide it from TTL GC forever).
    const sid = 'eeeeeeee-ffff-1111-2222-333333333333'
    db.prepare(
      `INSERT INTO sessions (id, purpose, working_dir, status, last_heartbeat, archived_at)
       VALUES (?, 'copilot-hook', '/tmp', 'expired', datetime('now', '-600 seconds'), datetime('now'))`,
    ).run(sid)

    const psProvider = vi.fn().mockResolvedValue(`  88888 copilot --resume ${sid}\n`)
    const discovery = makeDiscovery(psProvider)

    await discovery.tick()
    const revived = db
      .prepare('SELECT status, archived_at FROM sessions WHERE id = ?')
      .get(sid) as { status: string; archived_at: string | null }
    expect(revived.status).toBe('active')
    expect(revived.archived_at).toBeNull()
    discovery.stop()
  })

  it('handles ps failure gracefully', async () => {
    const psProvider = vi.fn().mockRejectedValue(new Error('ps failed'))
    const discovery = makeDiscovery(psProvider)

    // tick catches errors internally — should return empty result
    const result = await discovery.tick()
    expect(result.discovered).toBe(0)
    expect(findAllSessions(db)).toHaveLength(0)
    discovery.stop()
  })

  it('tick() returns discovery stats', async () => {
    const sid = 'eeeeeeee-ffff-1111-2222-333333333333'
    const psProvider = vi.fn().mockResolvedValue(`  55555 copilot --resume ${sid}\n`)
    const discovery = makeDiscovery(psProvider)

    const result = await discovery.tick()
    expect(result.discovered).toBe(1)
    expect(result.processes).toHaveLength(1)
    expect(result.processes[0]!.sessionId).toBe(sid)
    discovery.stop()
  })

  it('stop() clears the interval timer', () => {
    const psProvider = vi.fn().mockResolvedValue('')
    const discovery = makeDiscovery(psProvider)
    // Should not throw
    expect(() => discovery.stop()).not.toThrow()
  })

  it('resets miss counter when process reappears', async () => {
    const sid = 'ffffffff-1111-2222-3333-444444444444'
    const psProvider = vi
      .fn()
      .mockResolvedValueOnce(`  11111 copilot --resume ${sid}\n`) // discover
      .mockResolvedValueOnce('') // miss 1
      .mockResolvedValueOnce('') // miss 2
      .mockResolvedValueOnce(`  11111 copilot --resume ${sid}\n`) // back!
      .mockResolvedValue('') // misses restart

    const discovery = makeDiscovery(psProvider)

    await discovery.tick() // discover
    expect(findSessionById(db, sid)!.status).toBe('active')

    await discovery.tick() // miss 1
    await discovery.tick() // miss 2
    await discovery.tick() // back — resets counter
    expect(findSessionById(db, sid)!.status).toBe('active')

    await discovery.tick() // miss 1 (reset)
    await discovery.tick() // miss 2
    expect(findSessionById(db, sid)!.status).toBe('active')

    await discovery.tick() // miss 3 → completed
    expect(findSessionById(db, sid)!.status).toBe('completed')
    discovery.stop()
  })
})
