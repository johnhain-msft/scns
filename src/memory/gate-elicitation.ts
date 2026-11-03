/**
 * GATE Part C — the async elicitation write-back that MANUFACTURES the clean accept/waste label.
 *
 * GATE (Generative Active Task Elicitation, arXiv:2310.11589) turns an under-determined prompt into a
 * clarifying question; when the human ANSWERS it, that answer both (a) settles the originating retrieval
 * as ACCEPTED — the elicitation SERVED — and (b) is recorded as the higher-confidence goal-level intent.
 * This is the clean label the reward loop needs, sidestepping the accept-rate bias of blind inference
 * (RealHumanEval 2404.02806). It runs on SCNS's existing per-attempt settle seam and mirrors the N1
 * re-ask detector's discipline exactly:
 *
 *   turn N   : ambiguous briefing logged (row_N) → a clarifying question is attached ({@link setGateQuestion}).
 *   turn N+1 : the next HUMAN-authored briefing DELIVERS the pending question
 *              ({@link findDeliverableGateQuestion} → {@link markGateDelivered}). A machine briefing (a
 *              sub-agent, a scheduled job) is skipped WITHOUT burning the one-shot flag, so the question
 *              waits for a turn the human will actually read.
 *   turn N+2 : a substantive follow-up = the human ANSWERED ({@link findGateAnsweredPriorId}) →
 *              {@link settleGateAnswered} writes ACCEPT + the elicited intent.
 *   (a verbatim RE-ASK of the original instead → the N1 re-ask detector settles WASTE — the two are
 *   mutually exclusive by the normalized-text comparison; no follow-up at all → the row stays NULL, an
 *   honest "we don't know", never a fabricated accept.)
 *
 * CONSERVATIVE + SESSION-SCOPED + UNSETTLED-ONLY + READ-MOSTLY + FAIL-SAFE (a store error is swallowed so
 * the briefing path is never affected), matching `reask-detector.ts`.
 */

import { deserializeEmbedding } from './embeddings.js'
import { normalizePrompt } from './reask-detector.js'
import { cosineSimilarity } from './gate-trigger.js'
import { settleHumanOutcome, type ExperienceStore } from './experience-store.js'
import { HUMAN_OUTCOME_GRADIENT } from './human-outcome.js'
import { classifyPromptAuthorship } from './prompt-authorship.js'
import type { SessionTranscript } from './session-transcript.js'

const DEFAULT_LOOKBACK = 25
const DEFAULT_SIMILARITY_LOOKBACK = 200
const DEFAULT_MIN_CHARS = 12

/**
 * Max cosine similarity of `embedding` to the query embeddings of prior HUMAN-authored attempts — the
 * OOS/novelty signal feeding {@link import('./gate-trigger.js').shouldElicit}. Store-wide by default
 * (novelty is a global "have we ever served anything like this"), bounded to the most recent `lookback`
 * embedded rows.
 *
 * Machine-authored priors are EXCLUDED. The question this signal answers is "have we served anything like
 * this to the HUMAN", but 58.1% of the live corpus is agent traffic (measured 2026-07-24), so an
 * unfiltered scan lets a sub-agent's own prompt make the human's prompt look familiar and suppresses the
 * clarifying question GATE should have asked. `lookback` bounds rows SCANNED; the human window is smaller.
 *
 * Returns null when NO human prior embedding exists (cold-start ⇒ the trigger treats similarity as
 * unknown, never as maximal novelty). Read-only + fail-safe.
 */
export function computeMaxPriorSimilarity(
  store: ExperienceStore,
  embedding: Float32Array,
  opts: { readonly lookback?: number } = {},
): number | null {
  if (embedding.length === 0) return null
  try {
    const rows = store.db
      .prepare(
        `SELECT query_embedding, query_text FROM retrieval_experience
          WHERE query_embedding IS NOT NULL AND retriever != 'full'
          ORDER BY id DESC LIMIT ?`,
      )
      .all(opts.lookback ?? DEFAULT_SIMILARITY_LOOKBACK) as Array<{
      query_embedding: Buffer
      query_text: string
    }>
    if (rows.length === 0) return null
    let max = -1
    for (const r of rows) {
      if (classifyPromptAuthorship(r.query_text).author === 'machine') continue
      const sim = cosineSimilarity(embedding, deserializeEmbedding(r.query_embedding))
      if (sim > max) max = sim
    }
    return max === -1 ? null : max
  } catch {
    return null
  }
}

