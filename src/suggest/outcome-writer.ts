/**
 * D2b — proposal outcome writer: the WRITE half of the self-improvement loop
 * (MAGMA Eq.2 `Mₜ₊₁ = Update(Mₜ, qₜ, oₜ)`, design-m1.md §6).
 *
 * When a self-improvement PROPOSAL reaches a terminal status (implemented / failed /
 * rejected / needs-human) this records the outcome into `proposal_outcomes` keyed to
 * the gazetteer entity it targeted, so the next D2a read learns what landed and what
 * keeps failing. It ALSO writes a discrete `outcomes/<date>.md` event entry — a real
 * "proposal → outcome" cause→effect record that feeds the M1.3 causal candidate
 * generator (the convergence that fixes its ~0-edge barrier on chunk fragments).
 *
 * Only ENTITY-ANCHORED (memory-path) proposals are tracked — a proposal whose tags
 * don't resolve to a gazetteer entity (e.g. a legacy static seed) is skipped, so the
 * loop only learns about proposals it can map back to the graph. Pure + injectable;
 * never edits guardrail files. Wired default-OFF at the terminal-status seam.
 */

import type Database from 'better-sqlite3'
import { canonicalize, SCNS_GAZETTEER, type GazetteerEntry } from '../memory/entities/gazetteer.js'
import {
  recordProposalOutcome,
  type ProposalVerdict,
  type ProposalOutcomeRow,
} from '../memory/proposal-outcomes.js'
import { humanOutcomeOfVerdict, settleHumanOutcomeForEntity } from '../memory/human-outcome.js'
import type { ExperienceStore } from '../memory/experience-store.js'
import type { Suggestion, SuggestionStatus } from './types.js'
import type { ReviewVerdict } from './review-reason.js'

const SELF_IMPROVEMENT_TAG = 'self-improvement'
const RESERVED_TAGS: ReadonlySet<string> = new Set([SELF_IMPROVEMENT_TAG, 'scns-self-improvement'])

/** Map a terminal SuggestionStatus to a proposal verdict; null for non-terminal states. */
export function statusToVerdict(status: SuggestionStatus): ProposalVerdict | null {
  switch (status) {
    case 'implemented':
      return 'implemented'
    case 'failed':
      return 'failed'
    case 'rejected':
      return 'rejected'
    case 'needs-human':
      return 'needs-human'
    default:
      // pending / approved / in-progress / blocked-autonomy — not an outcome yet
      return null
  }
}

/**
 * The proposal verdict to bank for a suggestion the HUMAN has explicitly answered.
 *
 * `statusToVerdict` reads a mechanical status; this reads a judgement, and where the two disagree
 * the judgement wins. They disagree precisely on the backfill path the weekly review supports: an
 * already-terminal suggestion keeps its status and gains only a reason, so `status` still describes
 * what the machine did while `reviewReason` now holds what the human thinks of it.
 *
 * Before this existed, that divergence was a SIGN FLIP rather than a mislabel. Measured on the built
 * dist:
 *
 *     status: implemented | John typed: reject -> banked: implemented | gradient: 1 (accepted)
 *     status: rejected    | John typed: explain -> banked: rejected   | gradient: 0.2 (waste)
 *
 * i.e. his rejection was written onto the entity's retrieval experiences as a maximal ACCEPT with
 * his rejection sentence as its evidence, and "I cannot judge this" was scored as waste. Both
 * corrupt human accept-vs-waste, the metric `docs/NORTH_STAR.md` names.
 *
 * The rules:
 *   - **`explain` / `defer` bank NOTHING.** "I cannot judge this" and "not now" are evidence about
 *     the WRITE-UP, not the idea. Banking either way teaches the learner something he did not say.
 *   - **`reject` banks `rejected`,** whatever the status claims. His judgement is the ground truth
 *     for accept-vs-waste.
 *   - **`approve` banks only once the work actually happened.** `approved` alone is not an outcome
 *     yet (unchanged from `statusToVerdict`), and an approval contradicted by a `rejected` status —
 *     he changed his mind mid-session and the terminal status could not move — banks nothing rather
 *     than a label that contradicts one of his two answers.
 */
