/**
 * QUERY CHAINS — the missing PRODUCER for the `'used'` / `'edited'` implicit cues.
 *
 * ## The gap this closes
 * `human-outcome.ts:67` defines the cue vocabulary `'used' | 'edited' | 're-asked'`, and
 * `settleHumanOutcomeForAttempt` maps it onto the 6-pt gradient. But grep finds exactly ONE live
 * emitter — `src/cli.ts:1258`, sending `'re-asked'` from the verbatim N1 detector. `'used'` and
 * `'edited'` are unreachable anchors. This module is the producer, emitting onto that SAME seam. It
 * introduces no new gradient, no new vocabulary, and no new settle path.
 *
 * ## Prior art — Radlinski & Joachims, "Query Chains: Learning to Rank from Implicit Feedback", KDD 2005
 * https://www.cs.cornell.edu/people/tj/publications/radlinski_joachims_05a.pdf
 * Users issue a *sequence* of queries against one underlying information need — a **query chain** —
 * and the reformulation itself is feedback: if the chain CONTINUES, the earlier result set did not
 * satisfy the need. Two mechanisms are adopted directly:
 *
 * 1. **Chain detection is allowed to be a heuristic.** The paper trained an SVM (94.3% accuracy) and
 *    then *shipped the simple rule* — same IP, within 30 minutes — at 91.6% precision, judging it
 *    sufficient (§6). SCNS's analog is stronger: same `conversation_id` plus ADJACENT human turns
 *    from the CLI transcript oracle, which is an exact record rather than an IP guess.
 * 2. **Query similarity is the chain-continuation signal.** The largest positive SVM weight was
 *    `CosineDistance(q1,q2)` (§6). {@link queryChainSimilarity} is the dependency-free analog.
 *
 * SCNS's N1 re-ask detector is the **degenerate similarity = 1.0 case** of chain continuation; this
 * generalizes it from verbatim to semantic-shape without changing its meaning.
 *
 * ## Why it ABSTAINS by default
 * The classifier is itself a model, and a wrong one re-contaminates the labels. Joachims et al.
 * (SIGIR 2005) is the standing caution: implicit signals are biased, and the ABSENCE of a negative is
 * not a positive. So a bare topic change yields **null**, not `'used'` — rule 4 below is a deliberate
 * negative control. Precision over recall, exactly as the N1 detector was built.
 *
 * ## Why the DELIVERY GATE exists (the second premise, measured 2026-07-25)
 * A human outcome may only be attributed to a briefing the human actually received. The installed
 * extension aborts the context call at `TIMEOUT_MS = 1500`
 * (`~/.copilot/extensions/scns/extension.mjs:12,26`), while `/api/extension/context`
 * (`dashboard-routes.ts:961`, the sole writer of these rows) logs the row server-side regardless of
 * whether the client is still listening. Measured on the live corpus: of 664 magma rows only
 * **321 (48.3%)** finished within 1500 ms (avg 2272 ms, p50 1575 ms, p90 4520 ms). Labeling the rest
 * would score a treatment that was never delivered — and both `reward/kto-learner.ts:166-168` and
 * `memory/edge-reinforcement.ts:136` select on `human_outcome IS NOT NULL` with NO delivery filter,
 * so such labels would flow straight into the learner. Rows over budget, or with an unknown (NULL)
 * latency, therefore ABSTAIN.
 *
 * Read-only + fail-safe: this module never writes. The caller settles through the existing seam.
 */

import type { ExperienceStore } from './experience-store.js'
import type { SessionTranscript } from './session-transcript.js'
import { settleHumanOutcomeForAttempt, type ImplicitCue } from './human-outcome.js'
import { normalizePrompt } from './reask-detector.js'
import { CUE_CONFIDENCE_FLOOR, type ReadableCue } from './followup-satisfaction.js'
import { classifyPromptAuthorship } from './prompt-authorship.js'

/**
 * The installed Copilot extension's `AbortController` budget for `/api/extension/context`. A briefing
 * slower than this never reached the model, so its row carries no human signal.
 *
 * DELIBERATELY STILL 1500 even though the generator default is now 5000
 * (`extension-template.ts`). The raise only takes effect in Copilot CLI sessions started AFTER the
 * extension file is regenerated; sessions already running keep aborting at 1500 ms. Raising this
 * constant before those sessions cycle out would mark undelivered rows as delivered — fabricating
 * the exact class of label this gate exists to prevent.
 *
 * Being too LOW costs recall; being too HIGH costs validity. Stay low.
 *
 * To flip it to 5000, first show that no unsettled row remains from a pre-cutover conversation.
 */
