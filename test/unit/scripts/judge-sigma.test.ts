/**
 * T008 (feature 002) — the pinned-judge σ re-measure protocol (research R2/R7). fable5 quoted "σ=0.0267"
 * with no backing artifact; this suite proves σ is COMPUTED from raw repeats, ARCHIVED to a real file,
 * and correctly gates a Δ-vs-noise win. Positive AND negative controls throughout.
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  computeJudgeSigma,
  measureJudgeSigma,
  archiveSigmaArtifact,
  loadSigmaArtifact,
  deltaExceedsSigma,
  PINNED_JUDGE_MODEL,
  MIN_SIGMA_SAMPLES,
} from '../../../scripts/lib/judge-sigma.js'

describe('computeJudgeSigma — sample σ (n−1) of repeated grades', () => {
  it('POSITIVE: [0.2,0.4,0.6] → mean 0.4, σ 0.2', () => {
    const { n, mean, sigma } = computeJudgeSigma([0.2, 0.4, 0.6])
    expect(n).toBe(3)
    expect(mean).toBeCloseTo(0.4, 6)
    expect(sigma).toBeCloseTo(0.2, 6)
  })

  it('POSITIVE: identical grades → σ = 0 (a perfectly consistent judge)', () => {
    expect(computeJudgeSigma([0.6, 0.6, 0.6, 0.6, 0.6]).sigma).toBe(0)
  })

  it('NEGATIVE: a single grade throws (σ undefined — never a silent 0)', () => {
    expect(() => computeJudgeSigma([0.6])).toThrow(/>= 2 scores/)
  })

  it('NEGATIVE: an out-of-range score (an unfiltered NULL_JUDGE_SCORE = -1) throws', () => {
    expect(() => computeJudgeSigma([0.6, -1, 0.6])).toThrow(/out-of-range|NULL_JUDGE_SCORE/i)
  })

  it('NEGATIVE: a non-finite score (NaN) throws', () => {
    expect(() => computeJudgeSigma([0.6, Number.NaN, 0.6])).toThrow(/out-of-range|rubric scores/i)
  })
})

describe('measureJudgeSigma — powered flag + pinned model', () => {
  it('is under-powered below the sample floor and powered at/above it', () => {
    const under = measureJudgeSigma('itemA', [0.6, 0.6, 0.6])
    expect(under.n).toBeLessThan(MIN_SIGMA_SAMPLES)
    expect(under.powered).toBe(false)

    const powered = measureJudgeSigma('itemA', [0.6, 0.6, 0.6, 0.6, 0.62])
    expect(powered.n).toBeGreaterThanOrEqual(MIN_SIGMA_SAMPLES)
    expect(powered.powered).toBe(true)
    expect(powered.model).toBe(PINNED_JUDGE_MODEL)
    expect(powered.raw_scores).toEqual([0.6, 0.6, 0.6, 0.6, 0.62])
  })
})

describe('archiveSigmaArtifact — every quoted σ resolves to a real file (R7)', () => {
  it('round-trips the raw scores so the number is backed, not asserted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scns-sigma-'))
    try {
      const m = measureJudgeSigma('held-out-1', [0.6, 0.62, 0.58, 0.6, 0.61])
      const path = join(dir, 'held-out-1-judge-sigma.json')
      archiveSigmaArtifact(path, m)
      expect(existsSync(path)).toBe(true)
      const loaded = loadSigmaArtifact(path)
      expect(loaded.raw_scores).toEqual([0.6, 0.62, 0.58, 0.6, 0.61])
      expect(loaded.sigma).toBeCloseTo(m.sigma, 12)
      expect(loaded.powered).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('deltaExceedsSigma — a win requires Δ > measured, powered σ (Constitution I)', () => {
  it('POSITIVE: a Δ above a powered σ is a real win', () => {
    const m = measureJudgeSigma('i', [0.60, 0.61, 0.59, 0.60, 0.605]) // σ ~0.007
    expect(deltaExceedsSigma(0.05, m)).toBe(true)
  })

  it('NEGATIVE: a Δ below σ is NOT a win', () => {
    const m = measureJudgeSigma('i', [0.5, 0.7, 0.4, 0.6, 0.55]) // σ ~0.11
    expect(deltaExceedsSigma(0.02, m)).toBe(false)
  })

  it('NEGATIVE: an under-powered σ never certifies a win, even for a large Δ', () => {
    const under = measureJudgeSigma('i', [0.6, 0.6, 0.6]) // n=3 < floor
    expect(deltaExceedsSigma(0.9, under)).toBe(false)
  })
})
