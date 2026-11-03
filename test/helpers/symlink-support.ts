/**
 * Symlink-capability probe for the test harness (#54).
 *
 * Windows refuses `symlinkSync` with `EPERM` unless the process is elevated
 * or Developer Mode is on. GitHub's `windows-latest` runners have the
 * privilege, so CI is green while a developer's own Windows box fails 9
 * tests that assume a symlink can be created.
 *
 * Two different kinds of test were affected, and they need different fixes:
 *
 *   1. Tests of the bridge's BRANCH LOGIC ("symlink step succeeded, so the
 *      result is 'symlinked'"). These do not need a real symlink — the
 *      bridge already accepts a `symlink` hook for dependency injection, so
 *      they should inject one and stay deterministic on every platform.
 *
 *   2. Tests of REAL filesystem or git behaviour through a symlink (does
 *      `git add -A` stage the link? does `git diff --cached` include it?).
 *      These genuinely require the OS capability, so they skip when it is
 *      unavailable rather than asserting a POSIX-only outcome.
 *
 * Use `itIfSymlink` / `describeIfSymlink` for case 2 only. Reaching for a
 * skip in case 1 would hide real logic regressions on Windows.
 *
 * A skip that says nothing is its own trap: a developer scrolling past
 * `↓ git add pathspec exclusion` has no way to tell "this platform cannot
 * do symlinks" from "someone disabled a failing test". Both helpers
 * therefore append {@link NO_SYMLINK_REASON} to the reported name, so the
 * reason travels with the skip in every reporter — see
 * {@link symlinkSkipName}.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, it } from 'vitest'

let cached: boolean | null = null

/**
 * Can this process create a directory symlink? Probes once and caches.
 * Never throws.
 */
export function canCreateSymlink(): boolean {
  if (cached !== null) return cached
  let dir: string | null = null
  try {
    dir = mkdtempSync(join(tmpdir(), 'scns-symlink-probe-'))
    const target = join(dir, 'target')
    mkdirSync(target)
    symlinkSync(target, join(dir, 'link'), 'dir')
    cached = true
  } catch {
    cached = false
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* best effort — a leaked probe dir must not fail a test run */
      }
    }
  }
  return cached
}

/** Reason string shown when a symlink-dependent test is skipped. */
export const NO_SYMLINK_REASON =
  'requires symlink privilege (Windows: enable Developer Mode or run elevated)'

/**
 * The name a skipped symlink test reports, carrying the reason with it.
 *
 * Vitest has no first-class "skip with reason" for a suite, and a bare
 * `it.skip` prints only the original title. Folding the reason into the
 * title is what makes it visible in every reporter, local and CI alike.
 */
export function symlinkSkipName(name: string): string {
  return `${name} [SKIPPED: ${NO_SYMLINK_REASON}]`
}

/** `it`, but skipped — with the reason attached — when symlinks are unavailable. */
export function itIfSymlink(
  name: string,
  body: () => void | Promise<void>,
  timeout?: number,
): void {
  if (canCreateSymlink()) {
    it(name, body, timeout)
    return
  }
  it.skip(symlinkSkipName(name), body, timeout)
}

/** `describe`, but skipped — with the reason attached — when symlinks are unavailable. */
export function describeIfSymlink(name: string, body: () => void): void {
  if (canCreateSymlink()) {
    describe(name, body)
    return
  }
  describe.skip(symlinkSkipName(name), body)
}