export const DEFAULT_DELIVERY_TIMEOUT_MS = 1500

/** At or above this similarity the chain is CONTINUING — the earlier briefing did not satisfy the need. */
export const REFORMULATION_THRESHOLD = 0.55

/** A next turn shorter than this is an acknowledgement, not a labelable chain step. */
const DEFAULT_MIN_CHARS = 12

/** Max prior same-session rows scanned. Bounded, newest-first. */
const DEFAULT_LOOKBACK = 25
/** Conversations one sweep run may walk. 1472 were unsettled live on 2026-07-31, so 500 truncated
 * the frontier and hid eligible pairs; this covers the whole corpus with headroom. */
const DEFAULT_SWEEP_CONVERSATIONS = 5000

/**
 * Function words carry no information need, so they must not inflate chain similarity — the paper's
 * cosine is over content, and two turns sharing only "the/a/of" are not the same query.
 */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'did', 'do', 'does', 'for',
  'from', 'had', 'has', 'have', 'how', 'i', 'if', 'in', 'is', 'it', 'its', 'me', 'my', 'of', 'on',
  'or', 'our', 's', 'so', 't', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they',
  'this', 'to', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with',
  'you', 'your',
])

/** The human explicitly steering a delivered answer: engaged with it, but corrected it. */
const CORRECTION_MARKERS: readonly RegExp[] = [
  /^(no|nope|nah)\b/,
  /^(actually|wait|hold on|hold up)\b/,
  /\bi (meant|actually wanted)\b/,
  /\bthat'?s (not|wrong|incorrect)\b/,
  /\b(not what i|instead of that)\b/,
]

/** The human moving on approvingly — the chain ended because the need was met. */
const AFFIRMATION_MARKERS: readonly RegExp[] = [
  /^(yes|yep|yeah|ok|okay|great|perfect|nice|awesome|excellent|thanks|thank you|correct|right)\b/,
  /^(now|next|then)\b/,
  /\b(go ahead|do it|proceed|ship it|lgtm|sounds good|looks good|makes sense)\b/,
]

function contentTokens(s: string): Set<string> {
  const out = new Set<string>()
  for (const tok of normalizePrompt(s).split(/[^a-z0-9]+/)) {
    if (tok !== '' && !STOPWORDS.has(tok)) out.add(tok)
  }
  return out
}

/**
 * COSINE similarity over binary content-token vectors — the paper's own chain feature
 * (`CosineDistance(q1, q2)`, Table 2), computed without a vector dependency.
 *
 * Cosine rather than Jaccard is load-bearing here, not a detail: a reformulation typically RESTATES
 * the need and ADDS constraints, and Jaccard charges every added term to the denominator. "restart
 * the scns broker safely" vs "restart the scns broker without losing state" scores 0.43 under Jaccard
 * (reads as a topic change) but 0.61 under cosine (correctly reads as the same need, restated) —
 * which is exactly the case this producer exists to catch.
 *
 * 1.0 for a verbatim re-ask (the N1 degenerate case); 0 when either side carries no content word.
 */
export function queryChainSimilarity(a: string, b: string): number {
  const ta = contentTokens(a)
  const tb = contentTokens(b)
  if (ta.size === 0 || tb.size === 0) return 0
  let shared = 0
  for (const t of ta) if (tb.has(t)) shared++
  return shared / Math.sqrt(ta.size * tb.size)
}

/** Which rule produced a cue — carried into `answer_source` so every label is auditable. */
export type ChainRule = 'reformulation' | 'correction' | 'affirmed-advance'

export interface ChainStepVerdict {
  readonly cue: ImplicitCue
  readonly rule: ChainRule
  readonly similarity: number
}

