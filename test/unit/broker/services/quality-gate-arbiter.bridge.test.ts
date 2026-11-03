/**
 * Task 37 — verify node_modules bridge resolves vitest/eslint.
 *
 * Postmortem of qc=13ab2fb7 and qc=394de9bb: two back-to-back
 * quality_gate verdicts FAILED with reason='tooling-missing' —
 * `npm test` / `npm run lint` exited 127 inside the QG worktree
 * (`vitest: command not found`, `eslint: command not found`).
 *
 * Root cause: `git worktree add` does not copy node_modules
 * (gitignored), and the existing symlink bridge reported success
 * without ever checking that the runtime binaries actually resolve
 * under `<worktree>/node_modules/.bin/`. Failures were silent — the
 * verdict findings never carried a `node_modules bridge failed (...)`
 * line.
 *
 * This file covers:
 *   (a) symlink + verify ok → reason:'symlinked'; cpSync not called.
 *   (b) symlink + verify reports vitest missing → copy fires, verify
 *       now ok → reason:'copied'.
 *   (c) symlink + verify reports both missing + cpSync throws →
 *       reason:'tooling-unresolved'; error names both binaries AND
 *       the throw text.
 *   (d) High-level: arbiter run with stub projectRoot missing vitest
 *       produces verdict findings containing /tooling-unresolved/ AND
 *       the missing binary name.
 *   (e) strategy='none' returns {linked:false, reason:'strategy-none'}
 *       with no side effects.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { TestDb } from '../../../helpers/db-harness.js'
import { createBrokerTestDb } from '../../../helpers/broker-db-harness.js'
import { itIfSymlink } from '../../../helpers/symlink-support.js'
import { createEventLog } from '../../../../src/broker/services/event-log.js'
import { createEventDispatcher } from '../../../../src/broker/event-dispatcher.js'
import {
  createQualityGateArbiter,
  bridgeNodeModulesIntoWorktree,
  verifyBridgedTooling,
  type RunResult,
  type VerifyToolingResult,
} from '../../../../src/broker/services/quality-gate-arbiter.js'
import type { TeamCompletionData } from '../../../../src/broker/services/team-lifecycle.js'

// ── helpers ───────────────────────────────────────────────────────────

function makeProjectRoot(bins: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'qg-bridge-src-'))
  const binDir = join(root, 'node_modules', '.bin')
  mkdirSync(binDir, { recursive: true })
  for (const bin of bins) {
    writeFileSync(join(binDir, bin), '#!/usr/bin/env node\n', { mode: 0o755 })
  }
  return root
}

function makeWorktree(): string {
  const wt = mkdtempSync(join(tmpdir(), 'qg-bridge-wt-'))
  return wt
}

function ok(stdout = '', stderr = ''): RunResult {
  return { ok: true, stdout, stderr }
}

/**
 * A symlink step that succeeds without touching the filesystem. Lets a
 * branch-logic test assert "the symlink step did not throw" on a platform
 * that cannot actually create one (Windows without Developer Mode).
 */
function noopSymlink(_s: string, _d: string): void {
  /* deliberately empty — the bridge only cares that this did not throw */
}

// ── tests ─────────────────────────────────────────────────────────────

describe('verifyBridgedTooling', () => {
  const cleanup: string[] = []
  afterEach(() => {
    for (const p of cleanup) {
      if (existsSync(p)) rmSync(p, { recursive: true, force: true })
    }
    cleanup.length = 0
  })

  itIfSymlink('returns ok:true when both binaries exist', () => {
    const src = makeProjectRoot(['vitest', 'eslint'])
    const wt = makeWorktree()
    cleanup.push(src, wt)
    symlinkSync(join(src, 'node_modules'), join(wt, 'node_modules'), 'dir')
    const r = verifyBridgedTooling(wt)
    expect(r.ok).toBe(true)
    expect(r.missing).toEqual([])
    expect(r.binDir).toBe(join(wt, 'node_modules', '.bin'))
    expect(r.binDirRealpath).not.toBeNull()
  })

  it('returns missing names when binaries are absent', () => {
    const wt = makeWorktree()
    cleanup.push(wt)
    const r = verifyBridgedTooling(wt)
    expect(r.ok).toBe(false)
    expect(r.missing).toContain('vitest')
    expect(r.missing).toContain('eslint')
    expect(r.binDirRealpath).toBeNull()
  })
})

