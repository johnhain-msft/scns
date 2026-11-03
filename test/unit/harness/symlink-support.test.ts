/**
 * Symlink skip-with-reason (#54 item 2).
 *
 * The first cut of `test/helpers/symlink-support.ts` declared
 * `NO_SYMLINK_REASON` and then never used it — one occurrence repo-wide,
 * its own declaration. `itIfSymlink`/`describeIfSymlink` fell through to a
 * bare `it.skip`/`describe.skip`, so a developer on a Windows box without
 * Developer Mode saw `↓ git add pathspec exclusion` with no hint whether
 * the platform was incapable or someone had muted a failing test.
 *
 * #54 asked for skip-WITH-REASON. Vitest offers no first-class reason for a
 * suite, so the helpers fold the reason into the reported name. These tests
 * hold that wiring in place: a reason constant that nothing reads is how the
 * dead code came back the first time.
 */
import { describe, expect, it } from 'vitest'

import {
  NO_SYMLINK_REASON,
  canCreateSymlink,
  describeIfSymlink,
  itIfSymlink,
  symlinkSkipName,
} from '../../helpers/symlink-support.js'

describe('symlinkSkipName', () => {
  it('carries the reason into the reported test name', () => {
    expect(symlinkSkipName('stages a symlink')).toContain(NO_SYMLINK_REASON)
  })

  it('keeps the original title readable rather than replacing it', () => {
    expect(symlinkSkipName('stages a symlink')).toMatch(/^stages a symlink\b/)
  })

  it('tells the operator what to actually DO about it', () => {
    // The reason is only worth surfacing if it is actionable.
    expect(NO_SYMLINK_REASON).toMatch(/Developer Mode|elevated/)
  })
})

describe('itIfSymlink / describeIfSymlink', () => {
  it('are callable helpers, not raw vitest handles', () => {
    // The old form was `canCreateSymlink() ? it : it.skip`, which could
    // never attach a reason. Both must now be our own wrappers.
    expect(typeof itIfSymlink).toBe('function')
    expect(typeof describeIfSymlink).toBe('function')
    expect(itIfSymlink).not.toBe(it)
    expect(describeIfSymlink).not.toBe(describe)
  })

  it('probe the capability without throwing on any platform', () => {
    expect(typeof canCreateSymlink()).toBe('boolean')
    expect(canCreateSymlink()).toBe(canCreateSymlink()) // cached, stable
  })
})

itIfSymlink('runs (or reports its reason) through the real helper', () => {
  // Self-check of the wrapper's happy path: on a symlink-capable machine
  // this executes; elsewhere it is reported as skipped WITH the reason.
  expect(canCreateSymlink()).toBe(true)
})
