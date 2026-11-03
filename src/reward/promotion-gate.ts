/**
 * THE PROMOTION GATE — the statistical rule that decides whether a challenger arm may replace the
 * incumbent.
 *
 * This logic previously lived only in `scripts/locomo-judge-lib.ts`, i.e. inside the offline judged
 * harness, which had a consequence worth stating plainly: `reward-report-run.ts` declares a
 * {@link PromotionFn} seam, but the broker's scheduled `reward-report` task calls `runRewardReport()`
 * with no `promotion` argument, and the verdict block is guarded by `if (learned.proposedArm &&
 * opts.promotion)`. **So on the live path the promotion verdict was never computed at all** — only
 * the offline script ever evaluated it.
 *
 * It is moved here (not copied — `scripts/locomo-judge-lib.ts` now re-exports from this module, so
 * there is exactly one implementation and no drifting second copy) so the live broker can compute
 * the verdict and turn it into something John can actually rule on.
 *
 * ## The rule
 *
 * A challenger promotes ONLY when its mean settled human outcome beats the incumbent's with a
 * POSITIVE one-sided 95% Welch lower bound, `d̄ − z·√(s²c/nc + s²i/ni)` with `z = 1.645`, at adequate
 * support on BOTH sides (`minN` each — a two-anecdote "win" never promotes). Anything else is an
 * honestly-reported null and the incumbent stands.
 *
 * This is the safe-policy-improvement posture of Thomas et al. 2015 (HCOPE / HCPI): act only on a
 * high-confidence lower bound, and prefer "no change" to an unsupported change.
 *
 * ⚠ **A standing caveat the caller must carry.** The bound is only a valid lower bound if the
 * propensities are correct (Dudík et al. 2011). SCNS currently logs a uniform `propensity = 0.5` for
 * every explored row, so until that is replaced by a fitted model the guarantee is nominal rather
 * than earned. This function is deliberately still worth running — but its verdict is an input to a
 * HUMAN decision here, never an automatic flip.
 *
 * Throws on out-of-range outcomes: a malformed reward row must never silently shape a promotion.
 */

export interface HumanPromotionRow {
  readonly arm: string
  readonly humanOutcome: number
  readonly propensity: number | null
}

export interface HumanPromotionVerdict {
  readonly promote: boolean
  readonly challenger: string
  readonly incumbent: string
  readonly nChallenger: number
  readonly nIncumbent: number
  readonly challengerMean: number
  readonly incumbentMean: number
  /** One-sided 95% Welch lower bound on (challenger − incumbent) mean human outcome. */
  readonly deltaLowerBound: number
  readonly reason: string
}

export function humanOutcomePromotion(
  rows: readonly HumanPromotionRow[],
  opts: { challenger: string; incumbent: string; minN?: number; z?: number },
): HumanPromotionVerdict {
  const minN = opts.minN ?? 5
  const z = opts.z ?? 1.645
  for (const r of rows) {
    if (!Number.isFinite(r.humanOutcome) || r.humanOutcome < 0 || r.humanOutcome > 1) {
      throw new Error(`humanOutcomePromotion: outcome out of [0,1]: ${r.humanOutcome} (${r.arm})`)
    }
  }
  const of = (arm: string): number[] => rows.filter((r) => r.arm === arm).map((r) => r.humanOutcome)
  const c = of(opts.challenger)
  const i = of(opts.incumbent)
  const m = (xs: readonly number[]): number =>
    xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
  const sampleVar = (xs: readonly number[]): number => {
    if (xs.length < 2) return 0
    const mu = m(xs)
    return xs.reduce((a, x) => a + (x - mu) * (x - mu), 0) / (xs.length - 1)
  }
  const challengerMean = m(c)
  const incumbentMean = m(i)
  const base = {
    challenger: opts.challenger,
    incumbent: opts.incumbent,
    nChallenger: c.length,
    nIncumbent: i.length,
    challengerMean,
    incumbentMean,
  }
  if (c.length < minN || i.length < minN) {
    return {
      ...base,
      promote: false,
      deltaLowerBound: Number.NEGATIVE_INFINITY,
      reason: `insufficient support (challenger n=${c.length}, incumbent n=${i.length}, minN=${minN}) — the static policy stands`,
    }
  }
  const deltaLowerBound =
    challengerMean - incumbentMean - z * Math.sqrt(sampleVar(c) / c.length + sampleVar(i) / i.length)
  const promote = deltaLowerBound > 0
  return {
    ...base,
    promote,
    deltaLowerBound,
    reason: promote
      ? `challenger beats the static policy on settled human outcomes (one-sided 95% LB ${deltaLowerBound.toFixed(4)} > 0)`
      : `no certified human-outcome win (lower bound ${deltaLowerBound.toFixed(4)} ≤ 0) — the static policy stands (an honest null)`,
  }
}
