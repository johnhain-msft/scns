/**
 * M1 (anti-drift) — repo-local enforcement that main only moves via PR.
 *
 * GitHub-side branch protection is plan-gated on this private repo
 * (HTTP 403 "Upgrade to GitHub Pro", verified 2026-08-15), so the guard
 * is a pair of versioned git hooks under `scripts/git-hooks/`, routed
 * via `core.hooksPath` by `scripts/install-git-hooks.sh`:
 *
 *   - pre-commit: rejects a plain `git commit` while on `main`
 *   - pre-push:   rejects any push that updates `refs/heads/main`
 *
 * Escape hatch (John only, logged loudly): SCNS_ALLOW_MAIN_PUSH=1.
 *
 * The tests exercise the real scripts against throwaway repos: a bare
 * "origin" plus a clone with the hooks installed, exactly as a fresh
 * `bash scripts/install-git-hooks.sh` run would leave a working clone.
 *
 * ## Why issue #54 item 5 is NOT implemented here
 *
 * #54 listed "harden `git-hooks` teardown — retry the `rmdir`, or tolerate
 * EBUSY" and attributed 7 failures in this file to that race. That
 * attribution is wrong. The item is withdrawn at
 * https://github.com/johnhain-msft/scns/issues/54#issuecomment-5657656379
 *
 * The 7 failures were CRLF. `scripts/install-git-hooks.sh`,
 * `scripts/git-hooks/pre-commit` and `scripts/git-hooks/pre-push` had
 * drifted to CRLF in the working tree while `.gitattributes` pins them to
 * `eol=lf`, so `bash` choked on the `\r`. Proven both ways: converting the
 * three to LF made all 7 pass, and restoring them byte-for-byte brought
 * the failures back. `git ls-files --eol` showed `i/lf w/crlf` — the index
 * was always correct, only the checkout was stale. The fix is a
 * working-tree refresh, not code:
 *
 *   git add --renormalize . ; git checkout-index -f -a
 *
 * A fresh clone is unaffected. If these 7 fail again on a machine that has
 * carried the repo a while, check `git ls-files --eol` before touching
 * this file.
 *
 * The EBUSY race #54 named IS real — it was observed once here, in the
 * `afterEach` below — but it is a separate, intermittent issue that was
 * never the cause of those 7. The failures that actually persist belong to
 * issue #57 §2: three test files write scratch dirs into the repo root
 * instead of `os.tmpdir()`. Fix it there, at the root cause, rather than
 * patching retry options in here.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(__dirname, '../../..')
const HOOKS_SRC = join(REPO_ROOT, 'scripts', 'git-hooks')
const INSTALLER_SRC = join(REPO_ROOT, 'scripts', 'install-git-hooks.sh')

interface RunResult {
  readonly ok: boolean
  readonly output: string
}

/** Run a command in `cwd`, capturing combined output; never throws. */
function run(cwd: string, file: string, args: string[], env?: Record<string, string>): RunResult {
  // Strip the escape hatch from the inherited env so a developer's shell
  // can never silently flip a "rejected" test green.
  const cleanEnv: Record<string, string | undefined> = {
    ...process.env,
    SCNS_ALLOW_MAIN_PUSH: undefined,
    ...env,
  }
  const res = spawnSync(file, args, {
    cwd,
    env: cleanEnv as NodeJS.ProcessEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return { ok: res.status === 0, output: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

function git(cwd: string, args: string[], env?: Record<string, string>): RunResult {
  return run(cwd, 'git', args, env)
}

/**
 * Every test here drives real `git` (and `bash`) subprocesses: the beforeEach
 * alone runs init-bare, clone, two configs, checkout, commit, push, a recursive
 * hook copy and the installer — a dozen process spawns. On Windows that hook
 * measured 24754ms under full-suite load against the 10s global ceiling.
 *
 * The whole file is subprocess-bound, so the timeout is widened file-wide here
 * rather than globally in vitest.config.ts, which would also hide regressions
 * in the ~8000 tests that have no business taking ten seconds.
 */
describe('scripts/git-hooks (M1 — no direct-to-main)', { timeout: 90_000 }, () => {
  let scratch: string
  let origin: string
  let clone: string

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'scns-git-hooks-'))
    origin = join(scratch, 'origin.git')
    clone = join(scratch, 'clone')

    expect(git(scratch, ['init', '--bare', '--initial-branch=main', origin]).ok).toBe(true)
    expect(git(scratch, ['clone', origin, clone]).ok).toBe(true)
    git(clone, ['config', 'user.email', 'test@example.com'])
    git(clone, ['config', 'user.name', 'Test'])
    git(clone, ['checkout', '-b', 'main'])

    // Seed one commit on main BEFORE the hooks are installed, so the
    // remote has a main branch to protect.
    writeFileSync(join(clone, 'README.md'), 'seed\n', 'utf8')
    git(clone, ['add', '-A'])
    expect(git(clone, ['commit', '-m', 'seed']).ok).toBe(true)
    expect(git(clone, ['push', 'origin', 'main']).ok).toBe(true)

    // Ship the versioned hooks into the clone (as a merged main would
    // carry them) and install.
    mkdirSync(join(clone, 'scripts'), { recursive: true })
    cpSync(HOOKS_SRC, join(clone, 'scripts', 'git-hooks'), { recursive: true })
    cpSync(INSTALLER_SRC, join(clone, 'scripts', 'install-git-hooks.sh'))
    const install = run(clone, 'bash', ['scripts/install-git-hooks.sh'])
    expect(install.ok).toBe(true)
  }, 90_000)

  afterEach(() => {
    // Windows holds handles on freshly-written pack/index files briefly after
    // the git child exits, so an immediate recursive delete raced it and threw
    // `EBUSY: resource busy or locked, rmdir ...\clone`, failing a test whose
    // assertions had already passed. Retry instead of racing.
    rmSync(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  }, 90_000)

  function stageChange(name: string): void {
    writeFileSync(join(clone, name), `${name}\n`, 'utf8')
    git(clone, ['add', '-A'])
  }

  it('installer routes hooks via core.hooksPath and is idempotent', () => {
    expect(git(clone, ['config', 'core.hooksPath']).output.trim()).toBe('scripts/git-hooks')
    const second = run(clone, 'bash', ['scripts/install-git-hooks.sh'])
    expect(second.ok).toBe(true)
    expect(git(clone, ['config', 'core.hooksPath']).output.trim()).toBe('scripts/git-hooks')
  })

  it('rejects a direct commit on main', () => {
    stageChange('direct.txt')
    const commit = git(clone, ['commit', '-m', 'direct to main'])
    expect(commit.ok).toBe(false)
    expect(commit.output).toContain('REJECTED: direct commit on main')
  })

  it('allows commits on a topic branch and pushing that branch', () => {
    git(clone, ['checkout', '-b', 'feat/topic'])
    stageChange('topic.txt')
    expect(git(clone, ['commit', '-m', 'feat: topic work']).ok).toBe(true)
    expect(git(clone, ['push', 'origin', 'feat/topic']).ok).toBe(true)
  })

  it('rejects pushing main directly', () => {
    // Bypass the pre-commit guard deliberately (escape hatch) so the
    // push guard is exercised on its own.
    stageChange('push-main.txt')
    expect(git(clone, ['commit', '-m', 'on main'], { SCNS_ALLOW_MAIN_PUSH: '1' }).ok).toBe(true)
    const push = git(clone, ['push', 'origin', 'main'])
    expect(push.ok).toBe(false)
    expect(push.output).toContain('REJECTED: direct push to main')
  })

  it('rejects a sideways push to main (HEAD:main from a topic branch)', () => {
    git(clone, ['checkout', '-b', 'feat/sneaky'])
    stageChange('sneaky.txt')
    expect(git(clone, ['commit', '-m', 'feat: sneaky']).ok).toBe(true)
    const push = git(clone, ['push', 'origin', 'HEAD:main'])
    expect(push.ok).toBe(false)
    expect(push.output).toContain('REJECTED: direct push to main')
  })

  it('rejects deleting main on the remote', () => {
    git(clone, ['checkout', '-b', 'feat/parked'])
    const push = git(clone, ['push', 'origin', ':main'])
    expect(push.ok).toBe(false)
    expect(push.output).toContain('REJECTED: direct push to main')
  })

  it('escape hatch SCNS_ALLOW_MAIN_PUSH=1 allows and logs loudly', () => {
    stageChange('override.txt')
    const commit = git(clone, ['commit', '-m', 'override'], { SCNS_ALLOW_MAIN_PUSH: '1' })
    expect(commit.ok).toBe(true)
    expect(commit.output).toContain('OVERRIDE: SCNS_ALLOW_MAIN_PUSH=1')

    const push = git(clone, ['push', 'origin', 'main'], { SCNS_ALLOW_MAIN_PUSH: '1' })
    expect(push.ok).toBe(true)
    expect(push.output).toContain('OVERRIDE: SCNS_ALLOW_MAIN_PUSH=1')
  })
})
