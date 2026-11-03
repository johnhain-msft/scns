/**
 * Phase D — the HUMAN accept-vs-waste outcome signal (plan §9 Phase D; the north-star reward).
 *
 * The gradient sits on the SAME 6-pt scale as the App-C.3 LLM-Judge rubric (1.0/0.8/0.6/0.4/0.2/0.0),
 * so human and judge outcomes are directly comparable columns of one experience row. The implicit
 * emitting surface wired here is the D2b proposal-outcome verdict (suggest/outcome-writer.ts): a
 * proposal the human implemented/merged = ACCEPTED; rejected/failed = WASTE; reverted = HARD WASTE
 * (cost time AND was undone). `needs-human` is PENDING — never written as a score.
 *
 * PROXY-VALIDITY DISCIPLINE (PRIOR_ART §D — RealHumanEval arXiv:2404.02806 / Ziegler arXiv:2205.06537 /
 * SPACE): acceptance is a BIASED proxy for value — it must NEVER be optimized naked. Every consumer of
 * `human_outcome` (the src/reward learner) is gated on the held-out judge + paper-axis controls before
 * any policy change, and this module only WRITES the signal; it makes no decision.
 *
 * CREDIT ASSIGNMENT (trap #3 — sparse/delayed signal): the outcome of a proposal binds back to the
 * retrievals that INFORMED it. Until a per-suggestion experience-id linkage exists, the bounded,
 * auditable binding is entity-scoped: settle the newest UNSETTLED rows whose query names the entity the
 * proposal targeted (cap default 3, never overwriting an existing outcome). Imprecise but honest —
 * every settle returns the exact row ids for the audit trail.
 */
import { settleHumanOutcome, type ExperienceStore } from './experience-store.js'
import type { ProposalVerdict } from './proposal-outcomes.js'

/** The 6-pt App-C.3-aligned behavioral gradient (1.0 accepted … 0.0 wasted). */
export const HUMAN_OUTCOME_GRADIENT = {
  /** Landed as proposed (implemented/merged) — the human accepted the outcome. */
  accepted: 1.0,
  /** Landed after human edits — accepted, with friction. */
  acceptedEdited: 0.8,
  /** Partially used (e.g. passed the quality gate but not yet landed by the human). */
  partiallyUsed: 0.6,
  /** Ignored — surfaced, never acted on. */
  ignored: 0.4,
  /**
   * Rejected — the human deemed it not worth it.
   *
   * `failed` deliberately does NOT map here. See {@link humanOutcomeOfVerdict}.
   */
  waste: 0.2,
  /** Reverted — cost time AND had to be undone. The hard waste anchor. */
  hardWaste: 0.0,
} as const

/**
 * Implicit accept-vs-waste from the D2b proposal verdict. `needs-human` (pending), `failed` (a build
 * failure) and `null`-ish unknowns return null — a pending state is never a score, and neither is a
 * machine failure.
 *
 * **`failed` returns null by John's ruling of 2026-08-04 (FR-059, Phase 10f §16).** It previously
 * scored `waste` (0.2), which contradicted FR-059's own reasoning: `failed` was removed from
 * `FAILED_VERDICTS` because a build failure says nothing about whether the human wanted the
 * outcome, yet the north-star metric still read it as his displeasure. That is this phase's defect
 * — the machine's inability to build something being counted as the human's refusal — surviving in
 * the one place it does the most damage.
 *
 * Neutral is `null` rather than a 0.5 midpoint on purpose. The honest statement is "this is not
 * evidence about what he values", and `null` settles nothing (`outcome-writer.ts:256`); a midpoint
 * would still be a datum, and would still move the mean.
 *
 * ⚠️ This retires half of T156, which was written to catch an UNDISCLOSED version of this exact
 * change. The retirement is disclosed, dated, attributed, and the test now pins the new invariant
 * plus a positive control. The other half of T156 stands: the ledger still records `failed`, so the
 * FACT of the failure is kept and only its reading as human displeasure is dropped.
 */
export function humanOutcomeOfVerdict(verdict: ProposalVerdict): number | null {
  switch (verdict) {
    case 'implemented':
    case 'merged':
      return HUMAN_OUTCOME_GRADIENT.accepted
    case 'passed-gate':
      return HUMAN_OUTCOME_GRADIENT.partiallyUsed
    case 'rejected':
      return HUMAN_OUTCOME_GRADIENT.waste
    case 'reverted':
      return HUMAN_OUTCOME_GRADIENT.hardWaste
    case 'failed':
    case 'needs-human':
      return null
  }
}

