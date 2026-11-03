/**
 * Phase D — the reward-learner report CORE, shared by the CLI entrypoint (`scripts/reward-report.ts`)
 * and the broker's scheduled `reward-report` task.
 *
 * Extracted so the scheduled consumer REUSES the existing entrypoint's logic instead of growing a
 * second, drifting copy of it (the `__fleet__` redundant-lane mistake). The store is opened STRICTLY
 * READ-ONLY (`readonly` + `fileMustExist`), so neither caller can create or mutate it even by bug:
 * the learner observes the accept-vs-waste rows, it never writes them and never flips a default.
 *
 * The INCUMBENT is the arm the live briefing path actually serves. It was hardcoded to `'hybrid'`,
 * which is the `search:` handler's arm — the briefing path (which carries essentially all real human
 * traffic) serves `magma` unless `SCNS_LIVE_MEMORY_BRIEFING` says otherwise. Mislabelling the
 * incumbent makes the learner contrast the challenger against an arm that has no settled rows.
 *
 * STATUS (Step 2, 2026-08-15): PARKED, not deleted. The purpose frame (NORTH_STAR "Retrieval design
 * intent", 2026-08-14) retired the incumbent/challenger comparison — the weekly review now renders
 * routing accuracy from `reward/routing-accuracy.ts` and no longer calls this module. The scheduled
 * `reward-report` task and `scripts/reward-report.ts` still run it read-only; its `promotion` seam has
 * no live caller. Removal is a later, separate decision.
 */
import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveScnsHome } from '../shared/scns-home.js'
import { learnArmValues, loadRewardRows, type LearnedArmValues } from './kto-learner.js'
import { drEstimate, type OffPolicyRow } from './dr-estimator.js'
import { formatRewardReport, type RewardReportExtras } from './report.js'
import type { HumanPromotionVerdict } from './promotion-gate.js'
import { BRIEFING_CHALLENGER_ARMS, resolveBriefingDefaultTool } from '../memory/explore-router.js'

/**
 * Support required on BOTH arms before the verdict is even attempted.
 *
 * MIRRORS `humanOutcomePromotion`'s own `opts.minN ?? 5` (`promotion-gate.ts:58`), which is not
 * exported and must not be changed (A2/A2a: that file stays byte-identical). Duplicating a constant
 * invites drift, so the coupling is pinned behaviourally by a test that asserts the gate refuses at
 * PROMOTION_MIN_N - 1 and produces a verdict at PROMOTION_MIN_N.
 */
const PROMOTION_MIN_N = 5

/**
 * Resolve the store through `resolveScnsHome()` — NOT `homedir()` — so an isolated dev/test broker
 * (`SCNS_HOME=$(mktemp -d)`) reads ITS OWN experience store. Resolved per call, not frozen at import,
 * because the override is set by the harness that spawns the broker. Using `homedir()` here made a
 * sandboxed probe silently report on the LIVE production rows while believing it was isolated.
 */
export function resolveExperienceStorePath(): string {
  return join(resolveScnsHome(), '.scns', 'memory', 'experience.db')
}

/**
 * Promotion verdict seam — injected so the core stays free of the judged-harness import.
 *
 * The verdict TYPE now lives in `src/reward/promotion-gate.ts` (moved out of the harness script so
 * the broker could reach it), so this is a type-only import and adds no runtime dependency.
 */
export type PromotionFn = (
  rows: ReadonlyArray<{ arm: string; humanOutcome: number; propensity: number | null }>,
  opts: { challenger: string; incumbent: string },
) => HumanPromotionVerdict

/**
 * @deprecated drift-era name — the briefing's DEFAULT tool, not an "incumbent" (there is no
 * challenger under purpose routing; NORTH_STAR 2026-08-14). Delegates to
 * {@link resolveBriefingDefaultTool} so behaviour is byte-identical; kept for this parked learner's
 * own `incumbent` option and its tests. New code uses `resolveBriefingDefaultTool` /
 * `resolveBriefingTools` from `memory/explore-router.ts`.
 */
export function resolveLiveIncumbent(env: NodeJS.ProcessEnv = process.env): string {
  return resolveBriefingDefaultTool(env)
}