/**
 * Verdicts that say nothing about accept-vs-waste.
 *
 * "I cannot judge this" and "not now" are evidence about the WRITE-UP, not the idea. Banking either
 * one — in either direction — teaches the learner something the human did not say.
 */
export const VERDICTS_WITHOUT_SIGNAL: ReadonlySet<ReviewVerdict> = new Set<ReviewVerdict>([
  'explain',
  'defer',
])

export function humanVerdictToProposalVerdict(
  verdict: ReviewVerdict,
  status: SuggestionStatus,
): ProposalVerdict | null {
  if (VERDICTS_WITHOUT_SIGNAL.has(verdict)) return null
  switch (verdict) {
    case 'reject':
      return 'rejected'
    case 'approve':
      // He endorsed the IDEA; the status says what then happened to it. `failed` is genuine waste
      // and must keep reaching the learner — dropping it in the name of protecting his approval
      // would trade one silent distortion for another. Only an outright contradiction (he approved,
      // the record says rejected) banks nothing, and the caller warns him when that happens.
      return status === 'rejected' ? null : statusToVerdict(status)
    default:
      return null
  }
}

export interface SuggestionOutcomeTarget {
  readonly entity: string
  readonly family: string
}

/**
 * Resolve the gazetteer entity + family a self-improvement suggestion targets, from
 * its tags. Memory-path suggestions are tagged
 * `['self-improvement','scns-self-improvement', <entity>, <family>]`; the entity is the
 * first tag that canonicalizes to a gazetteer entity and the family is the first
 * remaining non-reserved, non-entity tag. Returns null when the suggestion is not a
 * self-improvement proposal or doesn't resolve to a gazetteer entity.
 */
export function resolveOutcomeTarget(
  suggestion: Suggestion,
  gazetteer: readonly GazetteerEntry[] = SCNS_GAZETTEER,
): SuggestionOutcomeTarget | null {
  if (!suggestion.tags.includes(SELF_IMPROVEMENT_TAG)) return null

  let entity: string | undefined
  for (const t of suggestion.tags) {
    if (RESERVED_TAGS.has(t)) continue // 'self-improvement' is itself a gazetteer entity — skip the structural tags
    const c = canonicalize(t, gazetteer)
    if (c) {
      entity = c
      break
    }
  }
  if (!entity) return null

  const family = suggestion.tags.find(
    (t) => !RESERVED_TAGS.has(t) && t !== entity && canonicalize(t, gazetteer) === undefined,
  )
  if (!family) return null

  return { entity, family }
}

export interface OutcomeWriterDeps {
  /** Memory vault DB (holds `proposal_outcomes`). */
  readonly db: Database.Database
  /** Optional vault writer for the discrete event entry (the causal-candidate source). */
  readonly vault?: { readonly write: (relativePath: string, content: string) => unknown }
  readonly gazetteer?: readonly GazetteerEntry[]
  /** Injectable clock for deterministic entry filenames in tests. */
  readonly now?: () => Date
  /**
   * Phase D (optional, default-OFF): when supplied, a terminal verdict also settles the human
   * accept-vs-waste gradient ({@link humanOutcomeOfVerdict}) onto the newest unsettled retrieval rows
   * naming the target entity ({@link settleHumanOutcomeForEntity} — bounded, auditable, fail-safe).
   */
  readonly experienceStore?: ExperienceStore | null
}

export interface RecordSuggestionOutcomeResult {
  readonly recorded: boolean
  readonly skipReason?:
    | 'non-terminal-status'
    | 'not-entity-anchored'
    | 'idempotent-noop'
    | 'human-verdict-carries-no-signal'
  readonly row?: ProposalOutcomeRow
  /** Path of the written event entry, when a vault was provided. */
  readonly entryPath?: string
  /** Phase D: experience-row ids the human outcome was settled onto (audit trail), when a store was given. */
  readonly humanOutcomeSettled?: readonly number[]
}

