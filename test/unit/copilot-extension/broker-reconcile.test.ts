/**
 * Issue #61, option A — session-start reconciliation.
 *
 * Every Windows persistence trigger reachable from a non-admin account is
 * logon-scoped, and the affected host routinely goes days without a logon —
 * which is exactly how an 11h47m outage went unnoticed. The Copilot extension
 * runs at every session start, needs no privileges, and is self-limiting (no
 * Copilot session, no need for a broker), so it is the highest-frequency
 * trigger available.
 *
 * These tests pin the decision, and — because the runtime copy of it is emitted
 * as JavaScript text into the generated extension — cross-check the emitted
 * function against this one over the whole input space, so the two cannot drift.
 */

import { describe, it, expect } from 'vitest'
import {
  decideReconcile,
  reconcileRuntimeJs,
  DEFAULT_RECONCILE_LOCK_TTL_MS,
  type ReconcileState,
} from '../../../src/copilot-extension/broker-reconcile.js'

const DEAD: ReconcileState = {
  healthy: false,
  enabled: true,
  teamMode: false,
  startCommandConfigured: true,
  lockAgeMs: null,
}

describe('decideReconcile', () => {
  it('does nothing when the broker answered', () => {
    expect(decideReconcile({ ...DEAD, healthy: true })).toEqual({
      action: 'none',
      reason: 'healthy',
    })
  })

  it('starts the stack when the broker is dead', () => {
    expect(decideReconcile(DEAD)).toEqual({ action: 'start', reason: 'broker-down' })
  })

  it('does nothing when reconciliation is switched off', () => {
    expect(decideReconcile({ ...DEAD, enabled: false })).toEqual({
      action: 'none',
      reason: 'disabled',
    })
  })

  it('never starts anything in team mode — the spawner owns that broker', () => {
    expect(decideReconcile({ ...DEAD, teamMode: true })).toEqual({
      action: 'none',
      reason: 'team-mode',
    })
  })

  it('does nothing when no start command was baked in at install time', () => {
    expect(decideReconcile({ ...DEAD, startCommandConfigured: false })).toEqual({
      action: 'none',
      reason: 'no-start-command',
    })
  })

  it('waits instead of starting when a peer session is already starting the stack', () => {
    expect(decideReconcile({ ...DEAD, lockAgeMs: 1_000 })).toEqual({
      action: 'wait',
      reason: 'peer-starting',
    })
  })

  it('ignores a STALE lock — a session that died mid-start must not wedge the next one', () => {
    expect(decideReconcile({ ...DEAD, lockAgeMs: DEFAULT_RECONCILE_LOCK_TTL_MS + 1 })).toEqual({
      action: 'start',
      reason: 'broker-down',
    })
  })

  it('treats a lock exactly at the TTL as stale (boundary)', () => {
    expect(decideReconcile({ ...DEAD, lockAgeMs: DEFAULT_RECONCILE_LOCK_TTL_MS }).action).toBe(
      'start',
    )
  })

  it('health beats every other consideration — a live broker is never restarted', () => {
    for (const enabled of [true, false]) {
      for (const teamMode of [true, false]) {
        expect(decideReconcile({ ...DEAD, healthy: true, enabled, teamMode }).action).toBe('none')
      }
    }
  })
})

// ── anti-drift: the emitted runtime must agree with the TS core ──────

describe('reconcileRuntimeJs', () => {
  it('emits a self-contained decideReconcile function', () => {
    const js = reconcileRuntimeJs()
    expect(js).toContain('function decideReconcile')
    expect(js).not.toContain('import ')
    expect(js).not.toContain('require(')
  })

  it('agrees with the TypeScript core across the entire input space', () => {
    const js = reconcileRuntimeJs()
    const emitted = new Function(`${js}; return decideReconcile;`)() as typeof decideReconcile

    const lockAges = [
      null,
      0,
      1_000,
      DEFAULT_RECONCILE_LOCK_TTL_MS,
      DEFAULT_RECONCILE_LOCK_TTL_MS + 1,
    ]
    let cases = 0
    for (const healthy of [true, false]) {
      for (const enabled of [true, false]) {
        for (const teamMode of [true, false]) {
          for (const startCommandConfigured of [true, false]) {
            for (const lockAgeMs of lockAges) {
              const state: ReconcileState = {
                healthy,
                enabled,
                teamMode,
                startCommandConfigured,
                lockAgeMs,
              }
              expect(emitted(state)).toEqual(decideReconcile(state))
              cases += 1
            }
          }
        }
      }
    }
    expect(cases).toBe(2 * 2 * 2 * 2 * lockAges.length)
  })
})
