/**
 * Causal-edge candidate generation + gated persistence (M1.3, design-m1.md §3-5).
 *
 * Two halves of the dream slow-path's causal phase, both deterministic and
 * LLM-free (the LLM only judges candidates, via a {@link CausalProvider}):
 *
 *  1. {@link buildCausalCandidates} derives (cause→effect) pairs from the existing
 *     DETERMINISTIC temporal backbone (`memory_edges` edge_type='temporal'), scoped
 *     to CURATED tiers (MEMORY.md / weekly / monthly / sessions) — never raw daily
 *     telemetry. Each pair is keyed on a STABLE content-hash, not the volatile
 *     chunk id, so an adopted edge survives re-chunking (design-m1.md §3).
 *
 *  2. {@link persistCausalEdges} is the GATE: it drops edges below a confidence
 *     threshold, caps the number written per run (keeping the most confident), and
 *     dedupes on (cause_key, effect_key). It writes ONLY to the dedicated
 *     `memory_causal` table — NEVER to guardrail files (issue-#5 precedent).
 */

import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { CausalCandidate, CausalEdge } from './causal-provider.js'

/** Tiers excluded from causal reasoning: raw telemetry, not curated memory. */
const NON_CURATED_PREFIXES = ['daily/', 'archive/'] as const

/** Default cap on candidate pairs sent to the (expensive) provider per run. */
export const DEFAULT_MAX_CANDIDATES = 200
/** Default confidence gate — only edges at/above this are persisted. */
export const DEFAULT_MIN_CONFIDENCE = 0.7
/** Default cap on edges persisted per run (keeps the highest-confidence ones). */
export const DEFAULT_MAX_EDGES = 50

/**
 * Stable, deterministic key for a memory's text — a truncated SHA-256 of the
 * whitespace-normalised content. Insignificant whitespace (the only thing
 * re-chunking can change for the same source text) is collapsed first, so the
 * same logical content always yields the same key across re-indexing.
 */
export function causalKey(content: string): string {
  const normalised = content.replace(/\s+/g, ' ').trim()
  return createHash('sha256').update(normalised).digest('hex').slice(0, 16)
}

/** True for curated tiers (anything that is NOT raw daily/archive telemetry). */
export function isCuratedTierPath(path: string): boolean {
  return !NON_CURATED_PREFIXES.some((p) => path.startsWith(p))
}

/** Telemetry / stat-table markers that signal non-narratable content. */
const TELEMETRY_MARKERS: readonly RegExp[] = [
  /session digest:/i,
  /tool usage pattern/i,
  /weekly logs processed/i,
  /stable patterns found/i,
  /\bspans:\s*\*{0,2}\s*\d/i,
  /\btraces:\s*\*{0,2}\s*\d/i,
  /avg duration/i,
  /generated:\s*\d{4}-/i,
]

/**
 * True for content that is telemetry / stats / non-prose rather than a narratable event:
 * session digests, tool-usage patterns, markdown stat tables, trivially short fragments, or
 * text dominated by numbers/symbols. Such chunks make poor causal candidates (the judge
 * cannot reason about cause→effect over a stats table), so {@link buildCausalCandidates}
 * excludes them by default. This was added after the M1.3 L2 go-live exercise showed the
 * raw temporal backbone pairs were mid-word fragments of telemetry-heavy consolidation tiers
 * (the conservative judge correctly returned zero edges over them).
 */
export function isLowSignalContent(content: string): boolean {
  const s = content.trim()
  if (s.length < 16) return true
  if (TELEMETRY_MARKERS.some((re) => re.test(s))) return true
  const lines = s.split('\n')
  if (lines.length >= 3) {
    const pipeLines = lines.filter((l) => l.includes('|')).length
    if (pipeLines / lines.length > 0.5) return true
  }
  const words = s.split(/\s+/).filter(Boolean)
  const alphaWords = words.filter((w) => /[a-z]{3,}/i.test(w)).length
  if (words.length >= 6 && alphaWords / words.length < 0.5) return true
  return false
}

export interface BuildCandidatesOptions {
  /** Cap the number of candidate pairs. Default {@link DEFAULT_MAX_CANDIDATES}. */
  readonly maxCandidates?: number
  /**
   * Drop pairs whose cause and effect are the same file — consecutive chunks of one
   * document are overlapping fragments, not two distinct events. Default true.
   */
  readonly excludeSameFile?: boolean
  /**
   * Drop pairs where either side is {@link isLowSignalContent} (telemetry/stat tables).
   * Default true.
   */
  readonly excludeLowSignal?: boolean
}

interface TemporalRow {
  causeContent: string
  causeFile: string
  effectContent: string
  effectFile: string
  entity: string | null
}

/**
 * Derive (cause→effect) candidate pairs from the temporal backbone, restricted to
 * curated tiers and deduped by stable key pair. The earlier chunk is the candidate
 * cause; the later chunk (its temporal successor) the candidate effect.
 */
