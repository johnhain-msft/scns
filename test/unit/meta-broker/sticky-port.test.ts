import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  applyMetaSchema,
  getProject,
  persistDesiredPort,
  registerProject,
  stickyDesiredPort,
  updateChildState,
} from '../../../src/meta-broker/registry.js'

describe('stickyDesiredPort', () => {
  it('prefers an explicitly registered desired port', () => {
    expect(stickyDesiredPort({ desiredPort: 3501, boundPort: 3507 })).toBe(3501)
  })

  // The regression: every registry row had desired_port NULL, so pickPort
  // passed `undefined` and the allocator re-dealt the pool from scratch on
  // every meta-broker restart. The last-known-good port is the anchor.
  it('falls back to the last bound port when no desired port is set', () => {
    expect(stickyDesiredPort({ desiredPort: null, boundPort: 3506 })).toBe(3506)
  })

  it('returns undefined when the project has never bound a port', () => {
    expect(stickyDesiredPort({ desiredPort: null, boundPort: null })).toBeUndefined()
  })
})

describe('persistDesiredPort', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    applyMetaSchema(db)
    registerProject(db, { projectId: 'p1', projectRoot: '/repo/p1' })
  })

  afterEach(() => {
    db.close()
  })

  it('records a verified port as the durable anchor', () => {
    persistDesiredPort(db, 'p1', 3500)
    expect(getProject(db, 'p1')?.desiredPort).toBe(3500)
  })

  it('never overrides an operator-registered desired port', () => {
    registerProject(db, { projectId: 'p2', projectRoot: '/repo/p2', desiredPort: 3600 })
    persistDesiredPort(db, 'p2', 3501)
    expect(getProject(db, 'p2')?.desiredPort).toBe(3600)
  })

  // bound_port is nulled when a child exits, so it cannot be the only anchor:
  // the persisted desired_port has to survive a clean shutdown.
  it('survives a child exit that clears bound_port', () => {
    persistDesiredPort(db, 'p1', 3500)
    updateChildState(db, 'p1', {
      status: 'failing',
      boundPort: null,
      childPid: null,
      instanceId: null,
      lastSeenAt: new Date().toISOString(),
    })
    const p = getProject(db, 'p1')
    expect(p?.boundPort).toBeNull()
    expect(stickyDesiredPort(p!)).toBe(3500)
  })

  it('is a no-op for an unregistered project', () => {
    expect(() => persistDesiredPort(db, 'nope', 3500)).not.toThrow()
  })
})