/**
 * Classify ONE chain step: the query a briefing answered, and the human turn that followed it.
 * Rule order is first-match-wins; anything unmatched returns **null** (abstain).
 *
 * 1. `reformulation` — similarity ≥ {@link REFORMULATION_THRESHOLD}. The chain continued, so the
 *    briefing failed to serve ⇒ `'re-asked'` (0.2 waste). Ranked FIRST deliberately: a restatement of
 *    the same need is a failure even when it is phrased as a correction.
 * 2. `correction` — the human engaged with the answer and steered it ⇒ `'edited'` (0.8, accepted with
 *    friction — the previously unreachable anchor).
 * 3. `affirmed-advance` — an approving move onto a different need ⇒ `'used'` (1.0).
 * 4. otherwise **null** — NEGATIVE CONTROL. A bare topic change is not evidence of value.
 */
export function classifyChainStep(
  priorQuery: string,
  nextTurn: string,
  minChars: number = DEFAULT_MIN_CHARS,
): ChainStepVerdict | null {
  const next = normalizePrompt(nextTurn)
  const prior = normalizePrompt(priorQuery)
  if (prior === '' || next.length < minChars) return null

  const similarity = queryChainSimilarity(prior, next)
  if (similarity >= REFORMULATION_THRESHOLD) {
    return { cue: 're-asked', rule: 'reformulation', similarity }
  }
  if (CORRECTION_MARKERS.some((re) => re.test(next))) {
    return { cue: 'edited', rule: 'correction', similarity }
  }
  if (AFFIRMATION_MARKERS.some((re) => re.test(next))) {
    return { cue: 'used', rule: 'affirmed-advance', similarity }
  }
  return null
}

export interface ChainOutcome {
  readonly experienceId: number
  readonly cue: ImplicitCue
  readonly rule: ChainRule
  readonly similarity: number
  /**
   * Provenance written to `answer_source`, e.g. `query-chain:affirmed-advance:turn-4:sim-0.08`. The
   * `query-chain:` prefix keeps transcript-DERIVED labels distinguishable from the `transcript-oracle:`
   * GATE labels, which are oracle-VERIFIED answers to a delivered question.
   */
  readonly source: string
}

export interface ChainLookup {
  readonly conversationId: string | undefined
  /** The CLI transcript oracle. `fallback`/null ⇒ never fires: a chain needs real human turns. */
  readonly transcript: SessionTranscript | null | undefined
  /** Client abort budget. Rows slower than this were never delivered. Default 1500 ms. */
  readonly deliveryTimeoutMs?: number
  readonly minChars?: number
  readonly lookback?: number
  /**
   * Pairs the caller has already offered and does not want returned again.
   *
   * The live briefing hook never sets this: it wants the newest pair and gets another chance on the
   * next briefing. The cross-conversation sweep gets no second chance — an abstained row stays NULL,
   * so without this every OLDER eligible pair in that conversation is sealed off permanently.
   * Measured on a copy of the live corpus 2026-07-31: 41 eligible pairs existed but only 17 were
   * reachable, and 4 of the challenger arm's 5 were lost to position alone.
   *
   * This only ever SHRINKS the result set — eligibility is unchanged, so no gate can be skipped.
   */
  readonly excludeIds?: ReadonlySet<number>
}

export interface ChainCandidate {
  readonly experienceId: number
  /** The query this briefing answered. */
  readonly priorQuery: string
  /** The human turn that followed it, verbatim from the transcript oracle. */
  readonly nextTurn: string
  readonly nextTurnIndex: number
}

/**
 * Every UNSETTLED, DELIVERY-ELIGIBLE attempt in this session whose query appears in the transcript and
 * is followed by a human turn — newest first. This is the ONE eligibility pass both settle producers
 * share, so the deterministic classifier and the follow-up reader can never disagree about which pairs
 * are even labellable.
 *
 * Ordering is by transcript **turn index**, never timestamps: `turns.timestamp` is the turn's
 * COMPLETION time (verified live — session `4f2c4f11` turn 6 arrived 21:42 and stamped 03:50 the next
 * morning), so a time comparison can select a turn as its own successor.
 *
 * A query with no matching human turn was a MACHINE briefing (a sub-agent, a scheduled job). The human
 * never saw it, so nothing can label it. Read-only + fail-safe.
 */
