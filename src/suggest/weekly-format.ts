/**
 * How the weekly review PRESENTS itself.
 *
 * Kept pure and separate from the CLI action for the usual reason (I/O-free code is testable), but
 * also for a substantive one: what SCNS shows before asking determines the quality of the answer it
 * gets back. Bansal et al. (2021) found explanations raise human AGREEMENT without raising joint
 * accuracy — a persuasive pitch buys assent, not judgement. So an item is rendered as *evidence and
 * a stated selection rationale*, not as an argument for approving it, and the engagement warning is
 * shown to John rather than merely logged for the system's own use.
 */

import type { Suggestion } from './types.js'
import type { WeeklySession } from './weekly-session.js'
import { reasonCodesFor, type ReviewVerdict } from './review-reason.js'

/** The opening frame: what SCNS is asking for and why now. */
export function formatWeeklyHeader(session: WeeklySession): string {
  const { packet, engagement } = session
  const lines: string[] = ['', 'Weekly review', '─────────────']

  if (!session.hasWork) {
    lines.push('Nothing needs your judgement this week.')
    if (packet.totalUnexplained > 0) {
      lines.push(
        `(${packet.totalUnexplained} past decision(s) still carry no reason — run again once there is something pending to pair them with.)`,
      )
    }
    return lines.join('\n')
  }

  // FR-041: each numerator is printed against the denominator it was drawn from. `items` merges the
  // pending and backfill pools, so `items.length` is a fraction of neither — printing it over
  // `totalPending` is what produced "5 of 13" for a 3-pending selection.
  lines.push(
    `${packet.selectedPending} of ${packet.totalPending} pending item(s) selected — the ones where your answer would tell me the most.`,
  )
  // FR-041 again: `selectedEscalated` was computed and never printed, so the header claimed to
  // describe a packet of N items while the loop presented N+E of them — the same miscount, one
  // pool later.
  //
  // FOURTH PASS — the subject is the BUILD, not John. This read "proposal(s) you approved", which
  // is false for every auto-approved escalation, and auto-approval is live on the plist. The pool
  // is mixed, so the only honest shared subject is what actually happened to it.
  if (packet.selectedEscalated > 0) {
    const more =
      packet.totalEscalated > packet.selectedEscalated
        ? ' Use `--budget N` to see more of them in one sitting.'
        : ''
    lines.push(
      `${packet.selectedEscalated} of ${packet.totalEscalated} approved proposal(s) that the build could not land are in this packet too — they need "try again" or "close it", and they are counted separately.${more}`,
    )
  }
  if (packet.nonActionablePending > 0) {
    lines.push(
      `(${packet.nonActionablePending} further pending proposal(s) are marked non-actionable, so they are not eligible for review and sit outside that count.)`,
    )
  }
  if (packet.selectedBackfill > 0) {
    lines.push(
      `${packet.selectedBackfill} of ${packet.totalUnexplained} past decision(s) with no recorded reason are in this packet too — a separate pool, counted separately. I can only learn from the ones you explain.`,
    )
  } else if (packet.totalUnexplained > 0) {
    lines.push(
      `${packet.totalUnexplained} past decision(s) have no recorded reason. I can only learn from the ones you explain.`,
    )
  }

  // The guard speaks to the human, not about him. A warning that only the system can see would be
  // an audit trail; shown here it is a chance to correct course.
  if (engagement.flags.length > 0 && engagement.sufficientData) {
    lines.push('', 'Before we start — about how these reviews have been going:')
    for (const f of engagement.flags) lines.push(`  · ${f}`)
    lines.push(
      '  If a proposal is wrong, saying so is worth far more to me than another yes.',
    )
  }

  return lines.join('\n')
}

/** One proposal, with the evidence behind it and why it earned a slot this week. */
export function formatReviewItem(
  s: Suggestion,
  index: number,
  total: number,
  why: string,
): string {
  const lines: string[] = [
    '',
    `── ${index} of ${total} ${'─'.repeat(Math.max(0, 40 - String(index).length))}`,
    `${s.title}`,
    `   type: ${s.type}   confidence: ${s.confidence.toFixed(2)}   id: ${s.id}`,
    `   selected because: ${why}`,
  ]
  if (s.description) {
    lines.push('', ...s.description.split('\n').map((l) => `   ${l}`))
  }
  // The spec is the reviewable object. Without it the reader gets a pattern-observation and no way
  // to know what approving would actually do — the failure the first live review exposed.
  if (s.implementationPlan) {
    lines.push('', ...s.implementationPlan.split('\n').map((l) => (l ? `   ${l}` : '')))
  } else {
    lines.push(
      '',
      '   ⚠ no implementation spec — this proposal has not been worked up yet.',
      "     Answer `explain` rather than guessing; that is recorded as a gap in the proposal,",
      '     not as a verdict on the idea.',
    )
  }
  if (s.evidence && s.evidence.length > 0) {
    lines.push('', '   evidence:')
    for (const e of s.evidence) lines.push(`     · [${e.source}] ${e.detail}`)
  }
  return lines.join('\n')
}

/** The taxonomy for this verdict — offered, never inferred from prose. */
export function formatReasonMenu(verdict: ReviewVerdict): string {
  const codes = reasonCodesFor(verdict)
  const entries = Object.entries(codes)
  if (entries.length === 0) return ''
  const width = Math.max(...entries.map(([c]) => c.length))
  return [
    `   why? pick a code (or just type your own words):`,
    ...entries.map(([c, d]) => `     ${c.padEnd(width)}  ${d}`),
  ].join('\n')
}

export interface WeeklyClosing {
  readonly recorded: number
  readonly skipped: number
  readonly refused: number
}

/** What actually landed. Refusals are reported, not silently swallowed. */
export function formatWeeklyClosing(c: WeeklyClosing): string {
  const lines = ['', `Recorded ${c.recorded} decision(s) with your reasoning.`]
  if (c.skipped > 0) lines.push(`Skipped ${c.skipped} — they stay pending for next time.`)
  if (c.refused > 0) {
    lines.push(
      `${c.refused} verdict(s) came without a reason and were NOT recorded — a decision I can't explain teaches me nothing, so I'd rather ask again next week.`,
    )
  }
  return lines.join('\n')
}
