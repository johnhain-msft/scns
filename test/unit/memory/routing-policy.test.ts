/**
 * T036/T037 [US3] (specs/001-learning-memory-loop) — the evidence arbiter's ENACTMENT mechanism.
 *
 * A routing policy becomes the live default ONLY through `commitRoutingPolicy`, which refuses
 * anything that is not a fully-certified verdict (HCOPE lower bound > 0, controls passing with
 * MEASURED coverage, det×2, σ recorded) — so "a proposed non-default without a certified gate is
 * never enacted" (SC-006/SC-012) is structural, not procedural. FR-027 bounds are hard: a commit
 * targeting a safety/guardrail path is refused outright. Reads fail CLOSED to null (incumbent
 * hybrid stands on any doubt).
 */
import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  commitRoutingPolicy,
  readCommittedRoutingPolicy,
  type RoutingPolicyCommit,
} from '../../../src/memory/routing-policy.js'

const CERTIFIED: RoutingPolicyCommit = {
  arm: 'magma',
  committedAt: '2026-07-06T00:00:00.000Z',
  evidence: {
    deltaAcc: 0.08,
    sigma: 0.0267,
    hcopeLowerBound: 0.021,
    controlsPass: true,
    negControlN: 6,
    meanTokensDelta: -120,
    deterministicRuns: 2,
    gate: 'arm-frontier-accuracy',
    heldOut: true,
  },
}

function tmpPolicyPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'scns-policy-'))
  return {
    path: join(dir, 'routing-policy.json'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

describe('commitRoutingPolicy — enacts ONLY a fully-certified verdict', () => {
  it('POSITIVE: a certified commit round-trips through readCommittedRoutingPolicy', () => {
    const { path, cleanup } = tmpPolicyPath()
    try {
      const res = commitRoutingPolicy(path, CERTIFIED)
      expect(res.committed).toBe(true)
      const read = readCommittedRoutingPolicy(path)
      expect(read).toEqual(CERTIFIED)
    } finally {
      cleanup()
    }
  })

  it('NEGATIVE: an uncertified verdict is REFUSED — no file is written', () => {
    const { path, cleanup } = tmpPolicyPath()
    try {
      const cases: Array<[string, RoutingPolicyCommit]> = [
        ['LB ≤ 0', { ...CERTIFIED, evidence: { ...CERTIFIED.evidence, hcopeLowerBound: 0 } }],
        [
          'controls failing',
          { ...CERTIFIED, evidence: { ...CERTIFIED.evidence, controlsPass: false } },
        ],
        [
          'unmeasured neg controls',
          { ...CERTIFIED, evidence: { ...CERTIFIED.evidence, negControlN: 0 } },
        ],
        [
          'single run (no det×2)',
          { ...CERTIFIED, evidence: { ...CERTIFIED.evidence, deterministicRuns: 1 } },
        ],
        ['no σ', { ...CERTIFIED, evidence: { ...CERTIFIED.evidence, sigma: 0 } }],
      ]
      for (const [label, commit] of cases) {
        const res = commitRoutingPolicy(path, commit)
        expect(res.committed, label).toBe(false)
        expect(res.reason, label).toBeTruthy()
      }
      expect(existsSync(path)).toBe(false) // nothing was ever written
    } finally {
      cleanup()
    }
  })

  it('NEGATIVE: an unknown arm is refused', () => {
    const { path, cleanup } = tmpPolicyPath()
    try {
      const res = commitRoutingPolicy(path, { ...CERTIFIED, arm: 'sneaky-arm' as never })
      expect(res.committed).toBe(false)
      expect(existsSync(path)).toBe(false)
    } finally {
      cleanup()
    }
  })

  it('NEGATIVE (FR-027 hard bound): a commit targeting a safety/guardrail path is REFUSED', () => {
    for (const evil of [
      'config/safety-allowlist.json',
      'src/broker/services/safety-kernel/kernel-policy.ts',
      '/abs/repo/config/safety-allowlist.json',
      '/abs/repo/src/broker/services/safety-kernel/anything.json',
    ]) {
      const res = commitRoutingPolicy(evil, CERTIFIED)
      expect(res.committed, evil).toBe(false)
      expect(res.reason, evil).toMatch(/safety|guardrail/i)
    }
    expect(existsSync('config/safety-allowlist.json.tmp')).toBe(false)
  })
})

describe('readCommittedRoutingPolicy — fails CLOSED (incumbent hybrid stands on any doubt)', () => {
  it('missing file ⇒ null', () => {
    const { path, cleanup } = tmpPolicyPath()
    try {
      expect(readCommittedRoutingPolicy(path)).toBeNull()
    } finally {
      cleanup()
    }
  })

  it('corrupt JSON / wrong shape / uncertified content ⇒ null', () => {
    const { path, cleanup } = tmpPolicyPath()
    try {
      writeFileSync(path, 'not-json{{{')
      expect(readCommittedRoutingPolicy(path)).toBeNull()
      writeFileSync(path, JSON.stringify({ arm: 'magma' })) // missing evidence
      expect(readCommittedRoutingPolicy(path)).toBeNull()
      writeFileSync(
        path,
        JSON.stringify({ ...CERTIFIED, evidence: { ...CERTIFIED.evidence, hcopeLowerBound: -1 } }),
      )
      expect(readCommittedRoutingPolicy(path)).toBeNull() // a tampered/uncertified record never routes
    } finally {
      cleanup()
    }
  })
})
