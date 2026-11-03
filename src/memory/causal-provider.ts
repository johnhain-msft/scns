/**
 * Causal-edge provider (M1.3, design-m1.md §5) — the LLM "WHY" inference seam.
 *
 * Mirrors `negative-memory-critic-llm.ts`: the actual transport (ACP / mock) is
 * injected via {@link CausalProvider}, so the dream slow-path is testable and
 * degrades gracefully when no provider is configured. The DEFAULT is the
 * {@link NULL_CAUSAL_PROVIDER}, which infers ZERO edges — M1.3 is default-OFF and
 * inert until a real provider is explicitly wired in behind an env flag.
 *
 * Causal edges are the highest-value but highest-risk MAGMA subspace (issue-#5
 * precedent: an ungated self-writer corrupted the guardrails file). This module
 * therefore NEVER writes anything itself — it only proposes (cause→effect) edges
 * that the runner gates (confidence threshold + cap) before persisting to the
 * dedicated `memory_causal` table (never to guardrail files).
 */

import { logger } from '../shared/logger.js'

const log = logger.child({ module: 'causal-provider' })

/**
 * A (cause→effect) pair proposed for causal judgement. Keys are STABLE
 * content-hashes (see `causal-edges.causalKey`) so an adopted edge survives
 * re-chunking, when chunk ids change (design-m1.md §3-4).
 */
export interface CausalCandidate {
  readonly causeKey: string
  readonly effectKey: string
  readonly causeContent: string
  readonly effectContent: string
  /** Shared neighbourhood anchor (gazetteer canonical entity). */
  readonly entity: string
  readonly causeFilePath: string
  readonly effectFilePath: string
}

/** An inferred causal edge — cause led to effect, with a confidence in [0,1]. */
export interface CausalEdge {
  readonly causeKey: string
  readonly effectKey: string
  readonly confidence: number
  readonly rationale?: string
}

export interface CausalInferRequest {
  readonly candidates: readonly CausalCandidate[]
  readonly timeoutMs?: number
}

export interface CausalProvider {
  infer(req: CausalInferRequest): Promise<readonly CausalEdge[]>
}

/**
 * Null provider — infers NO edges for any input. The default, making M1.3
 * default-OFF: with the null provider the runner writes nothing.
 */
export const NULL_CAUSAL_PROVIDER: CausalProvider = {
  async infer(): Promise<readonly CausalEdge[]> {
    return []
  },
}

const NULL_MARKER = Symbol.for('scns.causalProvider.nullProvider')
;(NULL_CAUSAL_PROVIDER as unknown as Record<symbol, boolean>)[NULL_MARKER] = true

export function isNullCausalProvider(p: CausalProvider | undefined | null): boolean {
  if (!p) return true
  return Boolean((p as unknown as Record<symbol, boolean>)[NULL_MARKER])
}

// ── Prompt builder + parser (used by real providers) ─────────────────────────

export const CAUSAL_SYSTEM_PROMPT = `You are analysing pairs of memory entries from an
autonomous coding agent's long-term memory. Each pair is two events about the SAME
subject, in time order: an EARLIER event (the candidate cause) and a LATER event (the
candidate effect). Decide, for each pair, whether the earlier event PLAUSIBLY CAUSED or
directly led to the later event — not merely that they are about the same topic or
happened in sequence.

Be conservative. Only assert a causal link when the text supports genuine logical
entailment. If in doubt, omit the pair.

Return ONE JSON array. Each element you are confident about:
{"causeKey": string, "effectKey": string, "confidence": number (0..1), "rationale": string (<= 140 chars)}.
Use the EXACT causeKey/effectKey from the input. Omit pairs that are not causal.
Only output the JSON array. No prose, no code fences.`

export function buildCausalUserPrompt(opts: { candidates: readonly CausalCandidate[] }): string {
  const lines = ['Candidate cause→effect pairs:', '']
  for (const c of opts.candidates) {
    lines.push(`- causeKey: ${c.causeKey}`)
    lines.push(`  effectKey: ${c.effectKey}`)
    lines.push(`  entity: ${c.entity}`)
    lines.push(`  cause (earlier): ${JSON.stringify(c.causeContent.slice(0, 280).replace(/\s+/g, ' '))}`)
    lines.push(`  effect (later): ${JSON.stringify(c.effectContent.slice(0, 280).replace(/\s+/g, ' '))}`)
  }
  return lines.join('\n')
}

function clamp01(n: number): number {
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

/**
 * Extract a JSON value from a model response. LLMs routinely wrap JSON in markdown code
 * fences or inline backticks (even when told not to) or surround it with prose, so strip a
 * leading/trailing backtick fence (1–3 backticks, optional language tag) and, failing a
 * direct parse, fall back to the outermost `[...]` array literal. Throws if nothing parses
 * (the caller turns that into "no edges").
 */
function extractJsonArray(raw: string): unknown {
  const stripped = raw
    .trim()
    .replace(/^`{1,3}[ \t]*(?:json|jsonc)?[ \t]*\r?\n?/i, '')
    .replace(/\r?\n?[ \t]*`{1,3}$/i, '')
    .trim()
  try {
    return JSON.parse(stripped)
  } catch {
    const start = stripped.indexOf('[')
    const end = stripped.lastIndexOf(']')
    if (start !== -1 && end > start) {
      return JSON.parse(stripped.slice(start, end + 1))
    }
    throw new Error('no JSON array found in response')
  }
}

/**
 * Parse a JSON-array response into validated edges. Defensive (do-no-harm):
 *   - unparseable / non-array ⇒ [] (no edges, never throws)
 *   - only key pairs that EXIST in `candidates` are kept (no hallucinated keys)
 *   - confidence must be a finite number; it is clamped to [0,1]
 */
export function parseCausalResponse(
  raw: string,
  candidates: readonly CausalCandidate[],
): readonly CausalEdge[] {
  const validPairs = new Set(candidates.map((c) => `${c.causeKey}\u0000${c.effectKey}`))
  if (validPairs.size === 0) return []

  let parsed: unknown
  try {
    parsed = extractJsonArray(raw)
  } catch (err) {
    log.warn({ err: String(err) }, 'causal critic response was not valid JSON; inferring no edges')
    return []
  }
  if (!Array.isArray(parsed)) return []

  const out: CausalEdge[] = []
  const seen = new Set<string>()
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const causeKey = typeof o['causeKey'] === 'string' ? o['causeKey'] : ''
    const effectKey = typeof o['effectKey'] === 'string' ? o['effectKey'] : ''
    const pair = `${causeKey}\u0000${effectKey}`
    if (!causeKey || !effectKey || !validPairs.has(pair) || seen.has(pair)) continue
    const confRaw = o['confidence']
    if (typeof confRaw !== 'number' || !Number.isFinite(confRaw)) continue
    const rationale = typeof o['rationale'] === 'string' ? o['rationale'].slice(0, 280) : undefined
    seen.add(pair)
    out.push({
      causeKey,
      effectKey,
      confidence: clamp01(confRaw),
      ...(rationale ? { rationale } : {}),
    })
  }
  return out
}
