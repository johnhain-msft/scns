/**
 * WS-2 Phase B3 — conversation event EXTRACTOR seam (LLM extraction at SESSION granularity).
 *
 * MAGMA does not index raw conversation turns: at ingest it runs an LLM that EXTRACTS structured
 * events (App C.1 event extraction; Alg 2 fast-path segmentation), each a self-contained node
 * ⟨content, τ, vec, entities⟩ (Eq 3). This module is the extraction seam for CONVERSATION sources
 * (the explicit WS-1 follow-up — session-episode segmentation the deterministic
 * `dream/event-segmenter.ts` left unimplemented because prose lacks the structured verdict/event_type
 * fields the deterministic path relies on).
 *
 * Design mirrors `fact-extractor-provider.ts` exactly: the transport (ACP / mock / fixture) is
 * injected via {@link ConversationEventExtractor}, the DEFAULT is {@link NULL_CONVERSATION_EVENT_EXTRACTOR}
 * (default-OFF ⇒ zero events ⇒ byte-identical to today), and the pure prompt/parser here NEVER spawn
 * a process. The extractor only PROPOSES event fields; persistence lives in `event-nodes.ts`.
 *
 * Field mapping: an event is a decision → OBSERVATION → outcome triple. The paper's OBSERVATION term
 * (the observable event between the decision and its outcome) is carried by
 * {@link ExtractedConversationEvent.action}, so it maps 1:1 onto the WS-1 `EventNodeRecord.action`
 * column without any schema change.
 */

import { logger } from '../shared/logger.js'

const log = logger.child({ module: 'conversation-event-extractor' })

/**
 * One structured event extracted from a conversation session. `content` is the self-contained
 * narratable node text (what gets embedded + FTS-indexed); `entity` is the acting person/subject
 * (a free surface form the segmenter later canonicalizes against the gazetteer). `decision`,
 * `action` (paper's OBSERVATION), and `outcome` are the discrete decision→observation→outcome parts
 * (each nullable — not every event has all three).
 */
export interface ExtractedConversationEvent {
  readonly entity: string | null
  readonly decision: string | null
  /** The paper's OBSERVATION: the observable event between the decision and its outcome. */
  readonly action: string | null
  readonly outcome: string | null
  /** Self-contained narratable node text (the chunk content). Required, non-empty. */
  readonly content: string
  // ── App C.1 structured schema (optional on the type for legacy mocks; the parser + real extractor
  //    ALWAYS populate them). Kept ALONGSIDE the decision/observation/outcome triple, not instead of it. ──
  /** C.1 "entities": proper nouns (People, Locations, Organizations). */
  readonly entities?: readonly string[]
  /** C.1 "topic": 1–3 words representing the main theme. */
  readonly topic?: string | null
  /** C.1 "relationships": interaction descriptions (e.g. "X researches Y"). */
  readonly relationships?: readonly string[]
  /** C.1 "semantic_facts": atomic facts preserving key information. */
  readonly semanticFacts?: readonly string[]
  /** C.1 "dates_mentioned": temporal strings (e.g. "next Friday", "2024-01-01"). */
  readonly datesMentioned?: readonly string[]
  /** C.1 "summary": one-sentence summary preserving speaker attribution. */
  readonly summary?: string | null
}

export interface ConversationTurnInput {
  readonly speaker: string
  readonly text: string
}

/** One conversation SESSION offered to the extractor (the granularity of extraction). */
export interface ConversationEpisodeInput {
  /** Stable episode id (e.g. LoCoMo `session_5`) — provenance only. */
  readonly episodeId: string
  readonly speakers: readonly string[]
  readonly turns: readonly ConversationTurnInput[]
  readonly timeoutMs?: number
}

export interface ConversationEventExtractor {
  extract(episode: ConversationEpisodeInput): Promise<readonly ExtractedConversationEvent[]>
}

/** Hard cap on one extracted event's content length (chars) — a runaway node can't bloat the index. */
export const MAX_EVENT_CONTENT_CHARS = 400
/** Hard cap on events kept per session — bounds index growth from a verbose extraction. */
export const MAX_EVENTS_PER_EPISODE = 8
/** Per-turn text truncation in the prompt (keeps the batch bounded). */
const MAX_TURN_CHARS = 500

/**
 * Null extractor — extracts NO events for any input. The default, making conversation ingestion
 * default-OFF: with the null extractor the segmenter yields zero event nodes and the pipeline is
 * byte-identical to today.
 */
export const NULL_CONVERSATION_EVENT_EXTRACTOR: ConversationEventExtractor = {
  async extract(): Promise<readonly ExtractedConversationEvent[]> {
    return []
  },
}

const NULL_MARKER = Symbol.for('scns.conversationEventExtractor.nullProvider')
;(NULL_CONVERSATION_EVENT_EXTRACTOR as unknown as Record<symbol, boolean>)[NULL_MARKER] = true

export function isNullConversationEventExtractor(
  p: ConversationEventExtractor | undefined | null,
): boolean {
  if (!p) return true
  return Boolean((p as unknown as Record<symbol, boolean>)[NULL_MARKER])
}

// ── Prompt builder + parser (used by real providers) ─────────────────────────

