/**
 * WS-1 event/outcome substrate — STORAGE + readers (vault memory DB; DEFAULT-OFF).
 *
 * Owns the persisted shape of an event node and writes it as a first-class node the proven
 * retrieval pipeline consumes: each {@link EventNodeRecord} becomes a CHUNK (facts-as-chunks
 * precedent) under a synthetic `event-nodes/*` file_path at `chunk_index >= EVENT_CHUNK_INDEX_BASE`
 * (FTS + embedding + entity/semantic edges + traversal, zero extra plumbing), plus a row in the
 * `event_nodes` sidecar that carries the first-class event-time τ and the decision→action→outcome
 * structure the `chunks` row cannot hold.
 *
 * Idempotent: dedup on the stable `event_key`, so re-running a slow-path pass over the same sources
 * inserts ZERO new nodes (convergence). Never edits guardrail files; inert until called.
 */

import type Database from 'better-sqlite3'
import {
  generateEmbeddingsBatch,
  serializeEmbedding,
  type EmbeddingResult,
} from './embeddings.js'
import { rebuildMemoryEdges } from './entities/edges.js'
import { buildSemanticEdges } from './semantic-edges.js'
import { SCNS_GAZETTEER, type GazetteerEntry } from './entities/gazetteer.js'
import { causalKey, DEFAULT_MAX_CANDIDATES } from './causal-edges.js'
import type { CausalCandidate } from './causal-provider.js'
import { EVENT_CHUNK_INDEX_BASE, EVENT_NODE_PATH_PREFIX } from './db.js'

export type EventNodeKind = 'broker-decision' | 'proposal-outcome' | 'conversation-event'

/** The persisted shape of an event node (produced by the dream event-segmenter). */
export interface EventNodeRecord {
  /** Stable, re-chunk-proof content-hash identity (causalKey convention). */
  readonly eventKey: string
  /** ISO-8601 EVENT time (from the source row — NOT a file mtime). */
  readonly tau: string
  readonly entity: string | null
  /**
   * ALL App-C.1 LEARNED entity canonicals on this node (proper nouns extracted from content), used
   * to populate the PRIMARY entity vocabulary + drive entity edges (not just the gazetteer). Optional
   * (default ⇒ []) so the deterministic broker/proposal producers need no change; the conversation
   * segmenter populates it.
   */
  readonly entities?: readonly string[]
  readonly kind: EventNodeKind
  readonly decision: string | null
  readonly action: string | null
  readonly outcome: string | null
  /** The narratable node text stored in the chunk. */
  readonly content: string
  /** Provenance: 'events#<id>' | 'proposal_outcomes#<id>'. */
  readonly sourceRef: string
}

/** Synthetic vault file each event-node kind is stored under (all share EVENT_NODE_PATH_PREFIX). */
const FILE_BY_KIND: Record<EventNodeKind, string> = {
  'broker-decision': `${EVENT_NODE_PATH_PREFIX}broker.md`,
  'proposal-outcome': `${EVENT_NODE_PATH_PREFIX}outcomes.md`,
  // WS-2 B3: conversation session-episode events (segmented by the LLM conversation segmenter).
  'conversation-event': `${EVENT_NODE_PATH_PREFIX}conversation.md`,
}

/** Injectable embedder (tests pass a deterministic stub; prod uses the real fastembed batch). */
export type EmbedBatchFn = (texts: readonly string[]) => Promise<readonly EmbeddingResult[]>

export interface WriteEventNodesOptions {
  /** Embedder. Default {@link generateEmbeddingsBatch} (real fastembed worker). */
  readonly embed?: EmbedBatchFn
  /** Rebuild deterministic entity/temporal edges after writing (so traversal sees nodes). Default true. */
  readonly rebuildEdges?: boolean
  /** Also rebuild the semantic edge tier. Default false (heavier; opt-in). */
  readonly buildSemantic?: boolean
  readonly gazetteer?: readonly GazetteerEntry[]
}

export interface WriteEventNodesStats {
  /** Records supplied. */
  readonly considered: number
  /** New event nodes written this call. */
  readonly written: number
  /** Records skipped because their event_key already exists (idempotency). */
  readonly skippedExisting: number
  /** Chunk embeddings actually stored. */
  readonly embeddingsWritten: number
}

/**
 * Defensive schema-ensure for callers that did not run the full `openMemoryDb` SCHEMA (mirrors
 * `ensureProposalOutcomesSchema`). openMemoryDb already creates this table; this only helps tests /
 * partial DBs. The WRITER ensures schema; readers tolerate a missing table.
 */
