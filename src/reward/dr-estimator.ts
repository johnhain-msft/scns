/**
 * T035 [US3] (specs/001-learning-memory-loop) — DOUBLY-ROBUST off-policy estimator
 * (Dudík, Langford, Li, ICML 2011, arXiv:1103.4601; docs/PRIOR_ART.md §C.3 #9 — the one true
 * algorithmic BUILD; clipped IPS and HCOPE pre-exist and are ADOPTED unchanged).
 *
 *   V̂_DR = mean over rows of [ Σ_a π(a|x)·r̂(x,a)  +  (π(a_i|x)/μ_i)·(r_i − r̂(x,a_i)) ]
 *
 * Unbiased when EITHER the reward model r̂ OR the logged propensities μ are correct; the importance
 * ratio is clipped with the same CRM convention as the kto-learner (default 10, Swaminathan &
 * Joachims 2015). Degenerate propensities (∉ (0,1]) are DROPPED and counted — never silently kept.
 *
 * Same reward-tamper isolation as the rest of `src/reward/` (Everitt et al. 2019, arXiv:1908.04734):
 * pure math, SELECT-nothing, writes nothing, no import path to the judge, the gate, or any guardrail.
 */

/** One logged decision: the arm the LOGGING policy took, its observed reward, and its propensity μ. */
export interface OffPolicyRow {
  readonly arm: string
  /** Observed reward for the taken arm (judge score or human_outcome, both ∈ [0,1] by convention). */
  readonly reward: number
  /** P(arm | logging policy) at decision time. Valid iff ∈ (0,1]. */
  readonly propensity: number
}

/** r̂(x, a): predicted reward for playing `arm` on this row's context. */
export interface RewardModel {
  predict(row: OffPolicyRow, arm: string): number
}

/** π(a | x): the target policy's probability of playing `arm` on this row's context. */
export interface Policy {
  prob(row: OffPolicyRow, arm: string): number
}

export interface DrEstimateOptions {
  /** Arms the direct term sums over. Default: the distinct arms observed in `rows`. */
  readonly arms?: readonly string[]
  /** Importance-ratio clip (CRM variance control). Default 10 — matches the kto-learner. */
  readonly ipsClip?: number
}

export interface DrResult {
  /** V̂_DR over the valid rows (0 when none — never NaN). */
  readonly value: number
  /** Rows supplied. */
  readonly n: number
  /** Rows actually used (valid propensity). */
  readonly nUsed: number
  /** Rows dropped for a degenerate propensity (≤0, >1, or non-finite). */
  readonly nDroppedInvalid: number
  /** Mean of the direct (model) term over used rows — the audit split. */
  readonly meanDirect: number
  /** Mean of the IPS-correction term over used rows. */
  readonly meanCorrection: number
}

/** Doubly-robust value estimate of `targetPolicy` from logged `rows` (see module header). */
export function drEstimate(
  rows: readonly OffPolicyRow[],
  rewardModel: RewardModel,
  targetPolicy: Policy,
  opts: DrEstimateOptions = {},
): DrResult {
  const ipsClip = opts.ipsClip ?? 10
  const arms = opts.arms ?? [...new Set(rows.map((r) => r.arm))]
  let used = 0
  let dropped = 0
  let directSum = 0
  let correctionSum = 0
  for (const row of rows) {
    const mu = row.propensity
    if (!Number.isFinite(mu) || mu <= 0 || mu > 1) {
      dropped++
      continue
    }
    used++
    let direct = 0
    for (const a of arms) direct += targetPolicy.prob(row, a) * rewardModel.predict(row, a)
    const ratio = Math.min(ipsClip, targetPolicy.prob(row, row.arm) / mu)
    const correction = ratio * (row.reward - rewardModel.predict(row, row.arm))
    directSum += direct
    correctionSum += correction
  }
  const meanDirect = used ? directSum / used : 0
  const meanCorrection = used ? correctionSum / used : 0
  return {
    value: meanDirect + meanCorrection,
    n: rows.length,
    nUsed: used,
    nDroppedInvalid: dropped,
    meanDirect,
    meanCorrection,
  }
}
