/**
 * MAGMA node-model — LLM fact-extraction seam (the "what is this passage ABOUT, as a
 * self-contained relation" inference at ingest).
 *
 * MAGMA (Eq.3 / App C.1) does NOT index raw text chunks. At ingest it runs an LLM that
 * extracts RELATIONAL fact nodes — each a self-contained ⟨content, τ, vec, entities⟩ where
 * `content` states the relation in resolved form ("Riverdale is the place Melanie volunteers;
 * it is notable for its pipe organ"). Because the node's own text encodes the relation, its
 * embedding is query-relevant AND its entity links are clean, so a buried multi-hop answer is
 * reachable by its own relevance instead of only by a deep graph walk. SCNS proved last session
 * that deep multi-hop (depth-2 entity chains) is bounded by NODE QUALITY, not traversal scoring —
 * this is the seam that fixes that.
 *
 * Design mirrors `causal-provider.ts` / `negative-memory-critic-llm.ts`: the actual transport
 * (ACP / mock / fixture) is injected via {@link LlmFactExtractor}, so the indexer stays
 * LLM-agnostic and testable. The DEFAULT is {@link NULL_FACT_EXTRACTOR}, which extracts ZERO
 * facts — extraction is default-OFF and inert until a real provider is explicitly wired in
 * behind an env flag (`SCNS_EXTRACT_FACTS`). The provider NEVER writes anything: it only
 * proposes fact strings the indexer stores as derived chunks (facts-as-chunks).
 */

import { logger } from '../shared/logger.js'

const log = logger.child({ module: 'fact-extractor-provider' })

/**
 * A source passage offered to the extractor. `id` is an opaque token the caller maps back to
 * the originating chunk/file; `path` is the source file the extracted fact should attach to
 * (facts-as-chunks land under their source file so gold-by-file attribution is preserved).
 */
export interface FactSourceChunk {
  readonly id: string
  readonly path: string
  readonly content: string
}

/**
 * One extracted relational fact node. `sourceId` ties it back to the input chunk it is grounded
 * in / should attach to; `content` is the self-contained relational sentence (the node text).
 */
export interface ExtractedFact {
  readonly sourceId: string
  readonly content: string
}

export interface FactExtractionRequest {
  readonly chunks: readonly FactSourceChunk[]
  readonly timeoutMs?: number
}

export interface LlmFactExtractor {
  extract(req: FactExtractionRequest): Promise<readonly ExtractedFact[]>
}

/** Hard cap on a single extracted fact's length (chars) — a runaway node can't bloat the index. */
export const MAX_FACT_CHARS = 400
/** Hard cap on facts kept per source chunk — bounds index growth from a verbose extraction. */
export const MAX_FACTS_PER_SOURCE = 4

/**
 * Null extractor — extracts NO facts for any input. The default, making the node-model
 * default-OFF: with the null extractor the indexer adds zero derived nodes and behaves
 * byte-identically to today.
 */
export const NULL_FACT_EXTRACTOR: LlmFactExtractor = {
  async extract(): Promise<readonly ExtractedFact[]> {
    return []
  },
}

const NULL_MARKER = Symbol.for('scns.factExtractor.nullProvider')
;(NULL_FACT_EXTRACTOR as unknown as Record<symbol, boolean>)[NULL_MARKER] = true

export function isNullFactExtractor(p: LlmFactExtractor | undefined | null): boolean {
  if (!p) return true
  return Boolean((p as unknown as Record<symbol, boolean>)[NULL_MARKER])
}

// ── Prompt builder + parser (used by real providers) ─────────────────────────

