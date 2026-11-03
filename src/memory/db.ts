/**
 * Memory database — SQLite with sqlite-vec + FTS5.
 */

import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// sqlite-vec must be loaded per database instance
function loadSqliteVec(db: Database.Database): void {
  const sqliteVec = require('sqlite-vec') as { load: (db: Database.Database) => void }
  sqliteVec.load(db)
}

export const EMBEDDING_DIMENSIONS = 384

/**
 * chunk_index base for WS-1 EVENT nodes (clean decision→action→outcome nodes with a first-class
 * event-time τ). Disjoint from source chunks (`< 1_000_000`) and derived fact nodes
 * (`[1_000_000, 2_000_000)`) so all three coexist under `UNIQUE(file_path, chunk_index)`. Event
 * nodes are stored AS chunks (the facts-as-chunks precedent) under synthetic
 * {@link EVENT_NODE_PATH_PREFIX} file_paths so the proven FTS/embedding/edge/traversal pipeline
 * consumes them with zero extra plumbing.
 */
export const EVENT_CHUNK_INDEX_BASE = 2_000_000

/**
 * Synthetic `vault_files.path` prefix owned by the WS-1 event substrate. These rows are written by
 * the dream slow-path (NOT by a real on-disk file), so the incremental indexer must NOT treat them
 * as "deleted-from-disk" and cascade-wipe them — see the guard in `indexer.ts`. Kept distinct from
 * every real vault tier (daily/weekly/monthly/sessions/lessons/negative/archive).
 */
