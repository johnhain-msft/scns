/**
 * GATE Part A — the ambiguity / OOS elicitation TRIGGER ("when to ask").
 *
 * Grounds the "ask, don't guess" mechanism (GATE — Generative Active Task Elicitation, Li/Tamkin/
 * Goodman/Andreas, ICLR 2024, arXiv:2310.11589) in a live retrieval front-end. GATE always elicits
 * when the task specification is under-determined; a live coding assistant must NOT nag, so this trigger
 * is CONSERVATIVE + high-precision. It fires on either of two independent "can't confidently serve"
 * signals, and NEVER on a clearly-specific prompt:
 *   (1) AMBIGUITY — the prompt is intrinsically under-determined (Aliannejadi SIGIR'19: estimate query
 *       ambiguity, ask when high). {@link isUnderspecified}.
 *   (2) NOVELTY / OOS — the prompt has no precedent: its max cosine similarity to prior episode
 *       embeddings is below a threshold (Larson 1909.02027 out-of-scope detection). Only when the
 *       similarity is KNOWN — an unknown (cold-start, no priors) is NOT treated as maximally novel
 *       (Settles'09 cold-start caveat: early uncertainty is itself unreliable).
 * A CLEARLY-specific prompt ({@link isClearlySpecific}) never asks — John's negative control ("clear ⇒
 * asking wastes the human's time"). A prompt no human authored never asks either (`classifyPromptAuthorship`
 * — there is nobody to answer it). Every ask is BUDGET-bounded per session (Settles active-learning
 * budget + GATE's own automation-bias caveat).
 *
 * PURE + DETERMINISTIC: no DB, no LLM, no I/O — trivially unit-testable with positive AND negative
 * controls. The DB cosine scan that supplies {@link GateTriggerInput.maxPriorSimilarity} lives in the
 * store-touching layer (`gate-elicitation.ts`); the ACP question generation is Part B (`gate-question`).
 */

import { normalizePrompt } from './reask-detector.js'
import { shouldSkipRetrieval } from './arm-router.js'
import { classifyPromptAuthorship } from './prompt-authorship.js'

/** Pure cosine similarity over two Float32 embeddings (same space as `query_embedding`). 0 on a zero vector. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom > 0 ? dot / denom : 0
}

/** Vague action verbs that, aimed at a deictic/generic target, signal an under-determined task. */
const VAGUE_VERB =
  '(?:fix|improve|optimi[sz]e|refactor|debug|change|update|clean\\s?up|tidy\\s?up|handle|redo|make|sort\\s+out|enhance|streamline)'
/** Placeholder/deictic objects with no concrete referent. */
const DEICTIC = '(?:it|this|that|these|those)'
/**
 * A concrete SPECIFICITY marker — a file path, code identifier, quoted term, or a number/value. Its
 * presence means the request is pinned down enough that a clarifying question would waste the human's
 * time (the negative control). Shared by {@link isUnderspecified} and {@link isClearlySpecific}.
 */
