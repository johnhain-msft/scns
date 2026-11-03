/**
 * Idle reaping — registry half: the `stopped_reason` migration and the wake.
 *
 * The migration matters more than it looks. The `projects` table carries
 * `CHECK (status IN (...))` baked into its CREATE TABLE, and
 * `CREATE TABLE IF NOT EXISTS` does NOT alter a table that already exists — so
 * adding a seventh status value like `'idle'` would have thrown on every
 * registry DB already on disk (including the live one at
 * `~/.scns/meta-broker.db`). Hence a nullable column instead, applied with the
 * same additive PRAGMA/ALTER pattern the file already used for autonomy.
 *
 * These tests therefore build a DB with the OLD schema by hand and migrate it,
 * rather than trusting `applyMetaSchema` against a fresh file.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  applyMetaSchema,
  getProject,
  recordProjectResolved,
  registerProject,
  resetProject,
  updateChildState,
  wakeIdleProject,
} from '../../../src/meta-broker/registry.js'

/** Verbatim pre-`stopped_reason` schema, as shipped. */
const OLD_SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  project_id      TEXT PRIMARY KEY,
  project_root    TEXT NOT NULL,
  desired_port    INTEGER,
  bound_port      INTEGER,
  status          TEXT NOT NULL DEFAULT 'registered'
                  CHECK (status IN ('registered','starting','running','failing','failed','stopped')),
  instance_id     TEXT,
  child_pid       INTEGER,
  last_seen_at    TEXT,
  last_error      TEXT,
  health_failures INTEGER NOT NULL DEFAULT 0,
  autonomy_level  INTEGER,
  auto_approve_threshold REAL,
  self_issue_repo TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_projects_root ON projects(project_root);