export const EVENT_NODE_PATH_PREFIX = 'event-nodes/'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS vault_files (
    path          TEXT PRIMARY KEY,
    mtime_ms      INTEGER NOT NULL,
    size_bytes    INTEGER NOT NULL,
    content_hash  TEXT,
    indexed_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS chunks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path   TEXT NOT NULL REFERENCES vault_files(path) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    content     TEXT NOT NULL,
    start_offset INTEGER NOT NULL,
    end_offset  INTEGER NOT NULL,
    token_count INTEGER NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(file_path, chunk_index)
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    content,
    tokenize='porter unicode61'
  );

  CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
    INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
  END;

  CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
    DELETE FROM chunks_fts WHERE rowid = old.id;
  END;

  CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE OF content ON chunks BEGIN
    DELETE FROM chunks_fts WHERE rowid = old.id;
    INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
  END;

  CREATE INDEX IF NOT EXISTS idx_chunks_file_path ON chunks(file_path);

  -- ── M1.1 relational layer (MAGMA-lite) ──
  -- Durable curated entity catalog (gazetteer vocabulary is stable across re-indexing).
  CREATE TABLE IF NOT EXISTS memory_entities (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,            -- canonical, e.g. 'auto-merger'
    kind        TEXT NOT NULL,                   -- 'component'|'agent'|'artifact'|'concept'
    aliases     TEXT,                            -- JSON array of surface forms
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Derived edges. DETERMINISTIC types (entity/temporal) are recomputed every content-changing
  -- index pass: chunks.id is AUTOINCREMENT and is deleted+reinserted (NEW id) on content change,
  -- so edges keyed on chunks(id) are ephemeral and must cascade-clean + rebuild (design-m1.md §3).
  CREATE TABLE IF NOT EXISTS memory_edges (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    src_chunk   INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
    edge_type   TEXT NOT NULL,                   -- 'entity'|'temporal'|'causal'
    dst_entity  INTEGER REFERENCES memory_entities(id) ON DELETE CASCADE,  -- entity edges
    dst_chunk   INTEGER REFERENCES chunks(id) ON DELETE CASCADE,           -- temporal/causal edges
    weight      REAL NOT NULL DEFAULT 1.0,
    source      TEXT NOT NULL,                   -- 'gazetteer'|'timestamp'|'llm'
    confidence  REAL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_edges_src ON memory_edges(src_chunk, edge_type);
  CREATE INDEX IF NOT EXISTS idx_edges_entity ON memory_edges(dst_entity, edge_type);

  -- ── M1.3 causal edges (LLM-inferred in the dream slow-path; default-OFF) ──
  -- Unlike the deterministic entity/temporal edges (recomputed each index pass and keyed on the
  -- volatile chunks.id), an LLM causal edge is EXPENSIVE to recompute, so it is keyed on STABLE
  -- identifiers (content-hash of the cause/effect text) and lives in its own table that survives
  -- re-chunking (design-m1.md §3-4). NEVER auto-edits guardrail files (issue-#5 precedent).
  CREATE TABLE IF NOT EXISTS memory_causal (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    cause_key   TEXT NOT NULL,                   -- stable content-hash of the cause text
    effect_key  TEXT NOT NULL,                   -- stable content-hash of the effect text
    entity      TEXT,                            -- shared neighborhood anchor (gazetteer canonical)
    rationale   TEXT,
    confidence  REAL NOT NULL,
    provider    TEXT NOT NULL,                   -- 'null'|'acp'|... (which provider inferred it)
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(cause_key, effect_key)
  );
  CREATE INDEX IF NOT EXISTS idx_causal_cause ON memory_causal(cause_key);
  CREATE INDEX IF NOT EXISTS idx_causal_effect ON memory_causal(effect_key);

  -- ── D2b proposal outcomes (the read→write self-improvement loop; design-m1.md §6) ──
  -- Per-entity memory of how each self-improvement PROPOSAL fared (quality-gate verdict / merge /
  -- revert / reject). This is the "what landed for X over time" signal the D2a ideation read
  -- aggregates, AND the event/outcome-level causal-candidate source (a discrete proposal→outcome
  -- record, unlike the volatile mid-word chunk fragments). Additive + inert until D2b writes;
  -- NEVER auto-edits guardrail files. entity is a gazetteer canonical (caller canonicalizes).
  CREATE TABLE IF NOT EXISTS proposal_outcomes (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    entity        TEXT NOT NULL,                   -- gazetteer canonical anchor
    family        TEXT NOT NULL,                   -- template family / seed tag
    title         TEXT NOT NULL,
    verdict       TEXT NOT NULL,                   -- implemented|merged|reverted|rejected|failed|needs-human|passed-gate
    score         REAL,                            -- quality-gate rubric score etc. (nullable)
    suggestion_id TEXT,                            -- source suggestion (nullable; dedupe key when present)
    rationale     TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(suggestion_id, entity, family)
  );
  CREATE INDEX IF NOT EXISTS idx_proposal_outcomes_entity ON proposal_outcomes(entity);

  -- ── WS-1 event/outcome substrate (dream slow-path; DEFAULT-OFF) ──
  -- Clean, narratable EVENT nodes (decision->action->outcome) with a REAL per-node event-time tau,
  -- segmented from structured sources (broker events, proposal_outcomes) instead of the
  -- ~400-token size-window chunks that make up ~94% telemetry today. Each event node is stored AS a
  -- chunk (facts-as-chunks precedent) under a synthetic event-nodes/* file_path at
  -- chunk_index >= EVENT_CHUNK_INDEX_BASE (2e6), so FTS/embeddings/entity+semantic edges/traversal
  -- consume it directly; THIS sidecar carries the first-class tau + D->A->O structure the chunks row
  -- cannot hold. chunk_id CASCADE keeps the sidecar in lockstep with its chunk; event_key
  -- (stable content-hash, causalKey convention) is the durable, re-chunk-proof identity used for
  -- idempotent dedup across slow-path passes. Additive + inert until the phase writes
  -- (SCNS_EVENT_SEGMENTATION=1). NEVER auto-edits guardrail files.
  CREATE TABLE IF NOT EXISTS event_nodes (
    chunk_id    INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
    event_key   TEXT NOT NULL UNIQUE,            -- stable content-hash identity (re-chunk-proof)
    tau         TEXT NOT NULL,                   -- ISO-8601 EVENT time (NOT file mtime)
    entity      TEXT,                            -- primary entity anchor: gazetteer canonical OR learned (nullable)
    entities    TEXT,                            -- JSON array of ALL App-C.1 LEARNED entity canonicals on this node (nullable)
    kind        TEXT NOT NULL,                   -- 'broker-decision' | 'proposal-outcome' | 'conversation-event'
    decision    TEXT,                            -- structured decision->action->outcome (nullable parts)
    action      TEXT,
    outcome     TEXT,
    source_ref  TEXT NOT NULL,                   -- provenance: 'events#<id>' | 'proposal_outcomes#<id>'
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_event_nodes_tau ON event_nodes(tau);
  CREATE INDEX IF NOT EXISTS idx_event_nodes_entity ON event_nodes(entity);

  -- ── Retirement ledger (#71/#73) ──
  -- The minimal record that stops an explicitly removed memory from returning through a late
  -- index/backfill pass. Keyed by (path, content_hash) = a source REVISION, so only the exact
  -- retired bytes are refused; a genuinely new memory later written at the same path hashes
  -- differently and indexes normally. restored_at re-admits a revision after a recovery.
  -- Also created on demand by retirement-ledger.ts for databases that predate this table.
  CREATE TABLE IF NOT EXISTS memory_retirements (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    path         TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    mode         TEXT NOT NULL,
    plan_id      TEXT NOT NULL,
    recovery_ref TEXT,
    retired_at   TEXT NOT NULL DEFAULT (datetime('now')),
    restored_at  TEXT,
    UNIQUE(path, content_hash)
  );
  CREATE INDEX IF NOT EXISTS idx_memory_retirements_path ON memory_retirements(path);
`

export function openMemoryDb(dbPath: string): Database.Database {
  // First run on a fresh SCNS_HOME: the memory/ dir does not exist yet and
  // SQLite will not create parent directories (SQLITE_CANTOPEN). The daemon
  // swallows that throw and runs with memory search unavailable — so create
  // the directory here, where every open path funnels through.
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true })
  }
  const db = new Database(dbPath)

  if (dbPath !== ':memory:') {
    db.pragma('journal_mode = WAL')
  }
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')

  loadSqliteVec(db)

  // better-sqlite3 exec runs multi-statement SQL (not child_process)
  db.exec(SCHEMA)

  // Migration: add content_hash column if missing (pre-13.9.4 DBs).
  const cols = db.prepare('PRAGMA table_info(vault_files)').all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'content_hash')) {
    db.exec('ALTER TABLE vault_files ADD COLUMN content_hash TEXT')
  }

  // sqlite-vec virtual table: 384 dims for BGE-small-en-v1.5
  db.prepare(
    `CREATE VIRTUAL TABLE IF NOT EXISTS chunk_embeddings USING vec0(
      chunk_id INTEGER PRIMARY KEY,
      embedding float[${EMBEDDING_DIMENSIONS}]
    )`,
  ).run()

  return db
}

export function closeMemoryDb(db: Database.Database): void {
  db.close()
}
