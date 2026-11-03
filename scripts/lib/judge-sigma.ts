/**
 * Pinned-judge σ (sigma) re-measure protocol (feature 002, task T008) — research R2/R7.
 *
 * The blind three-field judge (`src/memory/judge-provider.ts`, App C.3) is stochastic: grading the SAME
 * {question, gold, candidate} triple N times yields a small spread. That spread — the judge noise σ — is
 * the bar any comparative Δ must clear (a win requires Δ > σ, Constitution I). fable5 QUOTED "σ=0.0267"
 * with NO backing artifact; this module makes that impossible by codifying the protocol AND persisting the
 * raw variance artifact every quoted σ must resolve to.
 *
 * ## Re-measure protocol (run before any verdict trusts a σ)
 * 1. Pick a held-out {question, gold, candidate} triple representative of the corpus.
 * 2. Grade it N ≥ 5 times with the PINNED model (`claude-opus-4.8`) in SEPARATE, isolated, ephemeral judge
 *    sessions (never the generator/working session — the R2 anti-self-grading control).
 * 3. {@link measureJudgeSigma} over the N scores → sample σ (n−1). {@link archiveSigmaArtifact} the RAW
 *    scores to `docs/evidence/…-judge-sigma.json` so the number is backed.
 * 4. A comparative verdict may only claim a win when its Δ exceeds this freshly-archived σ.
 *
 * Pure + fs-only; the judge transport is NOT imported here (this codifies the statistic, not the spawn).
 */
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * The σ measured for the pinned judge in a PRIOR run (fable5). Retained ONLY as the expected order of
 * magnitude / regression reference — it is NOT authoritative on its own. Any DoD that quotes a σ MUST
 * re-measure and archive via this module first; do not cite this constant as evidence.
 */
export const PRIOR_MEASURED_SIGMA = 0.0267

/** The pinned grader model the protocol re-measures against. */
export const PINNED_JUDGE_MODEL = 'claude-opus-4.8'

/** Minimum repeats for a meaningful sample σ. */
export const MIN_SIGMA_SAMPLES = 5

/** A raw variance measurement — the artifact every quoted σ resolves to. */
export interface SigmaMeasurement {
  readonly model: string
  readonly item_id: string
  readonly n: number
  readonly mean: number
  readonly sigma: number
  readonly raw_scores: number[]
  readonly measured_at: string
  /** false when n < {@link MIN_SIGMA_SAMPLES}: the σ is under-powered and must not gate a verdict. */
  readonly powered: boolean
}

/**
 * Sample standard deviation (n−1) + mean of a judge's repeated scores. Throws on n < 2 (σ is undefined
 * for a single grade — a real, named failure, not a silent 0). Scores must be finite; NULL_JUDGE_SCORE
 * (−1) sentinels must be filtered out by the caller BEFORE measuring (they are "unscored", not a 0).
 */
export function computeJudgeSigma(scores: readonly number[]): { n: number; mean: number; sigma: number } {
  const bad = scores.find((s) => !Number.isFinite(s) || s < 0 || s > 1)
  if (bad !== undefined) {
    throw new Error(
      `computeJudgeSigma received an out-of-range score (${bad}) — rubric scores are [0,1]; filter ` +
        `NULL_JUDGE_SCORE (-1) "unscored" sentinels before measuring σ (a -1 must never enter the mean)`,
    )
  }
  const xs = scores
  if (xs.length < 2) {
    throw new Error(`computeJudgeSigma needs >= 2 scores to estimate σ (got ${xs.length})`)
  }
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1)
  return { n: xs.length, mean, sigma: Math.sqrt(variance) }
}

/** Build a full {@link SigmaMeasurement} (adds model/item/powered/timestamp around {@link computeJudgeSigma}). */
export function measureJudgeSigma(
  itemId: string,
  scores: readonly number[],
  model: string = PINNED_JUDGE_MODEL,
): SigmaMeasurement {
  const { n, mean, sigma } = computeJudgeSigma(scores)
  return {
    model,
    item_id: itemId,
    n,
    mean,
    sigma,
    raw_scores: [...scores],
    measured_at: new Date().toISOString(),
    powered: n >= MIN_SIGMA_SAMPLES,
  }
}

/** Persist the RAW variance artifact so any DoD quoting this σ resolves to a real file (R7). */
export function archiveSigmaArtifact(path: string, m: SigmaMeasurement): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(m, null, 2) + '\n', 'utf8')
}

/** Read back an archived σ artifact (for a verdict to cite the backed number). */
export function loadSigmaArtifact(path: string): SigmaMeasurement {
  return JSON.parse(readFileSync(path, 'utf8')) as SigmaMeasurement
}

/**
 * Is an observed Δ a real win against judge noise? A win requires Δ (strictly) greater than the measured,
 * powered σ (Constitution I). An under-powered σ (n < {@link MIN_SIGMA_SAMPLES}) never certifies a win.
 */
export function deltaExceedsSigma(delta: number, m: SigmaMeasurement): boolean {
  return m.powered && Number.isFinite(delta) && Math.abs(delta) > m.sigma
}