const SPECIFIC_MARKER =
  /(?:[\w.-]+\.(?:ts|tsx|js|mjs|jsx|md|json|sql|py|go|rs|sh|yml|yaml)\b|[\w-]+\/[\w./-]+|`[^`]+`|"[^"]+"|\b\d+\b)/i
/**
 * Curated GENERIC targets — inherently under-determined coding *areas* (not named/proper subjects like
 * "README", "OAuth", "SQL", a file path, or an identifier). "improve the code" / "clean up the output"
 * leave the *what/how* open; "optimize SQL query plan" / "fix OAuth callback handling" name the target and
 * must NOT trigger (they are specific enough — the negative control the independent grader flagged).
 */
const GENERIC_TARGET =
  '(?:the\\s+)?(?:codebase|code|outputs?|logs?|logging|tests?|test\\s+suite|build|errors?|error\\s+handling|performance|perf|ui|styling|formatting|layout|structure|logic|docs|documentation|comments?|naming|things?|stuff|everything)'

/** Curated, high-precision patterns for an intrinsically under-determined prompt. */
const UNDERSPECIFIED_PATTERNS: readonly RegExp[] = [
  // vague verb + a DEICTIC or a curated GENERIC target: "fix this", "make it better", "clean up the output",
  // "improve the code". A named/proper subject (README/OAuth/SQL/path) is NOT generic ⇒ never matches.
  new RegExp(`\\b${VAGUE_VERB}\\s+(?:${DEICTIC}|${GENERIC_TARGET})\\b`, 'i'),
  // bare complaint with no subject: "it doesn't work", "this is broken", "not working"
  /\b(it|this|that)\s+(does\s?n['’]?t\s+work|is\s+broken|is\s+wrong|fails?)\b/i,
  /\b(does\s?n['’]?t\s+work|not\s+working|is\s+broken)\b/i,
  // broad open help-ask with no object: "help me", "can you help", "what should I do", "where do I start"
  /\b(can\s+you\s+)?help\s+me\b/i,
  /\bwhat\s+should\s+i\s+do\b/i,
  /\bwhere\s+(do|should)\s+i\s+(start|begin)\b/i,
]

/**
 * TRUE when the prompt is intrinsically under-determined: a vague action verb aimed at a deictic object
 * or a curated GENERIC coding area (where the *what/how* is left open), a bare complaint, or a broad
 * help-ask. HIGH PRECISION by construction — a named/proper subject, file path, identifier, number, or a
 * long detailed request never matches, so specific prompts are served directly (never nagged). Novel-but-
 * named requests are handled live by the OOS/novelty signal, not this text test.
 */
export function isUnderspecified(prompt: string): boolean {
  const norm = normalizePrompt(prompt)
  if (norm === '') return false
  if (SPECIFIC_MARKER.test(prompt)) return false
  return UNDERSPECIFIED_PATTERNS.some((re) => re.test(norm))
}

/**
 * TRUE when the prompt is CLEARLY specific — it carries a concrete anchor (a file path, code identifier,
 * quoted term, number). Such prompts NEVER elicit (the negative control), so a novel-but-clear request is
 * served directly, not questioned.
 *
 * LENGTH IS NOT SPECIFICITY (calibration, 2026-07-30). This used to also return true for any prompt of
 * >= 14 words with no vague marker. Measured read-only over the live store, of the 275 human prompts the
 * gate called `clearly-specific`, 264 carry a real anchor and 11 reached that verdict ONLY via the
 * word-count branch. Because {@link shouldElicit} short-circuits on this predicate BEFORE the OOS/
 * novelty check, those 11 could never elicit no matter how novel they were. They are the human asking
 * for clarification — e.g. live row 1085, "i'm confused -- are you saying there is or isn't a bug to
 * address right now?" — where a verbose prompt is MORE ambiguous, not less.
 *
 * HONEST MAGNITUDE: this removal is a correctness fix, NOT the driver of the ask rate. Replayed over the
 * live corpus it unblocks exactly ONE additional ask on its own (row 1495); the recalibrated
 * {@link DEFAULT_OOS_THRESHOLD} accounts for the rest (human 2 → 7 of 8). See that constant's note.
 */
export function isClearlySpecific(prompt: string): boolean {
  const norm = normalizePrompt(prompt)
  if (norm === '' || isUnderspecified(norm)) return false
  return SPECIFIC_MARKER.test(prompt)
}

export interface GateTriggerInput {
  /** The incoming user prompt. */
  readonly prompt: string
  /**
   * Max cosine similarity of this prompt's embedding to prior episode embeddings ∈ [−1, 1], or null/
   * undefined when UNKNOWN (no priors, or no embedding available). Unknown is NOT novelty (cold-start).
   */
  readonly maxPriorSimilarity?: number | null
  /** GATE asks already fired this session — the budget counter (anti-nag / Settles). Default 0. */
  readonly sessionAskCount?: number
}

export interface GateTriggerOptions {
  /** Min normalized prompt length to consider — filters trivial commands ("go","plan"). Default 6. */
  readonly minChars?: number
  /** OOS threshold: a KNOWN maxPriorSimilarity below this ⇒ novel/out-of-scope. Default 0.7. */
  readonly oosThreshold?: number
  /** Max GATE asks per session (budget). Default 2. */
  readonly maxAsksPerSession?: number
}

export interface GateTriggerDecision {
  /** Whether to elicit a clarifying question this turn. */
  readonly ask: boolean
  /** Strength that eliciting is warranted ∈ [0,1]; 0 whenever {@link ask} is false. */
  readonly confidence: number
  /** Machine-parseable reason (audit trail + the "why we asked"). */
  readonly reason: string
}

const DEFAULT_MIN_CHARS = 6
/**
 * OOS/novelty threshold — CALIBRATED against the live similarity distribution (2026-07-30), not guessed.
 *
 * Measured read-only over `~/.scns/memory/experience.db`, across the 259 human-authored rows carrying a
 * recorded `gate_max_sim`: min 0.612, p5 0.700, p10 0.756, p50 0.990. The previous default of 0.5 sat
 * BELOW THE ENTIRE OBSERVED DISTRIBUTION — not one prompt in the corpus could ever reach it, so the
 * novelty branch was dead code in practice. `docs/research/intent-prior-art.md:511` flags exactly this
 * failure mode: softmax/cosine confidence "is famously miscalibrated, so the threshold itself needs its
 * own positive/negative control before it is" trusted.
 *
 * 0.70 = the measured 5th percentile. Replayed over the live corpus (279 human / 619 machine rows with a
 * recorded `gate_max_sim`), the ask rate moves 2 (0.7%) → 8 (2.9%) for humans and 0 → 0 for machines —
 * the negative control holds. This threshold move, not the `isClearlySpecific` change, is what makes the
 * branch reachable: it alone accounts for 7 of the 8 asks. {@link DEFAULT_MAX_ASKS_PER_SESSION} bounds
 * the worst case per session regardless. Re-derive from the store rather than hand-tuning if traffic
 * shifts.
 */
const DEFAULT_OOS_THRESHOLD = 0.7
const DEFAULT_MAX_ASKS_PER_SESSION = 2

const NO = (reason: string): GateTriggerDecision => ({ ask: false, confidence: 0, reason })

/**
 * Decide whether to fire a GATE clarifying question for `input.prompt`. Pure + deterministic. Guard order
 * (fail-closed, precision-first): too-short → machine-authored → greeting/ack → budget-exhausted → then
 * the two ambiguity signals, with the clearly-specific override protecting the negative control.
 */
export function shouldElicit(
  input: GateTriggerInput,
  options: GateTriggerOptions = {},
): GateTriggerDecision {
  const minChars = options.minChars ?? DEFAULT_MIN_CHARS
  const oosThreshold = options.oosThreshold ?? DEFAULT_OOS_THRESHOLD
  const maxAsks = options.maxAsksPerSession ?? DEFAULT_MAX_ASKS_PER_SESSION

  const norm = normalizePrompt(input.prompt)
  if (norm.length < minChars) return NO('too-short')
  // AUTHORSHIP — an elicitation needs a human to answer it. Until 2026-07-30 the >=14-word branch of
  // `isClearlySpecific` short-circuited long machine briefs INCIDENTALLY; removing that branch (a
  // correctness fix — length is not specificity) left the novelty branch reachable by agent prompts,
  // where an ask spawns an ACP worker and consumes the per-session budget for a row nobody will ever
  // answer. Measured live exposure was 0 only because every observed machine brief happened to carry a
  // digit/path/quote, i.e. the negative control rested on happenstance rather than on a guard.
  // Placed HERE, not at the call site, for two reasons: no caller can forget it (the defect being fixed
  // is exactly a forgotten guard), and the caller still reaches `recordGateDecision`, so the machine
  // funnel stays OBSERVED — that telemetry (`gate_decision`/`gate_max_sim` on machine rows) is what
  // evidences the negative control. Same negative filter used by the arm decision and the WASTE settle.
  if (classifyPromptAuthorship(input.prompt).author !== 'human') return NO('machine-authored')
  if (shouldSkipRetrieval(input.prompt)) return NO('no-memory-need')
  if ((input.sessionAskCount ?? 0) >= maxAsks) return NO('ask-budget-exhausted')

  // (1) Ambiguity — the primary trigger. An intrinsically under-determined prompt always asks.
  if (isUnderspecified(norm)) {
    return { ask: true, confidence: 0.7, reason: 'underspecified' }
  }

  // Negative control: a clearly-specific prompt is served directly, never questioned (even if novel).
  if (isClearlySpecific(input.prompt)) return NO('clearly-specific')

  // (2) Novelty / OOS — only when similarity is KNOWN (cold-start unknown ≠ novel; Settles caveat).
  const sim = input.maxPriorSimilarity
  if (typeof sim === 'number' && Number.isFinite(sim) && sim < oosThreshold) {
    // Confidence scales with how far below the threshold the best precedent sits.
    const confidence = Math.max(0, Math.min(1, 0.4 + (oosThreshold - sim)))
    return { ask: true, confidence, reason: `oos-novel(sim=${sim.toFixed(2)}<${oosThreshold})` }
  }

  return NO('confident-serve')
}
