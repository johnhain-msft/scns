/**
 * D2 — close the ideation feedback loop.
 *
 * D1 wrote proposals to the inbox and the prompt/synth already KNOW how to
 * consume `priorProposalOutcomes`, but nothing ever produced them. D2 supplies
 * the two missing halves, both deterministic (no LLM/ACP/network):
 *
 *   1. {@link linkOutcomes} — match still-open inbox records to realized signals
 *      (an implemented/failed/rejected suggestion of the same title-family) and
 *      stamp the record's `outcome` via the inbox.
 *   2. {@link buildPriorOutcomes} — turn outcome-bearing records into the
 *      `PriorProposalOutcome[]` the prompt renders and the synth novelty guard
 *      dedups against, so a landed idea is never re-proposed.
 *
 * Default-OFF: only `SCNS_IDEATE_FEEDBACK=1` wires this in; advisory either way.
 */

import type { IdeationInbox } from './inbox.js'
import type { IdeationOutcome, IdeationRecord, PriorProposalOutcome } from './types.js'

/** DEFAULT-OFF gate: feed prior outcomes + link realized fates only when set. */
export function feedbackEnabledFromEnv(env: NodeJS.ProcessEnv): boolean {
  return env.SCNS_IDEATE_FEEDBACK === '1'
}

/** Title-family key: lowercase, first 6 words — matches the synth novelty guard. */
export function titleFamily(title: string): string {
  return title.toLowerCase().trim().split(/\s+/).slice(0, 6).join(' ')
}

/** Realized fates of deterministic work, keyed by outcome result. */
export interface RealizedOutcomes {
  readonly implemented: readonly string[]
  readonly failed: readonly string[]
  readonly rejected: readonly string[]
}

/** Inbox records with a recorded outcome → the compact prompt/synth feedback shape. */
export function buildPriorOutcomes(records: readonly IdeationRecord[]): PriorProposalOutcome[] {
  return records
    .filter((r) => r.outcome != null)
    .map((r) => ({ title: r.title, outcome: r.outcome!.result }))
}

/**
 * Stamp outcomes onto open inbox records whose title-family matches a realized
 * suggestion. Pure planner: returns the (id, outcome) it would write so callers
 * can validate; pass an inbox to actually persist. Idempotent — skips records
 * that already carry an outcome.
 */
export function linkOutcomes(
  records: readonly IdeationRecord[],
  realized: RealizedOutcomes,
  now: () => Date = () => new Date(),
): ReadonlyArray<{ id: string; outcome: IdeationOutcome }> {
  const fam = new Map<string, IdeationOutcome['result']>()
  for (const t of realized.implemented) fam.set(titleFamily(t), 'implemented')
  for (const t of realized.rejected) fam.set(titleFamily(t), 'rejected')
  // failed loses to implemented/rejected only if it lands later; explicit no-action
  for (const t of realized.failed) if (!fam.has(titleFamily(t))) fam.set(titleFamily(t), 'no-action')

  const stamped: Array<{ id: string; outcome: IdeationOutcome }> = []
  const at = now().toISOString()
  for (const r of records) {
    if (r.outcome != null) continue
    const result = fam.get(titleFamily(r.title))
    if (result == null) continue
    stamped.push({ id: r.id, outcome: { result, detail: 'matched realized suggestion', recordedAt: at } })
  }
  return stamped
}

/** Apply {@link linkOutcomes} to a live inbox; returns how many records were stamped. */
export function applyLinkedOutcomes(
  inbox: IdeationInbox,
  realized: RealizedOutcomes,
  now?: () => Date,
): number {
  const stamped = linkOutcomes(inbox.list(), realized, now)
  for (const s of stamped) inbox.markOutcome(s.id, s.outcome)
  return stamped.length
}