describe('bridgeNodeModulesIntoWorktree', () => {
  const cleanup: string[] = []
  afterEach(() => {
    for (const p of cleanup) {
      if (existsSync(p)) rmSync(p, { recursive: true, force: true })
    }
    cleanup.length = 0
    vi.restoreAllMocks()
  })

  // (a) symlink succeeds + post-verify ok → 'symlinked', no copy.
  //     Asserts real filesystem state through the link, so it needs the
  //     OS capability rather than an injected hook.
  itIfSymlink('a) symlink + verify ok → reason:symlinked; cpSync not called', () => {
    const src = makeProjectRoot(['vitest', 'eslint'])
    const wt = makeWorktree()
    cleanup.push(src, wt)
    const copySpy = vi.fn(() => {
      throw new Error('copy should not be called')
    })
    const res = bridgeNodeModulesIntoWorktree(src, wt, 'symlink', {
      copy: copySpy,
    })
    expect(res.linked).toBe(true)
    expect(res.reason).toBe('symlinked')
    expect(copySpy).not.toHaveBeenCalled()
    expect(existsSync(join(wt, 'node_modules', '.bin', 'vitest'))).toBe(true)
  })

  // (b) symlink succeeds but post-verify says vitest missing → copy
  //     fires, second verify now ok → 'copied'.
  it('b) symlink + verify reports vitest missing → copy fires → reason:copied', () => {
    const src = makeProjectRoot(['vitest', 'eslint'])
    const wt = makeWorktree()
    cleanup.push(src, wt)

    // First verify reports vitest missing, second (post-copy) reports ok.
    let verifyCalls = 0
    const verify = (worktreePath: string): VerifyToolingResult => {
      verifyCalls++
      if (verifyCalls === 1) {
        return {
          ok: false,
          missing: ['vitest'],
          binDir: join(worktreePath, 'node_modules', '.bin'),
          binDirRealpath: null,
        }
      }
      return {
        ok: true,
        missing: [],
        binDir: join(worktreePath, 'node_modules', '.bin'),
        binDirRealpath: join(worktreePath, 'node_modules', '.bin'),
      }
    }
    const copy = vi.fn((_s: string, _d: string) => {
      /* simulate successful copy — leave fs state as-is for verify stub */
    })

    const res = bridgeNodeModulesIntoWorktree(src, wt, 'symlink', {
      verify,
      copy,
      // Inject a succeeding symlink step: this case is about the
      // verify-failed → copy branch, not about the OS's ability to link.
      symlink: noopSymlink,
    })
    expect(res.linked).toBe(true)
    expect(res.reason).toBe('copied')
    expect(copy).toHaveBeenCalledTimes(1)
    expect(verifyCalls).toBe(2)
    // After the bridge function runs, the dest path was rm'd and copy
    // was the (mocked) replacement — so the original symlink no longer
    // exists at dest. We don't assert the symlink survives.
  })

  // (c) both binaries missing + cpSync throws → 'tooling-unresolved';
  //     error names both binaries AND throw text. cpSync must never
  //     re-throw out of the bridge function.
  it('c) symlink + verify missing + cpSync throws → reason:tooling-unresolved', () => {
    const src = makeProjectRoot(['vitest', 'eslint'])
    const wt = makeWorktree()
    cleanup.push(src, wt)

    const verify = (worktreePath: string): VerifyToolingResult => ({
      ok: false,
      missing: ['vitest', 'eslint'],
      binDir: join(worktreePath, 'node_modules', '.bin'),
      binDirRealpath: '/realpath/to/bin',
    })
    const copyError = new Error('EACCES: cpSync exploded')
    const copy = vi.fn((_s: string, _d: string) => {
      throw copyError
    })

    // Must NOT throw.
    const res = bridgeNodeModulesIntoWorktree(src, wt, 'symlink', {
      verify,
      copy,
      // Inject a succeeding symlink step so this exercises the
      // symlink-ok → verify-failed → copy-threw branch on every platform.
      // Without it, Windows fails `symlinkSync` up front and lands in the
      // different (also correct) 'symlink-error' branch, which case (f)
      // covers explicitly.
      symlink: noopSymlink,
    })
    expect(res.linked).toBe(false)
    expect(res.reason).toBe('tooling-unresolved')
    expect(res.error).toBeDefined()
    // Error message names both missing binaries…
    expect(res.error).toMatch(/vitest/)
    expect(res.error).toMatch(/eslint/)
    // …and the throw text.
    expect(res.error).toMatch(/EACCES/)
    // realpath surfaced for diagnostics.
    expect(res.binDirRealpath).toBe('/realpath/to/bin')
    expect(copy).toHaveBeenCalledTimes(1)
  })

  // (f) The Windows shape of case (c): symlinkSync itself throws, so the
  //     bridge falls through to the copy fallback, and that copy also
  //     fails. Both strategies are exhausted, so the reason is
  //     'symlink-error' rather than 'tooling-unresolved'. Previously
  //     untested, which is why the reason code went unhandled downstream.
  it('f) symlink throws + copy throws → reason:symlink-error naming both causes', () => {
    const src = makeProjectRoot(['vitest', 'eslint'])
    const wt = makeWorktree()
    cleanup.push(src, wt)

    const symlink = vi.fn((_s: string, _d: string) => {
      throw new Error('EPERM: operation not permitted, symlink')
    })
    const copy = vi.fn((_s: string, _d: string) => {
      throw new Error('EACCES: cpSync exploded')
    })
    const verify = vi.fn()

    // Must NOT throw.
    const res = bridgeNodeModulesIntoWorktree(src, wt, 'symlink', {
      verify: verify as never,
      copy,
      symlink,
    })

    expect(res.linked).toBe(false)
    expect(res.reason).toBe('symlink-error')
    // The diagnostic names BOTH failed strategies, so an operator can tell
    // this apart from "copy worked but the binaries are still missing".
    expect(res.error).toMatch(/EPERM/)
    expect(res.error).toMatch(/EACCES/)
    expect(copy).toHaveBeenCalledTimes(1)
    // Verification is pointless once both strategies failed.
    expect(verify).not.toHaveBeenCalled()
  })

  // (e) strategy='none' → no side effects, structured result.
  it('e) strategy=none returns {linked:false, reason:strategy-none} with no side effects', () => {
    const src = makeProjectRoot(['vitest', 'eslint'])
    const wt = makeWorktree()
    cleanup.push(src, wt)
    const copy = vi.fn(() => {
      throw new Error('copy should not be called')
    })
    const res = bridgeNodeModulesIntoWorktree(src, wt, 'none', { copy })
    expect(res.linked).toBe(false)
    expect(res.reason).toBe('strategy-none')
    expect(copy).not.toHaveBeenCalled()
    // No node_modules created in worktree.
    expect(existsSync(join(wt, 'node_modules'))).toBe(false)
  })
})

