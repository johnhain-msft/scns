/**
 * Phase D — pure renderer for the offline reward-learner report (scripts/reward-report.ts wires it to
 * a READ-ONLY store handle). Lives in src/reward/ and therefore inherits the Everitt isolation
 * contract (no judge/gate/guardrail imports, no store writes) enforced by the package's structural
 * tests — this module only formats already-computed estimates.
 */
import type { LearnedArmValues } from './kto-learner.js'

const f4 = (x: number): string => x.toFixed(4)

/**
 * T048 [US4] — optional gate-side extras the entrypoint composes (structural shapes, so this module
 * keeps ZERO imports beyond the learner: Everitt isolation is preserved — the report renders
 * decisions, it never makes them).
 */
export interface RewardReportExtras {
  /** Per-arm doubly-robust value estimates (src/reward/dr-estimator.ts results). */
  readonly drByArm?: Readonly<
    Record<
      string,
      { readonly value: number; readonly nUsed: number; readonly nDroppedInvalid: number }
    >
  >
  /** The SC-008 promotion verdict over settled human outcomes (computed by the gate side). */
  readonly promotion?: {
    readonly promote: boolean
    readonly challenger: string
    readonly deltaLowerBound: number
    readonly reason: string
  }
}

/** Render a LearnedArmValues result as a deterministic human-readable report (one string, no I/O). */
export function formatRewardReport(
  learned: LearnedArmValues,
  extras: RewardReportExtras = {},
): string {
  const lines: string[] = []
  lines.push('=== Phase D — offline accept-vs-waste arm-value report (KTO/IPO + clipped IPS) ===')
  lines.push(
    `incumbent: ${learned.incumbent}   certified: ${learned.certified} (always — the gate certifies, not the learner)`,
  )
  if (learned.estimates.length === 0) {
    lines.push(
      'no settled human outcomes yet — nothing to learn (the store accumulates as verdicts land)',
    )
  } else {
    lines.push('arm            n    effN     rawMean  shrunkMean  (prior 0.5)')
    for (const e of learned.estimates) {
      lines.push(
        `${e.arm.padEnd(13)} ${String(e.n).padStart(3)}  ${f4(e.effectiveN).padStart(7)}  ${f4(e.rawMean)}   ${f4(e.shrunkMean)}`,
      )
    }
    lines.push(
      learned.proposedArm
        ? `PROPOSAL: '${learned.proposedArm}' — NOT a flip; must clear the held-out judge + paper-axis controls gate (AWAITING-JOHN)`
        : 'no proposal — the incumbent stands (a measured null is a success)',
    )
  }
  if (extras.drByArm && Object.keys(extras.drByArm).length > 0) {
    lines.push(
      'doubly-robust value (Dudík 2011; unbiased if EITHER the model OR the propensities hold):',
    )
    for (const [arm, dr] of Object.entries(extras.drByArm)) {
      lines.push(
        `  DR[${arm.padEnd(13)}] = ${f4(dr.value)}  (nUsed=${dr.nUsed}, invalid-propensity dropped=${dr.nDroppedInvalid})`,
      )
    }
  }
  if (extras.promotion) {
    const p = extras.promotion
    lines.push(
      p.promote
        ? `PROMOTION: PROMOTE '${p.challenger}' — one-sided 95% LB ${f4(p.deltaLowerBound)} > 0`
        : `PROMOTION: HOLD the incumbent — LB ${f4(p.deltaLowerBound)} ≤ 0 (challenger '${p.challenger}')`,
    )
    lines.push(`  evidence: ${p.reason}`)
  }
  for (const n of learned.notes) lines.push(`note: ${n}`)
  return lines.join('\n')
}
