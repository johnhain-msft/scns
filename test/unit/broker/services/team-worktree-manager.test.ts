/**
 * Task 43 — Per-team git worktree sandbox.
 *
 * SCNS dev agents historically launched with cwd = broker cwd = main
 * repo root. That meant every dev's `git diff --cached` (collected by
 * team-lifecycle on exit) raced against the broker's own working tree
 * and every other team's dev. Overnight self-improve runs would leave
 * the main repo dirty after each pass.
 *
 * This file pins the contract that:
 *   (a) the team-worktree-manager creates a worktree under
 *       `<baseDir>/<teamId>/wt` on `ensureWorktreeForTeam` and writes
 *       the path back to `teams.working_dir`,
 *   (b) `removeWorktreeForTeam` removes that worktree when the team is
 *       archived, and refuses to remove paths it does not own,
 *   (c) end-to-end: a dev that exits while pinned to the worktree
 *       causes team-lifecycle.collectStagedDiff to run against the
 *       worktree path, NOT the broker cwd.
 *
 * Real git is used against an isolated temp repo per test. No mocks
 * for the git CLI itself, because the bug ONLY surfaces when real
 * `git worktree add` and real `git diff --cached` are involved.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  existsSync,
  realpathSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import type { TestDb } from '../../../helpers/db-harness.js'
import { createBrokerTestDb } from '../../../helpers/broker-db-harness.js'
import { createEventLog } from '../../../../src/broker/services/event-log.js'
import {
  createTeamWorktreeManager,
  isValidTeamId,
} from '../../../../src/broker/services/team-worktree-manager.js'
import {
  createTeamLifecycleController,
  type AgentExitInfo,
} from '../../../../src/broker/services/team-lifecycle.js'
import { findTeamWorkingDir } from '../../../../src/broker/storage/repositories/team-repository.js'
import type {
  AgentSpawner,
  SpawnInput,
  SpawnResult,
  SpawnedAgentInfo,
} from '../../../../src/broker/services/agent-spawner.js'

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
  const dir = mkdtempSync(join(tmpdir(), 'scns-wt-proj-'))
  // Use realpathSync to follow macOS /var → /private/var symlinks so
  // path comparisons stay consistent across worktree + main repo.
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

function insertSession(db: TestDb['db'], id: string, cwd: string): void {
  db.prepare('INSERT INTO sessions (id, purpose, working_dir) VALUES (?, ?, ?)').run(
    id,
    'agent',
    cwd,
  )
}

function makeFakeSpawner(): AgentSpawner {
  return {
    async spawn(input: SpawnInput): Promise<SpawnResult> {
      return {
        sessionId: `sess-${Date.now()}`,
        teamId: input.team_id,
        name: input.name,
        role: input.role ?? 'dev',
        platform: 'linux',
        launchMethod: 'detached',
        pid: 1,
        tmuxSession: null,
        tmuxWindow: null,
        acpSessionId: null,
      }
    },
    async sendMessage() {
      return { accepted: true }
    },
    getActiveAgents(): ReadonlyMap<string, SpawnedAgentInfo> {
      return new Map()
    },
    async cleanup() {
      /* noop */
    },
    async shutdownAll() {
      /* noop */
    },
  } as AgentSpawner
}

// Stable UUIDs used in every test. The manager also accepts safe
// lowercase `team-…` ids (brain-generated); non-UUID, non-safe ids are
// rejected to keep filesystem paths well-formed (see isValidTeamId).
const TEAM_A = '11111111-1111-4111-8111-111111111111'
const TEAM_B = '22222222-2222-4222-8222-222222222222'