/**
 * Implicit behavioral cues observed on a delivered answer (T025 [US2]) — the lightweight signals a
 * live surface can emit without an explicit verdict: the human USED the answer as-is, EDITED it
 * before using it (the previously-unreachable `acceptedEdited` anchor), or immediately RE-ASKED the
 * same question (the answer failed to serve — waste, not hard waste: nothing had to be undone).
 */
export type ImplicitCue = 'used' | 'edited' | 're-asked'

/** Map an implicit cue onto the 6-pt gradient. */
export function humanOutcomeOfCue(cue: ImplicitCue): number {
  switch (cue) {
    case 'used':
      return HUMAN_OUTCOME_GRADIENT.accepted
    case 'edited':
      return HUMAN_OUTCOME_GRADIENT.acceptedEdited
    case 're-asked':
      return HUMAN_OUTCOME_GRADIENT.waste
  }
}

/**
 * PER-ATTEMPT credit assignment (T022/T025 [US2] — replaces topic-scoped guessing): bind an implicit
 * cue to the EXACT originating attempt id returned by the live answer path. First-signal-wins and
 * fail-safety are inherited from {@link settleHumanOutcome}, as is the atomic provenance write —
 * pass `answerSource` so the label is auditable [FR-034/SC-009].
 */
export function settleHumanOutcomeForAttempt(
  store: ExperienceStore,
  experienceId: number,
  cue: ImplicitCue,
  answerSource?: string,
): boolean {
  return settleHumanOutcome(store, experienceId, humanOutcomeOfCue(cue), answerSource)
}

export interface SettleForEntityOptions {
  /** Gazetteer canonical the proposal targeted (matched as a substring of query_text, case-insensitive). */
  readonly entity: string
  /** The gradient value to write ([0,1]). */
  readonly value: number
  /** Max rows settled per signal (bounded credit; default 3). */
  readonly cap?: number
  /** Provenance written atomically with the label [FR-034/SC-009], e.g. `proposal-outcome:implemented`. */
  readonly answerSource?: string
}

/**
 * Entity-scoped delayed credit assignment: settle `value` onto the newest UNSETTLED experience rows
 * whose query_text names `entity` (case-insensitive substring), up to `cap` rows. Rows with an existing
 * human_outcome are NEVER overwritten (first signal wins — a stable audit trail). Returns the settled
 * row ids (empty on invalid input or store error — FAIL-SAFE).
 *
 * MACHINE-ORIGIN REFUSAL is enforced here too. It previously was not: this path ran its own UPDATE
 * without the `prompt_origin IS NOT 'machine'` predicate that {@link settleHumanOutcome} enforces, so
 * agent/sub-agent traffic could be settled as a human accept-or-waste signal through the entity route
 * while the per-attempt route refused it. The predicate is applied to the SELECT as well as the UPDATE
 * so machine rows do not silently consume `cap` slots that belong to real human rows.
 */
export function settleHumanOutcomeForEntity(
  store: ExperienceStore,
  opts: SettleForEntityOptions,
): number[] {
  const entity = opts.entity.trim()
  const cap = opts.cap ?? 3
  if (entity === '' || !Number.isFinite(opts.value) || opts.value < 0 || opts.value > 1 || cap <= 0)
    return []
  try {
    const ids = (
      store.db
        .prepare(
          `SELECT id FROM retrieval_experience
            WHERE human_outcome IS NULL AND retriever != 'full'
              AND prompt_origin IS NOT 'machine'
              AND lower(query_text) LIKE ?
            ORDER BY id DESC LIMIT ?`,
        )
        .all(`%${entity.toLowerCase()}%`, cap) as Array<{ id: number }>
    ).map((r) => r.id)
    if (ids.length === 0) return []
    const settled: number[] = []
    for (const id of ids) {
      // Routed through the shared seam so the label, its provenance, first-signal-wins and the
      // machine-origin refusal are all enforced by ONE statement in ONE place.
      if (settleHumanOutcome(store, id, opts.value, opts.answerSource)) settled.push(id)
    }
    return settled
  } catch {
    return []
  }
}