/** Render the discrete proposal→outcome event entry (an event-level causal candidate). */
function renderOutcomeEntry(
  suggestion: Suggestion,
  target: SuggestionOutcomeTarget,
  verdict: ProposalVerdict,
  score: number | null,
  at: Date,
): string {
  const scoreLine = score === null ? '' : `\n- score: ${score}`
  return (
    `# Proposal outcome: ${suggestion.title}\n\n` +
    `- entity: ${target.entity}\n` +
    `- family: ${target.family}\n` +
    `- verdict: ${verdict}${scoreLine}\n` +
    `- suggestion: ${suggestion.id}\n` +
    `- recordedAt: ${at.toISOString()}\n\n` +
    `The self-improvement proposal "${suggestion.title}" targeting ${target.entity} ` +
    `resulted in: ${verdict}. ` +
    (verdict === 'implemented'
      ? `This change landed, so the ${target.family} family is now considered addressed for ${target.entity}.`
      : `This attempt did not land, informing whether to retry the ${target.family} family for ${target.entity}.`)
  )
}

/**
 * Record a proposal's terminal outcome to per-entity memory and (if a vault is given)
 * write the discrete event entry. Idempotent via the underlying
 * {@link recordProposalOutcome} on (suggestion_id, entity, family). Skips non-terminal
 * statuses and proposals that don't resolve to a gazetteer entity.
 */
export function recordSuggestionOutcome(
  deps: OutcomeWriterDeps,
  suggestion: Suggestion,
  status: SuggestionStatus,
  score?: number | null,
): RecordSuggestionOutcomeResult {
  const humanVerdict = suggestion.reviewVerdict
  const verdict = humanVerdict
    ? humanVerdictToProposalVerdict(humanVerdict, status)
    : statusToVerdict(status)
  if (!verdict) {
    // Two different silences, kept distinguishable. `explain`/`defer` mean he gave an answer that
    // says nothing about accept-vs-waste, so withholding it is the correct outcome. Everything else
    // that yields no verdict — an `approved` item whose work has not run yet, a contradicted
    // backfill — is simply not an outcome, which is what `non-terminal-status` has always meant.
    return {
      recorded: false,
      skipReason: VERDICTS_WITHOUT_SIGNAL.has(humanVerdict as ReviewVerdict)
        ? 'human-verdict-carries-no-signal'
        : 'non-terminal-status',
    }
  }

  const target = resolveOutcomeTarget(suggestion, deps.gazetteer)
  if (!target) return { recorded: false, skipReason: 'not-entity-anchored' }

  const row = recordProposalOutcome(deps.db, {
    entity: target.entity,
    family: target.family,
    title: suggestion.title,
    verdict,
    score: score ?? null,
    suggestionId: suggestion.id,
    rationale: suggestion.reviewReason ?? null,
  })

  if (!row) return { recorded: false, skipReason: 'idempotent-noop' }

  let entryPath: string | undefined
  if (deps.vault) {
    const at = deps.now?.() ?? new Date()
    const date = at.toISOString().slice(0, 10)
    entryPath = `outcomes/${date}-${target.family}-${suggestion.id.slice(0, 8)}.md`
    deps.vault.write(entryPath, renderOutcomeEntry(suggestion, target, verdict, score ?? null, at))
  }

  // Phase D — implicit accept-vs-waste: settle the verdict's gradient value onto the retrievals that
  // informed this entity (bounded + auditable; a pending verdict maps to null ⇒ settles nothing).
  let humanOutcomeSettled: number[] | undefined
  if (deps.experienceStore) {
    const value = humanOutcomeOfVerdict(verdict)
    if (value !== null) {
      const settled = settleHumanOutcomeForEntity(deps.experienceStore, {
        entity: target.entity,
        value,
        // Provenance [FR-034/SC-009]: an entity-scoped DELAYED credit assignment, bounded by `cap` and
        // inferred from a proposal verdict — materially weaker than a per-attempt signal, and the
        // verdict that produced it is named so it can be down-weighted rather than discarded.
        answerSource: `proposal-outcome:${verdict}`,
      })
      if (settled.length > 0) humanOutcomeSettled = settled
    }
  }

  return {
    recorded: true,
    row,
    ...(entryPath ? { entryPath } : {}),
    ...(humanOutcomeSettled ? { humanOutcomeSettled } : {}),
  }
}
