/**
 * worktree-tooling-bridge — make a freshly-`git worktree add`'d checkout
 * able to spawn `vitest` and `eslint` (and anything else under
 * `<projectRoot>/node_modules/.bin/`) without re-running `npm install`.
 *
 * Originally introduced in `quality-gate-arbiter.ts` (Task 37) to fix
 * `tooling-missing` QG verdicts (qc=13ab2fb7, qc=394de9bb). Extracted
 * here in the Layer-2 fix so the per-team worktree manager
 * (`team-worktree-manager.ts`) can call the same bridge — otherwise the
 * cross-team `.git/index` contamination fix removes the very tooling the
 * spawned dev/qa ACP processes need (live observation 2026-05-16 team
 * 4fde2759: dev exited after first turn with NO message_sent events
 * because `npm run typecheck` / `vitest run …` returned "command not
 * found" from a worktree that had no node_modules at all).
 *
 * Strategy (in order):
 *   1. symlink `<projectRoot>/node_modules` → `<worktreePath>/node_modules`,
 *   2. verify `vitest` AND `eslint` resolve via `<dest>/.bin/<bin>`,
 *   3. on verify-fail (broken symlink, partial source) OR symlink-throw
 *      (EPERM / EEXIST race), fall back to
 *      `cpSync(...,{recursive,dereference:false,force})`,
 *   4. re-verify and surface a structured BridgeResult so callers can
 *      either silently recover ('copied') or emit an actionable
 *      'tooling-unresolved' diagnostic.
 *
 * The function NEVER throws — every fs error becomes part of the
 * structured result. (cpSync in particular has historically thrown on
 * permission edges; we catch and report it.)
 */