export function buildCausalCandidates(
  db: Database.Database,
  options: BuildCandidatesOptions = {},
): CausalCandidate[] {
  const max = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES
  if (max <= 0) return []
  const excludeSameFile = options.excludeSameFile ?? true
  const excludeLowSignal = options.excludeLowSignal ?? true

  const rows = db
    .prepare(
      `SELECT pc.content AS causeContent, pc.file_path AS causeFile,
              sc.content AS effectContent, sc.file_path AS effectFile,
              me.name    AS entity
       FROM memory_edges e
       JOIN chunks pc ON pc.id = e.src_chunk
       JOIN chunks sc ON sc.id = e.dst_chunk
       LEFT JOIN memory_entities me ON me.id = e.dst_entity
       WHERE e.edge_type = 'temporal'
       ORDER BY e.id`,
    )
    .all() as TemporalRow[]

  const out: CausalCandidate[] = []
  const seen = new Set<string>()
  for (const r of rows) {
    if (!isCuratedTierPath(r.causeFile) || !isCuratedTierPath(r.effectFile)) continue
    if (excludeSameFile && r.causeFile === r.effectFile) continue
    if (excludeLowSignal && (isLowSignalContent(r.causeContent) || isLowSignalContent(r.effectContent)))
      continue
    const causeKey = causalKey(r.causeContent)
    const effectKey = causalKey(r.effectContent)
    if (causeKey === effectKey) continue
    const pair = `${causeKey}\u0000${effectKey}`
    if (seen.has(pair)) continue
    seen.add(pair)
    out.push({
      causeKey,
      effectKey,
      causeContent: r.causeContent,
      effectContent: r.effectContent,
      entity: r.entity ?? '',
      causeFilePath: r.causeFile,
      effectFilePath: r.effectFile,
    })
    if (out.length >= max) break
  }
  return out
}

export interface PersistCausalOptions {
  /** Confidence gate. Default {@link DEFAULT_MIN_CONFIDENCE}. */
  readonly minConfidence?: number
  /** Max edges persisted this run. Default {@link DEFAULT_MAX_EDGES}. */
  readonly maxEdges?: number
  /** Provider label recorded on each row (e.g. 'acp'). */
  readonly provider: string
  /** Optional `${causeKey}\u0000${effectKey}` → entity, recorded for context. */
  readonly entityByPair?: ReadonlyMap<string, string>
}

export interface PersistCausalStats {
  /** Edges supplied to the gate. */
  readonly considered: number
  /** Edges actually inserted (new rows; duplicates count 0). */
  readonly persisted: number
  /** Edges dropped for failing the confidence gate. */
  readonly rejectedLowConfidence: number
  /** Edges dropped because they exceeded the per-run cap. */
  readonly cappedOut: number
}

/**
 * Gate + persist inferred edges. Filters by confidence, caps the count (highest
 * confidence first), dedupes via the table's UNIQUE(cause_key, effect_key).
 */
