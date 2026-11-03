/**
 * Gap 1 — close the delivery loop.
 *
 * Autonomous agents write code in their per-team worktree but often
 * leave it UNSTAGED/untracked. team-lifecycle previously collected the
 * completion diff with `git diff --cached` (staged-only), so that work
 * was invisible to the quality gate and nothing ever merged.
 *
 * This file pins the contract that, BEFORE collecting the diff,
 * emitCompletion auto-stages the agent's work — but ONLY when the cwd
 * resolves to a worktree inside the manager's managed base directory.
 * It must NEVER `git add -A` in the live main repo.
 *
 * Real git against isolated temp repos/worktrees — the behavior only
 * surfaces with real `git add -A` / `git diff --cached` / worktrees.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import type { TestDb } from '../../../helpers/db-harness.js'
import { createBrokerTestDb } from '../../../helpers/broker-db-harness.js'
import { createEventLog } from '../../../../src/broker/services/event-log.js'
import {
  createTeamLifecycleController,
  defaultStageWorktree,
  type AgentExitInfo,
} from '../../../../src/broker/services/team-lifecycle.js'
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

function makeRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const repo = realpathSync(dir)
  git(repo, ['init', '-q', '-b', 'main'])
  writeFileSync(join(repo, 'README.md'), 'seed\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'seed'])
  return repo
}

/** Create a detached worktree of `projectRoot` under `<baseDir>/<teamId>/wt`. */
function makeWorktree(projectRoot: string, baseDir: string, teamId: string): string {
  const wt = join(baseDir, teamId, 'wt')
  mkdirSync(join(baseDir, teamId), { recursive: true })
  git(projectRoot, ['worktree', 'add', '--detach', wt, 'HEAD'])
  return wt
}

function insertTeam(db: TestDb['db'], id: string, name: string): void {
  db.prepare('INSERT INTO teams (id, name, working_dir) VALUES (?, ?, ?)').run(id, name, null)
}

function insertMember(db: TestDb['db'], teamId: string, sessionId: string, role: string): void {
  db.prepare('INSERT INTO sessions (id, purpose, working_dir) VALUES (?, ?, ?)').run(
    sessionId,
    'agent',
    null,
  )
  db.prepare('INSERT INTO team_members (team_id, session_id, name, role) VALUES (?, ?, ?, ?)').run(
    teamId,
    sessionId,
    `${role}-1`,
    role,
  )
}