export const FACT_EXTRACTION_SYSTEM_PROMPT = `You extract self-contained RELATIONAL FACTS from a
small set of related memory passages, in the style of a knowledge-graph builder.

You are given several short passages, each with an id. Together they may describe a chain of
relations across DIFFERENT passages (e.g. one passage says a person volunteers somewhere, another
says what that place is notable for). Your job is to emit fact nodes that each STAND ALONE.

Rules:
  - Each fact must be a single self-contained sentence that RESOLVES references using the other
    passages: replace pronouns and vague phrases ("the place", "there", "that cause") with the
    concrete named entities, and FOLD IN the relation that connects passages (e.g. "the place
    where Melanie volunteers each week, the Riverdale Settlement House, is notable for its
    century-old pipe organ").
  - Ground every fact ONLY in the given passages — never invent entities or facts not supported
    by the text. If a passage states a notable/defining property of an entity that another
    passage links to a person/topic, fuse them into ONE fact attached to the property passage.
  - Attach each fact to the sourceId of the passage that carries the distinctive PROPERTY (the
    thing that ANSWERS "what is notable/special about X"), not the linking passage.
  - Do NOT emit a separate fact for a passage that merely LINKS two entities (a bridge that only
    says "X is where Y happens" with no distinctive property of its own) — fold its link INTO the
    property passage's fact and skip the bridge. Emitting a competing fact for a bare link only
    crowds retrieval. Emit at most a few high-value facts.
  - Keep each fact FOCUSED and concise: one clause for the entity + its link, one clause for the
    distinctive property. Omit incidental descriptive color (extra adjectives, who visits, how
    long, geographic asides) — trailing color dilutes the fact and weakens retrieval.

Return ONE JSON array. Each element: {"sourceId": string, "content": string}.
Use the EXACT sourceId values from the input. Only output the JSON array. No prose, no code fences.`

export function buildFactExtractionUserPrompt(opts: {
  chunks: readonly FactSourceChunk[]
}): string {
  const lines = ['Passages:', '']
  for (const c of opts.chunks) {
    lines.push(`- sourceId: ${c.id}`)
    lines.push(`  text: ${JSON.stringify(c.content.slice(0, 600).replace(/\s+/g, ' '))}`)
  }
  return lines.join('\n')
}

/**
 * Extract a JSON value from a model response. LLMs routinely wrap JSON in markdown code fences
 * or surround it with prose even when told not to, so strip a leading/trailing backtick fence
 * and, failing a direct parse, fall back to the outermost `[...]` array literal. Throws if
 * nothing parses (the caller turns that into "no facts").
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
 * Parse a JSON-array response into validated facts. Defensive (do-no-harm):
 *   - unparseable / non-array ⇒ [] (no facts, never throws)
 *   - only facts whose sourceId EXISTS in the request are kept (no hallucinated attachment)
 *   - blank content is dropped; content is trimmed + capped to {@link MAX_FACT_CHARS}
 *   - identical (sourceId, content) pairs are de-duplicated
 *   - at most {@link MAX_FACTS_PER_SOURCE} facts are kept per source chunk
 */
export function parseFactExtractionResponse(
  raw: string,
  validSourceIds: readonly string[],
): readonly ExtractedFact[] {
  const valid = new Set(validSourceIds)
  if (valid.size === 0) return []

  let parsed: unknown
  try {
    parsed = extractJsonArray(raw)
  } catch (err) {
    log.warn({ err: String(err) }, 'fact-extractor response was not valid JSON; extracting no facts')
    return []
  }
  if (!Array.isArray(parsed)) return []

  const out: ExtractedFact[] = []
  const seen = new Set<string>()
  const perSource = new Map<string, number>()
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const sourceId = typeof o['sourceId'] === 'string' ? o['sourceId'] : ''
    if (!sourceId || !valid.has(sourceId)) continue
    const rawContent = typeof o['content'] === 'string' ? o['content'] : ''
    const content = rawContent.trim().replace(/\s+/g, ' ').slice(0, MAX_FACT_CHARS)
    if (!content) continue
    const dedupKey = `${sourceId}\u0000${content}`
    if (seen.has(dedupKey)) continue
    const count = perSource.get(sourceId) ?? 0
    if (count >= MAX_FACTS_PER_SOURCE) continue
    seen.add(dedupKey)
    perSource.set(sourceId, count + 1)
    out.push({ sourceId, content })
  }
  return out
}
