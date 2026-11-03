/**
 * THE ANTI-RUBBER-STAMP GUARD — is the human still actually thinking?
 *
 * John's stated goal is that SCNS "needs me less and less" until automated promotion becomes
 * genuinely safe. The obvious way to measure progress toward that is agreement: if he keeps saying
 * yes, the system must be getting good. That inference is exactly wrong, and the literature is
 * unusually pointed about it:
 *
 * - **Mosier & Skitka (1996, 1999)** — automation bias. Humans supervising a capable automated
 *   system drift into omission and commission errors, accepting outputs they would have caught had
 *   they been deciding unaided. Requiring an explicit justification is one of the few interventions
 *   shown to suppress it, which is why an approval here must carry a reason at all.
 * - **Bansal et al. (2021, CHI)** — explanations reliably increase human AGREEMENT with a model
 *   without increasing the accuracy of the joint human+model team. A well-argued proposal earns
 *   assent whether or not it earns it on the merits, so a rising approval rate is *evidence of
 *   persuasion at least as much as evidence of quality*.
 *
 * Together those say a naive readiness rule — "agreement is high, therefore graduate" — measures the
 * wrong thing and will graduate the system precisely when the human has stopped scrutinising it.
 * This module is the counterweight: it can only ever BLOCK an autonomy raise, never grant one.
 *
 * ## What it looks at
 *
 * 1. **Approval rate.** High assent is the precondition for concern, never the sole trigger.
 * 2. **Reason-code entropy.** A human genuinely evaluating varied proposals reaches for varied
 *    reasons. Collapse onto one code is the signature of a reflex rather than a judgement.
 * 3. **Reason effort.** Perfunctory text ("sure ok fine") alongside high assent is the classic
 *    pattern. Length is a coarse proxy for engagement, and is treated as corroborating evidence
 *    rather than proof.
 * 4. **Recent disagreement.** In the spirit of the Seldonian rule (Thomas et al. 2019) — no solution
 *    beats a wrong one — a human who has not disagreed with anything recently has not demonstrated
 *    that he *would*. Without that demonstration his approvals carry no information, so escalation
 *    is blocked outright regardless of how good everything else looks.
 *
 * ⚠ **Acknowledged invention.** The research pass found no published operationalisation of
 * rubber-stamp detection; the thresholds below are ours, chosen to be conservative in the direction
 * that costs least (a false "not ready" merely delays autonomy, a false "ready" hands over control
 * to a system nobody is checking). They are constants to be tuned against real data, not findings.
 */

import { REJECT_REASON_CODES, APPROVE_REASON_CODES } from './review-reason.js'

/** Below this many recorded reviews, engagement is simply not assessable. */
export const MIN_ASSESSABLE_REVIEWS = 5

/** Assent above this rate is the precondition for a rubber-stamp concern (never the sole trigger). */
export const APPROVAL_RATE_CEILING = 0.9

/** Normalised reason-code entropy below this counts as concentrated. */
export const MIN_REASON_ENTROPY = 0.25

/** Mean reason length below this counts as perfunctory. */
export const MIN_MEAN_REASON_CHARS = 25

/** The human must have disagreed at least once within this many most-recent reviews. */
export const DISAGREEMENT_WINDOW = 10

/** Total taxonomy size — the denominator that makes entropy comparable across histories. */
const TAXONOMY_SIZE =
  Object.keys(REJECT_REASON_CODES).length + Object.keys(APPROVE_REASON_CODES).length

export interface ReviewRecord {
  readonly verdict: 'approve' | 'reject'
  /** Taxonomy code the human picked, or null when he gave only free text. */
  readonly code: string | null
  /** The human's own words. */
  readonly text: string
  readonly at: string
}