/**
 * Attach a generated clarifying question to the EXACT originating attempt (the async result of Part B's
 * question generation). Only sets it when currently absent (idempotent, first-write-wins). A blank
 * question is a no-op. Returns whether a question was written. Fail-safe.
 */
export function setGateQuestion(store: ExperienceStore, experienceId: number, question: string): boolean {
  if (experienceId < 0) return false
  const q = question.trim()
  if (q === '') return false
  try {
    const info = store.db
      .prepare(
        `UPDATE retrieval_experience SET gate_question = ?
          WHERE id = ? AND gate_question IS NULL AND human_outcome IS NULL`,
      )
      .run(q, experienceId)
    return info.changes === 1
  } catch {
    return false
  }
}

/** What the trigger decided for one prompt — persisted so the funnel is OBSERVED, not inferred. */
export interface GateDecisionRecord {
  /** The `shouldElicit` reason verbatim (`underspecified`, `confident-serve`, `oos-novel(...)`, …). */
  readonly reason: string
  /** Max cosine to a prior human episode; null/undefined when the embedding worker was cold. */
  readonly maxPriorSimilarity?: number | null | undefined
}

/**
 * Record the trigger's decision for the attempt that produced it. FIRST-WRITE-WINS (a row's decision is
 * a fact about one turn, never revised) and fail-safe — telemetry must never affect the response.
 *
 * Why: measured 2026-07-27 the live funnel showed 0 asks across 162 rows / 10 days and there was NO way
 * to distinguish "the trigger ran and declined" from "the trigger never ran". `shouldElicit` already
 * returns the reason; this persists it.
 */
export function recordGateDecision(
  store: ExperienceStore,
  experienceId: number,
  record: GateDecisionRecord,
): boolean {
  if (experienceId < 0) return false
  const reason = record.reason?.trim()
  if (!reason) return false
  const sim =
    typeof record.maxPriorSimilarity === 'number' && Number.isFinite(record.maxPriorSimilarity)
      ? record.maxPriorSimilarity
      : null
  try {
    const info = store.db
      .prepare(
        `UPDATE retrieval_experience SET gate_decision = ?, gate_max_sim = ?
          WHERE id = ? AND gate_decision IS NULL`,
      )
      .run(reason, sim, experienceId)
    return info.changes === 1
  } catch {
    return false
  }
}

export interface DeliverableGateQuestion {
  readonly experienceId: number
  readonly question: string
}

/**
 * The newest prior attempt in this session that has a clarifying question ATTACHED but NOT YET DELIVERED
 * and NOT YET settled — the question to inject into the current briefing so it reaches the human. Returns
 * null when there is nothing to deliver (or no session key). Read-only + fail-safe.
 *
 * ## `deliveryPrompt` — the authorship guard (REQUIRED)
 * A briefing is only a delivery vehicle if a HUMAN is going to read it. Sub-agents and scheduled jobs
 * request briefings through the very same path, so without this guard the question is appended to
 * whatever came next — and {@link markGateDelivered} then burns the one-shot flag on a turn the human
 * never saw. Measured on the live store 2026-07-28: row 843's question was delivered onto row 844, the
 * assistant's own "You are an INDEPENDENT fresh-context grader" sub-agent brief, so
 * `resolveAnswerFromTranscript` found `deliveryPos = -1` and the row could never settle — permanently,
 * because `gate_delivered = 1` is terminal. 21 of the 40 most recent briefings were machine-authored.
 *
 * The filter is {@link classifyPromptAuthorship} — the same NEGATIVE filter the arm-selection decision
 * immediately above the delivery site in `cli.ts` already applies, for the same stated reason ("a row
 * that can never settle"). Being a negative filter it can only prove MACHINE, never prove human, so this
 * is conservative in the safe direction: an unrecognized machine shape delivers (status quo), while
 * every recognized one defers the question to the next human turn instead of burning it. This makes
 * delivery STRICTER — it widens no abstention rule and adds no settle path.
 */