import {
  cpSync,
  existsSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { join } from 'node:path'

// ── Types ────────────────────────────────────────────────────────────

export type BridgeReason =
  | 'symlinked'
  | 'copied'
  | 'tooling-unresolved'
  | 'strategy-none'
  | 'src-missing'
  | 'symlink-error'

export interface BridgeResult {
  readonly linked: boolean
  readonly reason: BridgeReason
  readonly srcPath: string
  readonly destPath: string
  /** Missing binaries from the bin dir, present on failure paths. */
  readonly missing?: readonly string[]
  /** realpath() of `<worktree>/node_modules/.bin/`, null if not resolvable. */
  readonly binDirRealpath?: string | null
  /** Human-readable diagnostic — populated on every non-success reason. */
  readonly error?: string
}

export interface VerifyToolingResult {
  readonly ok: boolean
  readonly missing: readonly string[]
  readonly binDir: string
  readonly binDirRealpath: string | null
}

/** Required binaries the worktree must be able to spawn. */
export const REQUIRED_BINS = ['vitest', 'eslint'] as const

// ── Reason-code policy ───────────────────────────────────────────────
//
// Consumers used to re-derive these answers inline as
// `reason === 'copied' || reason === 'tooling-unresolved'`, which silently
// omitted 'symlink-error'.
//
// 'symlink-error' is the BOTH-STRATEGIES-FAILED state: `symlink` threw AND
// the `cpSync` fallback then threw too. It is rare on every platform and
// exclusive to none — on POSIX an EEXIST/EACCES/ENOSPC symlink failure plus
// a failing copy reaches it just as well. What differs is the odds of the
// first half: on Windows without Developer Mode `symlinkSync` throws EPERM
// every time, so the copy fallback is the only thing standing between an
// operator and this state, and the ORDINARY Windows outcome is 'copied',
// not 'symlink-error'.
//
// That asymmetry is why the omission bit Windows first: a worktree that
// lost both strategies reported `fallbackAttempted:false` (a copy WAS
// attempted) and produced no verdict finding. Keep the policy here, next
// to the type it describes.

/** Reasons the bridge only reaches after attempting the `cpSync` fallback. */
const FALLBACK_ATTEMPTED: ReadonlySet<BridgeReason> = new Set([
  'copied',
  'tooling-unresolved',
  'symlink-error',
])

/** Reasons that leave the worktree without usable tooling. */
const BRIDGE_FAILED: ReadonlySet<BridgeReason> = new Set([
  'tooling-unresolved',
  'symlink-error',
])

/**
 * Did the bridge actually try to copy `node_modules`? Drives the
 * `fallbackAttempted` field of the `worktree_provisioning` event.
 */
export function bridgeFallbackAttempted(reason: BridgeReason): boolean {
  return FALLBACK_ATTEMPTED.has(reason)
}

/**
 * Does the operator need an actionable diagnostic naming the missing
 * binaries and the underlying cause?
 *
 * True whenever the bridge ended without usable tooling — 'tooling-unresolved'
 * when the copy landed but verification still failed, 'symlink-error' when
 * neither the symlink nor the copy survived — and also when a copy reported
 * success but the runtime tooling floor still tripped, which means the copy
 * did not actually deliver the binaries. Both failure reasons are reachable
 * on every platform; neither is a platform's normal outcome.
 */
export function bridgeNeedsDiagnostic(
  reason: BridgeReason,
  toolingFloorTripped: boolean,
): boolean {
  return BRIDGE_FAILED.has(reason) || (reason === 'copied' && toolingFloorTripped)
}

// ── Functions ────────────────────────────────────────────────────────

/**
 * Probe `<worktreePath>/node_modules/.bin/{vitest,eslint}`. Never
 * throws — missing-file cases become entries in the `missing` array.
 */
export function verifyBridgedTooling(worktreePath: string): VerifyToolingResult {
  const binDir = join(worktreePath, 'node_modules', '.bin')
  let binDirRealpath: string | null = null
  try {
    binDirRealpath = realpathSync(binDir)
  } catch {
    binDirRealpath = null
  }
  const missing: string[] = []
  for (const bin of REQUIRED_BINS) {
    try {
      if (!existsSync(join(binDir, bin))) missing.push(bin)
    } catch {
      missing.push(bin)
    }
  }
  return { ok: missing.length === 0, missing, binDir, binDirRealpath }
}

/**
 * Bridge node_modules into the worktree. See module-level comment.
 *
 * The `hooks` parameter is dependency-injection for unit tests:
 *   - `verify`  overrides the post-link verification probe,
 *   - `copy`    overrides the recursive copy step,
 *   - `symlink` overrides the symlink step (lets tests force a throw
 *               and exercise the rubber-duck-#6 fallback path
 *               deterministically). Default is `symlinkSync`.
 * Production callers omit all three; defaults are `verifyBridgedTooling`,
 * a wrapped `cpSync(src, dest, {recursive:true, dereference:false,
 * force:true})`, and `symlinkSync(srcPath, destPath, 'dir')`. The
 * function NEVER re-throws fs errors out of itself.
 */
export function bridgeNodeModulesIntoWorktree(
  projectRoot: string,
  worktreePath: string,
  strategy: 'symlink' | 'none' = 'symlink',
  hooks: {
    verify?: (worktreePath: string) => VerifyToolingResult
    copy?: (src: string, dest: string) => void
    symlink?: (src: string, dest: string) => void
  } = {},
): BridgeResult {
  const srcPath = join(projectRoot, 'node_modules')
  const destPath = join(worktreePath, 'node_modules')
  const verify = hooks.verify ?? verifyBridgedTooling
  const copy =
    hooks.copy ??
    ((s: string, d: string): void => {
      cpSync(s, d, { recursive: true, dereference: false, force: true })
    })
  const symlink =
    hooks.symlink ?? ((s: string, d: string): void => symlinkSync(s, d, 'dir'))

  if (strategy === 'none') {
    return { linked: false, reason: 'strategy-none', srcPath, destPath }
  }
  if (!existsSync(srcPath)) {
    return {
      linked: false,
      reason: 'src-missing',
      srcPath,
      destPath,
      error: `source node_modules missing at ${srcPath}`,
    }
  }

  // 1) Try a symlink first.
  let symlinkErr: Error | null = null
  if (!existsSync(destPath)) {
    try {
      symlink(srcPath, destPath)
    } catch (err) {
      symlinkErr = err as Error
    }
  }

  // 1a) Hardening (rubber-duck #6): if `symlinkSync` itself threw — EPERM
  // on a no-symlink filesystem, race with a parallel ensure, etc. — we
  // used to bail with `symlink-error`. Now we fall through to the copy
  // fallback, exactly as we already do when the symlink succeeded but
  // verification failed. Only after the copy ALSO fails do we surface
  // a hard `symlink-error`. Restores tooling on platforms where
  // `symlinkSync` is unreliable but `cpSync` works.
  if (symlinkErr) {
    let copyErr: Error | null = null
    try {
      copy(srcPath, destPath)
    } catch (err) {
      copyErr = err as Error
    }
    if (copyErr) {
      return {
        linked: false,
        reason: 'symlink-error',
        srcPath,
        destPath,
        error: `symlinkSync failed (${symlinkErr.message}); copy fallback also failed (${copyErr.message})`,
      }
    }
    const v = verify(worktreePath)
    if (v.ok) {
      return {
        linked: true,
        reason: 'copied',
        srcPath,
        destPath,
        binDirRealpath: v.binDirRealpath,
      }
    }
    return {
      linked: false,
      reason: 'tooling-unresolved',
      srcPath,
      destPath,
      missing: v.missing,
      binDirRealpath: v.binDirRealpath,
      error: `symlinkSync failed (${symlinkErr.message}); copy succeeded but bridged bin dir missing required binaries (missing=${v.missing.join(',') || 'unknown'}, realpath=${v.binDirRealpath ?? 'null'})`,
    }
  }

  // 2) Verify required binaries resolve through the link.
  const v1 = verify(worktreePath)
  if (v1.ok) {
    return {
      linked: true,
      reason: 'symlinked',
      srcPath,
      destPath,
      binDirRealpath: v1.binDirRealpath,
    }
  }

  // 3) Fallback — rm the symlink and copy the tree.
  try {
    rmSync(destPath, { recursive: true, force: true })
  } catch {
    /* best effort — if rm fails, copy below may still succeed via force:true */
  }
  let copyErr: Error | null = null
  try {
    copy(srcPath, destPath)
  } catch (err) {
    copyErr = err as Error
  }
  if (copyErr) {
    const missing = v1.missing
    return {
      linked: false,
      reason: 'tooling-unresolved',
      srcPath,
      destPath,
      missing,
      binDirRealpath: v1.binDirRealpath,
      error: `cpSync failed bridging node_modules (missing=${missing.join(',') || 'unknown'}, realpath=${v1.binDirRealpath ?? 'null'}): ${copyErr.message}`,
    }
  }

  // 4) Re-verify after copy.
  const v2 = verify(worktreePath)
  if (v2.ok) {
    return {
      linked: true,
      reason: 'copied',
      srcPath,
      destPath,
      binDirRealpath: v2.binDirRealpath,
    }
  }
  return {
    linked: false,
    reason: 'tooling-unresolved',
    srcPath,
    destPath,
    missing: v2.missing,
    binDirRealpath: v2.binDirRealpath,
    error: `node_modules bridge could not resolve required binaries after copy (missing=${v2.missing.join(',') || 'unknown'}, realpath=${v2.binDirRealpath ?? 'null'})`,
  }
}
