/**
 * Bridge reason-code policy (#54).
 *
 * `BridgeReason` is consumed in three places that each re-derived their own
 * answer to "did we try a copy?" and "does the operator need to be told?":
 *
 *   quality-gate-arbiter.ts  fallbackAttempted  (worktree_provisioning event)
 *   quality-gate-arbiter.ts  shouldEmit         (verdict finding)
 *   team-worktree-manager.ts fallbackAttempted  (worktree_provisioning event)
 *
 * All three listed `'copied' | 'tooling-unresolved'` and omitted
 * `'symlink-error'` — the BOTH-STRATEGIES-FAILED state: `symlinkSync` threw
 * AND the `cpSync` fallback then threw too.
 *
 * That state is rare on every platform and exclusive to none: on POSIX an
 * EEXIST/EACCES/ENOSPC symlink failure plus a failing copy reaches it just
 * as well. What differs is the odds of the first half. On Windows without
 * Developer Mode `symlinkSync` throws EPERM every single time, so the copy
 * fallback is the only thing standing between an operator and this reason —
 * and when the copy works, which is the ORDINARY Windows outcome, the
 * reason is `'copied'`, not `'symlink-error'`.
 *
 * Consequence when both did fail: a worktree with no working tooling
 * produced `fallbackAttempted:false` (a copy WAS attempted) and no verdict
 * finding, so the operator saw only the generic "runner missing in
 * worktree".
 *
 * These predicates are the single source of truth, so the set cannot drift
 * apart again.
 */
import { describe, expect, it } from 'vitest'

import {
  bridgeFallbackAttempted,
  bridgeNeedsDiagnostic,
  type BridgeReason,
} from '../../../../src/broker/services/worktree-tooling-bridge.js'

const ALL_REASONS: readonly BridgeReason[] = [
  'symlinked',
  'copied',
  'tooling-unresolved',
  'strategy-none',
  'src-missing',
  'symlink-error',
]

describe('bridgeFallbackAttempted', () => {
  it('is true for every reason reached by way of an attempted copy', () => {
    expect(bridgeFallbackAttempted('copied')).toBe(true)
    expect(bridgeFallbackAttempted('tooling-unresolved')).toBe(true)
    // Both strategies failed: symlink threw, copy was attempted, copy threw.
    expect(bridgeFallbackAttempted('symlink-error')).toBe(true)
  })

  it('is false when no copy was ever attempted', () => {
    expect(bridgeFallbackAttempted('symlinked')).toBe(false)
    expect(bridgeFallbackAttempted('strategy-none')).toBe(false)
    expect(bridgeFallbackAttempted('src-missing')).toBe(false)
  })

  it('answers for every declared reason', () => {
    for (const r of ALL_REASONS) {
      expect(typeof bridgeFallbackAttempted(r), r).toBe('boolean')
    }
  })
})

describe('bridgeNeedsDiagnostic', () => {
  it('always reports a bridge that ended with tooling unresolved', () => {
    expect(bridgeNeedsDiagnostic('tooling-unresolved', false)).toBe(true)
    expect(bridgeNeedsDiagnostic('tooling-unresolved', true)).toBe(true)
  })

  it('always reports symlink-error — both strategies failed', () => {
    // The regression: this returned false, so an operator whose worktree
    // lost BOTH strategies got no actionable line naming the missing
    // binaries or the underlying cause.
    expect(bridgeNeedsDiagnostic('symlink-error', false)).toBe(true)
    expect(bridgeNeedsDiagnostic('symlink-error', true)).toBe(true)
  })

  it('reports a successful copy only when tooling is still missing at runtime', () => {
    expect(bridgeNeedsDiagnostic('copied', true)).toBe(true)
    expect(bridgeNeedsDiagnostic('copied', false)).toBe(false)
  })

  it('stays quiet when the bridge succeeded or was never asked to run', () => {
    expect(bridgeNeedsDiagnostic('symlinked', true)).toBe(false)
    expect(bridgeNeedsDiagnostic('strategy-none', true)).toBe(false)
  })

  it('treats both no-tooling reasons alike, however the bridge got there', () => {
    // 'tooling-unresolved' (copy landed, verify failed) and 'symlink-error'
    // (symlink AND copy both threw) are different routes to the same
    // outcome — a worktree with no usable tooling. Both are reachable on
    // every platform, and neither may be silent.
    const copyLanded = bridgeNeedsDiagnostic('tooling-unresolved', false)
    const bothFailed = bridgeNeedsDiagnostic('symlink-error', false)
    expect(bothFailed).toBe(copyLanded)
  })
})