`

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
})

afterEach(() => {
  db.close()
})

function columns(): Set<string> {
  return new Set(
    (db.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>).map((c) => c.name),
  )
}

describe('stopped_reason migration against an EXISTING old-schema registry', () => {
  it('adds the column to a DB created with the old schema, preserving its rows', () => {
    db.exec(OLD_SCHEMA)
    db.prepare(
      "INSERT INTO projects (project_id, project_root, status, desired_port) VALUES ('legacy','/repo/legacy','running',3500)",
    ).run()
    expect(columns().has('stopped_reason')).toBe(false)

    applyMetaSchema(db)

    expect(columns().has('stopped_reason')).toBe(true)
    expect(columns().has('last_resolved_at')).toBe(true)
    const row = getProject(db, 'legacy')
    expect(row).toMatchObject({
      projectId: 'legacy',
      projectRoot: '/repo/legacy',
      status: 'running',
      desiredPort: 3500,
      stoppedReason: null,
      lastResolvedAt: null,
    })
  })

  it('is idempotent — applying the schema repeatedly does not throw or duplicate', () => {
    db.exec(OLD_SCHEMA)
    applyMetaSchema(db)
    applyMetaSchema(db)
    applyMetaSchema(db)
    expect([...columns()].filter((c) => c === 'stopped_reason')).toHaveLength(1)
    expect([...columns()].filter((c) => c === 'last_resolved_at')).toHaveLength(1)
  })

  it('keeps the original status CHECK constraint intact (no table rebuild)', () => {
    // Proof that the migration did NOT quietly recreate the table with a
    // widened enum: an invalid status must still be rejected.
    db.exec(OLD_SCHEMA)
    applyMetaSchema(db)
    registerProject(db, { projectId: 'p1', projectRoot: '/repo/a' })
    expect(() =>
      db.prepare("UPDATE projects SET status='idle' WHERE project_id='p1'").run(),
    ).toThrow(/CHECK constraint failed/i)
  })

  it('an old-schema row written by a pre-migration build reads as terminal (reason null)', () => {
    db.exec(OLD_SCHEMA)
    db.prepare(
      "INSERT INTO projects (project_id, project_root, status) VALUES ('old','/repo/old','stopped')",
    ).run()
    applyMetaSchema(db)
    expect(getProject(db, 'old')?.stoppedReason).toBeNull()
    expect(wakeIdleProject(db, 'old')).toBe(false)
    expect(getProject(db, 'old')?.status).toBe('stopped')
  })
})

describe('stopped_reason lifecycle', () => {
  beforeEach(() => {
    applyMetaSchema(db)
    registerProject(db, { projectId: 'p1', projectRoot: '/repo/a' })
  })

  it('records the reason on an idle stop', () => {
    updateChildState(db, 'p1', {
      status: 'stopped',
      stoppedReason: 'idle',
      boundPort: null,
      childPid: null,
      instanceId: null,
      lastSeenAt: 'now',
    })
    expect(getProject(db, 'p1')).toMatchObject({ status: 'stopped', stoppedReason: 'idle' })
  })

  it('defaults the reason to null when a stop does not state one (= operator intent)', () => {
    updateChildState(db, 'p1', {
      status: 'stopped',
      boundPort: null,
      childPid: null,
      instanceId: null,
      lastSeenAt: 'now',
    })
    expect(getProject(db, 'p1')?.stoppedReason).toBeNull()
  })

  it('CLEARS the reason on any transition out of stopped', () => {
    // Load-bearing: a woken child that kept `stopped_reason='idle'` would keep
    // being answered `child-idle` by routing even while it was up and serving.
    updateChildState(db, 'p1', {
      status: 'stopped',
      stoppedReason: 'idle',
      boundPort: null,
      childPid: null,
      instanceId: null,
      lastSeenAt: 'now',
    })
    updateChildState(db, 'p1', {
      status: 'running',
      // Deliberately passed and deliberately ignored.
      stoppedReason: 'idle',
      boundPort: 3500,
      childPid: 42,
      instanceId: 'i1',
      lastSeenAt: 'now',
    })
    expect(getProject(db, 'p1')).toMatchObject({ status: 'running', stoppedReason: null })
  })

  it('resetProject clears the reason too', () => {
    updateChildState(db, 'p1', {
      status: 'stopped',
      stoppedReason: 'idle',
      boundPort: null,
      childPid: null,
      instanceId: null,
      lastSeenAt: 'now',
    })
    expect(resetProject(db, 'p1')).toBe(true)
    expect(getProject(db, 'p1')).toMatchObject({ status: 'registered', stoppedReason: null })
  })
})

describe('wakeIdleProject', () => {
  beforeEach(() => {
    applyMetaSchema(db)
    registerProject(db, { projectId: 'p1', projectRoot: '/repo/a', desiredPort: 3500 })
  })

  function stop(reason: 'idle' | 'operator' | null): void {
    updateChildState(db, 'p1', {
      status: 'stopped',
      stoppedReason: reason,
      boundPort: null,
      childPid: null,
      instanceId: null,
      lastSeenAt: 'now',
    })
  }

  it('flips an idle-reaped project back to registered so the next tick spawns it', () => {
    stop('idle')
    expect(wakeIdleProject(db, 'p1')).toBe(true)
    expect(getProject(db, 'p1')).toMatchObject({
      status: 'registered',
      stoppedReason: null,
      healthFailures: 0,
    })
  })

  it('preserves desired_port so the woken child reclaims its own address', () => {
    stop('idle')
    wakeIdleProject(db, 'p1')
    expect(getProject(db, 'p1')?.desiredPort).toBe(3500)
  })

  it('ACCEPTANCE: refuses to wake an OPERATOR stop — that stays terminal', () => {
    stop('operator')
    expect(wakeIdleProject(db, 'p1')).toBe(false)
    expect(getProject(db, 'p1')?.status).toBe('stopped')
  })

  it('ACCEPTANCE: refuses to wake an unexplained stop (reason null)', () => {
    stop(null)
    expect(wakeIdleProject(db, 'p1')).toBe(false)
    expect(getProject(db, 'p1')?.status).toBe('stopped')
  })

  it('is idempotent — concurrent resolves produce one transition, not N', () => {
    stop('idle')
    expect(wakeIdleProject(db, 'p1')).toBe(true)
    expect(wakeIdleProject(db, 'p1')).toBe(false)
    expect(wakeIdleProject(db, 'p1')).toBe(false)
    expect(getProject(db, 'p1')?.status).toBe('registered')
  })

  it('never touches a project that is not stopped', () => {
    updateChildState(db, 'p1', {
      status: 'running',
      boundPort: 3500,
      childPid: 1,
      instanceId: 'i1',
      lastSeenAt: 'now',
    })
    expect(wakeIdleProject(db, 'p1')).toBe(false)
    expect(getProject(db, 'p1')?.status).toBe('running')
  })

  it('never touches a project suspended as failed', () => {
    updateChildState(db, 'p1', {
      status: 'failed',
      boundPort: null,
      childPid: null,
      instanceId: null,
      lastSeenAt: 'now',
    })
    expect(wakeIdleProject(db, 'p1')).toBe(false)
    expect(getProject(db, 'p1')?.status).toBe('failed')
  })
})

describe('recordProjectResolved — demand the child cannot observe', () => {
  beforeEach(() => {
    applyMetaSchema(db)
    registerProject(db, { projectId: 'p1', projectRoot: '/repo/a' })
  })

  it('stamps the first resolve', () => {
    const nowMs = Date.parse('2026-10-14T12:00:00.000Z')
    expect(recordProjectResolved(db, 'p1', { nowMs })).toBe(true)
    expect(getProject(db, 'p1')?.lastResolvedAt).toBe('2026-10-14T12:00:00.000Z')
  })

  it('throttles repeat resolves so the hot path does not write per request', () => {
    const nowMs = Date.parse('2026-10-14T12:00:00.000Z')
    expect(recordProjectResolved(db, 'p1', { nowMs })).toBe(true)
    expect(recordProjectResolved(db, 'p1', { nowMs: nowMs + 1_000 })).toBe(false)
    expect(recordProjectResolved(db, 'p1', { nowMs: nowMs + 59_000 })).toBe(false)
    expect(getProject(db, 'p1')?.lastResolvedAt).toBe('2026-10-14T12:00:00.000Z')
  })

  it('stamps again once the throttle window has passed', () => {
    const nowMs = Date.parse('2026-10-14T12:00:00.000Z')
    recordProjectResolved(db, 'p1', { nowMs })
    expect(recordProjectResolved(db, 'p1', { nowMs: nowMs + 60_001 })).toBe(true)
    expect(getProject(db, 'p1')?.lastResolvedAt).toBe('2026-10-14T12:01:00.001Z')
  })

  it('is a no-op for an unregistered project', () => {
    expect(recordProjectResolved(db, 'nope')).toBe(false)
  })

  it('recovers from an unparseable existing stamp by overwriting it', () => {
    db.prepare("UPDATE projects SET last_resolved_at = 'garbage' WHERE project_id = 'p1'").run()
    const nowMs = Date.parse('2026-10-14T12:00:00.000Z')
    expect(recordProjectResolved(db, 'p1', { nowMs })).toBe(true)
    expect(getProject(db, 'p1')?.lastResolvedAt).toBe('2026-10-14T12:00:00.000Z')
  })
})
