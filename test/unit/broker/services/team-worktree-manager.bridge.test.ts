/**
 * Layer-2 fix — verify the team-worktree-manager invokes the
 * node_modules bridge after `git worktree add` (and on idempotent
 * re-ensures), emits a `worktree_provisioning` event, and never fails
 * provisioning when the bridge can't link.
 *
 * Pre-Layer-2: provisioned worktrees had no `node_modules`, so ACP-
 * spawned dev/qa agents exited on the first turn with no output
 * because `vitest`/`eslint`/`tsc` returned "command not found"
 * (live observation 2026-05-16 team 4fde2759).
 *
 * Covered properties:
 *   (W1) Fresh ensure invokes the injected bridge with
 *        (projectRoot, wtPath, 'symlink') exactly once.
 *   (W2) Successful bridge (linked:true, reason:'symlinked') emits
 *        a worktree_provisioning event with linked:true.
 *   (W3) Failed bridge (linked:false, reason:'tooling-unresolved')
 *        logs a warning, emits a diagnostic event, AND still returns
 *        the worktree path (provisioning never fails the spawn).
 *   (W4) Idempotent re-ensure: when teams.working_dir is already pinned
 *        AND the pin is INSIDE baseDir AND verify says tooling is OK,
 *        bridge is NOT re-invoked (cheap skip).
 *   (W5) Idempotent re-ensure: when the pin is INSIDE baseDir AND
 *        verify reports missing binaries, bridge IS re-invoked
 *        (repair path) and a 're-bridge' trigger event is emitted.
 *   (W6) External pin (OUTSIDE baseDir): bridge is NEVER invoked
 *        (manager has no authority over external pins).
 *   (W7) Bridge throw is caught — provisioning returns the worktree
 *        path and an event with reason:'tooling-unresolved' is emitted.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import type { TestDb } from '../../../helpers/db-harness.js'
import { createBrokerTestDb } from '../../../helpers/broker-db-harness.js'
import {
  createTeamWorktreeManager,
  type TeamWorktreeManagerEventSink,
} from '../../../../src/broker/services/team-worktree-manager.js'
import type {
  BridgeResult,
  VerifyToolingResult,
} from '../../../../src/broker/services/worktree-tooling-bridge.js'

function git(cwd: string, args: ReadonlyArray<string>): string {
  return execFileSync('git', args as string[], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  })
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scns-wt-bridge-proj-'))
  const repo = realpathSync(dir)
  git(repo, ['init', '-q', '-b', 'main'])
  writeFileSync(join(repo, 'README.md'), 'seed\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'seed'])
  return repo
}

function insertTeam(db: TestDb['db'], id: string, name: string): void {
  db.prepare('INSERT INTO teams (id, name) VALUES (?, ?)').run(id, name)
}

function makeEventSink(): TeamWorktreeManagerEventSink & {
  calls: Array<{ sessionId: string | null; data: Record<string, unknown> }>
} {
  const calls: Array<{
    sessionId: string | null
    data: Record<string, unknown>
  }> = []
  return {
    calls,
    worktreeProvisioning(sessionId, data) {
      calls.push({ sessionId, data })
      return undefined
    },
  }
}

const TEAM_A = '33333333-3333-4333-8333-333333333333'

describe('team-worktree-manager — Layer-2 bridge wiring', () => {
  let testDb: TestDb
  let projectRoot: string
  let baseDir: string

  beforeEach(() => {
    testDb = createBrokerTestDb()
    projectRoot = makeRepo()
    baseDir = realpathSync(mkdtempSync(join(tmpdir(), 'scns-wt-bridge-base-')))
  })

  afterEach(() => {
    testDb.close()
    try {
      git(projectRoot, ['worktree', 'prune'])
    } catch {
      /* repo already gone */
    }
    try {
      rmSync(baseDir, { recursive: true, force: true })
    } catch {
      /* noop */
    }
    try {
      rmSync(projectRoot, { recursive: true, force: true })
    } catch {
      /* noop */
    }
  })

  it('(W1) fresh ensure invokes bridge(projectRoot, wtPath, "symlink") exactly once', () => {
    insertTeam(testDb.db, TEAM_A, 'team-alpha')

    const bridge = vi.fn(
      (src: string, dest: string): BridgeResult => ({
        linked: true,
        reason: 'symlinked',
        srcPath: join(src, 'node_modules'),
        destPath: join(dest, 'node_modules'),
        binDirRealpath: join(dest, 'node_modules', '.bin'),
      }),
    )

    const mgr = createTeamWorktreeManager({
      db: testDb.db,
      projectRoot,
      baseDir,
      bridge,
    })

    const wt = mgr.ensureWorktreeForTeam(TEAM_A)!
    expect(wt).toBe(join(baseDir, TEAM_A, 'wt'))
    expect(bridge).toHaveBeenCalledTimes(1)
    const callArgs = bridge.mock.calls[0]!
    expect(callArgs[0]).toBe(projectRoot)
    expect(callArgs[1]).toBe(wt)
    expect(callArgs[2]).toBe('symlink')
  })

  it('(W2) successful bridge emits worktree_provisioning event with linked:true', () => {
    insertTeam(testDb.db, TEAM_A, 'team-alpha')
    const sink = makeEventSink()

    const bridge = vi.fn(
      (src: string, dest: string): BridgeResult => ({
        linked: true,
        reason: 'symlinked',
        srcPath: join(src, 'node_modules'),
        destPath: join(dest, 'node_modules'),
        binDirRealpath: '/realpath/bin',
      }),
    )

    const mgr = createTeamWorktreeManager({
      db: testDb.db,
      projectRoot,
      baseDir,
      bridge,
      eventLog: sink,
    })

    mgr.ensureWorktreeForTeam(TEAM_A)
    expect(sink.calls).toHaveLength(1)
    const ev = sink.calls[0]!
    expect(ev.sessionId).toBeNull()
    expect(ev.data['team_id']).toBe(TEAM_A)
    expect(ev.data['linked']).toBe(true)
    expect(ev.data['reason']).toBe('symlinked')
    expect(ev.data['vitestResolved']).toBe(true)
    expect(ev.data['eslintResolved']).toBe(true)
    expect(ev.data['binDirRealpath']).toBe('/realpath/bin')
    expect(ev.data['trigger']).toBe('fresh-create')
  })

  it('(W3) failed bridge does NOT fail provisioning — path still returned + diagnostic event emitted', () => {
    insertTeam(testDb.db, TEAM_A, 'team-alpha')
    const sink = makeEventSink()

    const bridge = vi.fn(
      (src: string, dest: string): BridgeResult => ({
        linked: false,
        reason: 'tooling-unresolved',
        srcPath: join(src, 'node_modules'),
        destPath: join(dest, 'node_modules'),
        missing: ['vitest'],
        binDirRealpath: null,
        error: 'simulated failure',
      }),
    )

    const mgr = createTeamWorktreeManager({
      db: testDb.db,
      projectRoot,
      baseDir,
      bridge,
      eventLog: sink,
    })

    const wt = mgr.ensureWorktreeForTeam(TEAM_A)
    expect(wt).toBe(join(baseDir, TEAM_A, 'wt'))
    // Provisioning succeeded even though bridge failed.
    expect(existsSync(wt!)).toBe(true)

    expect(sink.calls).toHaveLength(1)
    const ev = sink.calls[0]!
    expect(ev.data['linked']).toBe(false)
    expect(ev.data['reason']).toBe('tooling-unresolved')
    expect(ev.data['missing']).toEqual(['vitest'])
    expect(ev.data['error']).toBe('simulated failure')
    expect(ev.data['fallbackAttempted']).toBe(true)
    expect(ev.data['fallbackOk']).toBe(false)
  })

  it('(W4) re-ensure on existing pin INSIDE baseDir + verify ok → bridge NOT re-invoked', () => {
    insertTeam(testDb.db, TEAM_A, 'team-alpha')

    const bridge = vi.fn(
      (src: string, dest: string): BridgeResult => ({
        linked: true,
        reason: 'symlinked',
        srcPath: join(src, 'node_modules'),
        destPath: join(dest, 'node_modules'),
      }),
    )
    const verify = vi.fn(
      (wtPath: string): VerifyToolingResult => ({
        ok: true,
        missing: [],
        binDir: join(wtPath, 'node_modules', '.bin'),
        binDirRealpath: join(wtPath, 'node_modules', '.bin'),
      }),
    )

    const mgr = createTeamWorktreeManager({
      db: testDb.db,
      projectRoot,
      baseDir,
      bridge,
      verify,
    })

    mgr.ensureWorktreeForTeam(TEAM_A) // creates + bridges once
    expect(bridge).toHaveBeenCalledTimes(1)
    expect(verify).toHaveBeenCalledTimes(0)

    mgr.ensureWorktreeForTeam(TEAM_A) // re-ensure → verify ok → no re-bridge
    expect(verify).toHaveBeenCalledTimes(1)
    expect(bridge).toHaveBeenCalledTimes(1)
  })

  it('(W5) re-ensure on existing pin INSIDE baseDir + verify missing → bridge re-invoked with trigger:re-bridge', () => {
    insertTeam(testDb.db, TEAM_A, 'team-alpha')
    const sink = makeEventSink()

    const bridge = vi.fn(
      (src: string, dest: string): BridgeResult => ({
        linked: true,
        reason: 'symlinked',
        srcPath: join(src, 'node_modules'),
        destPath: join(dest, 'node_modules'),
      }),
    )
    let verifyCalls = 0
    const verify = vi.fn(
      (wtPath: string): VerifyToolingResult => {
        verifyCalls++
        return {
          ok: false,
          missing: ['vitest'],
          binDir: join(wtPath, 'node_modules', '.bin'),
          binDirRealpath: null,
        }
      },
    )

    const mgr = createTeamWorktreeManager({
      db: testDb.db,
      projectRoot,
      baseDir,
      bridge,
      verify,
      eventLog: sink,
    })

    mgr.ensureWorktreeForTeam(TEAM_A) // create + bridge (fresh-create)
    expect(bridge).toHaveBeenCalledTimes(1)
    expect(sink.calls).toHaveLength(1)
    expect(sink.calls[0]!.data['trigger']).toBe('fresh-create')

    mgr.ensureWorktreeForTeam(TEAM_A) // re-ensure → verify missing → re-bridge
    expect(verifyCalls).toBe(1)
    expect(bridge).toHaveBeenCalledTimes(2)
    expect(sink.calls).toHaveLength(2)
    expect(sink.calls[1]!.data['trigger']).toBe('re-bridge')
  })

  it('(W6) external pin (OUTSIDE baseDir) → bridge NEVER invoked', () => {
    insertTeam(testDb.db, TEAM_A, 'team-alpha')
    const otherDir = realpathSync(mkdtempSync(join(tmpdir(), 'scns-external-pin-')))
    try {
      testDb.db
        .prepare('UPDATE teams SET working_dir = ? WHERE id = ?')
        .run(otherDir, TEAM_A)

      const bridge = vi.fn()
      const verify = vi.fn()

      const mgr = createTeamWorktreeManager({
        db: testDb.db,
        projectRoot,
        baseDir,
        bridge,
        verify,
      })

      const wt = mgr.ensureWorktreeForTeam(TEAM_A)
      expect(wt).toBe(otherDir)
      // External pin is sovereign — no bridge, no verify.
      expect(bridge).not.toHaveBeenCalled()
      expect(verify).not.toHaveBeenCalled()
    } finally {
      rmSync(otherDir, { recursive: true, force: true })
    }
  })

  it('(W7) bridge throw is caught — provisioning succeeds and emits tooling-unresolved event', () => {
    insertTeam(testDb.db, TEAM_A, 'team-alpha')
    const sink = makeEventSink()

    const bridge = vi.fn(() => {
      throw new Error('boom (test)')
    })

    const mgr = createTeamWorktreeManager({
      db: testDb.db,
      projectRoot,
      baseDir,
      bridge,
      eventLog: sink,
    })

    const wt = mgr.ensureWorktreeForTeam(TEAM_A)
    expect(wt).toBe(join(baseDir, TEAM_A, 'wt'))
    expect(existsSync(wt!)).toBe(true)
    expect(sink.calls).toHaveLength(1)
    expect(sink.calls[0]!.data['linked']).toBe(false)
    expect(sink.calls[0]!.data['reason']).toBe('tooling-unresolved')
    expect(String(sink.calls[0]!.data['error'])).toMatch(/boom/)
  })

  it('(W7b) eventLog throw is caught — provisioning still succeeds', () => {
    insertTeam(testDb.db, TEAM_A, 'team-alpha')

    const bridge = vi.fn(
      (src: string, dest: string): BridgeResult => ({
        linked: true,
        reason: 'symlinked',
        srcPath: join(src, 'node_modules'),
        destPath: join(dest, 'node_modules'),
      }),
    )
    const sink: TeamWorktreeManagerEventSink = {
      worktreeProvisioning() {
        throw new Error('event sink down (test)')
      },
    }

    const mgr = createTeamWorktreeManager({
      db: testDb.db,
      projectRoot,
      baseDir,
      bridge,
      eventLog: sink,
    })

    expect(() => mgr.ensureWorktreeForTeam(TEAM_A)).not.toThrow()
  })
})
