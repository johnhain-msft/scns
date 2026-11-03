/**
 * N1 — verbatim same-session RE-ASK detector (the first REAL human accept/waste emitting surface).
 *
 * The live magma briefing logs one {@link logRetrievalExperience} row per prompt and mints an
 * `experienceId`. When the SAME human re-asks the SAME question in the SAME session, the prior briefing
 * FAILED to serve — a real implicit `re-asked` cue (→ 0.2 waste on the 6-pt gradient, see human-outcome.ts).
 * This module finds the EXACT prior attempt id so {@link settleHumanOutcomeForAttempt} can bind that human
 * verdict to the retrieval that informed it (the north-star INPUT the metric depends on).
 *
 * CONSERVATIVE BY DESIGN (high precision > recall — N1 wants the FIRST real datapoint with zero false
 * positives, NOT paraphrase coverage, which is the post-N1 §7 intent/semantic work):
 *  - SESSION-SCOPED: requires a non-empty conversationId. Live rows logged without a session key (episode
 *    `{}`) never settle — a briefing that carries no session context can never be mis-attributed.
 *  - VERBATIM: matches on the normalized prompt only (trim + lowercase + collapse whitespace). NO semantic
 *    similarity, NO clustering, NO OOS classification.
 *  - MIN LENGTH: a normalized prompt below `minChars` never fires, so generic one-word command shortcuts
 *    ("plan", "analyze") that recur legitimately in a session cannot produce a false waste signal.
 *  - UNSETTLED ONLY: matches rows whose `human_outcome IS NULL` (first-signal-wins is enforced upstream).
 *  - READ-ONLY + FAIL-SAFE: never writes; any store error returns null so the briefing path is untouched.
 *
 * SEAM CONTRACT: detection MUST run BEFORE the new row for this prompt is logged, so any match is
 * necessarily an EARLIER turn (never the current attempt).
 */

import type { ExperienceStore } from './experience-store.js'
import { classifyPromptAuthorship } from './prompt-authorship.js'

/** Normalize a prompt for verbatim re-ask comparison: trim, lowercase, collapse whitespace runs to one space. */
export function normalizePrompt(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ')
}

export interface ReaskDetectionInput {
  /** The session/conversation key. Detection is SCOPED to one session — undefined/empty ⇒ never fires. */
  readonly conversationId: string | undefined
  /** The incoming prompt (the potential re-submission). */
  readonly prompt: string
  /** Minimum normalized length to consider (precision guard vs generic short prompts). Default 12. */
  readonly minChars?: number
  /** Max prior same-session rows to scan (bounded). Default 25. */
  readonly lookback?: number
}

const DEFAULT_MIN_CHARS = 12
const DEFAULT_LOOKBACK = 25

/**
 * Find the exact id of a PRIOR unsettled retrieval in the SAME session whose prompt is a verbatim
 * (normalized) re-submission of `input.prompt`. Returns the NEWEST such id, or null when no conservative
 * match exists (see module doc for the guards). Read-only + fail-safe.
 */
export function findReaskPriorId(store: ExperienceStore, input: ReaskDetectionInput): number | null {
  const conv = input.conversationId?.trim()
  if (!conv) return null
  // AUTHORSHIP GUARD — a re-ask is a HUMAN signal, so a machine-authored prompt must never settle one.
  // Agent completion notices are verbatim-identical strings that recur constantly, so text matching
  // alone read a repeated system notification as a frustrated human re-asking. Live evidence (rows 907,
  // 1685, 1687 in the pre-cleanup snapshot `experience.db.bak.1785453679`): all three were settled
  // human_outcome=0.2 (waste) against retriever=magma, from prompts of the form
  // `Agent "<name>" (<type>) has finished processing and is now idle` — 3 of the 8 waste rows in that
  // snapshot. They were reverted to unsettled with the operator's approval, so they read NULL in the
  // live store now; the backup is the evidence. The GATE ACCEPT path was hardened against exactly this
  // on 2026-07-25 (transcript oracle); the WASTE path was missed.
  if (classifyPromptAuthorship(input.prompt).author !== 'human') return null
  const norm = normalizePrompt(input.prompt)
  if (norm.length < (input.minChars ?? DEFAULT_MIN_CHARS)) return null
  try {
    const rows = store.db
      .prepare(
        `SELECT id, query_text FROM retrieval_experience
          WHERE conversation_id = ? AND human_outcome IS NULL AND retriever != 'full'
          ORDER BY id DESC LIMIT ?`,
      )
      .all(conv, input.lookback ?? DEFAULT_LOOKBACK) as Array<{ id: number; query_text: string }>
    for (const r of rows) {
      if (normalizePrompt(r.query_text) === norm) return r.id
    }
    return null
  } catch {
    return null
  }
}
