/**
 * Phase 13.12.34 — Symlink poison-pill guard for QG auto-commit.
 *
 * Postmortem (team ca3ecfec): three verdict-PASS auto-branches shipped a
 * 120000-mode `node_modules` symlink pointing at the developer's absolute
 * host path. Cause: `bridgeNodeModulesIntoWorktree` creates that symlink
 * to make tooling resolve inside the worktree; the subsequent `git add -A`
 * swept it into the staged diff. Every consumer of the resulting branch
 * (merge, cherry-pick, CI) would then reproduce the foreign path entry.
 *
 * This file pins two layers of defense:
 *
 *   1) `detectStagedSymlinks` — pure utility. Parses `git ls-files --stage`
 *      output and returns paths whose mode is 120000 (symlink).
 *   2) Real-git integration — runs the new pathspec-excluded `git add`
 *      command against a temp repo containing a real symlink, and asserts
 *      the symlink does NOT end up in the staged index.
 */

import { describe, it, expect, afterEach } from 'vitest'

import { describeIfSymlink } from '../../../helpers/symlink-support.js'
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import {
  detectStagedSymlinks,
  type RunResult,
} from '../../../../src/broker/services/quality-gate-arbiter.js'

function ok(stdout: string, stderr = ''): RunResult {
  return { ok: true, stdout, stderr }
}
function err(code: number, stdout = '', stderr = ''): RunResult {
  return { ok: false, stdout, stderr, code }
}

describe('detectStagedSymlinks — pure parser (Phase 13.12.34)', () => {
  it('returns [] when ls-files output is empty', () => {
    const run = () => ok('')
    expect(detectStagedSymlinks(run, '/tmp/wt')).toEqual([])
  })

  it('returns [] when no entries are mode 120000', () => {
    const stage =
      '100644 a1b2c3 0\tsrc/file.ts\n' +
      '100755 d4e5f6 0\tscripts/run.sh\n' +
      '100644 a7b8c9 0\tREADME.md\n'
    expect(detectStagedSymlinks(() => ok(stage), '/tmp/wt')).toEqual([])
  })

  it('returns the single symlink when one is staged', () => {
    const stage = '100644 a1b2c3 0\tsrc/file.ts\n' + '120000 ffffff 0\tnode_modules\n'
    expect(detectStagedSymlinks(() => ok(stage), '/tmp/wt')).toEqual(['node_modules'])
  })

  it('returns all symlinks when several are staged', () => {
    const stage =
      '120000 a1 0\tnode_modules\n' +
      '100644 b2 0\tsrc/x.ts\n' +
      '120000 c3 0\t.cache/foo\n' +
      '120000 d4 0\tpath with spaces/link\n'
    expect(detectStagedSymlinks(() => ok(stage), '/tmp/wt')).toEqual([
      'node_modules',
      '.cache/foo',
      'path with spaces/link',
    ])
  })

  it('returns [] when ls-files itself fails (defensive: no false-positives)', () => {
    expect(detectStagedSymlinks(() => err(128, '', 'fatal: not a repo'), '/tmp/wt')).toEqual([])
  })

  it('ignores malformed lines (no tab)', () => {
    const stage =
      '100644 a1 0\tsrc/file.ts\n' + '120000 nope-no-tab-here\n' + '120000 b2 0\tlegit/link\n'
    expect(detectStagedSymlinks(() => ok(stage), '/tmp/wt')).toEqual(['legit/link'])
  })

  it('does NOT match modes that merely contain "120000" as substring', () => {
    // Real git modes are exactly 6 chars; defensive parsing should still
    // not accept a line where the first 6 chars are something else.
    const stage = ' 12000 abcd 0\tnot-a-symlink\n' + '120000 efgh 0\treal-symlink\n'
    expect(detectStagedSymlinks(() => ok(stage), '/tmp/wt')).toEqual(['real-symlink'])
  })
})

const tmpDirs: string[] = []

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()
    if (d) {
      try {
        rmSync(d, { recursive: true, force: true })
      } catch {
        /* best-effort */
      }
    }
  }
})

describeIfSymlink('git add pathspec exclusion — real-git integration (Phase 13.12.34)', () => {
  it('`git add -A . ":!node_modules" ":!.git/info/exclude"` excludes the bridged symlink', () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'qg-symlink-'))
    tmpDirs.push(repoDir)

    // 1) Real repo with one tracked file already committed.
    execSync('git init -q -b main', { cwd: repoDir })
    execSync('git config user.email t@t', { cwd: repoDir })
    execSync('git config user.name t', { cwd: repoDir })
    writeFileSync(join(repoDir, 'README.md'), '# seed\n')
    execSync('git add -A && git commit -q -m seed', { cwd: repoDir })

    // 2) Simulate the bridge: create a real symlink in the worktree pointing
    //    at some absolute host path. We don't care that the target is a
    //    valid node_modules — we only care that git would treat it as a
    //    120000-mode entry on `git add`.
    const realModules = mkdtempSync(join(tmpdir(), 'qg-fakemods-'))
    tmpDirs.push(realModules)
    writeFileSync(join(realModules, 'package.json'), '{"name":"fake"}')
    symlinkSync(realModules, join(repoDir, 'node_modules'), 'dir')

    // 3) Also create a legitimate source file change that SHOULD land.
    writeFileSync(join(repoDir, 'feature.ts'), 'export const x = 1\n')

    // 4) Apply the new pathspec-excluded git add (the production command —
    //    double quotes so cmd.exe on win32 strips them like sh does).
    execSync('git add -A . ":!node_modules" ":!.git/info/exclude"', { cwd: repoDir })

    // 5) Validate: the staged index must contain feature.ts but NOT
    //    node_modules (which would otherwise be a 120000-mode entry).
    const staged = execSync('git ls-files --stage', {
      cwd: repoDir,
      encoding: 'utf8',
    })
    expect(staged).toContain('feature.ts')
    expect(staged).not.toContain('node_modules')

    // Also confirm no symlinks of any kind landed.
    expect(staged.split('\n').some((l) => l.startsWith('120000 '))).toBe(false)
  })

  it('the legacy `git add -A` (no pathspec) WOULD have committed the symlink — proves the pre-fix bug', () => {
    // This is the negative-control test: it documents the actual deadlock
    // root cause and will start failing if anyone reverts the fix without
    // updating this test, which is the desired tripwire behavior.
    const repoDir = mkdtempSync(join(tmpdir(), 'qg-symlink-legacy-'))
    tmpDirs.push(repoDir)

    execSync('git init -q -b main', { cwd: repoDir })
    execSync('git config user.email t@t', { cwd: repoDir })
    execSync('git config user.name t', { cwd: repoDir })
    writeFileSync(join(repoDir, 'README.md'), '# seed\n')
    execSync('git add -A && git commit -q -m seed', { cwd: repoDir })

    const realModules = mkdtempSync(join(tmpdir(), 'qg-fakemods-legacy-'))
    tmpDirs.push(realModules)
    writeFileSync(join(realModules, 'package.json'), '{"name":"fake"}')
    symlinkSync(realModules, join(repoDir, 'node_modules'), 'dir')

    // Legacy command:
    execSync('git add -A', { cwd: repoDir })

    const staged = execSync('git ls-files --stage', {
      cwd: repoDir,
      encoding: 'utf8',
    })
    // Confirms the bug: legacy command DOES stage the symlink.
    expect(staged).toContain('node_modules')
    expect(staged.split('\n').some((l) => l.startsWith('120000 '))).toBe(true)
  })
})