// (d) High-level integration: arbiter run with stub projectRoot
// missing vitest produces verdict findings containing
// /tooling-unresolved/ AND the missing binary name.
describe('QualityGateArbiter — tooling-unresolved diagnostic', () => {
  let testDb: TestDb
  let tmpRoot: string

  beforeEach(() => {
    testDb = createBrokerTestDb()
    tmpRoot = mkdtempSync(join(tmpdir(), 'qg-bridge-int-'))
  })
  afterEach(() => {
    testDb.close()
    if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('d) emits tooling-unresolved finding when bridge cannot resolve vitest', async () => {
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(testDb.db, dispatcher)

    // projectRoot has eslint but NOT vitest. The bridge will symlink
    // then verify, see vitest missing, attempt copy (which preserves
    // the same partial source — vitest still missing), and report
    // 'tooling-unresolved'.
    const projectRoot = mkdtempSync(join(tmpdir(), 'qg-bridge-proj-'))
    mkdirSync(join(projectRoot, 'node_modules', '.bin'), { recursive: true })
    writeFileSync(
      join(projectRoot, 'node_modules', '.bin', 'eslint'),
      '#!/usr/bin/env node\n',
      { mode: 0o755 },
    )

    const completion: TeamCompletionData = {
      teamId: 'team-task-bridge-fail',
      memberSessionIds: ['s1'],
      stagedDiff:
        'diff --git a/foo.md b/foo.md\n--- a/foo.md\n+++ b/foo.md\n@@ -1 +1,2 @@\n line\n+new\n',
      artifacts: [],
      logs: [],
      aggregateOutcome: 'success',
      completedAt: new Date().toISOString(),
    }

    // Stub run: `git worktree add` makes the dir; `git apply` ok; npm
    // test / lint return command-not-found so that postTestMissing /
    // postLintMissing fire (so we exercise the diagnostic emission).
    const runCmd = (cmd: string, cwd: string): RunResult => {
      if (cmd.startsWith('git worktree add')) {
        // Extract worktree dest and create it so the bridge has a dir
        // to write into.
        const m = cmd.match(/git worktree add -b \S+ "([^"]+)" HEAD/)
        if (m) {
          mkdirSync(m[1], { recursive: true })
          // npm-project fixture shape (G2 non-npm probe reads the worktree).
          writeFileSync(join(m[1], 'package.json'), '{"name":"fixture","version":"0.0.0"}')
        }
        return ok()
      }
      if (cmd.startsWith('git apply')) return ok()
      if (cmd.startsWith('npm test')) {
        return { ok: false, stdout: '', stderr: 'vitest: command not found', code: 127 }
      }
      if (cmd.startsWith('npm run lint')) {
        return { ok: false, stdout: '', stderr: 'eslint: command not found', code: 127 }
      }
      if (cmd.startsWith('git rev-parse')) return ok('deadbeef\n')
      if (cmd.startsWith('git worktree remove')) return ok()
      if (cmd.startsWith('git add')) return ok()
      void cwd
      return ok()
    }

    const arbiter = createQualityGateArbiter({
      db: testDb.db,
      eventLog,
      dispatcher,
      projectRoot,
      runCommand: runCmd,
      worktreeBase: tmpRoot,
    })

    const verdict = await arbiter.handleTeamCompletion(completion)
    arbiter.stop()

    expect(verdict.passed).toBe(false)
    const findingsBlob = verdict.findings.join(' || ')
    expect(findingsBlob).toMatch(/tooling-unresolved/)
    expect(findingsBlob).toMatch(/vitest/)

    if (existsSync(projectRoot)) rmSync(projectRoot, { recursive: true, force: true })
  })
})