export function findDeliverableGateQuestion(
  store: ExperienceStore,
  input: {
    readonly conversationId: string | undefined
    /** The prompt of the briefing that would CARRY the question. Machine-authored ⇒ never delivered. */
    readonly deliveryPrompt: string | undefined
    readonly lookback?: number
  },
): DeliverableGateQuestion | null {
  const conv = input.conversationId?.trim()
  if (!conv) return null
  // No prompt ⇒ we cannot establish that a human is receiving this briefing ⇒ do not deliver.
  const carrier = input.deliveryPrompt?.trim()
  if (!carrier) return null
  if (classifyPromptAuthorship(carrier).author === 'machine') return null
  try {
    const row = store.db
      .prepare(
        `SELECT id, gate_question FROM retrieval_experience
          WHERE conversation_id = ? AND gate_question IS NOT NULL
            AND gate_delivered = 0 AND human_outcome IS NULL
          ORDER BY id DESC LIMIT 1`,
      )
      .get(conv) as { id: number; gate_question: string } | undefined
    if (!row) return null
    return { experienceId: row.id, question: row.gate_question }
  } catch {
    return null
  }
}

/**
 * Mark a gate-pending row's question as DELIVERED (surfaced to the human) and record HOW it was
 * delivered. `deliveredByExperienceId` is the attempt whose briefing carried the question — its
 * `query_text` is what lets {@link findGateAnswer} locate the delivering turn in the CLI transcript,
 * which is the only way to know that "the next human turn" is genuinely AFTER the human saw the
 * question. First-write-wins; returns success. Fail-safe.
 */
export function markGateDelivered(
  store: ExperienceStore,
  experienceId: number,
  opts: { readonly deliveredByExperienceId?: number; readonly nowMs?: number } = {},
): boolean {
  if (experienceId < 0) return false
  try {
    const ref =
      opts.deliveredByExperienceId != null && opts.deliveredByExperienceId >= 0
        ? opts.deliveredByExperienceId
        : null
    const info = store.db
      .prepare(
        `UPDATE retrieval_experience
            SET gate_delivered = 1, gate_delivered_ref = ?, gate_delivered_at = ?
          WHERE id = ? AND gate_question IS NOT NULL AND gate_delivered = 0`,
      )
      .run(ref, opts.nowMs ?? Date.now(), experienceId)
    return info.changes === 1
  } catch {
    return false
  }
}

/**
 * How many GATE clarifying questions have already been generated this session — the anti-nag budget
 * counter feeding {@link import('./gate-trigger.js').shouldElicit} (Settles active-learning budget +
 * GATE's automation-bias caveat). Counts rows with a question attached in the conversation. Read-only +
 * fail-safe (0 on error or no session key ⇒ the trigger is never blocked by a counting failure).
 */
export function countSessionGateAsks(
  store: ExperienceStore,
  conversationId: string | undefined,
): number {
  const conv = conversationId?.trim()
  if (!conv) return 0
  try {
    const row = store.db
      .prepare(
        `SELECT COUNT(*) AS n FROM retrieval_experience
          WHERE conversation_id = ? AND gate_question IS NOT NULL`,
      )
      .get(conv) as { n: number }
    return row.n
  } catch {
    return 0
  }
}

export interface GateAnswerInput {
  readonly conversationId: string | undefined
  /** The incoming follow-up prompt (the potential answer to a delivered clarifying question). */
  readonly prompt: string
  /** Minimum normalized length for a follow-up to count as a substantive answer. Default 12. */
  readonly minChars?: number
  readonly lookback?: number
}

export interface GateAnswer {
  readonly experienceId: number
  /** The human's answer text — from the transcript in oracle mode, the incoming prompt in fallback. */
  readonly answer: string
  /** Provenance, persisted to `answer_source`: `transcript-oracle:turn-N` or `shape-classifier[:why]`. */
  readonly source: string
}