export function findChainCandidates(store: ExperienceStore, input: ChainLookup): ChainCandidate[] {
  const conv = input.conversationId?.trim()
  if (!conv) return []
  const oracle = input.transcript?.mode === 'oracle' ? input.transcript : null
  if (!oracle) return []
  const budget = input.deliveryTimeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS

  try {
    const rows = store.db
      .prepare(
        `SELECT id, query_text, latency_ms, client_timeout_ms FROM retrieval_experience
          WHERE conversation_id = ? AND human_outcome IS NULL AND retriever != 'full'
          ORDER BY id DESC LIMIT ?`,
      )
      .all(conv, input.lookback ?? DEFAULT_LOOKBACK) as Array<{
      id: number
      query_text: string
      latency_ms: number | null
      client_timeout_ms: number | null
    }>
    if (rows.length === 0) return []

    const turns = oracle.humanTurns(conv)
    if (turns.length < 2) return []

    const out: ChainCandidate[] = []
    for (const row of rows) {
      // DELIVERY GATE — an aborted or unknown-latency briefing never reached the human.
      // The budget is the one the CLIENT ACTUALLY ENFORCED on that request when the row recorded it;
      // it is ground truth and therefore outranks any caller-supplied default. Rows predating that
      // column fall back to the conservative default rather than to a wall-clock guess.
      const rowBudget = row.client_timeout_ms ?? budget
      if (row.latency_ms == null || row.latency_ms > rowBudget) continue
      const norm = normalizePrompt(row.query_text ?? '')
      if (norm === '') continue
      // A MACHINE-AUTHORED PRIOR IS NOT A NEED. `readFollowupSatisfaction` already refuses a
      // machine-authored NEXT turn as "not the human's reaction"; the prior deserves the same guard
      // for the same reason — if no human asked, no human was served, and the label is meaningless.
      // The transcript match does not screen these out: a brief pasted into the prompt slot appears
      // in the transcript verbatim. This is the contamination class that produced fabricated ACCEPTs.
      if (classifyPromptAuthorship(row.query_text ?? '').author === 'machine') continue
      // AN OUTSTANDING QUESTION OUTRANKS EVERY DERIVED READING. If a clarifying question has been
      // delivered and not yet answered, the human is mid-sentence: an oracle-grade label is in
      // flight. `settleHumanOutcome` is first-signal-wins, so a derived label landing here does not
      // merely arrive early — it REFUSES the real answer permanently and loses `elicited_intent`.
      //
      // This guard belongs in the SHARED eligibility pass, not in one caller. `findChainOutcome` and
      // `findChainResidue` both consume these candidates; guarding only the latter left the
      // deterministic `query-chain:` producer free to pre-empt the human (DP-F1). Nor does the
      // synchronous producer order in `cli.ts` cover it: `runSettleSweep` walks up to
      // DEFAULT_SWEEP_CONVERSATIONS conversations running ONLY derived producers, with no
      // `settleGateAnswered` anywhere on that path.
      if (hasPendingGateQuestion(store, row.id)) continue
      const pos = turns.findIndex((t) => normalizePrompt(t.text) === norm)
      if (pos === -1) continue
      const next = turns[pos + 1]
      if (!next) continue
      out.push({
        experienceId: row.id,
        priorQuery: row.query_text,
        nextTurn: next.text,
        nextTurnIndex: next.turnIndex,
      })
    }
    return out
  } catch {
    return []
  }
}

/**
 * Every conversation that still holds an UNSETTLED, labellable-in-principle briefing, newest activity
 * first. This is the frontier the cross-conversation settle sweep walks.
 *
 * It exists because the harvest used to be reachable only from inside the live briefing hook, which
 * settles a prior turn when a NEW briefing arrives in the SAME conversation. Measured read-only over
 * the live corpus (rows since 2026-07-27): 902 of 911 conversations (99.0%) carry exactly ONE
 * briefing, so for 99% of traffic that second trigger never arrives and the pair is never harvested —
 * 29 fully-eligible pairs were sitting unlabelled. Enumerating the frontier is what lets the same
 * producers run without waiting on conversation continuation.
 *
 * `retriever != 'full'` mirrors {@link findChainCandidates}: the `full` rows are token-reference rows,
 * not served briefings. Read-only + fail-safe.
 */
