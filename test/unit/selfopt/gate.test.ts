/**
 * Phase 0 — gate strict-improve semantics.
 *
 * Ports the SkillOpt gate contract: a candidate is accepted ONLY if its
 * projected score is STRICTLY greater than the current score (never on a tie),
 * and is promoted to best only if it also beats the best score.
 */
import { describe, it, expect } from 'vitest'
import { evaluateGate, selectGateScore } from '../../../src/selfopt/gate.js'

describe('selectGateScore', () => {
  it('projects onto hard / soft / mixed', () => {
    expect(selectGateScore(1, 0, 'hard')).toBe(1)
    expect(selectGateScore(1, 0, 'soft')).toBe(0)
    expect(selectGateScore(1, 0, 'mixed', 0.5)).toBe(0.5)
    expect(selectGateScore(0.4, 0.8, 'mixed', 0.25)).toBeCloseTo(0.5, 6)
  })

  it('clamps mixed weight to [0,1]', () => {
    expect(selectGateScore(1, 0, 'mixed', -5)).toBe(1) // w=0 -> all hard
    expect(selectGateScore(1, 0, 'mixed', 5)).toBe(0) // w=1 -> all soft
  })
})

describe('evaluateGate', () => {
  const base = {
    candidateSkill: 'cand',
    currentSkill: 'cur',
    bestSkill: 'best',
    bestScore: 0.7,
    bestStep: 2,
    globalStep: 5,
  }

  it('rejects a candidate that does not strictly exceed current (tie => reject)', () => {
    const r = evaluateGate({ ...base, candHard: 0.5, currentScore: 0.5 })
    expect(r.action).toBe('reject')
    expect(r.currentSkill).toBe('cur')
    expect(r.currentScore).toBe(0.5)
    // best is preserved
    expect(r.bestSkill).toBe('best')
    expect(r.bestScore).toBe(0.7)
  })

  it('accepts (not new best) when it beats current but not best', () => {
    const r = evaluateGate({ ...base, candHard: 0.6, currentScore: 0.5 })
    expect(r.action).toBe('accept')
    expect(r.currentSkill).toBe('cand')
    expect(r.currentScore).toBe(0.6)
    expect(r.bestSkill).toBe('best')
    expect(r.bestScore).toBe(0.7)
    expect(r.bestStep).toBe(2)
  })

  it('accepts as new best when it beats current AND best, stamping globalStep', () => {
    const r = evaluateGate({ ...base, candHard: 0.9, currentScore: 0.5 })
    expect(r.action).toBe('accept_new_best')
    expect(r.bestSkill).toBe('cand')
    expect(r.bestScore).toBe(0.9)
    expect(r.bestStep).toBe(5) // globalStep
  })

  it('uses the projected metric for the comparison', () => {
    // hard=0.4 would reject vs current 0.5, but soft=0.9 accepts under soft metric
    const r = evaluateGate({
      ...base,
      candHard: 0.4,
      candSoft: 0.9,
      currentScore: 0.5,
      metric: 'soft',
    })
    expect(r.action).toBe('accept_new_best')
    expect(r.currentScore).toBeCloseTo(0.9, 6)
  })
})