export interface GateAnswerLookup {
  readonly conversationId: string | undefined
  /** The incoming prompt. Used only in FALLBACK mode; the oracle reads the transcript instead. */
  readonly prompt: string
  /** The CLI transcript oracle. Omitted/`fallback` mode ⇒ shape classification. */
  readonly transcript?: SessionTranscript | null
  readonly minChars?: number
  readonly lookback?: number
}

/**
 * Resolve the answer to a delivered clarifying question — the fix for the contaminated ACCEPT label.
 *
 * ## Oracle path (authoritative)
 * Asks an ORDERING question, not an authorship one: locate the DELIVERY turn (the transcript turn whose
 * text matches the briefing that carried the question), then take the FIRST HUMAN TURN AFTER IT. Because
 * the Copilot CLI transcript only contains what the human actually typed, sub-agent briefs and
 * "agent has finished" notices are simply absent — they cannot settle anything.
 *
 * Two properties worth stating plainly:
 * - **Index ordering, never timestamps.** `turns.timestamp` is the turn's COMPLETION time (verified live:
 *   turn 6 of session 4f2c4f11 arrived 21:42 and stamped 03:50 next morning), so a time comparison would
 *   select the delivery turn as its own answer — exactly the bug being fixed.
 * - **Settles one turn late, but correctly.** A turn row is written when the turn completes, so the
 *   answer becomes visible on the briefing AFTER it. Lateness is harmless here; wrongness was not.
 *
 * Fail-closed throughout: no matching delivery turn (the question went into a machine briefing, so no
 * human ever saw it), nothing after it, a too-short reply, or a verbatim re-ask (that is the WASTE path)
 * all yield null — the row stays an honest "we don't know" rather than a fabricated accept.
 *
 * ## Fallback path (weaker, announced at startup)
 * When the transcript is unreadable, fall back to shape classification of the incoming prompt. Machine
 * prompts are TRANSPARENT — they neither answer nor abandon a pending question, so a real answer arriving
 * later can still settle it.
 *
 * Read-only + fail-safe.
 */
export function findGateAnswer(store: ExperienceStore, input: GateAnswerLookup): GateAnswer | null {
  const conv = input.conversationId?.trim()
  if (!conv) return null
  const minChars = input.minChars ?? DEFAULT_MIN_CHARS
  const oracle = input.transcript?.mode === 'oracle' ? input.transcript : null
  try {
    const rows = store.db
      .prepare(
        `SELECT id, query_text, gate_delivered_ref FROM retrieval_experience
          WHERE conversation_id = ? AND gate_question IS NOT NULL
            AND gate_delivered = 1 AND human_outcome IS NULL
          ORDER BY id DESC LIMIT ?`,
      )
      .all(conv, input.lookback ?? DEFAULT_LOOKBACK) as Array<{
      id: number
      query_text: string
      gate_delivered_ref: number | null
    }>

    for (const r of rows) {
      if (oracle && r.gate_delivered_ref != null) {
        const answered = resolveAnswerFromTranscript(store, oracle, conv, r, minChars)
        if (answered) return answered
        continue
      }
      const fallbackAnswer = resolveAnswerFromShape(input.prompt, r, minChars)
      if (fallbackAnswer)
        return {
          ...fallbackAnswer,
          source: oracle ? 'shape-classifier:no-delivery-ref' : 'shape-classifier',
        }
      return null
    }
    return null
  } catch {
    return null
  }
}

/** Oracle resolution: the first human turn following the turn that delivered the question. */
function resolveAnswerFromTranscript(
  store: ExperienceStore,
  oracle: SessionTranscript,
  conversationId: string,
  row: { id: number; query_text: string; gate_delivered_ref: number | null },
  minChars: number,
): GateAnswer | null {
  const delivering = store.db
    .prepare('SELECT query_text FROM retrieval_experience WHERE id = ?')
    .get(row.gate_delivered_ref) as { query_text: string } | undefined
  if (!delivering) return null
  const deliveryNorm = normalizePrompt(delivering.query_text)
  if (deliveryNorm === '') return null

  const turns = oracle.humanTurns(conversationId)
  const deliveryPos = turns.findIndex((t) => normalizePrompt(t.text) === deliveryNorm)
  // No matching turn ⇒ the question was surfaced into a machine briefing (a sub-agent, a scheduled
  // job). The human never saw it, so nothing can answer it.
  if (deliveryPos === -1) return null

  const answer = turns[deliveryPos + 1]
  if (!answer) return null
  const norm = normalizePrompt(answer.text)
  if (norm.length < minChars) return null
  // A verbatim re-ask of the ORIGINAL is not an answer — that is the WASTE path (reask-detector).
  if (norm === normalizePrompt(row.query_text)) return null
  return {
    experienceId: row.id,
    answer: answer.text,
    source: `transcript-oracle:turn-${answer.turnIndex}`,
  }
}