export interface EngagementAssessment {
  readonly n: number
  readonly sufficientData: boolean
  readonly approvalRate: number
  /** Shannon entropy over reason codes, normalised to [0,1] by the taxonomy size. */
  readonly reasonEntropy: number
  readonly meanReasonLength: number
  readonly disagreedRecently: boolean
  readonly rubberStamping: boolean
  /** True only when nothing blocks an autonomy raise. This module never grants one by itself. */
  readonly readyToEscalate: boolean
  /** Human-readable reasons for any block — surfaced to John, never silently applied. */
  readonly flags: readonly string[]
}

/**
 * Normalised Shannon entropy over reason codes.
 *
 * A missing code is folded into a single shared `(none)` bucket rather than being ignored. That is
 * deliberate: treating unlabelled reviews as absent from the distribution would let a history with
 * NO structured reasons at all appear perfectly diverse, which is the opposite of the truth.
 */
function reasonEntropy(records: readonly ReviewRecord[]): number {
  if (records.length === 0) return 0
  const counts = new Map<string, number>()
  for (const r of records) {
    const key = r.code ?? '(none)'
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  if (counts.size <= 1) return 0
  const n = records.length
  let h = 0
  for (const c of counts.values()) {
    const p = c / n
    h -= p * Math.log2(p)
  }
  return Math.min(1, h / Math.log2(TAXONOMY_SIZE))
}

/**
 * Assess whether the human's review behaviour still carries information.
 *
 * Returns `readyToEscalate: false` whenever anything is off — including simply not having enough
 * evidence to tell. The asymmetry is intentional: this guard's only job is to withhold permission.
 */
export function assessEngagement(records: readonly ReviewRecord[]): EngagementAssessment {
  const n = records.length
  const sufficientData = n >= MIN_ASSESSABLE_REVIEWS
  const approvals = records.filter((r) => r.verdict === 'approve').length
  const approvalRate = n === 0 ? 0 : approvals / n
  const entropy = reasonEntropy(records)
  const meanReasonLength =
    n === 0 ? 0 : records.reduce((a, r) => a + (r.text?.trim().length ?? 0), 0) / n
  const window = records.slice(-DISAGREEMENT_WINDOW)
  const disagreedRecently = window.some((r) => r.verdict === 'reject')

  const flags: string[] = []
  if (!sufficientData) {
    flags.push(`only ${n} recorded review(s) — need ${MIN_ASSESSABLE_REVIEWS} before engagement is assessable`)
  }

  const highApproval = approvalRate > APPROVAL_RATE_CEILING
  const lowEntropy = entropy < MIN_REASON_ENTROPY
  const lowEffort = meanReasonLength < MIN_MEAN_REASON_CHARS

  // High assent alone is not a fault — it may simply mean the proposals were good. It becomes a
  // concern only when paired with evidence that the assent was cheap to give.
  const rubberStamping = sufficientData && highApproval && (lowEntropy || lowEffort)
  if (rubberStamping) {
    if (lowEntropy) {
      flags.push(
        `approval rate ${(approvalRate * 100).toFixed(0)}% with the same reason repeated (normalised entropy ${entropy.toFixed(2)} < ${MIN_REASON_ENTROPY}) — looks like a reflex, not a judgement`,
      )
    }
    if (lowEffort) {
      flags.push(
        `approval rate ${(approvalRate * 100).toFixed(0)}% with low-effort reasons (mean ${meanReasonLength.toFixed(0)} chars < ${MIN_MEAN_REASON_CHARS}) — too short to show engagement`,
      )
    }
  }

  if (sufficientData && !disagreedRecently) {
    flags.push(
      `no disagreement in the last ${Math.min(DISAGREEMENT_WINDOW, n)} reviews — until you push back on something, agreement carries no information`,
    )
  }

  return {
    n,
    sufficientData,
    approvalRate,
    reasonEntropy: entropy,
    meanReasonLength,
    disagreedRecently,
    rubberStamping,
    readyToEscalate: sufficientData && !rubberStamping && disagreedRecently,
    flags,
  }
}
