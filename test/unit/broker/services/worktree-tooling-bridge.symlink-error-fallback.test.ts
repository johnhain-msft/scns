/**
 * worktree-tooling-bridge — rubber-duck #6 hardening regression test.
 *
 * Pre-Layer-2: when `symlinkSync` itself threw (EPERM on read-only
 * filesystem, EEXIST on a race with a parallel ensure, etc.) the bridge
 * returned `reason:'symlink-error'` immediately, leaving the worktree
 * with no `node_modules` and the spawned dev/qa ACP processes unable
 * to spawn `vitest` / `eslint`. The Layer-2 fix falls back to the
 * `cpSync` copy step before giving up, exactly as we already do when
 * the symlink succeeded but verification reported missing binaries.
 *
 * This file covers three new contract properties:
 *   (a) symlink throws + copy succeeds + verify ok → reason:'copied'
 *       with linked:true.
 *   (b) symlink throws + copy succeeds + verify still missing →
 *       reason:'tooling-unresolved' (NOT symlink-error), with error
 *       text naming the symlink throw AND the missing binaries.
 *   (c) symlink throws + copy ALSO throws → reason:'symlink-error',
 *       with error text naming BOTH the symlink throw and the copy
 *       throw (so on-call gets the full picture).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { itIfSymlink } from '../../../helpers/symlink-support.js'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bridgeNodeModulesIntoWorktree,
  type VerifyToolingResult,
} from '../../../../src/broker/services/worktree-tooling-bridge.js'

function makeProjectRoot(bins: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'wtb-rd6-src-'))
  const binDir = join(root, 'node_modules', '.bin')
  mkdirSync(binDir, { recursive: true })
  for (const bin of bins) {
    writeFileSync(join(binDir, bin), '#!/usr/bin/env node\n', { mode: 0o755 })
  }
  return root
}

describe('bridgeNodeModulesIntoWorktree — rubber-duck #6: symlink throw → copy fallback', () => {
  const cleanup: string[] = []
  afterEach(() => {
    for (const p of cleanup) {
      if (existsSync(p)) rmSync(p, { recursive: true, force: true })
    }
    cleanup.length = 0
    vi.restoreAllMocks()
  })

  beforeEach(() => {
    /* no-op — kept for symmetry with sibling test files */
  })

  it('(a) symlink throws + copy succeeds + verify ok → reason:copied', () => {
    const src = makeProjectRoot(['vitest', 'eslint'])
    const wt = mkdtempSync(join(tmpdir(), 'wtb-rd6-wt-'))
    cleanup.push(src, wt)

    const symlink = vi.fn((_s: string, _d: string) => {
      throw new Error('EPERM: read-only fs (test)')
    })
    const copy = vi.fn((_s: string, _d: string) => {
      /* simulated successful copy — no fs side effect needed for the
         stubbed verify below to report ok */
    })
    const verify = vi.fn(
      (worktreePath: string): VerifyToolingResult => ({
        ok: true,
        missing: [],
        binDir: join(worktreePath, 'node_modules', '.bin'),
        binDirRealpath: join(worktreePath, 'node_modules', '.bin'),
      }),
    )

    const res = bridgeNodeModulesIntoWorktree(src, wt, 'symlink', {
      symlink,
      copy,
      verify,
    })

    expect(symlink).toHaveBeenCalledTimes(1)
    expect(copy).toHaveBeenCalledTimes(1)
    expect(verify).toHaveBeenCalledTimes(1)
    expect(res.linked).toBe(true)
    expect(res.reason).toBe('copied')
    expect(res.error).toBeUndefined()
  })

  it('(b) symlink throws + copy succeeds + verify still missing → reason:tooling-unresolved (NOT symlink-error)', () => {
    const src = makeProjectRoot(['vitest', 'eslint'])
    const wt = mkdtempSync(join(tmpdir(), 'wtb-rd6-wt-'))
    cleanup.push(src, wt)

    const symlink = vi.fn((_s: string, _d: string) => {
      throw new Error('EPERM: read-only fs (test)')
    })
    const copy = vi.fn(() => {
      /* simulated successful copy with stale verify */
    })
    const verify = vi.fn(
      (worktreePath: string): VerifyToolingResult => ({
        ok: false,
        missing: ['vitest', 'eslint'],
        binDir: join(worktreePath, 'node_modules', '.bin'),
        binDirRealpath: null,
      }),
    )

    const res = bridgeNodeModulesIntoWorktree(src, wt, 'symlink', {
      symlink,
      copy,
      verify,
    })

    expect(symlink).toHaveBeenCalledTimes(1)
    expect(copy).toHaveBeenCalledTimes(1)
    expect(res.linked).toBe(false)
    expect(res.reason).toBe('tooling-unresolved')
    expect(res.error).toMatch(/EPERM/)
    expect(res.error).toMatch(/vitest/)
    expect(res.error).toMatch(/eslint/)
    expect(res.missing).toEqual(['vitest', 'eslint'])
  })

  it('(c) symlink throws + copy ALSO throws → reason:symlink-error names BOTH throws', () => {
    const src = makeProjectRoot(['vitest', 'eslint'])
    const wt = mkdtempSync(join(tmpdir(), 'wtb-rd6-wt-'))
    cleanup.push(src, wt)

    const symlink = vi.fn(() => {
      throw new Error('EPERM: read-only fs (test)')
    })
    const copy = vi.fn(() => {
      throw new Error('ENOSPC: out of space (test)')
    })
    // verify must NOT be called if copy threw — assert that below.
    const verify = vi.fn(
      (worktreePath: string): VerifyToolingResult => ({
        ok: false,
        missing: ['vitest', 'eslint'],
        binDir: join(worktreePath, 'node_modules', '.bin'),
        binDirRealpath: null,
      }),
    )

    const res = bridgeNodeModulesIntoWorktree(src, wt, 'symlink', {
      symlink,
      copy,
      verify,
    })

    expect(symlink).toHaveBeenCalledTimes(1)
    expect(copy).toHaveBeenCalledTimes(1)
    expect(verify).not.toHaveBeenCalled()
    expect(res.linked).toBe(false)
    expect(res.reason).toBe('symlink-error')
    expect(res.error).toMatch(/EPERM/)
    expect(res.error).toMatch(/ENOSPC/)
  })

  itIfSymlink(
    '(d) symlink succeeds + verify ok → reason:symlinked; copy + symlink hook NOT re-invoked',
    () => {
      // Sanity baseline: the new symlink hook does not change the
      // happy-path. Using the real symlinkSync via the hook default, so
      // this needs the OS capability rather than an injected stub.
      const src = makeProjectRoot(['vitest', 'eslint'])
      const wt = mkdtempSync(join(tmpdir(), 'wtb-rd6-wt-'))
      cleanup.push(src, wt)

      const copy = vi.fn(() => {
        throw new Error('copy should not be called')
      })

      const res = bridgeNodeModulesIntoWorktree(src, wt, 'symlink', { copy })
      expect(res.linked).toBe(true)
      expect(res.reason).toBe('symlinked')
      expect(copy).not.toHaveBeenCalled()
    },
  )
})