export function ensureEventNodesSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_nodes (
      chunk_id    INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
      event_key   TEXT NOT NULL UNIQUE,
      tau         TEXT NOT NULL,
      entity      TEXT,
      entities    TEXT,
      kind        TEXT NOT NULL,
      decision    TEXT,
      action      TEXT,
      outcome     TEXT,
      source_ref  TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_event_nodes_tau ON event_nodes(tau);
    CREATE INDEX IF NOT EXISTS idx_event_nodes_entity ON event_nodes(entity);
  `)
  // Upgrade guard: a DB created before the App-C.1 learned-entity column exists (e.g. an on-disk
  // vault) is missing `entities`. Add it in-place (additive, nullable) so the writer + edge builder
  // work without a full rebuild. No-op when the column is already present.
  const hasEntitiesCol = (
    db.prepare("PRAGMA table_info('event_nodes')").all() as Array<{ name: string }>
  ).some((c) => c.name === 'entities')
  if (!hasEntitiesCol) db.exec('ALTER TABLE event_nodes ADD COLUMN entities TEXT')
}

function tableExists(db: Database.Database, name: string): boolean {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined
  )
}

function wordCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length
}

/**
 * Persist event nodes as chunks + sidecar rows. Idempotent (skips already-present `event_key`s),
 * embeds new node content, and — unless disabled — rebuilds edges so traversal consumes the nodes.
 * Do-no-harm: the chunk/sidecar writes are one transaction; nothing existing is deleted.
 */
export async function writeEventNodes(
  db: Database.Database,
  records: readonly EventNodeRecord[],
  options: WriteEventNodesOptions = {},
): Promise<WriteEventNodesStats> {
  ensureEventNodesSchema(db)
  const embed = options.embed ?? generateEmbeddingsBatch
  const considered = records.length

  // Idempotency: drop records whose event_key already exists (or repeats within this batch).
  const existing = new Set(
    (db.prepare('SELECT event_key FROM event_nodes').all() as Array<{ event_key: string }>).map(
      (r) => r.event_key,
    ),
  )
  const seen = new Set<string>()
  const toWrite: EventNodeRecord[] = []
  for (const r of records) {
    if (existing.has(r.eventKey) || seen.has(r.eventKey)) continue
    seen.add(r.eventKey)
    toWrite.push(r)
  }
  const skippedExisting = considered - toWrite.length

  if (toWrite.length === 0) {
    return { considered, written: 0, skippedExisting, embeddingsWritten: 0 }
  }

  // Embed OUTSIDE the transaction (async), aligned to toWrite order.
  const embeddings = await embed(toWrite.map((r) => r.content))

  // Per-file running chunk_index (continue after any existing event chunks for that synthetic file).
  const nextIndexByFile = new Map<string, number>()
  const nextIndex = (file: string): number => {
    if (!nextIndexByFile.has(file)) {
      const row = db
        .prepare('SELECT COALESCE(MAX(chunk_index), ?) AS mx FROM chunks WHERE file_path = ?')
        .get(EVENT_CHUNK_INDEX_BASE - 1, file) as { mx: number }
      nextIndexByFile.set(file, row.mx + 1)
    }
    const idx = nextIndexByFile.get(file)!
    nextIndexByFile.set(file, idx + 1)
    return idx
  }

  // The synthetic event-nodes/* file has NO on-disk mtime, so it is stored with mtime_ms=0. This is
  // intentional and inert: the temporal backbone orders event nodes by their real PER-NODE event-time
  // τ persisted in `event_nodes.tau` (see `rebuildMemoryEdges`, which reads that sidecar) — NOT by
  // this per-file mtime (one synthetic file holds many nodes with different τ, so a per-file mtime
  // could never represent per-node τ). Non-event vault files keep their real mtime as the fallback.
  const insertFile = db.prepare(
    `INSERT OR IGNORE INTO vault_files (path, mtime_ms, size_bytes, content_hash) VALUES (?, 0, 0, NULL)`,
  )
  const insertChunk = db.prepare(
    `INSERT INTO chunks (file_path, chunk_index, content, start_offset, end_offset, token_count)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
  const insertEmbedding = db.prepare(
    'INSERT INTO chunk_embeddings (chunk_id, embedding) VALUES (?, ?)',
  )
  const insertNode = db.prepare(
    `INSERT INTO event_nodes (chunk_id, event_key, tau, entity, entities, kind, decision, action, outcome, source_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )

  let written = 0
  let embeddingsWritten = 0
  const tx = db.transaction(() => {
    for (const file of new Set(toWrite.map((r) => FILE_BY_KIND[r.kind]))) insertFile.run(file)
    for (let i = 0; i < toWrite.length; i++) {
      const r = toWrite[i]!
      const file = FILE_BY_KIND[r.kind]
      const res = insertChunk.run(
        file,
        nextIndex(file),
        r.content,
        0,
        r.content.length,
        wordCount(r.content),
      )
      const chunkId = Number(res.lastInsertRowid)
      const emb = embeddings[i]
      if (emb) {
        insertEmbedding.run(BigInt(chunkId), serializeEmbedding(emb.embedding))
        embeddingsWritten++
      }
      insertNode.run(
        chunkId,
        r.eventKey,
        r.tau,
        r.entity,
        JSON.stringify(r.entities ?? []),
        r.kind,
        r.decision,
        r.action,
        r.outcome,
        r.sourceRef,
      )
      written++
    }
  })
  tx()

  // Rebuild edges so the entity/temporal/semantic graph includes the new event nodes.
  if ((options.rebuildEdges ?? true) && written > 0) {
    rebuildMemoryEdges(db, options.gazetteer ?? SCNS_GAZETTEER)
  }
  if (options.buildSemantic && written > 0) {
    buildSemanticEdges(db)
  }

  return { considered, written, skippedExisting, embeddingsWritten }
}

// ── Readers (side-effect-free; tolerate a missing table) ────────────

export interface EventNodeCounts {
  readonly total: number
  readonly byKind: Record<string, number>
}

/** Count event nodes overall and per kind. */
export function countEventNodes(db: Database.Database): EventNodeCounts {
  if (!tableExists(db, 'event_nodes')) return { total: 0, byKind: {} }
  const rows = db
    .prepare('SELECT kind, COUNT(*) AS c FROM event_nodes GROUP BY kind')
    .all() as Array<{ kind: string; c: number }>
  const byKind: Record<string, number> = {}
  let total = 0
  for (const r of rows) {
    byKind[r.kind] = r.c
    total += r.c
  }
  return { total, byKind }
}

export interface EventNodeView {
  readonly chunkId: number
  readonly eventKey: string
  readonly tau: string
  readonly entity: string | null
  readonly kind: string
  readonly sourceRef: string
  readonly content: string
}

/** List event nodes joined to their chunk content (for harness/example output). */
export function listEventNodes(db: Database.Database, limit = 50): EventNodeView[] {
  if (!tableExists(db, 'event_nodes')) return []
  return db
    .prepare(
      `SELECT en.chunk_id AS chunkId, en.event_key AS eventKey, en.tau AS tau, en.entity AS entity,
              en.kind AS kind, en.source_ref AS sourceRef, c.content AS content
         FROM event_nodes en JOIN chunks c ON c.id = en.chunk_id
        ORDER BY en.tau ASC, en.chunk_id ASC
        LIMIT ?`,
    )
    .all(limit) as EventNodeView[]
}

export interface EventCausalOptions {
  readonly maxCandidates?: number
}

interface EventCandidateRow {
  entity: string
  content: string
  sourceRef: string
}

/**
 * WS-2b UNBLOCK SIGNAL (demonstration only — does NOT persist causal edges): pair each entity's
 * chronologically-consecutive event nodes into (cause→effect) candidates, exactly as
 * `buildOutcomeCausalCandidates` does for `proposal_outcomes`, but over the UNIFIED event
 * substrate (broker decisions + outcomes). The candidates are narratable events (not mid-word
 * telemetry fragments), which is the signal WS-2 causal inference was blocked on. Deterministic,
 * LLM-free, read-only.
 */
export function buildEventCausalCandidates(
  db: Database.Database,
  options: EventCausalOptions = {},
): CausalCandidate[] {
  const max = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES
  if (max <= 0 || !tableExists(db, 'event_nodes')) return []

  const rows = db
    .prepare(
      `SELECT en.entity AS entity, en.source_ref AS sourceRef, c.content AS content
         FROM event_nodes en JOIN chunks c ON c.id = en.chunk_id
        WHERE en.entity IS NOT NULL AND en.entity <> ''
        ORDER BY en.entity ASC, en.tau ASC, en.chunk_id ASC`,
    )
    .all() as EventCandidateRow[]

  const out: CausalCandidate[] = []
  const seen = new Set<string>()
  let i = 0
  while (i < rows.length) {
    const entity = rows[i]!.entity
    let j = i
    while (j < rows.length && rows[j]!.entity === entity) j++
    const run = rows.slice(i, j)
    i = j
    if (run.length < 2) continue

    for (let k = 0; k + 1 < run.length; k++) {
      const cause = run[k]!
      const effect = run[k + 1]!
      const causeKey = causalKey(cause.content)
      const effectKey = causalKey(effect.content)
      if (causeKey === effectKey) continue
      const pair = `${causeKey}\u0000${effectKey}`
      if (seen.has(pair)) continue
      seen.add(pair)
      out.push({
        causeKey,
        effectKey,
        causeContent: cause.content,
        effectContent: effect.content,
        entity,
        causeFilePath: cause.sourceRef,
        effectFilePath: effect.sourceRef,
      })
      if (out.length >= max) return out
    }
  }
  return out
}
