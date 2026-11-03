import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { openDatabase, closeDatabase } from '../../../src/broker/storage/db.js'
import { createEventLog } from '../../../src/broker/services/event-log.js'
import {
  startSessionDiscovery,
  type SessionDiscovery,
} from '../../../src/broker/session-discovery.js'
import { createSession } from '../../../src/broker/storage/repositories/session-repository.js'

const ROOT = join(process.cwd(), 'project-fixture')
const SID = 'dddddddd-eeee-ffff-1111-222222222222'

describe('project-scoped session discovery (injected process lists only)', () => {
  let db: Database.Database
  let discovery: SessionDiscovery

  beforeEach(() => {
    db = openDatabase(':memory:')
    discovery = startSessionDiscovery(db, createEventLog(db), {
      projectRoot: ROOT,
      skipInitialTick: true,
      intervalMs: 999_999,
      psProvider: async () => `12345 copilot --resume ${SID}`,
    })
  })

  afterEach(() => {
    discovery.stop()
    closeDatabase(db)
  })

  it('does not register a globally visible resumed session into every project DB', async () => {
    const result = await discovery.tick()
    expect(result.discovered).toBe(0)
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 0 })
  })

  it('does not resurrect or refresh an existing foreign row', async () => {
    createSession(db, {
      id: SID,
      working_dir: process.cwd(),
      purpose: 'copilot-hook',
      worktree: null,
    })
    db.prepare("UPDATE sessions SET status='completed',last_heartbeat='2000-01-01' WHERE id=?").run(
      SID,
    )
    const before = db.prepare('SELECT * FROM sessions WHERE id=?').get(SID)
    const result = await discovery.tick()
    expect(result.discovered).toBe(0)
    expect(result.refreshed).toBe(0)
    expect(db.prepare('SELECT * FROM sessions WHERE id=?').get(SID)).toEqual(before)
  })

  it('still keeps an already registered native resumed session alive', async () => {
    createSession(db, { id: SID, working_dir: ROOT, purpose: 'copilot-hook', worktree: null })
    db.prepare("UPDATE sessions SET last_heartbeat='2000-01-01' WHERE id=?").run(SID)
    const result = await discovery.tick()
    expect(result.refreshed).toBe(1)
    expect(db.prepare('SELECT last_heartbeat FROM sessions WHERE id=?').get(SID)).not.toEqual({
      last_heartbeat: '2000-01-01',
    })
    expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual({ n: 0 })
  })
})