describe('isValidTeamId (worktree eligibility)', () => {
  it('accepts UUID-v4 ids', () => {
    expect(isValidTeamId(TEAM_A)).toBe(true)
    expect(isValidTeamId(TEAM_B)).toBe(true)
  })

  it('accepts safe brain-generated team ids', () => {
    expect(isValidTeamId('team-sugg-0e404fde')).toBe(true)
    expect(isValidTeamId('team-123')).toBe(true)
    expect(isValidTeamId('team-sugg-0e404fde-2')).toBe(true)
    expect(isValidTeamId('team-a')).toBe(true)
  })

  it('accepts the brain-solo singleton + brain- family (Gap 2 — brain solo spawns)', () => {
    // src/brain/spawn-adapter.ts DEFAULT_SOLO_TEAM = 'brain-solo'. Brain solo
    // spawns (agent-loop HandleSolo/SpawnSolo → onSpawnAgent without a teamId)
    // MUST be worktree-eligible or they run in BROKER_PROJECT_ROOT (the live
    // checkout) and silently bypass Gap 2 isolation.
    expect(isValidTeamId('brain-solo')).toBe(true)
    expect(isValidTeamId('brain-implementer-f03a16ac')).toBe(true)
  })

  it('keeps brain- ids path-safe (no traversal / empty suffix / uppercase)', () => {
    expect(isValidTeamId('brain-')).toBe(false)
    expect(isValidTeamId('brain-../evil')).toBe(false)
    expect(isValidTeamId('brain-a/b')).toBe(false)
    expect(isValidTeamId('BRAIN-solo')).toBe(false)
    expect(isValidTeamId('brain-SOLO')).toBe(false)
  })

  it('rejects path-traversal / separator / whitespace shapes', () => {
    expect(isValidTeamId('team-../evil')).toBe(false)
    expect(isValidTeamId('team-a/b')).toBe(false)
    expect(isValidTeamId('../escape')).toBe(false)
    expect(isValidTeamId('team-a b')).toBe(false)
    expect(isValidTeamId('team-a\t')).toBe(false)
  })

  it('rejects uppercase generated ids (case-insensitive-FS collision guard)', () => {
    expect(isValidTeamId('team-SUGG-x')).toBe(false)
    expect(isValidTeamId('TEAM-abc')).toBe(false)
  })

  it('rejects empty suffix, empty string, and over-long ids', () => {
    expect(isValidTeamId('team-')).toBe(false)
    expect(isValidTeamId('')).toBe(false)
    expect(isValidTeamId('team-' + 'a'.repeat(124))).toBe(false) // 129 chars
    expect(isValidTeamId('team-' + 'a'.repeat(123))).toBe(true) // 128 chars
  })

  it('rejects non-string input', () => {
    expect(isValidTeamId(undefined as unknown as string)).toBe(false)
    expect(isValidTeamId(null as unknown as string)).toBe(false)
  })
})