export function findUnsettledConversations(
  store: ExperienceStore,
  opts: { readonly limit?: number } = {},
): string[] {
  try {
    const rows = store.db
      .prepare(
        `SELECT conversation_id AS conv, MAX(id) AS newest FROM retrieval_experience
          WHERE conversation_id IS NOT NULL AND human_outcome IS NULL AND retriever != 'full'
          GROUP BY conversation_id ORDER BY newest DESC LIMIT ?`,
      )
      .all(opts.limit ?? DEFAULT_SWEEP_CONVERSATIONS) as Array<{ conv: string }>
    return rows.map((r) => r.conv).filter((c) => typeof c === 'string' && c.trim() !== '')
  } catch {
    return []
  }
}

/**
 * Find the newest UNSETTLED, DELIVERY-ELIGIBLE attempt in this session whose query appears in the
 * transcript and is followed by a classifiable human turn. Returns the cue bound to that exact
 * attempt id, or null.
 */
export function findChainOutcome(store: ExperienceStore, input: ChainLookup): ChainOutcome | null {
  const minChars = input.minChars ?? DEFAULT_MIN_CHARS
  for (const c of findChainCandidates(store, input)) {
    const verdict = classifyChainStep(c.priorQuery, c.nextTurn, minChars)
    if (!verdict) continue
    return {
      experienceId: c.experienceId,
      cue: verdict.cue,
      rule: verdict.rule,
      similarity: verdict.similarity,
      source: `query-chain:${verdict.rule}:turn-${c.nextTurnIndex}:sim-${verdict.similarity.toFixed(2)}`,
    }
  }
  return null
}

/**
 * The ABSTAIN RESIDUE — the newest eligible pair the deterministic classifier could NOT label. This is
 * the only input the follow-up satisfaction reader is ever given, which is what makes the reader purely
 * ADDITIVE: every pair the precise rules can settle is still settled by them, on their own provenance.
 *
 * Measured live 2026-07-28: 19 of the 24 eligible pairs in the whole store land here, and they are not
 * bare topic changes — they are substantive engagement with the same need.
 */
export function findChainResidue(
  store: ExperienceStore,
  input: ChainLookup,
): ChainCandidate | null {
  const minChars = input.minChars ?? DEFAULT_MIN_CHARS
  // FR-010 (#17): NEVER-OFFERED pairs are returned before previously-refused ones — ordering, not
  // just filtering. Without this, a refused pair whose back-off just recovered would ride the
  // newest-first default straight back to the front of the queue and take the budget slot an unseen
  // pair was waiting for. Newest-first is preserved WITHIN each class. Whether a refused pair is
  // still DEFERRED is the caller's policy question (`isFollowupDeferred`); eligibility here is
  // unchanged, so no gate can be skipped.
  const refused = refusedExperienceIds(store, input.conversationId)
  let refusedFallback: ChainCandidate | null = null
  for (const c of findChainCandidates(store, input)) {
    if (input.excludeIds?.has(c.experienceId)) continue
    if (classifyChainStep(c.priorQuery, c.nextTurn, minChars)) continue
    // NOTE: the pending-question guard is no longer applied here. It was hoisted into
    // `findChainCandidates` (DP-F1) so both derived producers inherit it; re-checking it here would
    // be dead code, and duplicating a safety predicate invites the two copies to drift apart.
    if (!refused.has(c.experienceId)) return c
    if (!refusedFallback) refusedFallback = c
  }
  return refusedFallback
}

/** Pairs in this conversation with a durable refusal record (`followup_refusal`, #17). Fail-OPEN:
 *  an empty set on error restores the pre-#17 newest-first behaviour rather than hiding work. */
function refusedExperienceIds(
  store: ExperienceStore,
  conversationId: string | undefined,
): ReadonlySet<number> {
  const conv = conversationId?.trim()
  if (!conv) return new Set()
  try {
    const rows = store.db
      .prepare(`SELECT experience_id FROM followup_refusal WHERE conversation_id = ?`)
      .all(conv) as Array<{ experience_id: number }>
    return new Set(rows.map((r) => r.experience_id))
  } catch {
    return new Set()
  }
}

/** Is an unanswered clarifying question outstanding on this row? Fail-safe: assume yes on error. */
function hasPendingGateQuestion(store: ExperienceStore, experienceId: number): boolean {
  try {
    const row = store.db
      .prepare(`SELECT gate_question FROM retrieval_experience WHERE id = ?`)
      .get(experienceId) as { gate_question: string | null } | undefined
    return row?.gate_question != null
  } catch {
    return true
  }
}

