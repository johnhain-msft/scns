/**
 * MAGMA App C.3 — the Semantic Grader / LLM-as-a-Judge seam (THE PAPER'S METRIC).
 *
 * MAGMA does NOT score memory retrieval on n-gram / recall overlap (App F argues overlap metrics
 * give false rewards + false penalties). It scores the GENERATED ANSWER with an LLM-as-a-Judge on a
 * continuous [0.0, 1.0] semantic-fidelity rubric (App C.3), grading a Candidate answer against a Gold
 * reference. This module is that grader's pluggable seam — it MIRRORS the fact-extractor seam
 * (`fact-extractor-provider.ts`): the transport (ACP / `copilot -p` / mock / fixture) is injected via
 * {@link JudgeProvider}, so the harness stays LLM-agnostic and unit-testable. The DEFAULT is
 * {@link NULL_JUDGE} (grades nothing ⇒ default-OFF, inert until a real provider is wired in behind an
 * env flag). The grade is BLIND: the judge sees ONLY {question, gold, candidate} — never the retrieved
 * context or the generator's state — which is the R2 anti-self-grading control (a separate, ephemeral,
 * isolated judge session, never the working/generator session).
 *
 * Prompt fidelity: {@link SEMANTIC_GRADER_SYSTEM_PROMPT} is the App C.3 rubric verbatim
 * (~/Downloads/magma.pdf → /tmp/magma_raw.txt:~1528-1562; OSS `memory/llm_judge.py`).
 */

import { logger } from '../shared/logger.js'

const log = logger.child({ module: 'judge-provider' })

/**
 * One grading request. `gold` is the gold reference (for LoCoMo adversarial questions the caller
 * passes MAGMA's abstain convention — see the harness's gold selector). `category` is OPTIONAL and is
 * used ONLY for the caller's per-category reporting; it is NEVER sent to the judge (that would be an
 * oracle leak) beyond the adversarial-handling instruction already baked into the rubric.
 */
export interface JudgeRequest {
  readonly question: string
  readonly gold: string
  readonly candidate: string
  readonly category?: number
}

/** One grade: a semantic-fidelity `score` in [0,1] (or {@link NULL_JUDGE_SCORE}) + concise reasoning. */
export interface JudgeResult {
  readonly score: number
  readonly reasoning: string
}

export interface JudgeProvider {
  judge(req: JudgeRequest): Promise<JudgeResult>
}

/**
 * Out-of-band sentinel (< 0, so it can never collide with a genuine rubric score — 0.0 is a VALID
 * grade meaning "contradiction/hallucination"). Returned by {@link NULL_JUDGE} and by
 * {@link parseJudgeResponse} on an unparseable response. The harness treats score < 0 as "unscored"
 * and drops it from accuracy aggregation (never counts it as a real 0.0).
 */
export const NULL_JUDGE_SCORE = -1

/**
 * The App C.3 Semantic Grader system prompt — VERBATIM from the paper (arXiv:2601.03236v2, App C.3;
 * cross-checked vs OSS `memory/llm_judge.py`). Do not paraphrase: this rubric IS the metric.
 */
export const SEMANTIC_GRADER_SYSTEM_PROMPT = `You are an expert evaluator assessing the semantic fidelity of a memory retrieval system. Score the Candidate Answer against the Gold Reference on a continuous scale [0.0, 1.0].

Scoring Rubric:
• 1.0 (Exact Alignment): Captures all key entities, temporal markers, and causal relationships. Semantically equivalent.
• 0.8 (Substantially Correct): Main point is accurate but lacks minor nuances or secondary details.
• 0.6 (Partial Match): Contains valid information but misses key constraints (e.g., wrong date but correct event).
• 0.4 (Tangential): Touches on the topic but misses the core information requirement.
• 0.2 (Incoherent): Factually incorrect with only minimal topical overlap.
• 0.0 (Contradiction/Hallucination): Completely unrelated or contradicts the ground truth.

Evaluation Constraints:
1. Temporal Flexibility: Accept relative time references (e.g., "next Tuesday") if they resolve to the same period as the Gold Reference.
2. Semantic Equivalence: Prioritize informational content over lexical matching.
3. Adversarial Handling: If the Gold Reference states "Unanswerable", the Candidate MUST explicitly state lack of information. Any hallucinated fact results in 0.0.

Output ONLY a JSON object: {"score": <float in [0.0,1.0]>, "reasoning": "<concise explanation>"}. No prose, no code fences.`

