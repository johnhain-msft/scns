/**
 * Diff-collection filter — postmortem qc=c2d6b26d (2026-05-17).
 *
 * The Phase 13.12.32 / Layer-2 node_modules bridge symlinks
 * `<teamWorktree>/node_modules` to the host's project node_modules so
 * vitest/eslint/tsc resolve under the per-team worktree. The
 * `.gitignore` rule `node_modules/` (trailing slash) only matches a
 * **directory** at that path — NOT a symlink. So when a dev agent
 * runs the broker-instructed `git add -A` inside the team worktree,
 * the bridged symlink (mode 120000) gets swept into the staged index.
 *
 * The team-lifecycle controller then collects the staged diff via
 * `git diff --cached` (defaultCollectStagedDiff) and ships it to the
 * quality-gate arbiter. The arbiter's first step inside its
 * disposable QG worktree is to bridge node_modules into THAT worktree
 * too. Then it `git apply --index <stagedDiff>` and git refuses:
 *
 *   error: node_modules: already exists in working directory
 *
 * Verdict: `diff-apply-failed`, score 0, finding "git apply failed".
 * Three back-to-back failures of this shape (plus the two prior
 * `rubric-failed` regex false-fires) tripped the broker's
 * 3-consecutive-QG-fail halt-guard on team 1d9d264d, task 73.
 *
 * Fix (defense in depth, mirrors commit 4c3d3c6's commit-side guard):
 * `defaultCollectStagedDiff` now invokes
 *
 *   git diff --cached -- . ':!node_modules' ':!.git/info/exclude'
 *
 * which uses git pathspec magic (`:!` = exclude) to drop the bridged
 * symlink entry from the diff at collection time. The commit-side
 * exclusion lives in `quality-gate-arbiter.ts`; this is the analogous
 * **diff-collection-side** exclusion, applied to every team-completion
 * artifact before it ever reaches the arbiter.
 *
 * Tests:
 *
 *   1) Positive — after the fix, `defaultCollectStagedDiff(repoDir)`
 *      returns a diff that contains a legitimate source change but
 *      does NOT contain the bridged `node_modules` symlink path.
 *
 *   2) Negative control — the legacy unfiltered `git diff --cached`
 *      against the same repo state DOES include the symlink. This is
 *      the documented reproduction of the pre-fix bug and serves as a
 *      tripwire: if anyone reverts the pathspec in the future, the
 *      positive test fails and this negative test still passes,
 *      pointing directly at the regression.
 */

import { describe, it, expect, afterEach } from 'vitest'

import { describeIfSymlink } from '../../../helpers/symlink-support.js'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync, execFileSync } from 'node:child_process'
import {
  defaultCollectStagedDiff,
  defaultStageWorktree,
} from '../../../../src/broker/services/team-lifecycle.js'

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

function seedRepoWithBridgedNodeModules(): { repoDir: string } {
  const repoDir = mkdtempSync(join(tmpdir(), 'tl-diff-'))
  tmpDirs.push(repoDir)
  execSync('git init -q -b main', { cwd: repoDir })
  execSync('git config user.email t@t', { cwd: repoDir })
  execSync('git config user.name t', { cwd: repoDir })

  // Production-shape .gitignore: `node_modules/` with trailing slash.
  // This is the literal pattern at line 1 of the project .gitignore.
  // It only ignores a DIRECTORY named node_modules — a symlink at the
  // same path is NOT covered, which is exactly the leak vector.
  writeFileSync(join(repoDir, '.gitignore'), 'node_modules/\n')
  writeFileSync(join(repoDir, 'README.md'), '# seed\n')
  execSync('git add -A && git commit -q -m seed', { cwd: repoDir })

  // Simulate the Layer-2 bridge: a real symlink at <repo>/node_modules
  // pointing at some external "real" node_modules directory.
  const realModules = mkdtempSync(join(tmpdir(), 'tl-diff-fakemods-'))
  tmpDirs.push(realModules)
  writeFileSync(join(realModules, 'package.json'), '{"name":"fake"}')
  symlinkSync(realModules, join(repoDir, 'node_modules'), 'dir')

  // A legitimate source-file change the dev would stage alongside.
  writeFileSync(join(repoDir, 'feature.ts'), 'export const x = 1\n')

  // Dev's `git add -A` — the staging command the broker instructs in
  // every dev task prompt. This is the call site that captures the
  // symlink. Note that .gitignore's `node_modules/` rule does NOT
  // suppress it (only directories match the trailing-slash pattern),
  // so the symlink lands in the index.
  execSync('git add -A', { cwd: repoDir })

  return { repoDir }
}