describe('team-worktree-manager', () => {
  let testDb: TestDb
  let projectRoot: string
  let baseDir: string

  beforeEach(() => {
    testDb = createBrokerTestDb()
    projectRoot = makeRepo()
    baseDir = mkdtempSync(join(tmpdir(), 'scns-wt-base-'))
    baseDir = realpathSync(baseDir)
  })

  afterEach(() => {
    testDb.close()
    // Prune any leftover worktrees registered in projectRoot before
    // ripping the dirs out from under git.
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

  describe('ensureWorktreeForTeam', () => {
    it('(a) creates a worktree at <baseDir>/<teamId>/wt and writes teams.working_dir', () => {
      insertTeam(testDb.db, TEAM_A, 'team-alpha')

      const mgr = createTeamWorktreeManager({
        db: testDb.db,
        projectRoot,
        baseDir,
      })

      const wt = mgr.ensureWorktreeForTeam(TEAM_A)
      const expected = join(baseDir, TEAM_A, 'wt')
      expect(wt).toBe(expected)
      expect(existsSync(expected)).toBe(true)

      // It must be a real worktree of projectRoot, not just an empty dir.
      const insideWt = git(expected, ['rev-parse', '--is-inside-work-tree']).trim()
      expect(insideWt).toBe('true')

      // teams.working_dir now points at the worktree.
      const dbPath = findTeamWorkingDir(testDb.db, TEAM_A)
      expect(dbPath).toBe(expected)
    })

    it('is idempotent — second call returns the same path and does not re-run `git worktree add`', () => {
      insertTeam(testDb.db, TEAM_A, 'team-alpha')

      let gitWorktreeAddCalls = 0
      const mgr = createTeamWorktreeManager({
        db: testDb.db,
        projectRoot,
        baseDir,
        runGit: (args, cwd) => {
          if (args[0] === 'worktree' && args[1] === 'add') gitWorktreeAddCalls += 1
          return execFileSync('git', args as string[], { cwd, encoding: 'utf8' })
        },
      })

      const first = mgr.ensureWorktreeForTeam(TEAM_A)
      const second = mgr.ensureWorktreeForTeam(TEAM_A)
      expect(first).toBe(second)
      expect(gitWorktreeAddCalls).toBe(1)
    })

    it('does not clobber an existing teams.working_dir pin (task 34 neuron mode preserved)', () => {
      insertTeam(testDb.db, TEAM_A, 'team-alpha')
      testDb.db
        .prepare("UPDATE teams SET working_dir = ? WHERE id = ?")
        .run('/manually/pinned/path', TEAM_A)

      const mgr = createTeamWorktreeManager({
        db: testDb.db,
        projectRoot,
        baseDir,
      })

      const wt = mgr.ensureWorktreeForTeam(TEAM_A)
      expect(wt).toBe('/manually/pinned/path')
      // Manager did not touch the filesystem.
      expect(existsSync(join(baseDir, TEAM_A))).toBe(false)
      // DB pin preserved.
      expect(findTeamWorkingDir(testDb.db, TEAM_A)).toBe('/manually/pinned/path')
    })

    it('returns null for unknown / archived team and does not touch the filesystem', () => {
      const mgr = createTeamWorktreeManager({
        db: testDb.db,
        projectRoot,
        baseDir,
      })

      expect(mgr.ensureWorktreeForTeam(TEAM_A)).toBeNull()
      expect(existsSync(join(baseDir, TEAM_A))).toBe(false)

      // Archived team is also a no-op.
      insertTeam(testDb.db, TEAM_B, 'team-bravo')
      testDb.db
        .prepare("UPDATE teams SET archived_at = datetime('now') WHERE id = ?")
        .run(TEAM_B)
      expect(mgr.ensureWorktreeForTeam(TEAM_B)).toBeNull()
      expect(existsSync(join(baseDir, TEAM_B))).toBe(false)
    })

    it('rejects a teamId that is not a UUID (path-safety / defense in depth)', () => {
      const mgr = createTeamWorktreeManager({
        db: testDb.db,
        projectRoot,
        baseDir,
      })

      // Even after inserting a row with a path-traversal-shaped id, the
      // manager refuses to construct a worktree path from it.
      insertTeam(testDb.db, '../escape', 'evil')
      expect(mgr.ensureWorktreeForTeam('../escape')).toBeNull()
      // No directory was created at `<baseDir>/../escape`.
      expect(existsSync(join(baseDir, '..', 'escape'))).toBe(false)
    })

    it('accepts a safe brain-generated team id (team-sugg-<hex>) and provisions an isolated worktree', () => {
      // Gap 2 — brain solo spawns use non-UUID team ids
      // (`team-sugg-${suggestionId.slice(0,8)}` in cli.ts, `team-${task.id}`
      // in agent-loop.ts). These MUST be worktree-eligible so autonomous
      // agents never edit the live main checkout.
      const brainTeamId = 'team-sugg-0e404fde'
      insertTeam(testDb.db, brainTeamId, 'brain-suggestion-team')

      const mgr = createTeamWorktreeManager({
        db: testDb.db,
        projectRoot,
        baseDir,
      })

      const wt = mgr.ensureWorktreeForTeam(brainTeamId)
      const expected = join(baseDir, brainTeamId, 'wt')
      expect(wt).toBe(expected)
      expect(existsSync(expected)).toBe(true)
      expect(git(expected, ['rev-parse', '--is-inside-work-tree']).trim()).toBe('true')
      expect(findTeamWorkingDir(testDb.db, brainTeamId)).toBe(expected)

      // The whole point: the main repo stays clean.
      expect(git(projectRoot, ['status', '--short']).trim()).toBe('')
    })

    it('accepts a numeric brain task team id (team-<taskId>)', () => {
      const taskTeamId = 'team-123'
      insertTeam(testDb.db, taskTeamId, 'brain-task-team')

      const mgr = createTeamWorktreeManager({
        db: testDb.db,
        projectRoot,
        baseDir,
      })

      const wt = mgr.ensureWorktreeForTeam(taskTeamId)
      expect(wt).toBe(join(baseDir, taskTeamId, 'wt'))
      expect(existsSync(wt!)).toBe(true)
    })

    it('accepts the brain-solo solo-team id and provisions an isolated worktree (Gap 2)', () => {
      // Regression: brain solo spawns (spawn-adapter DEFAULT_SOLO_TEAM =
      // 'brain-solo') used to fail isValidTeamId, so ensureWorktreeForTeam
      // returned null and the agent-spawner fell back to BROKER_PROJECT_ROOT —
      // editing the LIVE repo. Live evidence (isolated run): agent_launch_started
      // events team_id=brain-solo, working_dir=<projectRoot>. The brain-solo
      // singleton MUST get an isolated worktree like every other brain team.
      const soloTeamId = 'brain-solo'
      insertTeam(testDb.db, soloTeamId, 'brain-solo')

      const mgr = createTeamWorktreeManager({
        db: testDb.db,
        projectRoot,
        baseDir,
      })

      const wt = mgr.ensureWorktreeForTeam(soloTeamId)
      const expected = join(baseDir, soloTeamId, 'wt')
      expect(wt).toBe(expected)
      expect(existsSync(expected)).toBe(true)
      expect(git(expected, ['rev-parse', '--is-inside-work-tree']).trim()).toBe('true')
      expect(findTeamWorkingDir(testDb.db, soloTeamId)).toBe(expected)

      // The whole point: the main repo stays clean.
      expect(git(projectRoot, ['status', '--short']).trim()).toBe('')
    })

    it('respects enabled=false — skips all worktree work and leaves teams.working_dir untouched', () => {
      insertTeam(testDb.db, TEAM_A, 'team-alpha')

      const mgr = createTeamWorktreeManager({
        db: testDb.db,
        projectRoot,
        baseDir,
        enabled: false,
      })

      expect(mgr.ensureWorktreeForTeam(TEAM_A)).toBeNull()
      expect(existsSync(join(baseDir, TEAM_A))).toBe(false)
      expect(findTeamWorkingDir(testDb.db, TEAM_A)).toBeNull()
    })
  })

  describe('removeWorktreeForTeam', () => {
    it('(b) removes the worktree created by ensureWorktreeForTeam on team archival', () => {
      insertTeam(testDb.db, TEAM_A, 'team-alpha')
      const mgr = createTeamWorktreeManager({
        db: testDb.db,
        projectRoot,
        baseDir,
      })

      const wt = mgr.ensureWorktreeForTeam(TEAM_A)!
      expect(existsSync(wt)).toBe(true)

      mgr.removeWorktreeForTeam(TEAM_A)
      expect(existsSync(wt)).toBe(false)
      // The teamId-scoped parent is also gone.
      expect(existsSync(join(baseDir, TEAM_A))).toBe(false)
      // baseDir itself is preserved (it may host other teams).
      expect(existsSync(baseDir)).toBe(true)
    })

    it('is idempotent on repeat / missing worktree', () => {
      insertTeam(testDb.db, TEAM_A, 'team-alpha')
      const mgr = createTeamWorktreeManager({
        db: testDb.db,
        projectRoot,
        baseDir,
      })

      // Never created — must not throw.
      expect(() => mgr.removeWorktreeForTeam(TEAM_A)).not.toThrow()

      mgr.ensureWorktreeForTeam(TEAM_A)
      mgr.removeWorktreeForTeam(TEAM_A)
      expect(() => mgr.removeWorktreeForTeam(TEAM_A)).not.toThrow()
    })

    it('(ownership) refuses to delete a path outside the manager baseDir', () => {
      insertTeam(testDb.db, TEAM_A, 'team-alpha')
      const otherDir = mkdtempSync(join(tmpdir(), 'scns-wt-other-'))
      const otherWt = realpathSync(otherDir)
      try {
        // Simulate a manual / external pin — value is OUTSIDE baseDir.
        testDb.db
          .prepare('UPDATE teams SET working_dir = ? WHERE id = ?')
          .run(otherWt, TEAM_A)

        const mgr = createTeamWorktreeManager({
          db: testDb.db,
          projectRoot,
          baseDir,
        })

        // Must NOT delete an externally-owned directory.
        mgr.removeWorktreeForTeam(TEAM_A)
        expect(existsSync(otherWt)).toBe(true)
      } finally {
        rmSync(otherWt, { recursive: true, force: true })
      }
    })

    it('(ownership) does not delete when a live team_member still references the team', () => {
      insertTeam(testDb.db, TEAM_A, 'team-alpha')
      const mgr = createTeamWorktreeManager({
        db: testDb.db,
        projectRoot,
        baseDir,
      })
      const wt = mgr.ensureWorktreeForTeam(TEAM_A)!

      insertSession(testDb.db, 's-live', wt)
      testDb.db
        .prepare(
          `INSERT INTO team_members (team_id, session_id, name, role) VALUES (?, ?, ?, ?)`,
        )
        .run(TEAM_A, 's-live', 'dev-1', 'dev')

      mgr.removeWorktreeForTeam(TEAM_A)
      // Live member → cleanup is skipped.
      expect(existsSync(wt)).toBe(true)
    })
  })

  describe('integration with team-lifecycle (staged diff collection)', () => {
    it('(c) team-lifecycle collects staged diff from the worktree, not from projectRoot', () => {
      insertTeam(testDb.db, TEAM_A, 'team-alpha')
      const mgr = createTeamWorktreeManager({
        db: testDb.db,
        projectRoot,
        baseDir,
      })
      const wt = mgr.ensureWorktreeForTeam(TEAM_A)!

      // Simulate a "dev" that ran inside the worktree and staged a change.
      const newFile = join(wt, 'work.md')
      writeFileSync(newFile, 'hello from worktree\n')
      git(wt, ['add', '-A'])
      const wtDiff = git(wt, ['diff', '--cached'])
      expect(wtDiff).toContain('work.md')

      // The main repo MUST stay clean — that is the whole point of the
      // sandbox. `git status --short` in projectRoot must be empty even
      // though the worktree has staged work.
      const mainStatus = git(projectRoot, ['status', '--short']).trim()
      expect(mainStatus).toBe('')

      // Now drive team-lifecycle as if the dev exited.
      insertSession(testDb.db, 's-dev', wt)
      testDb.db
        .prepare(
          `INSERT INTO team_members (team_id, session_id, name, role) VALUES (?, ?, ?, ?)`,
        )
        .run(TEAM_A, 's-dev', 'dev-1', 'dev')

      const eventLog = createEventLog(testDb.db)
      let collectFrom: string | null = null
      const controller = createTeamLifecycleController({
        db: testDb.db,
        eventLog,
        spawner: makeFakeSpawner(),
        options: {
          collectStagedDiff: (cwd) => {
            collectFrom = cwd
            // Use the real git call here so we ALSO verify the bytes
            // come from the worktree — not just the cwd argument.
            try {
              return execFileSync('git', ['diff', '--cached'], {
                cwd,
                encoding: 'utf8',
              })
            } catch {
              return ''
            }
          },
          readLogTail: () => '',
        },
      })

      // Spawner removes the team_members row right before firing exit.
      testDb.db.prepare('DELETE FROM team_members WHERE session_id = ?').run('s-dev')

      const exit: AgentExitInfo = {
        sessionId: 's-dev',
        teamId: TEAM_A,
        role: 'dev',
        name: 'dev-1',
        workingDir: wt,
        logPath: null,
        launchMethod: 'detached',
        reason: 'normal',
      }
      controller.handleAgentExit(exit)

      // primaryCwd resolves to the worktree path.
      expect(collectFrom).toBe(wt)

      // team_completed event carries a diff that mentions work.md.
      const completion = eventLog
        .since(0)
        .filter((e) => e.event_type === 'team_completed')[0]!
      const payload = JSON.parse(completion.payload as string) as {
        stagedDiff: string
      }
      expect(payload.stagedDiff).toContain('work.md')

      // And the projectRoot is STILL clean after the lifecycle ran.
      expect(git(projectRoot, ['status', '--short']).trim()).toBe('')
    })
  })

  describe('getBaseDir', () => {
    it('exposes the configured baseDir for diagnostics and tests', () => {
      const mgr = createTeamWorktreeManager({
        db: testDb.db,
        projectRoot,
        baseDir,
      })
      expect(mgr.getBaseDir()).toBe(baseDir)
    })
  })
})