/**
 * Build the BLIND user prompt: the judge is given ONLY the question, the gold reference, and the
 * candidate answer — never the retrieved context or generator state (R2 anti-self-grading). Matches
 * the App C.3 input line `Question: {question} | Gold: {gold} | Candidate: {generated}`.
 */
export function buildJudgeUserPrompt(req: JudgeRequest): string {
  return [
    `Question: ${req.question}`,
    `Gold: ${req.gold}`,
    `Candidate: ${req.candidate}`,
  ].join('\n')
}

/** Strip a leading/trailing markdown code fence (```json … ```), tolerant of an optional language tag. */
function stripFences(raw: string): string {
  return raw
    .trim()
    .replace(/^`{1,3}[ \t]*(?:json|jsonc)?[ \t]*\r?\n?/i, '')
    .replace(/\r?\n?[ \t]*`{1,3}$/i, '')
    .trim()
}

/** Extract the outermost `{ ... }` object literal from a string, or `null` if none is present. */
function extractJsonObject(s: string): string | null {
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  return s.slice(start, end + 1)
}

/** Clamp `n` into the closed [0,1] rubric range. */
function clamp01(n: number): number {
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

/**
 * Parse an LLM judge response into a validated {@link JudgeResult}. Defensive (do-no-harm): any
 * failure (non-JSON, missing/non-numeric score) returns `{score: NULL_JUDGE_SCORE}` and NEVER throws,
 * so a flaky judge turn is dropped from aggregation rather than corrupting the accuracy number. A
 * genuine `0.0` is preserved (it is a valid grade), distinct from the negative null sentinel. Numeric
 * scores are coerced (accepts `0.4` or `"0.4"`) and clamped into [0,1].
 */
export function parseJudgeResponse(raw: string): JudgeResult {
  let obj: unknown
  const candidate = extractJsonObject(stripFences(raw))
  if (candidate === null) {
    log.debug('judge response had no JSON object; scoring as null (do no harm)')
    return { score: NULL_JUDGE_SCORE, reasoning: 'unparseable judge response' }
  }
  try {
    obj = JSON.parse(candidate)
  } catch {
    return { score: NULL_JUDGE_SCORE, reasoning: 'unparseable judge response' }
  }
  if (!obj || typeof obj !== 'object') {
    return { score: NULL_JUDGE_SCORE, reasoning: 'unparseable judge response' }
  }
  const o = obj as Record<string, unknown>
  const rawScore = o['score']
  const n = typeof rawScore === 'number' ? rawScore : Number(rawScore)
  if (!Number.isFinite(n)) {
    return { score: NULL_JUDGE_SCORE, reasoning: 'judge response missing a numeric score' }
  }
  const reasoning = typeof o['reasoning'] === 'string' ? o['reasoning'] : ''
  return { score: clamp01(n), reasoning }
}

/**
 * Null judge — grades NOTHING (returns the null sentinel). The default, making the LLM-Judge
 * default-OFF: importing the seam spawns nothing and changes no behavior until a caller explicitly
 * constructs a real provider (the harness does so only under `SCNS_LLM_JUDGE`).
 */
export const NULL_JUDGE: JudgeProvider = {
  async judge(): Promise<JudgeResult> {
    return { score: NULL_JUDGE_SCORE, reasoning: 'null judge (grading disabled / default-OFF)' }
  },
}

const NULL_MARKER = Symbol.for('scns.judge.nullProvider')
;(NULL_JUDGE as unknown as Record<symbol, boolean>)[NULL_MARKER] = true

export function isNullJudge(p: JudgeProvider | undefined | null): boolean {
  if (!p) return true
  return Boolean((p as unknown as Record<symbol, boolean>)[NULL_MARKER])
}
