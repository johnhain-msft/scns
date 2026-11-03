/**
 * MAGMA App C.2 — the Query-Adaptive QA generator seam.
 *
 * The task pipeline the LLM-Judge (App C.3) grades is: retrieved context → a query-adaptive QA
 * GENERATOR → the answer. This module is that generator's pluggable seam, mirroring the fact-extractor
 * seam (`fact-extractor-provider.ts`): the transport (ACP / `copilot -p` / mock) is injected via
 * {@link QaGenerator}, default {@link NULL_GENERATOR} (abstains ⇒ default-OFF, inert until wired in
 * behind an env flag). For the HONEST BASELINE the `context` is SCNS's CURRENT prod assembly
 * (`retrieval-context.ts:106 formatRetrievedContext`) — plain join+slice; the Eq-7 Stage-4 linearizer
 * is ABSENT and is Phase B2, NOT this cycle.
 *
 * Prompt fidelity: {@link ADAPTIVE_QA_SYSTEM_PROMPT} + the {@link DYNAMIC_INSTRUCTIONS} are the App C.2
 * prompt verbatim (~/Downloads/magma.pdf → /tmp/magma_raw.txt:~1564-1600; OSS
 * answer_formatter.py:531 build_qa_prompt). CRITICAL anti-oracle rule: instruction 4 (the per-category
 * "dynamic instruction") is chosen by SCNS's OWN query classifier ({@link dynamicInstructionFor} over
 * `classifyIntent`), NEVER the LoCoMo gold `category` — the paper is explicit that the router uses "no
 * oracle labels". SCNS's classifier ({WHY,WHEN,ENTITY,DEFAULT}) is coarser than MAGMA's
 * {Multi-hop,Temporal,Open-domain,Single-hop} router (a finer router is Phase B1); the mapping below is
 * faithful-to-impl and documented.
 */

import type { QueryIntent } from './intent.js'

/** The exact abstain sentinel from App C.2 instruction 2 ("respond exactly with 'Information not found'"). */
export const QA_NOT_FOUND = 'Information not found'

export interface QaGenerationRequest {
  readonly question: string
  /** Retrieved + assembled context (the prod `formatRetrievedContext` output for the honest baseline). */
  readonly context: string
  /** SCNS-classified intent (from `classifyIntent`) — selects the dynamic instruction. NOT the gold label. */
  readonly intent: QueryIntent
}

export interface QaGenerationResult {
  readonly answer: string
  /** True iff the generator abstained with the App C.2 "Information not found" sentinel. */
  readonly notFound: boolean
  /**
   * True iff generation FAILED (spawn/timeout/parse error) rather than genuinely abstaining. The
   * harness must DROP `error` results from accuracy aggregation (never score a failed spawn as a real
   * abstain), exactly as it drops the judge's negative null-sentinel score. Absent/false ⇒ a real
   * answer or a genuine abstain.
   */
  readonly error?: boolean
}

export interface QaGenerator {
  generate(req: QaGenerationRequest): Promise<QaGenerationResult>
}

/**
 * App C.2 system prompt — the persona + the fixed instructions 1–3 (context-only, abstain-exactly,
 * concise). Instruction 4 (the dynamic per-intent instruction) is appended per-request in
 * {@link buildQaUserPrompt}. Verbatim from the paper; do not paraphrase.
 */
export const ADAPTIVE_QA_SYSTEM_PROMPT = `System Role: You are a precision QA assistant operating on retrieved memory contexts. Your goal is to answer the user's question accurately using only the provided information.

Instructions:
1. Use ONLY information explicitly stated in the context.
2. If the answer is not present, respond exactly with "${QA_NOT_FOUND}".
3. Be concise (typically 1–10 words) unless detailed reasoning is required.
4. Follow the query-specific instruction provided with the question.

Output ONLY the answer text. No preamble, no "Answer:" label, no code fences.`

/**
 * App C.2 "Dynamic Instruction Injection Candidates" (verbatim). Keyed by the MAGMA router category.
 * {@link dynamicInstructionFor} selects one from SCNS's coarser `classifyIntent` output.
 */
export const DYNAMIC_INSTRUCTIONS = {
  multihop:
    "Connect related facts across different nodes. For comparison queries (e.g., 'both/all'), identify commonalities between entities rather than listing individual details.",
  temporal:
    "Resolve relative dates (e.g., 'yesterday') using the event timestamps. Output dates strictly in 'D Month YYYY' format. Calculate durations if asked.",
  openDomain:
    "Make reasonable inferences based on the user's personality traits, interests, and past behaviors. Support hypothetical ('would/could') reasoning with evidence.",
  singleHop:
    'Extract the specific entity, name, or method requested. Do not add explanations. Return the exact fact matching the query intent.',
} as const

/**
 * Map SCNS's `classifyIntent` result to the App C.2 dynamic instruction (no oracle labels):
 *   WHEN → Temporal · WHY → Open-Domain/Inference · ENTITY → Single-hop/Factual ·
 *   DEFAULT → Multi-hop (the general "connect related facts" fallback).
 */
export function dynamicInstructionFor(intent: QueryIntent): string {
  switch (intent) {
    case 'WHEN':
      return DYNAMIC_INSTRUCTIONS.temporal
    case 'WHY':
      return DYNAMIC_INSTRUCTIONS.openDomain
    case 'ENTITY':
      return DYNAMIC_INSTRUCTIONS.singleHop
    case 'DEFAULT':
    default:
      return DYNAMIC_INSTRUCTIONS.multihop
  }
}

/**
 * Build the App C.2 user prompt: the retrieved context, the question, and the intent-derived dynamic
 * instruction. Carries NO gold answer and NO category number (anti-oracle).
 */
export function buildQaUserPrompt(req: QaGenerationRequest): string {
  return [
    `Context:\n${req.context}`,
    '',
    `Question: ${req.question}`,
    `Query-specific instruction: ${dynamicInstructionFor(req.intent)}`,
  ].join('\n')
}

/**
 * Parse a generator response: strip an echoed "Answer:" label + surrounding whitespace, and flag the
 * App C.2 abstain sentinel ("Information not found", tolerant of case + trailing punctuation) as
 * `notFound`. An empty response is treated as an abstain.
 */
export function parseQaResponse(raw: string): QaGenerationResult {
  const answer = raw.trim().replace(/^answer:\s*/i, '').trim()
  const normalized = answer.toLowerCase().replace(/[.!\s]+$/, '')
  if (answer === '' || normalized === QA_NOT_FOUND.toLowerCase()) {
    return { answer: answer === '' ? '' : answer, notFound: true }
  }
  return { answer, notFound: false }
}

/**
 * Null generator — always abstains, without spawning. The default, making the QA generator
 * default-OFF: importing the seam changes nothing until a caller wires in a real provider (the harness
 * does so only under `SCNS_QA_GENERATOR`).
 */
export const NULL_GENERATOR: QaGenerator = {
  async generate(): Promise<QaGenerationResult> {
    return { answer: '', notFound: true }
  },
}

const NULL_MARKER = Symbol.for('scns.qaGenerator.nullProvider')
;(NULL_GENERATOR as unknown as Record<symbol, boolean>)[NULL_MARKER] = true

export function isNullGenerator(p: QaGenerator | undefined | null): boolean {
  if (!p) return true
  return Boolean((p as unknown as Record<symbol, boolean>)[NULL_MARKER])
}
