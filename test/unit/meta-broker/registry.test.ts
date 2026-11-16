/**
 * P7 — Meta-broker project registry.
 *
 * Supervisor's source of truth for which projects exist and what their
 * lifecycle state is. DB lives at `~/.scns/meta-broker.db` (NOT the
 * shared `~/.session-broker/data.db`).
 *
 * Per the P7 rubber-duck (2026-06-03): no migration from the existing
 * shared data.db. Existing single-broker deployments are unaffected;
 * meta-broker is opt-in.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { win32 } from 'node:path'
import Database from 'better-sqlite3'
import {
  applyMetaSchema,
  registerProject,
  listProjects,
  getProject,
  getProjectByRoot,
  resolveProjectForPath,
  removeProject,
  resetProject,
  updateChildState,
  recordHealthFailure,
  resetHealthFailures,
  setGlobalTargets,
  getGlobalTargets,
  GLOBAL_BROKER_ID,
  type ProjectChildState,
} from '../../../src/meta-broker/registry.js'

let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  applyMetaSchema(db)
})

afterEach(() => {
  db.close()
})

describe('meta-broker registry — per-project config (Gap 5)', () => {
  it('persists autonomyLevel + autoApproveThreshold and round-trips them', () => {
    registerProject(db, {
      projectId: 'p-cfg',
      projectRoot: '/abs/p-cfg',
      autonomyLevel: 2,
      autoApproveThreshold: 0.8,
    })
    const p = getProject(db, 'p-cfg')!
    expect(p.autonomyLevel).toBe(2)
    expect(p.autoApproveThreshold).toBe(0.8)
  })

  it('defaults per-project config to null when omitted', () => {
    registerProject(db, { projectId: 'p-bare', projectRoot: '/abs/p-bare' })
    const p = getProject(db, 'p-bare')!
    expect(p.autonomyLevel).toBeNull()
    expect(p.autoApproveThreshold).toBeNull()
  })

  it('preserves existing per-project config when re-registered without it', () => {
    registerProject(db, {
      projectId: 'p-keep',
      projectRoot: '/abs/p-keep',
      autonomyLevel: 3,
      autoApproveThreshold: 0.75,
    })
    registerProject(db, { projectId: 'p-keep', projectRoot: '/abs/p-keep-moved' })
    const p = getProject(db, 'p-keep')!
    expect(p.projectRoot).toBe('/abs/p-keep-moved')
    expect(p.autonomyLevel).toBe(3)
    expect(p.autoApproveThreshold).toBe(0.75)
  })

  it('migrates a pre-Gap-5 projects table by adding the new columns', () => {
    const old = new Database(':memory:')
    // Simulate the legacy schema (no autonomy_level / auto_approve_threshold).
    old.exec(`CREATE TABLE projects (
      project_id TEXT PRIMARY KEY, project_root TEXT NOT NULL, desired_port INTEGER,
      bound_port INTEGER, status TEXT NOT NULL DEFAULT 'registered',
      instance_id TEXT, child_pid INTEGER, last_seen_at TEXT, last_error TEXT,
      health_failures INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')))`)
    old
      .prepare('INSERT INTO projects (project_id, project_root) VALUES (?, ?)')
      .run('legacy', '/abs/legacy')
    applyMetaSchema(old)
    const cols = (old.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    )
    expect(cols).toContain('autonomy_level')
    expect(cols).toContain('auto_approve_threshold')
    expect(getProject(old, 'legacy')!.autonomyLevel).toBeNull()
    old.close()
  })
})

describe('meta-broker registry — schema + idempotency', () => {
  it('applies the schema idempotently', () => {
    applyMetaSchema(db)
    applyMetaSchema(db)
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>
    const names = tables.map((t) => t.name)
    expect(names).toContain('projects')
  })

  it('rejects an empty projectId', () => {
    expect(() => registerProject(db, { projectId: '', projectRoot: '/r' })).toThrow()
  })

  it('rejects a relative projectRoot', () => {
    expect(() => registerProject(db, { projectId: 'p', projectRoot: 'relative' })).toThrow()
  })
})

describe('registerProject + getProject', () => {
  it('inserts a new project with default status=registered', () => {
    registerProject(db, { projectId: 'p1', projectRoot: '/a' })
    const proj = getProject(db, 'p1')
    expect(proj).not.toBeNull()
    expect(proj!.projectId).toBe('p1')
    expect(proj!.projectRoot).toBe('/a')
    expect(proj!.status).toBe('registered')
    expect(proj!.desiredPort).toBeNull()
    expect(proj!.boundPort).toBeNull()
    expect(proj!.childPid).toBeNull()
    expect(proj!.instanceId).toBeNull()
  })

  it('upserts on re-register (idempotent), updating project_root', () => {
    registerProject(db, { projectId: 'p1', projectRoot: '/a' })
    const first = getProject(db, 'p1')!
    registerProject(db, { projectId: 'p1', projectRoot: '/a-moved' })
    const second = getProject(db, 'p1')!
    expect(second.projectRoot).toBe('/a-moved')
    expect(second.createdAt).toBe(first.createdAt)
  })

  it('accepts a desiredPort on register', () => {
    registerProject(db, { projectId: 'p1', projectRoot: '/a', desiredPort: 3500 })
    expect(getProject(db, 'p1')!.desiredPort).toBe(3500)
  })

  it('getProject returns null for an unknown id', () => {
    expect(getProject(db, 'nope')).toBeNull()
  })
})

describe('getProjectByRoot — client discovery', () => {
  it('returns the project bound to a working_dir path', () => {
    registerProject(db, { projectId: 'p1', projectRoot: '/repos/foo' })
    expect(getProjectByRoot(db, '/repos/foo')!.projectId).toBe('p1')
  })

  it('returns null if no project owns that root', () => {
    registerProject(db, { projectId: 'p1', projectRoot: '/repos/foo' })
    expect(getProjectByRoot(db, '/repos/bar')).toBeNull()
  })
})

describe('listProjects', () => {
  it('returns rows ordered by created_at ASC for stable listings', () => {
    registerProject(db, { projectId: 'a', projectRoot: '/a' })
    registerProject(db, { projectId: 'b', projectRoot: '/b' })
    registerProject(db, { projectId: 'c', projectRoot: '/c' })
    const ids = listProjects(db).map((p) => p.projectId)
    expect(ids).toEqual(['a', 'b', 'c'])
  })

  it('returns an empty array on a fresh DB', () => {
    expect(listProjects(db)).toEqual([])
  })
})

describe('updateChildState — supervisor writes back', () => {
  it('records bound port, pid, instance_id, status, last_seen', () => {
    registerProject(db, { projectId: 'p1', projectRoot: '/a' })
    const state: ProjectChildState = {
      status: 'running',
      boundPort: 3500,
      childPid: 12345,
      instanceId: 'inst-abc',
      lastSeenAt: '2026-06-03T22:00:00.000Z',
    }
    updateChildState(db, 'p1', state)
    const proj = getProject(db, 'p1')!
    expect(proj.status).toBe('running')
    expect(proj.boundPort).toBe(3500)
    expect(proj.childPid).toBe(12345)
    expect(proj.instanceId).toBe('inst-abc')
    expect(proj.lastSeenAt).toBe('2026-06-03T22:00:00.000Z')
  })

  it('throws on unknown project id (caller should register first)', () => {
    expect(() =>
      updateChildState(db, 'unknown', {
        status: 'starting',
        boundPort: null,
        childPid: null,
        instanceId: null,
        lastSeenAt: null,
      }),
    ).toThrow()
  })

  it('can clear bound_port/pid/instance_id by passing null', () => {
    registerProject(db, { projectId: 'p1', projectRoot: '/a' })
    updateChildState(db, 'p1', {
      status: 'running',
      boundPort: 3500,
      childPid: 1,
      instanceId: 'i1',
      lastSeenAt: 'x',
    })
    updateChildState(db, 'p1', {
      status: 'stopped',
      boundPort: null,
      childPid: null,
      instanceId: null,
      lastSeenAt: 'y',
    })
    const p = getProject(db, 'p1')!
    expect(p.status).toBe('stopped')
    expect(p.boundPort).toBeNull()
    expect(p.childPid).toBeNull()
    expect(p.instanceId).toBeNull()
  })
})

describe('health failure tracking — for restart suppression', () => {
  it('starts at 0 consecutive failures', () => {
    registerProject(db, { projectId: 'p1', projectRoot: '/a' })
    expect(getProject(db, 'p1')!.healthFailures).toBe(0)
  })

  it('recordHealthFailure increments + sets last_error', () => {
    registerProject(db, { projectId: 'p1', projectRoot: '/a' })
    recordHealthFailure(db, 'p1', 'probe timeout')
    expect(getProject(db, 'p1')!.healthFailures).toBe(1)
    expect(getProject(db, 'p1')!.lastError).toBe('probe timeout')
    recordHealthFailure(db, 'p1', 'connection refused')
    expect(getProject(db, 'p1')!.healthFailures).toBe(2)
    expect(getProject(db, 'p1')!.lastError).toBe('connection refused')
  })

  it('resetHealthFailures clears the counter (after a successful probe)', () => {
    registerProject(db, { projectId: 'p1', projectRoot: '/a' })
    recordHealthFailure(db, 'p1', 'err')
    recordHealthFailure(db, 'p1', 'err')
    resetHealthFailures(db, 'p1')
    expect(getProject(db, 'p1')!.healthFailures).toBe(0)
  })
})

describe('removeProject', () => {
  it('returns true on success, false on missing', () => {
    registerProject(db, { projectId: 'p1', projectRoot: '/a' })
    expect(removeProject(db, 'p1')).toBe(true)
    expect(getProject(db, 'p1')).toBeNull()
    expect(removeProject(db, 'p1')).toBe(false)
  })
})

describe('meta-broker registry — per-project self-issue repo (Track-2)', () => {
  it('round-trips selfIssueRepo and defaults it to null', () => {
    registerProject(db, {
      projectId: 'cosmere',
      projectRoot: '/abs/cosmere',
      selfIssueRepo: 'example-org/Cosmere_RPG',
    })
    expect(getProject(db, 'cosmere')!.selfIssueRepo).toBe('example-org/Cosmere_RPG')

    registerProject(db, { projectId: 'no-repo', projectRoot: '/abs/x' })
    expect(getProject(db, 'no-repo')!.selfIssueRepo).toBeNull()
  })

  it('additively migrates self_issue_repo onto a legacy registry (pre-Track-2)', () => {
    const legacy = new Database(':memory:')
    // Registry created before per-project config columns existed.
    legacy.exec(`CREATE TABLE projects (
      project_id TEXT PRIMARY KEY, project_root TEXT NOT NULL,
      desired_port INTEGER, bound_port INTEGER,
      status TEXT NOT NULL DEFAULT 'registered',
      instance_id TEXT, child_pid INTEGER, last_seen_at TEXT, last_error TEXT,
      health_failures INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`)
    applyMetaSchema(legacy)
    const cols = new Set(
      (legacy.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>).map(
        (c) => c.name,
      ),
    )
    expect(cols.has('self_issue_repo')).toBe(true)
    registerProject(legacy, { projectId: 'p', projectRoot: '/a', selfIssueRepo: 'o/n' })
    expect(getProject(legacy, 'p')!.selfIssueRepo).toBe('o/n')
    legacy.close()
  })
})

describe('meta-broker registry — target graph (#63)', () => {
  it('round-trips upstreamRepo + writeTargetRepo and defaults both to null', () => {
    registerProject(db, {
      projectId: 'p-graph',
      projectRoot: '/abs/p-graph',
      upstreamRepo: 'upstream-org/tool',
      writeTargetRepo: 'me/tool-home',
    })
    const p = getProject(db, 'p-graph')!
    expect(p.upstreamRepo).toBe('upstream-org/tool')
    expect(p.writeTargetRepo).toBe('me/tool-home')

    registerProject(db, { projectId: 'p-bare', projectRoot: '/abs/p-bare' })
    expect(getProject(db, 'p-bare')!.upstreamRepo).toBeNull()
    expect(getProject(db, 'p-bare')!.writeTargetRepo).toBeNull()
  })

  it('preserves both columns via COALESCE when re-registered without them', () => {
    registerProject(db, {
      projectId: 'p-keep',
      projectRoot: '/abs/p-keep',
      upstreamRepo: 'upstream-org/tool',
      writeTargetRepo: 'me/tool-home',
    })
    registerProject(db, { projectId: 'p-keep', projectRoot: '/abs/p-keep-moved' })
    const p = getProject(db, 'p-keep')!
    expect(p.projectRoot).toBe('/abs/p-keep-moved')
    expect(p.upstreamRepo).toBe('upstream-org/tool')
    expect(p.writeTargetRepo).toBe('me/tool-home')
  })

  it('writeTargetRepo reads through to the legacy self_issue_repo until one is set', () => {
    // self_issue_repo is superseded but stays as the read-side alias: a row
    // written before #63 keeps its write target without any data migration.
    registerProject(db, { projectId: 'p-legacy', projectRoot: '/abs/p', selfIssueRepo: 'o/legacy' })
    expect(getProject(db, 'p-legacy')!.writeTargetRepo).toBe('o/legacy')

    registerProject(db, { projectId: 'p-legacy', projectRoot: '/abs/p', writeTargetRepo: 'o/new' })
    const p = getProject(db, 'p-legacy')!
    expect(p.writeTargetRepo).toBe('o/new')
    // The raw legacy column is untouched — it is an alias, not a mirror.
    expect(p.selfIssueRepo).toBe('o/legacy')
  })

  it('additively migrates upstream_repo + write_target_repo onto a pre-#63 registry', () => {
    const legacy = new Database(':memory:')
    legacy.exec(`CREATE TABLE projects (
      project_id TEXT PRIMARY KEY, project_root TEXT NOT NULL,
      desired_port INTEGER, bound_port INTEGER,
      status TEXT NOT NULL DEFAULT 'registered',
      instance_id TEXT, child_pid INTEGER, last_seen_at TEXT, last_error TEXT,
      health_failures INTEGER NOT NULL DEFAULT 0,
      autonomy_level INTEGER, auto_approve_threshold REAL, self_issue_repo TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`)
    legacy
      .prepare('INSERT INTO projects (project_id, project_root, self_issue_repo) VALUES (?, ?, ?)')
      .run('old-row', '/abs/old', 'o/legacy')
    applyMetaSchema(legacy)
    const cols = new Set(
      (legacy.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>).map(
        (c) => c.name,
      ),
    )
    expect(cols.has('upstream_repo')).toBe(true)
    expect(cols.has('write_target_repo')).toBe(true)
    const p = getProject(legacy, 'old-row')!
    expect(p.upstreamRepo).toBeNull()
    expect(p.writeTargetRepo).toBe('o/legacy') // read-side alias carries it forward
    legacy.close()
  })

  it('rejects registering a project under the reserved global id', () => {
    expect(() =>
      registerProject(db, { projectId: GLOBAL_BROKER_ID, projectRoot: '/abs/x' }),
    ).toThrow(/reserved/)
  })

  it('setGlobalTargets creates the reserved row and getGlobalTargets reads it back', () => {
    expect(getGlobalTargets(db)).toBeNull()
    setGlobalTargets(db, { upstreamRepo: 'upstream-org/tool', writeTargetRepo: 'me/tool-home' })
    expect(getGlobalTargets(db)).toEqual({
      upstreamRepo: 'upstream-org/tool',
      writeTargetRepo: 'me/tool-home',
    })
  })

  it('setGlobalTargets keeps the other column when updating only one (COALESCE)', () => {
    setGlobalTargets(db, { upstreamRepo: 'upstream-org/tool', writeTargetRepo: 'me/tool-home' })
    setGlobalTargets(db, { writeTargetRepo: 'me/other-home' })
    expect(getGlobalTargets(db)).toEqual({
      upstreamRepo: 'upstream-org/tool',
      writeTargetRepo: 'me/other-home',
    })
  })

  it('hides the reserved global row from listings, path routing, and lookups by root', () => {
    // listProjects feeds the supervisor's spawn loop and resolveProjectForPath
    // feeds session routing — the global row is configuration, not a child.
    setGlobalTargets(db, { upstreamRepo: 'upstream-org/tool', writeTargetRepo: 'me/tool-home' })
    registerProject(db, { projectId: 'p1', projectRoot: '/a' })
    expect(listProjects(db).map((p) => p.projectId)).toEqual(['p1'])
    expect(resolveProjectForPath(db, '/a/sub')?.projectId).toBe('p1')
    expect(resolveProjectForPath(db, '/elsewhere')).toBeNull()
  })
})

describe('resolveProjectForPath — walk-up matching (W5 routing)', () => {
  it('resolves the exact project root', () => {
    registerProject(db, {
      projectId: 'cosmere',
      projectRoot: '/Users/j/Coding_Projects/Cosmere_RPG',
    })
    const hit = resolveProjectForPath(db, '/Users/j/Coding_Projects/Cosmere_RPG')
    expect(hit?.projectId).toBe('cosmere')
  })

  it('resolves a subdirectory of a registered root (walk-up)', () => {
    registerProject(db, {
      projectId: 'cosmere',
      projectRoot: '/Users/j/Coding_Projects/Cosmere_RPG',
    })
    const hit = resolveProjectForPath(db, '/Users/j/Coding_Projects/Cosmere_RPG/src/deep/dir')
    expect(hit?.projectId).toBe('cosmere')
  })

  it('picks the deepest match when roots nest', () => {
    registerProject(db, { projectId: 'outer', projectRoot: '/mono' })
    registerProject(db, { projectId: 'inner', projectRoot: '/mono/packages/app' })
    expect(resolveProjectForPath(db, '/mono/packages/app/src')?.projectId).toBe('inner')
    expect(resolveProjectForPath(db, '/mono/other')?.projectId).toBe('outer')
  })

  it('returns null for an unregistered path', () => {
    registerProject(db, {
      projectId: 'cosmere',
      projectRoot: '/Users/j/Coding_Projects/Cosmere_RPG',
    })
    expect(resolveProjectForPath(db, '/Users/j/Elsewhere/repo')).toBeNull()
  })

  it('does not match a sibling directory sharing a name prefix', () => {
    registerProject(db, { projectId: 'foo', projectRoot: '/a/foo' })
    expect(resolveProjectForPath(db, '/a/foobar/src')).toBeNull()
  })
})

// ── WI-1(b): win32 branch, exercised on any host via path.win32 injection ──
// Runtime callers omit the platform param and get host semantics (Mac behavior
// unchanged — the describe blocks above are the golden gate for that). These
// tests are the from-Mac stand-in for running the suite on native Windows.

describe('registerProject — win32 branch (injected path.win32)', () => {
  it('accepts a drive-absolute Windows root', () => {
    registerProject(db, { projectId: 'winproj', projectRoot: 'C:\\Users\\j\\repos\\app' }, win32)
    expect(getProject(db, 'winproj')?.projectRoot).toBe('C:\\Users\\j\\repos\\app')
  })

  it('accepts a UNC root', () => {
    registerProject(db, { projectId: 'unc', projectRoot: '\\\\srv\\share\\repo' }, win32)
    expect(getProject(db, 'unc')?.projectRoot).toBe('\\\\srv\\share\\repo')
  })

  it('still rejects a relative Windows path', () => {
    expect(() =>
      registerProject(db, { projectId: 'rel', projectRoot: 'repos\\app' }, win32),
    ).toThrow(/absolute/)
    expect(() =>
      registerProject(db, { projectId: 'rel', projectRoot: 'C:relative' }, win32),
    ).toThrow(/absolute/)
  })
})

describe('resolveProjectForPath — win32 branch (injected path.win32)', () => {
  it('resolves the exact root and subdirectories', () => {
    registerProject(db, { projectId: 'app', projectRoot: 'C:\\repos\\app' }, win32)
    expect(resolveProjectForPath(db, 'C:\\repos\\app', win32)?.projectId).toBe('app')
    expect(resolveProjectForPath(db, 'C:\\repos\\app\\src\\deep', win32)?.projectId).toBe('app')
  })

  it('normalizes mixed separators and compares case-insensitively', () => {
    registerProject(db, { projectId: 'app', projectRoot: 'C:\\repos\\app' }, win32)
    expect(resolveProjectForPath(db, 'C:/repos/app/src', win32)?.projectId).toBe('app')
    expect(resolveProjectForPath(db, 'c:\\REPOS\\App\\src', win32)?.projectId).toBe('app')
  })

  it('picks the deepest match when roots nest', () => {
    registerProject(db, { projectId: 'outer', projectRoot: 'C:\\mono' }, win32)
    registerProject(db, { projectId: 'inner', projectRoot: 'C:\\mono\\packages\\app' }, win32)
    expect(resolveProjectForPath(db, 'C:\\mono\\packages\\app\\src', win32)?.projectId).toBe(
      'inner',
    )
    expect(resolveProjectForPath(db, 'C:\\mono\\other', win32)?.projectId).toBe('outer')
  })

  it('does not match a sibling sharing a name prefix, and returns null unregistered', () => {
    registerProject(db, { projectId: 'app', projectRoot: 'C:\\repos\\app' }, win32)
    expect(resolveProjectForPath(db, 'C:\\repos\\app2\\src', win32)).toBeNull()
    expect(resolveProjectForPath(db, 'D:\\repos\\app', win32)).toBeNull()
  })
})

describe('meta-broker registry — clearing a suspended project', () => {
  const suspended = (status: 'failed' | 'stopped'): ProjectChildState => ({
    status,
    boundPort: 3507,
    childPid: 4728,
    instanceId: 'i-old',
    lastSeenAt: '2026-10-12T20:06:00.000Z',
  })

  it('clears a failed project back to registered, keeping its pinned port', () => {
    // `registerProject` upserts only operator config and never `status`, so
    // re-registering a suspended project was a no-op and the documented
    // recovery did nothing. This is the supported replacement for the
    // hand-written UPDATE that recovery previously required.
    registerProject(db, { projectId: 'p1', projectRoot: '/abs/p1', desiredPort: 3507 })
    updateChildState(db, 'p1', suspended('failed'))
    recordHealthFailure(db, 'p1', 'probe returned non-OK / identity mismatch')

    expect(resetProject(db, 'p1')).toBe(true)
    expect(getProject(db, 'p1')).toMatchObject({
      status: 'registered',
      healthFailures: 0,
      boundPort: null,
      instanceId: null,
      childPid: null,
      // Cleared so it cannot read as a suspension timestamp if the row ever
      // re-enters 'failed' (the failed-retry backoff measures from it).
      lastSeenAt: null,
      lastError: null,
      desiredPort: 3507,
    })
  })

  it('clears a stopped project too', () => {
    registerProject(db, { projectId: 'p1', projectRoot: '/abs/p1' })
    updateChildState(db, 'p1', suspended('stopped'))
    expect(resetProject(db, 'p1')).toBe(true)
    expect(getProject(db, 'p1')?.status).toBe('registered')
  })

  it('refuses to clear a live project, whose identity still describes a real child', () => {
    // Blanking bound_port/instance_id under a running child would make the next
    // tick spawn a SECOND broker for the same project.
    registerProject(db, { projectId: 'p1', projectRoot: '/abs/p1' })
    updateChildState(db, 'p1', { ...suspended('failed'), status: 'running' })
    expect(resetProject(db, 'p1')).toBe(false)
    expect(getProject(db, 'p1')).toMatchObject({ status: 'running', boundPort: 3507 })
  })

  it('reports a miss for an unregistered project', () => {
    expect(resetProject(db, 'nope')).toBe(false)
  })
})