/** Fallback resolution: shape-classify the incoming prompt. Machine prompts are transparent. */
function resolveAnswerFromShape(
  prompt: string,
  row: { id: number; query_text: string },
  minChars: number,
): Omit<GateAnswer, 'source'> | null {
  const norm = normalizePrompt(prompt)
  if (norm.length < minChars) return null
  if (norm === normalizePrompt(row.query_text)) return null
  if (classifyPromptAuthorship(prompt).author === 'machine') return null
  return { experienceId: row.id, answer: prompt.trim() }
}

/**
 * Find the id of the DELIVERED, unsettled gate-pending prior attempt in this session that the incoming
 * prompt ANSWERS.
 *
 * @deprecated Superseded by {@link findGateAnswer}. This settles on ANY next >=12-char prompt, which on a
 * 56.3%-machine corpus produced provably fabricated ACCEPTs (live rows 382 and 678). Retained only for
 * callers that have no transcript and no delivery provenance; new code must use {@link findGateAnswer}.
 */
export function findGateAnsweredPriorId(store: ExperienceStore, input: GateAnswerInput): number | null {
  const conv = input.conversationId?.trim()
  if (!conv) return null
  const norm = normalizePrompt(input.prompt)
  if (norm.length < (input.minChars ?? DEFAULT_MIN_CHARS)) return null
  try {
    const rows = store.db
      .prepare(
        `SELECT id, query_text FROM retrieval_experience
          WHERE conversation_id = ? AND gate_question IS NOT NULL
            AND gate_delivered = 1 AND human_outcome IS NULL
          ORDER BY id DESC LIMIT ?`,
      )
      .all(conv, input.lookback ?? DEFAULT_LOOKBACK) as Array<{ id: number; query_text: string }>
    for (const r of rows) {
      // a verbatim re-ask of the ORIGINAL is not an answer (that is the WASTE path)
      if (normalizePrompt(r.query_text) === norm) continue
      return r.id
    }
    return null
  } catch {
    return null
  }
}

/**
 * MANUFACTURE the clean ACCEPT label: settle the originating attempt as ACCEPTED (the elicitation served)
 * and record the human's answer as the higher-confidence `elicited_intent`, together with the PROVENANCE
 * of that answer (`answer_source`) so a transcript-verified accept is never again indistinguishable from
 * a machine-authored one. First-signal-wins — a row already settled (e.g. a re-ask waste landed first) is
 * NEVER overwritten (returns false). Fail-safe.
 */
export function settleGateAnswered(
  store: ExperienceStore,
  experienceId: number,
  answer: string,
  source?: string,
): boolean {
  if (experienceId < 0) return false
  // Settle the outcome AND its provenance in one statement (first-signal-wins and the machine-origin
  // refusal are enforced in settleHumanOutcome). `elicited_intent` stays a follow-on write: it is a
  // separate annotation column, and if it fails the label still carries the source that makes it
  // auditable — which is what [FR-034/SC-009] requires.
  const settled = settleHumanOutcome(store, experienceId, HUMAN_OUTCOME_GRADIENT.accepted, source)
  if (!settled) return false
  try {
    store.db
      .prepare(`UPDATE retrieval_experience SET elicited_intent = ? WHERE id = ?`)
      .run(answer.trim(), experienceId)
  } catch {
    /* the outcome and its provenance are already recorded; the intent label is best-effort */
  }
  return true
}