/**
 * Settle a chain outcome through the EXISTING per-attempt seam
 * ({@link settleHumanOutcomeForAttempt}), which writes the label and its provenance in ONE statement.
 * No new settle path and no new gradient: the cue maps through `humanOutcomeOfCue` exactly as the N1
 * re-ask emitter's does.
 *
 * The `query-chain:` prefix is the whole point of the annotation: a DERIVED label must never be
 * mistaken for the `transcript-oracle:` GATE labels, which are oracle-VERIFIED human answers to a
 * question the human demonstrably received. Returns false when the row was already settled
 * (first-signal-wins) — in which case nothing is annotated either, because there is nothing to annotate.
 */
export function settleChainOutcome(store: ExperienceStore, outcome: ChainOutcome): boolean {
  return settleHumanOutcomeForAttempt(store, outcome.experienceId, outcome.cue, outcome.source)
}

/**
 * Settle a FOLLOW-UP READER verdict through the same per-attempt seam, stamping a provenance that is
 * deliberately distinguishable from both the deterministic `query-chain:` labels and the oracle-grade
 * `transcript-oracle:` ones, e.g. `followup:dispute:turn-5:conf-0.78`.
 *
 * Keeping the three label sources separable in `answer_source` is a requirement, not cosmetics: the
 * acceptance-bias literature (Ziegler arXiv:2205.06537, RealHumanEval arXiv:2404.02806, SPACE) says a
 * model-derived accept must never be consumed as if it were a verified human verdict, and the
 * confidence is written alongside so a downstream learner can down-weight rather than discard.
 *
 * Returns false when the row was already settled (first-signal-wins) — in which case nothing is
 * annotated either. This is what preserves the `cli.ts` precedence: the two oracle-grade producers and
 * the deterministic chain rules all run synchronously on the briefing path and therefore always reach
 * the row first; this reader runs fire-and-forget afterwards and can only ever fill a row they left NULL.
 */
export function settleFollowupOutcome(
  store: ExperienceStore,
  outcome: {
    readonly experienceId: number
    /** ReadableCue, NOT ImplicitCue — this seam must not be able to write an ACCEPT. */
    readonly cue: ReadableCue
    readonly pattern: string
    readonly confidence: number
    readonly nextTurnIndex: number
  },
): boolean {
  // RUNTIME guard, not just the type. The grader's point: `cue: 'used' as any` walks straight
  // through a compile-time-only constraint, and this is an exported function. A derived reader that
  // never sees the assistant answer must not be able to write an ACCEPT by any route.
  if (!(outcome.cue in CUE_CONFIDENCE_FLOOR)) return false
  // RE-CHECK AT SETTLE TIME [C8]. `findChainResidue` already applies this guard, but the caller then
  // `await`s an ACP round-trip before getting here (cli.ts ~1394-1410) — so a clarifying question
  // DELIVERED during that window is invisible to the earlier check. Re-reading it here closes the
  // TOCTOU: first-signal-wins is temporal, so a derived label that beats the human's answer by a
  // few hundred milliseconds would block the oracle-grade signal on that row permanently.
  if (hasPendingGateQuestion(store, outcome.experienceId)) return false
  const source = `followup:${outcome.pattern}:turn-${outcome.nextTurnIndex}:conf-${outcome.confidence.toFixed(2)}`
  return settleHumanOutcomeForAttempt(store, outcome.experienceId, outcome.cue, source)
}

export interface ConfidenceInterval {
  readonly point: number
  readonly low: number
  readonly high: number
  readonly n: number
}

/**
 * Wilson score interval — the honest error bar on a small-n rate. The normal approximation is invalid
 * at n≈17 and near p=0 or 1 (it can leave [0,1]); Wilson stays inside and stays wide when support is
 * thin. `n = 0` returns the fully uninformative [0,1] rather than NaN.
 */
export function wilsonInterval(successes: number, n: number, z = 1.96): ConfidenceInterval {
  if (!Number.isFinite(n) || n <= 0) return { point: 0, low: 0, high: 1, n: 0 }
  const p = successes / n
  const z2 = z * z
  const denom = 1 + z2 / n
  const centre = (p + z2 / (2 * n)) / denom
  const halfWidth = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom
  return {
    point: p,
    low: Math.max(0, centre - halfWidth),
    high: Math.min(1, centre + halfWidth),
    n,
  }
}