describeIfSymlink(
  'defaultCollectStagedDiff — node_modules pathspec filter (postmortem qc=c2d6b26d)',
  () => {
  it('strips the bridged node_modules symlink from the collected diff while preserving the real change', () => {
    const { repoDir } = seedRepoWithBridgedNodeModules()

    const diff = defaultCollectStagedDiff(repoDir)

    // The legitimate change must still be present.
    expect(diff).toContain('feature.ts')
    expect(diff).toMatch(/export const x = 1/)

    // The bridged symlink must NOT be present in the diff. Both the
    // bare path and the 120000-mode entry-marker would otherwise
    // surface in the unfiltered `git diff --cached` output.
    expect(diff).not.toContain('node_modules')
    expect(diff).not.toMatch(/new file mode 120000/)
  })

  it('returns a non-empty diff when both node_modules and a real change are staged', () => {
    // Regression guard: the pathspec must not over-exclude. As long
    // as there is at least one legitimate staged change, the diff
    // must be non-empty so the team-lifecycle controller does NOT
    // misclassify the completion as `no-diff` (which would skip QG).
    const { repoDir } = seedRepoWithBridgedNodeModules()

    const diff = defaultCollectStagedDiff(repoDir)

    expect(diff.trim().length).toBeGreaterThan(0)
  })

  it('negative control: the legacy unfiltered `git diff --cached` DOES include the symlink (proves the pre-fix bug)', () => {
    // Tripwire: documents the actual qc=c2d6b26d failure mode and
    // will start failing if the bug ever returns silently — for
    // example, if someone moves the node_modules pathspec from
    // defaultCollectStagedDiff to a layer that's bypassed in some
    // code path. The first positive test above would then start
    // passing only because this negative control no longer holds.
    const { repoDir } = seedRepoWithBridgedNodeModules()

    const legacyDiff = execSync('git diff --cached', {
      cwd: repoDir,
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
    })

    expect(legacyDiff).toContain('node_modules')
    // The hallmark of a staged symlink — 120000 file mode in the
    // diff header. This is exactly what `git apply --index` then
    // tries to recreate inside the QG worktree, and which collides
    // with the QG-side bridge that already created the symlink.
    expect(legacyDiff).toMatch(/new file mode 120000/)
  })
  },
)

/**
 * G3 (scns#36 handoff) — agent runtime logs must not pollute the gate's diff.
 *
 * Live evidence 2026-08-10 (Cosmere child): every `team_completed.stagedDiff`
 * that night BEGAN with the agents' own log files —
 * `.github/logs/acp-team-sel-brain-*.log` — inflating the diffs to
 * 182KB–733KB. The gate then built and judged a diff polluted with runtime
 * logs. The logs land there by design (`defaultLogPathFor` →
 * `<workingDir>/.github/logs/agent-<sessionId>.log`) and are swept into the
 * index by the Gap-1 auto-stage (`git add -A`) or by the agent's own staging.
 *
 * Fix: exclude `.github/logs` at BOTH capture points — the auto-stage
 * (defaultStageWorktree) and the diff collection (defaultCollectStagedDiff).
 * Collection-side matters independently: pathspec exclusion drops the log
 * entries from the diff even when an agent already staged them itself.
 */
describe('agent-log exclusion — .github/logs never reaches the gate diff (G3)', () => {
  function seedRepoWithAgentLogs(): { repoDir: string } {
    const repoDir = mkdtempSync(join(tmpdir(), 'tl-logs-'))
    tmpDirs.push(repoDir)
    execSync('git init -q -b main', { cwd: repoDir })
    execSync('git config user.email t@t', { cwd: repoDir })
    execSync('git config user.name t', { cwd: repoDir })
    writeFileSync(join(repoDir, 'README.md'), '# seed\n')
    execSync('git add -A && git commit -q -m seed', { cwd: repoDir })

    // The production shape: broker-assigned agent logs under .github/logs/.
    mkdirSync(join(repoDir, '.github', 'logs'), { recursive: true })
    writeFileSync(
      join(repoDir, '.github', 'logs', 'acp-team-sel-brain-123.log'),
      'x'.repeat(1024) + '\nruntime log noise\n',
    )
    writeFileSync(join(repoDir, 'feature.ts'), 'export const x = 1\n')

    // The agent's own `git add -A` sweeps the log in alongside the change.
    execSync('git add -A', { cwd: repoDir })
    return { repoDir }
  }

  it('defaultCollectStagedDiff strips .github/logs/** while preserving the real change', () => {
    const { repoDir } = seedRepoWithAgentLogs()

    const diff = defaultCollectStagedDiff(repoDir)

    expect(diff).toContain('feature.ts')
    expect(diff).not.toContain('.github/logs')
    expect(diff).not.toContain('acp-team-sel-brain-123.log')
  })

  it('negative control: the legacy unfiltered `git diff --cached` DOES include the log (proves the leak)', () => {
    const { repoDir } = seedRepoWithAgentLogs()

    const legacyDiff = execSync('git diff --cached', {
      cwd: repoDir,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    })

    expect(legacyDiff).toContain('.github/logs/acp-team-sel-brain-123.log')
  })

  it('defaultStageWorktree does not stage .github/logs/** from a managed worktree', () => {
    // A repo strictly inside a managed base dir, mirroring the per-team
    // worktree layout the auto-stage is gated to.
    const baseDir = mkdtempSync(join(tmpdir(), 'tl-logs-base-'))
    tmpDirs.push(baseDir)
    const repoDir = join(baseDir, 'wt')
    mkdirSync(repoDir, { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoDir })
    execSync('git config user.email t@t', { cwd: repoDir })
    execSync('git config user.name t', { cwd: repoDir })
    writeFileSync(join(repoDir, 'README.md'), '# seed\n')
    execSync('git add -A && git commit -q -m seed', { cwd: repoDir })

    mkdirSync(join(repoDir, '.github', 'logs'), { recursive: true })
    writeFileSync(join(repoDir, '.github', 'logs', 'agent-s1.log'), 'runtime log noise\n')
    writeFileSync(join(repoDir, 'feature.ts'), 'export const x = 1\n')

    const toplevel = defaultStageWorktree(repoDir, baseDir)
    expect(toplevel).not.toBeNull()

    const staged = execSync('git diff --cached --name-only', {
      cwd: repoDir,
      encoding: 'utf8',
    })
    expect(staged).toContain('feature.ts')
    expect(staged).not.toContain('.github/logs/agent-s1.log')
  })
})