export function persistCausalEdges(
  db: Database.Database,
  edges: readonly CausalEdge[],
  options: PersistCausalOptions,
): PersistCausalStats {
  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE
  const maxEdges = options.maxEdges ?? DEFAULT_MAX_EDGES
  const considered = edges.length

  const passing = edges.filter((e) => e.confidence >= minConfidence)
  const rejectedLowConfidence = considered - passing.length

  const ranked = [...passing].sort((a, b) => b.confidence - a.confidence)
  const capped = ranked.slice(0, Math.max(0, maxEdges))
  const cappedOut = ranked.length - capped.length

  const insert = db.prepare(
    `INSERT OR IGNORE INTO memory_causal (cause_key, effect_key, entity, rationale, confidence, provider)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
  let persisted = 0
  const tx = db.transaction((toWrite: readonly CausalEdge[]) => {
    for (const e of toWrite) {
      const entity = options.entityByPair?.get(`${e.causeKey}\u0000${e.effectKey}`) ?? null
      const res = insert.run(
        e.causeKey,
        e.effectKey,
        entity,
        e.rationale ?? null,
        e.confidence,
        options.provider,
      )
      persisted += res.changes
    }
  })
  tx(capped)

  return { considered, persisted, rejectedLowConfidence, cappedOut }
}

// ── WS-2b: materialize the content-hash-keyed causal table into the chunk→chunk graph ────────
//
// `memory_causal` (persisted above) is keyed on STABLE content hashes so an inferred edge survives
// re-chunking — but the adaptive-traversal beam reads `memory_edges` rows keyed on the volatile
// `chunks.id` (`adaptive-traversal.ts neighbors()`: edge_type='causal' → dst_chunk). That WRITE/READ
// split left the causal beam dimension INERT. This bridges it: resolve each causal row's cause/effect
// key back to a LIVE chunk and write chunk→chunk `memory_edges(edge_type='causal')` rows the beam can
// actually traverse. Re-run each dream causal pass (keys re-resolve to current chunk ids ⇒ re-chunk
// safe). SCOPED-delete + rebuild ⇒ idempotent, and — crucially — `rebuildMemoryEdges` only deletes
// edge_type IN ('entity','temporal'), so these causal rows SURVIVE a deterministic edge rebuild.

interface ChunkContentRow {
  readonly id: number
  readonly content: string
}

/**
 * Build a `causalKey(content) → live chunk` map over the current `chunks` table so the hash-keyed
 * `memory_causal` rows can be resolved back to chunk ids. On a hash collision (the SAME normalised
 * text in multiple chunks) the MOST-RECENT chunk (highest id) wins — the freshest surviving copy.
 * Shared with the WHY reader (`causal-neighborhood.ts`) so both resolve keys identically.
 */
export function buildCausalKeyToChunk(db: Database.Database): Map<string, ChunkContentRow> {
  const rows = db.prepare('SELECT id, content FROM chunks').all() as ChunkContentRow[]
  const map = new Map<string, ChunkContentRow>()
  for (const r of rows) {
    const key = causalKey(r.content)
    const existing = map.get(key)
    if (!existing || r.id > existing.id) map.set(key, r)
  }
  return map
}

/**
 * Which chunk→chunk edge directions to materialize per causal (cause→effect) pair.
 * The beam treats `memory_edges` as a reachability graph: `neighbors(u,'causal')` returns the
 * `dst_chunk` of rows with `src_chunk=u`. So a WHY query — which anchors on the EFFECT/outcome and
 * needs to reach the CAUSE — only reaches the cause when a REVERSE (effect→cause) edge exists;
 * a "what did X lead to" query needs the FORWARD (cause→effect) edge. `'both'` (default) makes
 * causal reachability symmetric; the causal DIRECTION is not lost — it is retained in `memory_causal`
 * and recovered at synthesis by the topological order (paper Stage 4). The pos+neg beam test settles
 * this empirically rather than by assumption.
 */
export type CausalEdgeDirection = 'forward' | 'reverse' | 'both'

export interface MaterializeCausalOptions {
  /** Directions to write per pair. Default 'both'. */
  readonly direction?: CausalEdgeDirection
}

export interface MaterializeCausalStats {
  /** `memory_causal` rows scanned. */
  readonly consideredRows: number
  /** `memory_edges(edge_type='causal')` rows written (2× resolved pairs when direction='both'). */
  readonly materialized: number
  /** Rows whose cause OR effect key did not resolve to a live chunk (left in `memory_causal`). */
  readonly unresolved: number
}

/**
 * Materialize `memory_causal` into chunk→chunk `memory_edges(edge_type='causal')` the beam reads.
 * Idempotent (scoped-delete + rebuild). Rows whose keys do not resolve to a live chunk (e.g. an
 * outcome-only edge with no backing chunk) are skipped and counted `unresolved` — they remain in
 * `memory_causal` and are surfaced by the WHY reader as today. Does NOT open its own transaction for
 * the delete/reads so it composes with a caller's transaction if needed (the writes use one txn).
 */
export function materializeCausalEdges(
  db: Database.Database,
  options: MaterializeCausalOptions = {},
): MaterializeCausalStats {
  const direction = options.direction ?? 'both'

  // Scoped, idempotent rebuild of the causal tier. This is the ONLY writer of edge_type='causal';
  // rebuildMemoryEdges deletes only entity/temporal, so these rows survive a deterministic rebuild.
  db.prepare("DELETE FROM memory_edges WHERE edge_type = 'causal'").run()

  const rows = db
    .prepare('SELECT cause_key AS causeKey, effect_key AS effectKey, confidence FROM memory_causal')
    .all() as Array<{ causeKey: string; effectKey: string; confidence: number }>
  const consideredRows = rows.length
  if (consideredRows === 0) return { consideredRows, materialized: 0, unresolved: 0 }

  const keyToChunk = buildCausalKeyToChunk(db)
  const insert = db.prepare(
    `INSERT INTO memory_edges (src_chunk, edge_type, dst_chunk, weight, source, confidence)
     VALUES (?, 'causal', ?, 1.0, 'causal-inference', ?)`,
  )

  let materialized = 0
  let unresolved = 0
  const tx = db.transaction(() => {
    for (const r of rows) {
      const cause = keyToChunk.get(r.causeKey)
      const effect = keyToChunk.get(r.effectKey)
      if (!cause || !effect || cause.id === effect.id) {
        unresolved++
        continue
      }
      if (direction === 'forward' || direction === 'both') {
        insert.run(cause.id, effect.id, r.confidence)
        materialized++
      }
      if (direction === 'reverse' || direction === 'both') {
        insert.run(effect.id, cause.id, r.confidence)
        materialized++
      }
    }
  })
  tx()

  return { consideredRows, materialized, unresolved }
}
