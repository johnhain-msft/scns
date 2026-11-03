/**
 * Phase D — the OFFLINE accept-vs-waste arm-value learner (plan §9 Phase D; PRIOR_ART §D legos).
 *
 * Prior-art adaptation, cited per mechanism:
 *   - KTO (Ethayarajh et al., ICML 2024, arXiv:2402.01306): learn from a per-output
 *     desirable/undesirable signal, OFFLINE, no pairs, no online self-reward RL. Adapted to SCNS's
 *     discrete arm policy: desirability = the stored `human_outcome` gradient (cardinal > raw ordinal —
 *     Kreutzer et al., ACL 2018, arXiv:1805.10627), aggregated per arm.
 *   - IPS / CRM-POEM (Joachims et al., WSDM 2017, arXiv:1608.04468; Swaminathan & Joachims, ICML 2015,
 *     arXiv:1502.02362): rows logged under the ε-exploration policy are inverse-propensity weighted
 *     (1/propensity), CLIPPED for variance control — the offline debias that makes logged outcomes
 *     usable at all.
 *   - IPO / ΨPO regularization (Azar et al., AISTATS 2024, arXiv:2310.12036): explicit shrinkage toward
 *     a prior so a run of unanimous accepts cannot collapse the estimate ("never flip on assumption",
 *     AGENTS.md #9). Implemented as n-scaled shrinkage: shrunk = (nEff·raw + k·prior)/(nEff + k).
 *   - Proxy-validity discipline (RealHumanEval arXiv:2404.02806; Ziegler arXiv:2205.06537; SPACE):
 *     acceptance is a BIASED proxy — this learner NEVER certifies. Its output is a PROPOSAL that must
 *     clear the held-out App-C.3 judge + paper-axis controls (the arm-frontier HCOPE gate) before any
 *     default flips, and the flip itself stays AWAITING-JOHN.
 *
 * REWARD-TAMPER ISOLATION (Everitt et al., Synthese 2021, arXiv:1908.04734) — enforced STRUCTURALLY and
 * unit-tested (test/unit/reward/kto-learner.test.ts): this package has NO import path to the judge, the
 * evaluator/gate, or any guardrail module, and NO write path to the experience store (SELECT-only). The
 * learner cannot touch its own reward signal or the gate that judges it.
 */
import { ARM_SAMPLE_WHERE, type ExperienceStore } from '../memory/experience-store.js'

/** One settled experience row projected for learning (arm + human outcome + logging propensity). */
export interface RewardExperienceRow {
  /** The fine arm that produced the row: `explore_arm` when explored, else the coarse retriever family. */
  readonly arm: string
  /** The settled human accept-vs-waste gradient [0,1]; null = unsettled (skipped by the learner). */
  readonly humanOutcome: number | null
  /** P(arm | logging policy) recorded at decision time; null = logged under the incumbent-always policy. */
  readonly propensity: number | null
}

export interface ArmValueEstimate {
  readonly arm: string
  /** Settled rows for this arm. */
  readonly n: number
  /** IPS effective sample size (Σw)²/Σw² — the honest support behind rawMean. */
  readonly effectiveN: number
  /** Clipped-IPS-weighted mean desirability. */
  readonly rawMean: number
  /** IPO-style shrinkage toward {@link prior} — the estimate policy decisions read. */
  readonly shrunkMean: number
  /** The shrinkage prior — the neutral gradient midpoint 0.5 (maximal uncertainty). */
  readonly prior: number
}

export interface LearnArmValuesOptions {
  /** The incumbent arm a proposal must beat. */
  readonly incumbent: string
  /** IPS weight clip (CRM variance control). Default 10. */
  readonly ipsClip?: number
  /** Shrinkage pseudo-count k (IPO regularization strength). Default 10. */
  readonly shrinkStrength?: number
  /** Minimum settled rows an arm needs before it can be proposed. Default 10. */
  readonly minN?: number
  /** Margin the challenger's shrunk mean must exceed the incumbent's by. Default 0.05. */
  readonly proposalMargin?: number
}

export interface LearnedArmValues {
  readonly estimates: readonly ArmValueEstimate[]
  /**
   * The argmax-shrunk-mean challenger IFF it has ≥ minN settled rows AND beats the incumbent's shrunk
   * mean by ≥ proposalMargin; null otherwise. A PROPOSAL for the evaluator gate — never a flip.
   */
  readonly proposedArm: string | null
  readonly incumbent: string
  /** ALWAYS false: certification is exclusively the held-out judge + controls gate's verdict. */
  readonly certified: false
  readonly notes: readonly string[]
}

/**
 * Learn per-arm desirability from settled rows (pure, deterministic). See the module doc for the
 * KTO/IPS/IPO mechanics. Unsettled rows are skipped; an unknown-propensity row weighs 1.
 */
