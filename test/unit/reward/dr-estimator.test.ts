/**
 * T030 [US3] (specs/001-learning-memory-loop) — doubly-robust off-policy estimator
 * (Dudík, Langford, Li 2011, arXiv:1103.4601; PRIOR_ART §C.3 #9 — the one true algorithmic BUILD).
 *
 * V̂_DR = mean( Σ_a π(a|x)·r̂(x,a)  +  (π(a_i|x)/μ_i)·(r_i − r̂(x,a_i)) )
 *
 * Every value below is HAND-COMPUTED (anti-mistesting). Degenerate propensities are dropped and
 * counted, never silently kept; the importance ratio is clipped with the same CRM convention as the
 * kto-learner (default 10).
 */
import { describe, it, expect } from 'vitest'
import { drEstimate, type OffPolicyRow } from '../../../src/reward/dr-estimator.js'

const ARMS = ['A', 'B'] as const

/** Deterministic target policy: always play `arm`. */
const always = (arm: string) => ({
  prob: (_row: OffPolicyRow, a: string): number => (a === arm ? 1 : 0),
})

const row = (arm: string, reward: number, propensity: number): OffPolicyRow => ({
  arm,
  reward,
  propensity,
})

describe('drEstimate — hand-computed closed-form values', () => {
  it('PERFECT reward model ⇒ corrections vanish, V̂ = the direct estimate (0.5)', () => {
    // r̂(x,A)=0.5, r̂(x,B)=0.2 and rewards equal the model exactly.
    const model = { predict: (_r: OffPolicyRow, a: string) => (a === 'A' ? 0.5 : 0.2) }
    const res = drEstimate([row('A', 0.5, 0.5), row('B', 0.2, 0.5)], model, always('A'), {
      arms: ARMS,
    })
    // per row: direct = 1·0.5 + 0·0.2 = 0.5 ; corrections: (1/0.5)(0.5−0.5)=0 and (0/0.5)(…)=0
    expect(res.value).toBeCloseTo(0.5, 10)
    expect(res.nUsed).toBe(2)
    expect(res.nDroppedInvalid).toBe(0)
  })

  it('ZERO reward model ⇒ V̂ collapses to plain IPS (mean 2.0)', () => {
    const zero = { predict: () => 0 }
    const res = drEstimate([row('A', 1, 0.25), row('B', 1, 0.75)], zero, always('A'), {
      arms: ARMS,
    })
    // row1: 0 + (1/0.25)·1 = 4 ; row2: 0 + (0/0.75)·1 = 0 ⇒ mean 2
    expect(res.value).toBeCloseTo(2, 10)
  })

  it('MIXED case matches the hand computation (mean 1.0)', () => {
    const model = { predict: (_r: OffPolicyRow, a: string) => (a === 'A' ? 0.4 : 0.6) }
    const res = drEstimate([row('A', 1.0, 0.5), row('B', 0.0, 0.5)], model, always('A'), {
      arms: ARMS,
    })
    // row1: direct 0.4 + (1/0.5)(1.0−0.4)=1.2 ⇒ 1.6 ; row2: direct 0.4 + (0/0.5)(0−0.6)=0 ⇒ 0.4
    expect(res.value).toBeCloseTo(1.0, 10)
  })

  it('the importance ratio is CLIPPED (CRM variance control, default 10)', () => {
    const zero = { predict: () => 0 }
    // 1/μ = 1000 would explode; clip 10 ⇒ per-row 10·1 = 10.
    const res = drEstimate([row('A', 1, 0.001)], zero, always('A'), { arms: ARMS })
    expect(res.value).toBeCloseTo(10, 10)
    const custom = drEstimate([row('A', 1, 0.001)], zero, always('A'), { arms: ARMS, ipsClip: 3 })
    expect(custom.value).toBeCloseTo(3, 10)
  })
})

describe('drEstimate — degenerate inputs are handled honestly (negative controls)', () => {
  const zero = { predict: () => 0 }

  it('rows with propensity ≤ 0 / NaN / > 1 are DROPPED and counted, never silently kept', () => {
    const res = drEstimate(
      [
        row('A', 1, 0.5),
        row('A', 1, 0),
        row('A', 1, -0.2),
        row('A', 1, Number.NaN),
        row('A', 1, 1.5),
      ],
      zero,
      always('A'),
      { arms: ARMS },
    )
    expect(res.nUsed).toBe(1)
    expect(res.nDroppedInvalid).toBe(4)
    expect(res.value).toBeCloseTo(2, 10) // (1/0.5)·1 over the single valid row
  })

  it('an empty (or all-invalid) row set yields value 0 with nUsed 0 — never NaN', () => {
    const empty = drEstimate([], zero, always('A'), { arms: ARMS })
    expect(empty.value).toBe(0)
    expect(empty.nUsed).toBe(0)
    const allBad = drEstimate([row('A', 1, 0)], zero, always('A'), { arms: ARMS })
    expect(allBad.value).toBe(0)
    expect(allBad.nUsed).toBe(0)
    expect(allBad.nDroppedInvalid).toBe(1)
  })

  it('reports direct and correction components separately (audit trail)', () => {
    const model = { predict: (_r: OffPolicyRow, a: string) => (a === 'A' ? 0.4 : 0.6) }
    const res = drEstimate([row('A', 1.0, 0.5)], model, always('A'), { arms: ARMS })
    expect(res.meanDirect).toBeCloseTo(0.4, 10)
    expect(res.meanCorrection).toBeCloseTo(1.2, 10)
    expect(res.value).toBeCloseTo(1.6, 10)
  })
})
