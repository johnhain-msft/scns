/**
 * Layer-2 fix — end-to-end integration: team-worktree-manager
 * provisions a real worktree, calls the real bridge, and the
 * resulting worktree can spawn `vitest` from the bridged
 * `node_modules/.bin/`.
 *
 * This test exercises the actual production code path (no mocks for
 * git, fs.symlinkSync, or the bridge) so that we catch:
 *   - real `git worktree add --detach` shape regressions,
 *   - real symlink behaviour quirks on macOS/Linux,
 *   - real `verifyBridgedTooling` resolution of fake binaries via
 *     the symlinked `node_modules/.bin/` path.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  realpathSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import type { TestDb } from '../../helpers/db-harness.js'
import { createBrokerTestDb } from '../../helpers/broker-db-harness.js'
import { createTeamWorktreeManager } from '../../../src/broker/services/team-worktree-manager.js'
import { findTeamWorkingDir } from '../../../src/broker/storage/repositories/team-repository.js'

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

/**
 * Write a fake `node_modules/.bin/<name>` that BOTH platforms can execute.
 *
 * A `#!/bin/sh` script is unrunnable on Windows: `CreateProcess` cannot
 * execute an extensionless file, and a `.cmd` sibling would hit the EINVAL /
 * PATH-reresolution problems documented in test/helpers/node-bin.ts. A Node
 * script invoked through `process.execPath` behaves identically on every
 * platform and still proves what this test is for — that the bridged file's
 * CONTENT survived the symlink/copy, so the bin dir is not a stub and the
 * symlink does not point at the wrong realpath. The shebang keeps it
 * directly executable on POSIX.
 */
function writeFakeBin(binDir: string, name: string): void {
  const marker = `${name}-OK marker`
  writeFileSync(
    join(binDir, name),
    `#!/usr/bin/env node\nconsole.log([${JSON.stringify(marker)}, ...process.argv.slice(2)].join(' '))\n`,
    { mode: 0o755 },
  )
}

/** Run a bridged fake bin under the current interpreter. */
function runFakeBin(binPath: string, args: readonly string[] = []): string {
  return execFileSync(process.execPath, [binPath, ...args], { encoding: 'utf8' })
}

/**
 * Build a project root with a fake `node_modules/.bin/vitest` AND
 * `node_modules/.bin/eslint` script (the two bins the bridge's
 * `REQUIRED_BINS` list demands). Each echoes a marker we can grep for.
 */
function makeProjectRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scns-bridge-int-proj-'))
  const repo = realpathSync(dir)
  git(repo, ['init', '-q', '-b', 'main'])
  writeFileSync(join(repo, 'README.md'), 'integration\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'seed'])

  const binDir = join(repo, 'node_modules', '.bin')
  mkdirSync(binDir, { recursive: true })
  writeFakeBin(binDir, 'vitest')
  writeFakeBin(binDir, 'eslint')
  return repo
}

const TEAM = '44444444-4444-4444-8444-444444444444'

describe('integration — team-worktree-manager + real bridge end-to-end', () => {
  let testDb: TestDb
  let projectRoot: string
  let baseDir: string

  beforeEach(() => {
    testDb = createBrokerTestDb()
    projectRoot = makeProjectRoot()
    baseDir = realpathSync(mkdtempSync(join(tmpdir(), 'scns-bridge-int-base-')))
    testDb.db.prepare('INSERT INTO teams (id, name) VALUES (?, ?)').run(TEAM, 'integ')
  })

  afterEach(() => {
    testDb.close()
    try {
      git(projectRoot, ['worktree', 'prune'])
    } catch {
      /* repo may already be torn down */
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

  it('provisioned worktree has working vitest + eslint under node_modules/.bin/', () => {
    const mgr = createTeamWorktreeManager({
      db: testDb.db,
      projectRoot,
      baseDir,
    })

    const wt = mgr.ensureWorktreeForTeam(TEAM)
    expect(wt).toBe(join(baseDir, TEAM, 'wt'))
    expect(existsSync(wt!)).toBe(true)
    expect(findTeamWorkingDir(testDb.db, TEAM)).toBe(wt)

    // Bridge created node_modules in the worktree…
    expect(existsSync(join(wt!, 'node_modules'))).toBe(true)
    // …with both required binaries resolvable through the bin dir.
    const vitestPath = join(wt!, 'node_modules', '.bin', 'vitest')
    const eslintPath = join(wt!, 'node_modules', '.bin', 'eslint')
    expect(existsSync(vitestPath)).toBe(true)
    expect(existsSync(eslintPath)).toBe(true)

    // And the binaries are actually runnable through the bridged path —
    // this catches a class of bug where the symlink points at the wrong
    // realpath or the bin dir is a stub.
    const vitestOut = runFakeBin(vitestPath, ['--', 'arg1'])
    expect(vitestOut).toMatch(/vitest-OK marker --? arg1/)
    const eslintOut = runFakeBin(eslintPath)
    expect(eslintOut).toMatch(/eslint-OK marker/)
  })

  it('idempotent re-ensure does not re-create the worktree but keeps tooling healthy', () => {
    const mgr = createTeamWorktreeManager({
      db: testDb.db,
      projectRoot,
      baseDir,
    })

    const wt1 = mgr.ensureWorktreeForTeam(TEAM)!
    const wt2 = mgr.ensureWorktreeForTeam(TEAM)
    expect(wt2).toBe(wt1)

    // Still runnable after the second ensure (the cheap-skip path took it).
    const vitestOut = runFakeBin(join(wt1, 'node_modules', '.bin', 'vitest'))
    expect(vitestOut).toMatch(/vitest-OK marker/)
  })

  it('removeWorktreeForTeam cleans up the worktree dir without harming the main repo', () => {
    const mgr = createTeamWorktreeManager({
      db: testDb.db,
      projectRoot,
      baseDir,
    })
    const wt = mgr.ensureWorktreeForTeam(TEAM)!
    expect(existsSync(wt)).toBe(true)

    mgr.removeWorktreeForTeam(TEAM)
    expect(existsSync(wt)).toBe(false)
    // baseDir preserved, main repo's node_modules untouched.
    expect(existsSync(baseDir)).toBe(true)
    expect(existsSync(join(projectRoot, 'node_modules', '.bin', 'vitest'))).toBe(true)
  })
})
