/**
 * WS-2 Phase B3 — conversation SEGMENTER + measurement wiring (LoCoMo ruler; DEFAULT-OFF).
 *
 * The explicit WS-1 follow-up (`dream/event-segmenter.ts:14` — "Session-episode segmentation is a
 * deliberate WS-1 FOLLOW-UP, not implemented here"): turn a conversation (sessions of speaker turns)
 * into clean MAGMA event nodes ⟨c, τ, v, A⟩ (Eq 3). Unlike the deterministic broker/proposal
 * segmenters (which work only because their sources carry structured verdict/event_type fields),
 * conversation is unstructured PROSE, so events are EXTRACTED by an injected LLM at SESSION
 * granularity (Alg 2 fast-path segmentation, App C.1 event extraction) — measured to be the
 * evidence-supported path (deterministic per-turn reproduces the §B2 within-session turn-adjacency
 * null). Because consecutive event nodes for an entity now span SESSIONS, `buildEventCausalCandidates`
 * yields CROSS-SESSION decision→outcome pairs (the WHY subspace source, previously empty on LoCoMo).
 *
 * This module is MEASUREMENT-ONLY: prod `indexer.ts` is untouched and never segments conversation
 * (event + causal ingestion stay opt-in). With the NULL extractor it emits zero nodes ⇒ the pipeline
 * is byte-identical to today.
 */

import type Database from 'better-sqlite3'
import { causalKey, isLowSignalContent, buildCausalCandidates } from './causal-edges.js'
import {
  canonicalize,
  matchEntities,
  SCNS_GAZETTEER,
  type GazetteerEntry,
} from './entities/gazetteer.js'
import {
  writeEventNodes,
  buildEventCausalCandidates,
  type EventNodeRecord,
  type EmbedBatchFn,
  type WriteEventNodesStats,
} from './event-nodes.js'
import { runCausalEdgeInference, type CausalRunResult } from './causal-runner.js'
import type { CausalProvider } from './causal-provider.js'
import type {
  ConversationEventExtractor,
  ExtractedConversationEvent,
} from './conversation-event-extractor.js'

// ── LoCoMo time helpers (single source of truth; re-exported by scripts/locomo-corpus.ts) ──────────

const MONTHS: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
}

/** Parse a LoCoMo session date_time (e.g. "1:56 pm on 8 May, 2023") to epoch ms (UTC), or null. */
export function parseSessionDateTime(s: unknown): number | null {
  if (typeof s !== 'string') return null
  const m = /^(\d{1,2}):(\d{2})\s*(am|pm)\s+on\s+(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})$/i.exec(s.trim())
  if (!m) return null
  let hour = Number(m[1]) % 12
  if (m[3]!.toLowerCase() === 'pm') hour += 12
  const month = MONTHS[m[5]!.toLowerCase()]
  if (month === undefined) return null
  return Date.UTC(Number(m[6]), month, Number(m[4]), hour, Number(m[2]))
}

/** Deterministic epoch-ms → strict ISO-8601 (the first-class event-time τ carried on the node). */
export function tauMsToIso(ms: number): string {
  return new Date(ms).toISOString()
}

// ── conversation grouping ──────────────────────────────────────────────────────────────────────

export interface ConversationTurn {
  readonly speaker: string
  readonly text: string
  /** Provenance id (e.g. LoCoMo dia_id) — kept for debugging; not persisted on the node. */
  readonly ref: string
}