function removeMemberRow(db: TestDb['db'], sessionId: string): void {
  db.prepare('DELETE FROM team_members WHERE session_id = ?').run(sessionId)
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

const TEAM = 'team-sugg-0e404fde'

function exitInfo(sessionId: string, teamId: string, wd: string, role = 'scns-dev'): AgentExitInfo {
  return {
    sessionId,
    teamId,
    role,
    name: `${role}-1`,
    workingDir: wd,
    logPath: null,
    launchMethod: 'acp',
    reason: 'normal',
  }
}

function lastCompletion(
  eventLog: ReturnType<typeof createEventLog>,
): { stagedDiff: string } | null {
  const evts = eventLog.since(0).filter((e) => e.event_type === 'team_completed')
  if (evts.length === 0) return null
  return JSON.parse(evts[evts.length - 1]!.payload as string) as { stagedDiff: string }
}

describe('team-lifecycle Gap 1 auto-stage', () => {
  let testDb: TestDb
  let projectRoot: string
  let baseDir: string

  beforeEach(() => {
    testDb = createBrokerTestDb()
    projectRoot = makeRepo('scns-tl-proj-')
    baseDir = realpathSync(mkdtempSync(join(tmpdir(), 'scns-tl-base-')))
  })

  afterEach(() => {
    testDb.close()
    try {
      git(projectRoot, ['worktree', 'prune'])
    } catch {
      /* noop */
    }
    for (const d of [baseDir, projectRoot]) {
      try {
        rmSync(d, { recursive: true, force: true })
      } catch {
        /* noop */
      }
    }
  })

  it('auto-stages untracked + unstaged work in a managed worktree before collecting', () => {
    insertTeam(testDb.db, TEAM, 'brain-team')
    const wt = makeWorktree(projectRoot, baseDir, TEAM)

    // Agent wrote a NEW (untracked) file and modified a tracked one,
    // but staged NEITHER.
    writeFileSync(join(wt, 'feature.ts'), 'export const x = 1\n')
    writeFileSync(join(wt, 'README.md'), 'seed\nmodified by agent\n')

    insertMember(testDb.db, TEAM, 's-dev', 'scns-dev')
    const eventLog = createEventLog(testDb.db)
    const controller = createTeamLifecycleController({
      db: testDb.db,
      eventLog,
      spawner: makeFakeSpawner(),
      options: { managedWorktreeBaseDir: baseDir, readLogTail: () => '' },
    })

    removeMemberRow(testDb.db, 's-dev')
    controller.handleAgentExit(exitInfo('s-dev', TEAM, wt))

    const completion = lastCompletion(eventLog)
    expect(completion).not.toBeNull()
    expect(completion!.stagedDiff).toContain('feature.ts')
    expect(completion!.stagedDiff).toContain('modified by agent')
  })

  it('SAFETY: never auto-stages when cwd is OUTSIDE the managed base (live main repo)', () => {
    // A repo that is NOT under baseDir (simulates the main checkout).
    const mainLike = makeRepo('scns-tl-main-')
    try {
      writeFileSync(join(mainLike, 'unstaged.ts'), 'export const y = 2\n')

      insertTeam(testDb.db, TEAM, 'brain-team')
      insertMember(testDb.db, TEAM, 's-dev', 'scns-dev')
      const eventLog = createEventLog(testDb.db)
      const controller = createTeamLifecycleController({
        db: testDb.db,
        eventLog,
        spawner: makeFakeSpawner(),
        options: { managedWorktreeBaseDir: baseDir, readLogTail: () => '' },
      })

      removeMemberRow(testDb.db, 's-dev')
      controller.handleAgentExit(exitInfo('s-dev', TEAM, mainLike))

      // Diff is empty (nothing was staged) ...
      const completion = lastCompletion(eventLog)
      expect(completion!.stagedDiff.trim()).toBe('')
      // ... and CRUCIALLY the index was never touched: the file is still
      // untracked, not staged.
      const status = git(mainLike, ['status', '--porcelain']).trim()
      expect(status).toContain('?? unstaged.ts')
      expect(status).not.toContain('A  unstaged.ts')
    } finally {
      rmSync(mainLike, { recursive: true, force: true })
    }
  })

  it('stages from the git toplevel even when the agent exited from a subdirectory', () => {
    insertTeam(testDb.db, TEAM, 'brain-team')
    const wt = makeWorktree(projectRoot, baseDir, TEAM)
    const sub = join(wt, 'src', 'deep')
    mkdirSync(sub, { recursive: true })
    // Change at the worktree ROOT, while the agent's cwd is a subdir.
    writeFileSync(join(wt, 'root-change.ts'), 'export const z = 3\n')
    writeFileSync(join(sub, 'deep-change.ts'), 'export const d = 4\n')

    insertMember(testDb.db, TEAM, 's-dev', 'scns-dev')
    const eventLog = createEventLog(testDb.db)
    const controller = createTeamLifecycleController({
      db: testDb.db,
      eventLog,
      spawner: makeFakeSpawner(),
      options: { managedWorktreeBaseDir: baseDir, readLogTail: () => '' },
    })

    removeMemberRow(testDb.db, 's-dev')
    controller.handleAgentExit(exitInfo('s-dev', TEAM, sub))

    const completion = lastCompletion(eventLog)
    expect(completion!.stagedDiff).toContain('root-change.ts')
    expect(completion!.stagedDiff).toContain('deep-change.ts')
  })

  it('excludes QA-NOTES.md and node_modules from the auto-staged diff', () => {
    insertTeam(testDb.db, TEAM, 'brain-team')
    const wt = makeWorktree(projectRoot, baseDir, TEAM)
    writeFileSync(join(wt, 'feature.ts'), 'export const x = 1\n')
    writeFileSync(join(wt, 'QA-NOTES.md'), 'qa scratch notes\n')
    mkdirSync(join(wt, 'node_modules'), { recursive: true })
    writeFileSync(join(wt, 'node_modules', 'junk.js'), 'module.exports = {}\n')

    insertMember(testDb.db, TEAM, 's-dev', 'scns-dev')
    const eventLog = createEventLog(testDb.db)
    const controller = createTeamLifecycleController({
      db: testDb.db,
      eventLog,
      spawner: makeFakeSpawner(),
      options: { managedWorktreeBaseDir: baseDir, readLogTail: () => '' },
    })

    removeMemberRow(testDb.db, 's-dev')
    controller.handleAgentExit(exitInfo('s-dev', TEAM, wt))

    const completion = lastCompletion(eventLog)
    expect(completion!.stagedDiff).toContain('feature.ts')
    expect(completion!.stagedDiff).not.toContain('QA-NOTES.md')
    expect(completion!.stagedDiff).not.toContain('node_modules')
  })

  it('does NOT emit completion until the last member has exited', () => {
    insertTeam(testDb.db, TEAM, 'brain-team')
    const wt = makeWorktree(projectRoot, baseDir, TEAM)
    writeFileSync(join(wt, 'feature.ts'), 'export const x = 1\n')

    insertMember(testDb.db, TEAM, 's-dev', 'scns-dev')
    insertMember(testDb.db, TEAM, 's-qa', 'scns-qa')
    const eventLog = createEventLog(testDb.db)
    const controller = createTeamLifecycleController({
      db: testDb.db,
      eventLog,
      spawner: makeFakeSpawner(),
      options: { managedWorktreeBaseDir: baseDir, readLogTail: () => '' },
    })

    // Dev exits first; QA still a member → no completion yet.
    removeMemberRow(testDb.db, 's-dev')
    controller.handleAgentExit(exitInfo('s-dev', TEAM, wt))
    expect(lastCompletion(eventLog)).toBeNull()

    // QA exits → completion emitted with the staged work.
    removeMemberRow(testDb.db, 's-qa')
    controller.handleAgentExit(exitInfo('s-qa', TEAM, wt, 'scns-qa'))
    const completion = lastCompletion(eventLog)
    expect(completion).not.toBeNull()
    expect(completion!.stagedDiff).toContain('feature.ts')
  })

  describe('defaultStageWorktree', () => {
    it('stages and returns the toplevel for a worktree inside the base', () => {
      const wt = makeWorktree(projectRoot, baseDir, TEAM)
      writeFileSync(join(wt, 'a.ts'), 'export const a = 1\n')
      const top = defaultStageWorktree(wt, baseDir)
      // realpathSync.native: the product canonicalizes its return value the
      // same way (on win32 this expands 8.3 short temp-dir names).
      expect(top).toBe(realpathSync.native(wt))
      expect(git(wt, ['diff', '--cached', '--name-only']).trim()).toContain('a.ts')
    })

    it('returns null and does not stage for a repo outside the base', () => {
      const outside = makeRepo('scns-tl-out-')
      try {
        writeFileSync(join(outside, 'b.ts'), 'export const b = 1\n')
        expect(defaultStageWorktree(outside, baseDir)).toBeNull()
        expect(git(outside, ['status', '--porcelain']).trim()).toContain('?? b.ts')
      } finally {
        rmSync(outside, { recursive: true, force: true })
      }
    })

    it('returns null when cwd is not a git repo at all', () => {
      const plain = realpathSync(mkdtempSync(join(tmpdir(), 'scns-tl-plain-')))
      try {
        expect(defaultStageWorktree(plain, baseDir)).toBeNull()
      } finally {
        rmSync(plain, { recursive: true, force: true })
      }
    })
  })
})