export const CONVERSATION_EVENT_SYSTEM_PROMPT = `You are an automated Graph Memory Parser. You extract
structured life EVENTS from a single session of a long-running conversation between two people, to build
a knowledge graph (MAGMA App C.1 event extraction).

You are given the speakers and the ordered turns of ONE dated session. Extract the discrete EVENTS
that happened to / were decided by a speaker.

Rules:
  - Emit an event only for something that actually OCCURRED or was DECIDED in this session's text
    (a plan someone acted on, a thing they did, a result they reported). Do NOT invent events, and
    do NOT emit an event for small talk, greetings, questions, or opinions with no action.
  - Each event's "content" MUST be a single self-contained sentence that resolves references using
    the session (replace "I", "there", "it" with the concrete named person/place), so the node
    stands alone out of context.
  - Ground EVERY field ONLY in the session text. Prefer a FEW high-value events over many trivial ones.

Return ONE JSON array. Each element is an object matching this schema (App C.1 fields + the
decision→observation→outcome structure):
{
  "entities": string[],          // proper nouns: People, Locations, Organizations
  "topic": string,               // 1–3 words representing the main theme
  "relationships": string[],     // interactions, e.g. "X researches Y"
  "semantic_facts": string[],    // atomic facts preserving key information
  "dates_mentioned": string[],   // temporal strings, e.g. "next Friday", "2024-01-01"
  "summary": string,             // one-sentence summary preserving speaker attribution
  "entity": string|null,         // the primary person the event is ABOUT (usually a speaker)
  "decision": string|null,       // what they chose to do
  "observation": string|null,    // the observable event/action they took
  "outcome": string|null,        // the result or consequence
  "content": string              // the self-contained narratable node text
}
Any nullable field may be null and any list may be empty, but "content" (or "summary") is required.
Only output the JSON array. No prose, no code fences.`

export function buildConversationEventUserPrompt(episode: ConversationEpisodeInput): string {
  const lines: string[] = [
    `Session: ${episode.episodeId}`,
    `Speakers: ${episode.speakers.join(', ')}`,
    '',
    'Turns:',
  ]
  for (const t of episode.turns) {
    const text = t.text.slice(0, MAX_TURN_CHARS).replace(/\s+/g, ' ').trim()
    if (!text) continue
    lines.push(`- ${t.speaker}: ${text}`)
  }
  return lines.join('\n')
}

/**
 * Extract a JSON value from a model response — strip a leading/trailing markdown fence, then fall
 * back to the outermost `[...]` array literal. Throws if nothing parses (caller ⇒ "no events").
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

function optField(o: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'string' && v.trim() !== '') return v.trim().replace(/\s+/g, ' ')
  }
  return null
}

/** Parse a JSON array of strings, trimming + dropping blanks (do-no-harm: non-array ⇒ []). */
function strArray(o: Record<string, unknown>, key: string): string[] {
  const v = o[key]
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const x of v) {
    if (typeof x === 'string' && x.trim() !== '') out.push(x.trim().replace(/\s+/g, ' '))
  }
  return out
}

/**
 * Parse a JSON-array response into validated events. Defensive (do-no-harm):
 *   - unparseable / non-array ⇒ [] (no events, never throws)
 *   - the App C.1 schema {entities, topic, relationships, semantic_facts, dates_mentioned, summary} is
 *     parsed ALONGSIDE the paper's decision/observation/outcome triple ("observation" maps onto `action`;
 *     an explicit "action" key is also accepted)
 *   - `content` falls back to the C.1 `summary` when absent; an event with neither is dropped
 *   - the primary `entity` falls back to the first C.1 `entities[]` proper noun when absent
 *   - `content` is trimmed + capped to {@link MAX_EVENT_CONTENT_CHARS}; identical content is deduped
 *   - at most {@link MAX_EVENTS_PER_EPISODE} events are kept per session
 */
export function parseConversationEventResponse(raw: string): readonly ExtractedConversationEvent[] {
  let parsed: unknown
  try {
    parsed = extractJsonArray(raw)
  } catch (err) {
    log.warn({ err: String(err) }, 'conversation-event response was not valid JSON; extracting no events')
    return []
  }
  if (!Array.isArray(parsed)) return []

  const out: ExtractedConversationEvent[] = []
  const seen = new Set<string>()
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const summary = optField(o, 'summary')
    const rawContent = typeof o['content'] === 'string' ? o['content'] : ''
    const trimmedContent = rawContent.trim().replace(/\s+/g, ' ').slice(0, MAX_EVENT_CONTENT_CHARS)
    // Content is the node text; fall back to the C.1 one-sentence summary when content is absent.
    const content = trimmedContent || (summary ? summary.slice(0, MAX_EVENT_CONTENT_CHARS) : '')
    if (!content) continue
    if (seen.has(content)) continue
    seen.add(content)
    const entities = strArray(o, 'entities')
    out.push({
      entity: optField(o, 'entity') ?? (entities[0] ?? null),
      decision: optField(o, 'decision'),
      action: optField(o, 'observation', 'action'),
      outcome: optField(o, 'outcome'),
      content,
      entities,
      topic: optField(o, 'topic'),
      relationships: strArray(o, 'relationships'),
      semanticFacts: strArray(o, 'semantic_facts'),
      datesMentioned: strArray(o, 'dates_mentioned'),
      summary,
    })
    if (out.length >= MAX_EVENTS_PER_EPISODE) break
  }
  return out
}