export interface RewardReportResult {
  readonly ok: boolean
  readonly text: string
  readonly settledRows: number
  readonly arms: readonly string[]
  /**
   * The learner's structured output. Previously the verdict existed only INSIDE the rendered `text`,
   * so a programmatic caller could read the report but not act on it — which is why nothing ever
   * turned a proposal into something the human could rule on. Exposed so the weekly review can build
   * a reviewable proposal from the same numbers the report prints, with no second code path.
   */
  readonly learned?: LearnedArmValues
  /** The promotion verdict, present only when a {@link PromotionFn} was injected AND an arm was proposed. */
  readonly promotion?: HumanPromotionVerdict
}

/**
 * Run the learner over the settled rows and RENDER the report. Never throws for the ordinary
 * "not enough data yet" case — an honest `insufficient-data` report is the CORRECT first output.
 */
export function runRewardReport(
  opts: {
    readonly path?: string
    readonly incumbent?: string
    readonly promotion?: PromotionFn
  } = {},
): RewardReportResult {
  const path = opts.path ?? resolveExperienceStorePath()
  if (!existsSync(path)) {
    return {
      ok: false,
      text: `no experience store at ${path} — nothing to report (the live broker creates it on first retrieval)`,
      settledRows: 0,
      arms: [],
    }
  }
  const incumbent = opts.incumbent ?? resolveLiveIncumbent()
  const db = new Database(path, { readonly: true, fileMustExist: true })
  try {
    const rows = loadRewardRows({ db, close: () => db.close() })
    const learned = learnArmValues(rows, { incumbent })

    const offRows: OffPolicyRow[] = rows
      .filter((r) => r.humanOutcome !== null)
      .map((r) => ({ arm: r.arm, reward: r.humanOutcome!, propensity: r.propensity ?? 1 }))
    const shrunkByArm = new Map(learned.estimates.map((e) => [e.arm, e.shrunkMean]))
    const rewardModel = { predict: (_r: OffPolicyRow, a: string) => shrunkByArm.get(a) ?? 0.5 }
    const arms = [...new Set(offRows.map((r) => r.arm))]
    const drByArm: Record<string, { value: number; nUsed: number; nDroppedInvalid: number }> = {}
    for (const arm of arms) {
      const res = drEstimate(offRows, rewardModel, { prob: (_r, a) => (a === arm ? 1 : 0) }, { arms })
      drByArm[arm] = { value: res.value, nUsed: res.nUsed, nDroppedInvalid: res.nDroppedInvalid }
    }
    const extras: RewardReportExtras = { drByArm }
    let verdict: HumanPromotionVerdict | undefined
    const promotionRows = rows
      .filter((r) => r.humanOutcome !== null)
      .map((r) => ({ arm: r.arm, humanOutcome: r.humanOutcome!, propensity: r.propensity }))
    // T032 / spec Decision 5 (approved by John 2026-08-01): gate the verdict on SUPPORT, not on
    // `learnArmValues` having proposed an arm. `learnArmValues` proposes only when the gap also clears
    // its own `proposalMargin`, so two well-sampled but CLOSE arms yielded `proposedArm === null` and
    // the report showed no verdict at all — rendering "too close to call" as silence, which a reader
    // cannot tell from "nobody looked". Only this invocation condition changes: `learnArmValues`'
    // minN/margin and `promotion-gate.ts` are untouched.
    const challenger =
      learned.proposedArm ?? BRIEFING_CHALLENGER_ARMS.find((a) => a !== incumbent) ?? null
    const support = (arm: string): number => promotionRows.filter((r) => r.arm === arm).length
    if (
      opts.promotion &&
      challenger !== null &&
      support(challenger) >= PROMOTION_MIN_N &&
      support(incumbent) >= PROMOTION_MIN_N
    ) {
      verdict = opts.promotion(promotionRows, { challenger, incumbent })
      ;(extras as { promotion?: RewardReportExtras['promotion'] }).promotion = {
        promote: verdict.promote,
        challenger: verdict.challenger,
        deltaLowerBound: verdict.deltaLowerBound,
        reason: verdict.reason,
      }
    }
    return {
      ok: true,
      text:
        `store: ${path} (read-only) — ${rows.length} settled row(s), incumbent=${incumbent}\n` +
        formatRewardReport(learned, extras),
      settledRows: rows.length,
      arms,
      learned,
      ...(verdict ? { promotion: verdict } : {}),
    }
  } finally {
    db.close()
  }
}