/** One dated conversation SESSION (the extraction granularity). */
export interface ConversationEpisode {
  readonly episodeId: string
  /** Session event-time in epoch ms, or null when the session date is missing/unparseable. */
  readonly tauMs: number | null
  readonly speakers: readonly string[]
  readonly turns: readonly ConversationTurn[]
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/**
 * Group a LoCoMo-shaped conversation record (`session_N` arrays + `session_N_date_time` +
 * `speaker_a`/`speaker_b`) into ordered {@link ConversationEpisode}s. Deterministic: sessions are
 * ordered by their numeric suffix. Turns with no textual content are dropped.
 */
export function groupLocomoConversation(conversation: Record<string, unknown>): ConversationEpisode[] {
  const speakers = [asString(conversation['speaker_a']), asString(conversation['speaker_b'])].filter(
    (s) => s !== '',
  )
  const sessionKeys = Object.keys(conversation)
    .filter((k) => /^session_\d+$/.test(k))
    .sort((a, b) => Number(a.slice(8)) - Number(b.slice(8)))

  const episodes: ConversationEpisode[] = []
  for (const sk of sessionKeys) {
    const arr = conversation[sk]
    if (!Array.isArray(arr)) continue
    const tauMs = parseSessionDateTime(conversation[`${sk}_date_time`])
    const turns: ConversationTurn[] = []
    for (const t of arr as Array<Record<string, unknown>>) {
      if (!t || typeof t !== 'object') continue
      const text = asString(t['text'])
      const cap = asString(t['blip_caption'])
      const combined = cap ? `${text} [shared image: ${cap}]`.trim() : text
      if (!combined) continue
      turns.push({
        speaker: asString(t['speaker']) || 'unknown',
        text: combined,
        ref: asString(t['dia_id']),
      })
    }
    episodes.push({ episodeId: sk, tauMs, speakers, turns })
  }
  return episodes
}

// ── segmentation ─────────────────────────────────────────────────────────────────────────────────

/** Minimum narratable length — shorter assembled content is dropped as non-narratable. */
const MIN_CONTENT_LENGTH = 24
/** Defensive cap on emitted nodes across the whole conversation. */
export const DEFAULT_MAX_CONVERSATION_NODES = 2000

export interface SegmentConversationOptions {
  readonly extractor: ConversationEventExtractor
  /** Entity vocabulary the acting-person is canonicalized against (LoCoMo ⇒ the oracle/speaker gaz). */
  readonly gazetteer?: readonly GazetteerEntry[]
  readonly maxNodes?: number
}

/** Hard caps keeping a runaway LLM extraction from bloating the learned vocabulary. */
const MAX_ENTITY_CHARS = 64
const MAX_ENTITY_WORDS = 5
const MAX_ENTITIES_PER_NODE = 12

/**
 * Normalize ONE raw entity surface to a canonical, or null when it is noise. Gazetteer FIRST (the
 * gazetteer is now only a canonicalization AID/seed): exact alias, then in-surface match. Otherwise
 * the surface is a LEARNED entity — kept as its lowercased, whitespace-collapsed canonical (so
 * "Melanie"/"melanie" don't fragment), but ONLY when it looks like a proper noun (App-C.1 targets
 * "People, Locations, Organizations" ⇒ an initial-capital token). Pronouns / lowercase common nouns
 * ("she", "the clinic") carry no capital ⇒ dropped as noise.
 */
function normalizeEntitySurface(
  raw: string,
  gazetteer: readonly GazetteerEntry[],
): string | null {
  const s = raw.trim().replace(/\s+/g, ' ')
  if (!s || s.length > MAX_ENTITY_CHARS) return null
  if (s.split(' ').length > MAX_ENTITY_WORDS) return null
  const exact = canonicalize(s, gazetteer)
  if (exact) return exact
  const inName = matchEntities(s, gazetteer)
  if (inName.length > 0) return inName[0]!.canonical
  if (!/(^|\s)[A-Z]/.test(s)) return null // learned fallback: proper nouns only
  return s.toLowerCase()
}

/**
 * Resolve an event's entities faithfully: the FULL deduped, capped set of canonicals (gazetteer OR
 * learned) drawn from the acting `entity` plus the App-C.1 `entities[]` proper nouns — these become
 * first-class `memory_entities` rows + entity edges (object permanence). `primary` is the single
 * anchor field (`event_nodes.entity`, used by cross-session causal pairing); when the extractor
 * yields no usable entity it falls back to the first gazetteer entity mentioned in the content.
 */
function normalizeEntities(
  ev: ExtractedConversationEvent,
  gazetteer: readonly GazetteerEntry[],
): { primary: string | null; entities: string[] } {
  const entities: string[] = []
  const seen = new Set<string>()
  const add = (rawEntity: string | null | undefined): void => {
    if (!rawEntity) return
    const c = normalizeEntitySurface(rawEntity, gazetteer)
    if (c && !seen.has(c)) {
      seen.add(c)
      entities.push(c)
    }
  }
  add(ev.entity)
  for (const e of ev.entities ?? []) add(e)
  const capped = entities.slice(0, MAX_ENTITIES_PER_NODE)
  let primary = capped[0] ?? null
  if (primary === null) {
    const inContent = matchEntities(ev.content, gazetteer)
    if (inContent.length > 0) primary = inContent[0]!.canonical
  }
  return { primary, entities: capped }
}

/** Stable, re-chunk-proof event identity (mirrors the deterministic segmenter's makeEventKey). */
function makeEventKey(sourceRef: string, content: string): string {
  return causalKey(`${sourceRef}\u0000${content}`)
}

/**
 * Segment a LoCoMo-shaped conversation into MAGMA event nodes. For each DATED session (τ required —
 * undated sessions are skipped, they cannot anchor an event time) the injected extractor proposes
 * decision→observation→outcome events; each becomes an {@link EventNodeRecord} with the session-τ,
 * the canonicalized acting person, and a stable event key. Output is deduped, low-signal-filtered,
 * and stable-sorted ascending by τ (so persistence assigns idempotent chunk indices). Pure aside
 * from the injected extractor; writes nothing.
 */
export async function segmentConversation(
  conversation: Record<string, unknown>,
  options: SegmentConversationOptions,
): Promise<EventNodeRecord[]> {
  const gazetteer = options.gazetteer ?? SCNS_GAZETTEER
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_CONVERSATION_NODES
  const episodes = groupLocomoConversation(conversation)

  const raw: EventNodeRecord[] = []
  for (const ep of episodes) {
    if (ep.tauMs === null || ep.turns.length === 0) continue // τ required; no τ ⇒ skip (no spawn)
    const tau = tauMsToIso(ep.tauMs)
    const events = await options.extractor.extract({
      episodeId: ep.episodeId,
      speakers: ep.speakers,
      turns: ep.turns.map((t) => ({ speaker: t.speaker, text: t.text })),
    })
    for (let i = 0; i < events.length; i++) {
      const ev = events[i]!
      const content = ev.content.trim()
      if (!content) continue
      const sourceRef = `conversation#${ep.episodeId}#${i}`
      const { primary, entities } = normalizeEntities(ev, gazetteer)
      raw.push({
        eventKey: makeEventKey(sourceRef, content),
        tau,
        entity: primary,
        entities,
        kind: 'conversation-event',
        decision: ev.decision,
        action: ev.action,
        outcome: ev.outcome,
        content,
        sourceRef,
      })
    }
  }

  const seen = new Set<string>()
  const kept: EventNodeRecord[] = []
  for (const r of raw) {
    if (r.content.length < MIN_CONTENT_LENGTH) continue
    if (isLowSignalContent(r.content)) continue
    if (seen.has(r.eventKey)) continue
    seen.add(r.eventKey)
    kept.push(r)
  }
  // Stable sort by τ only (Array.sort is stable ⇒ equal-τ keeps session/extraction order).
  kept.sort((a, b) => (a.tau < b.tau ? -1 : a.tau > b.tau ? 1 : 0))
  return kept.slice(0, maxNodes)
}

// ── measurement wiring (B3.3) — segment → write → causal inference (injectable; harness-owned spawns) ──

export interface IngestConversationEventsDeps {
  readonly extractor: ConversationEventExtractor
  readonly gazetteer?: readonly GazetteerEntry[]
  /** Embedder for the written nodes. Default = the real fastembed batch (harness); tests inject a stub. */
  readonly embed?: EmbedBatchFn
  readonly rebuildEdges?: boolean
  /** Also build the semantic (E_sem) edge tier so the graph carries all three paper edge types (T026). */
  readonly buildSemantic?: boolean
  readonly maxNodes?: number
  /** Inject a causal provider directly (tests ⇒ a mock). Wins over the env-gated ACP factory. */
  readonly causalProvider?: CausalProvider
  /** Build the real ACP causal judge (harness) when {@link runCausalEdgeInference}'s env flag is set. */
  readonly makeAcpProvider?: () => CausalProvider
  readonly env?: Record<string, string | undefined>
  readonly minConfidence?: number
  /**
   * Cap on causal candidates handed to the (batched, single-prompt) judge — the M1 tuning seam. The
   * causal ACP judge batches ALL candidates into ONE deny-all prompt, so an uncapped ~160-candidate
   * union blows the wall (M1 persisted 0). Event candidates are unioned FIRST, so a small cap keeps
   * the high-signal decision→outcome pairs and drops only leftover chunk turn-adjacency. Forwarded to
   * {@link runCausalEdgeInference}; absent ⇒ its DEFAULT_MAX_CANDIDATES.
   */
  readonly maxCandidates?: number
}

export interface IngestConversationEventsResult {
  readonly episodes: number
  readonly datedEpisodes: number
  readonly segmented: number
  readonly wrote: WriteEventNodesStats
  /** Node-quality diagnostic: decision→outcome candidates (event-sourced). */
  readonly eventCausalCandidates: number
  /** Node-quality diagnostic: turn-adjacency candidates (chunk-pair backbone). */
  readonly chunkCausalCandidates: number
  readonly causal: CausalRunResult
}

/**
 * MEASUREMENT-ONLY Arm-B ingestion (B3.3): segment the conversation into event nodes, persist them,
 * then run causal inference over the now-populated event/outcome source. Every collaborator is
 * injectable so a unit test drives the whole chain with a MOCK extractor + MOCK provider (no spawn,
 * no fastembed); the harness supplies the real deny-all ACP extractor + judge and a real embedder.
 * Also returns the node-quality diagnostic (event-sourced vs turn-adjacency candidate counts).
 */
export async function ingestConversationEventNodes(
  db: Database.Database,
  conversation: Record<string, unknown>,
  deps: IngestConversationEventsDeps,
): Promise<IngestConversationEventsResult> {
  const gazetteer = deps.gazetteer ?? SCNS_GAZETTEER
  const episodes = groupLocomoConversation(conversation)
  const datedEpisodes = episodes.filter((e) => e.tauMs !== null).length

  const records = await segmentConversation(conversation, {
    extractor: deps.extractor,
    gazetteer,
    ...(deps.maxNodes !== undefined ? { maxNodes: deps.maxNodes } : {}),
  })
  const wrote = await writeEventNodes(db, records, {
    gazetteer,
    rebuildEdges: deps.rebuildEdges ?? true,
    ...(deps.buildSemantic ? { buildSemantic: true } : {}),
    ...(deps.embed ? { embed: deps.embed } : {}),
  })

  // Node-quality diagnostic BEFORE inference (read-only counts).
  const eventCausalCandidates = buildEventCausalCandidates(db).length
  const chunkCausalCandidates = buildCausalCandidates(db).length

  const causal = await runCausalEdgeInference({
    db,
    ...(deps.causalProvider ? { provider: deps.causalProvider } : {}),
    ...(deps.makeAcpProvider ? { makeAcpProvider: deps.makeAcpProvider } : {}),
    ...(deps.env ? { env: deps.env } : {}),
    ...(deps.minConfidence !== undefined ? { minConfidence: deps.minConfidence } : {}),
    ...(deps.maxCandidates !== undefined ? { maxCandidates: deps.maxCandidates } : {}),
  })

  return {
    episodes: episodes.length,
    datedEpisodes,
    segmented: records.length,
    wrote,
    eventCausalCandidates,
    chunkCausalCandidates,
    causal,
  }
}