export function learnArmValues(
  rows: readonly RewardExperienceRow[],
  opts: LearnArmValuesOptions,
): LearnedArmValues {
  const ipsClip = opts.ipsClip ?? 10
  const shrinkStrength = opts.shrinkStrength ?? 10
  const minN = opts.minN ?? 10
  const margin = opts.proposalMargin ?? 0.05

  const settled = rows.filter(
    (r): r is RewardExperienceRow & { humanOutcome: number } => r.humanOutcome !== null,
  )
  if (settled.length === 0) {
    return {
      estimates: [],
      proposedArm: null,
      incumbent: opts.incumbent,
      certified: false,
      notes: ['no settled human outcomes — nothing to learn'],
    }
  }

  // Clipped IPS weight per row (propensity null ⇒ 1: logged under the deployed incumbent policy).
  const weightOf = (r: RewardExperienceRow): number =>
    r.propensity !== null && r.propensity > 0 ? Math.min(ipsClip, 1 / r.propensity) : 1

  // Shrinkage prior = the NEUTRAL gradient midpoint (0.5, the 'ignored' anchor): a Beta(k/2,k/2)-style
  // uncertainty prior. Deliberately NOT the observed global mean — with data from a single arm the
  // global mean equals that arm's mean and the regularization would vanish, which is exactly the
  // unanimous-accept collapse IPO exists to prevent.
  const prior = 0.5

  const byArm = new Map<string, Array<RewardExperienceRow & { humanOutcome: number }>>()
  for (const r of settled) {
    if (!byArm.has(r.arm)) byArm.set(r.arm, [])
    byArm.get(r.arm)!.push(r)
  }

  const estimates: ArmValueEstimate[] = [...byArm.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([arm, armRows]) => {
      let sw = 0
      let sw2 = 0
      let swv = 0
      for (const r of armRows) {
        const w = weightOf(r)
        sw += w
        sw2 += w * w
        swv += w * r.humanOutcome
      }
      const rawMean = swv / sw
      const effectiveN = (sw * sw) / sw2
      const shrunkMean =
        (effectiveN * rawMean + shrinkStrength * prior) / (effectiveN + shrinkStrength)
      return { arm, n: armRows.length, effectiveN, rawMean, shrunkMean, prior }
    })

  const incumbentEst = estimates.find((e) => e.arm === opts.incumbent)
  const challengers = estimates.filter((e) => e.arm !== opts.incumbent && e.n >= minN)
  const best = challengers.reduce<ArmValueEstimate | null>(
    (acc, e) => (acc === null || e.shrunkMean > acc.shrunkMean ? e : acc),
    null,
  )
  const incumbentMean = incumbentEst?.shrunkMean ?? prior
  const proposedArm = best !== null && best.shrunkMean - incumbentMean >= margin ? best.arm : null

  const notes = [
    `IPS clip=${ipsClip}, shrink k=${shrinkStrength}, minN=${minN}, margin=${margin}`,
    proposedArm
      ? `PROPOSAL: '${proposedArm}' (shrunk ${best!.shrunkMean.toFixed(4)} vs incumbent ${incumbentMean.toFixed(4)}) — NOT certified; must clear the held-out judge + paper-axis controls gate, and any flip stays AWAITING-JOHN`
      : 'no challenger clears min-n + margin — incumbent stands (a measured null is a success)',
    'acceptance is a biased proxy (RealHumanEval/SPACE) — never optimized naked; gate on the judge axis',
  ]
  return { estimates, proposedArm, incumbent: opts.incumbent, certified: false, notes }
}

/**
 * READ-ONLY projection of the store's settled rows for the learner. Consumes the SAME
 * `ARM_SAMPLE_WHERE` the weekly report counts with, so the verdict and the report can never be
 * computed over different populations (SC-003). Arm identity is `explore_arm` alone — the predicate
 * guarantees it is non-null. Propensity comes from the first-class column, falling back to
 * `flag_state` JSON for pre-feature rows. SELECT-only by design (reward-tamper isolation) — this
 * module must never gain a write path to the store.
 *
 * The previous `r.explore_arm ?? r.retriever` was the THIRD copy of the discarded fallback keying and
 * the only one written in TypeScript, so the `grep -rn "COALESCE(explore_arm" src/` gate that T016 and
 * T086 specify passed while this line was still crediting unassigned rows to the incumbent.
 */
export function loadRewardRows(store: ExperienceStore): RewardExperienceRow[] {
  const raw = store.db
    .prepare(
      `SELECT retriever, explore_arm, human_outcome, propensity, flag_state
         FROM retrieval_experience
        WHERE ${ARM_SAMPLE_WHERE}`,
    )
    .all() as Array<{
    retriever: string
    explore_arm: string
    human_outcome: number
    propensity: number | null
    flag_state: string | null
  }>
  return raw.map((r) => {
    // T046 [US4]: the FIRST-CLASS propensity column (Foundational delta, clean IPS/DR) wins;
    // flag_state JSON remains the fallback for pre-feature rows.
    let propensity: number | null =
      typeof r.propensity === 'number' && Number.isFinite(r.propensity) ? r.propensity : null
    if (propensity === null && r.flag_state) {
      try {
        const flags = JSON.parse(r.flag_state) as { propensity?: unknown }
        if (typeof flags.propensity === 'number' && Number.isFinite(flags.propensity)) {
          propensity = flags.propensity
        }
      } catch {
        /* unparseable flag_state ⇒ propensity unknown */
      }
    }
    return { arm: r.explore_arm, humanOutcome: r.human_outcome, propensity }
  })
}
