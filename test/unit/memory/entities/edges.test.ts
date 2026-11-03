import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openMemoryDb, closeMemoryDb } from '../../../../src/memory/db.js'
import { rebuildMemoryEdges } from '../../../../src/memory/entities/edges.js'
import { SCNS_GAZETTEER, type GazetteerEntry } from '../../../../src/memory/entities/gazetteer.js'
import type Database from 'better-sqlite3'

interface CountRow {
  n: number
}

function count(db: Database.Database, sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...params) as CountRow).n
}

/** Insert a vault_file + one chunk, return the chunk id. */
function addChunk(
  db: Database.Database,
  path: string,
  mtimeMs: number,
  content: string,
  chunkIndex = 0,
): number {
  db.prepare(
    `INSERT INTO vault_files (path, mtime_ms, size_bytes) VALUES (?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET mtime_ms = excluded.mtime_ms`,
  ).run(path, mtimeMs, content.length)
  return db
    .prepare(
      `INSERT INTO chunks (file_path, chunk_index, content, start_offset, end_offset, token_count)
       VALUES (?, ?, ?, 0, ?, 1)`,
    )
    .run(path, chunkIndex, content, content.length).lastInsertRowid as number
}

function entityId(db: Database.Database, name: string): number {
  return (db.prepare('SELECT id FROM memory_entities WHERE name = ?').get(name) as { id: number }).id
}

/**
 * Insert a synthetic event-node: a `vault_files` row under the event-nodes/* prefix (mtime 0, as the
 * real writer does — a synthetic file has no on-disk mtime), a chunk, and the `event_nodes` sidecar
 * row that carries the first-class per-node event-time τ. Returns the chunk id.
 */
function addEventNode(
  db: Database.Database,
  file: string,
  chunkIndex: number,
  tau: string,
  content: string,
): number {
  db.prepare(
    `INSERT OR IGNORE INTO vault_files (path, mtime_ms, size_bytes) VALUES (?, 0, ?)`,
  ).run(file, content.length)
  const chunkId = db
    .prepare(
      `INSERT INTO chunks (file_path, chunk_index, content, start_offset, end_offset, token_count)
       VALUES (?, ?, ?, 0, ?, 1)`,
    )
    .run(file, chunkIndex, content, content.length).lastInsertRowid as number
  db.prepare(
    `INSERT INTO event_nodes (chunk_id, event_key, tau, entity, kind, source_ref)
     VALUES (?, ?, ?, 'broker', 'conversation-event', ?)`,
  ).run(chunkId, `evk-${chunkId}`, tau, `src#${chunkId}`)
  return chunkId
}

/**
 * Insert a synthetic CONVERSATION event-node that carries an App-C.1 LEARNED entity list (the
 * `event_nodes.entities` JSON column). `entities[0]` is the primary anchor. Returns the chunk id.
 */
function addLearnedEventNode(
  db: Database.Database,
  file: string,
  chunkIndex: number,
  tau: string,
  content: string,
  entities: readonly string[],
): number {
  db.prepare(
    `INSERT OR IGNORE INTO vault_files (path, mtime_ms, size_bytes) VALUES (?, 0, ?)`,
  ).run(file, content.length)
  const chunkId = db
    .prepare(
      `INSERT INTO chunks (file_path, chunk_index, content, start_offset, end_offset, token_count)
       VALUES (?, ?, ?, 0, ?, 1)`,
    )
    .run(file, chunkIndex, content, content.length).lastInsertRowid as number
  db.prepare(
    `INSERT INTO event_nodes (chunk_id, event_key, tau, entity, entities, kind, source_ref)
     VALUES (?, ?, ?, ?, ?, 'conversation-event', ?)`,
  ).run(chunkId, `evk-${chunkId}`, tau, entities[0] ?? null, JSON.stringify(entities), `src#${chunkId}`)
  return chunkId
}

describe('rebuildMemoryEdges', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb(':memory:')
  })
  afterEach(() => closeMemoryDb(db))

  it('upserts the full gazetteer catalog into memory_entities', () => {
    rebuildMemoryEdges(db)
    expect(count(db, 'SELECT COUNT(*) n FROM memory_entities')).toBe(SCNS_GAZETTEER.length)
    const broker = db.prepare("SELECT kind FROM memory_entities WHERE name='broker'").get() as
      | { kind: string }
      | undefined
    expect(broker?.kind).toBe('component')
  })

  it('creates entity edges (chunk → entity) for every gazetteer mention', () => {
    const a = addChunk(db, 'a.md', 1000, 'the broker started')
    const b = addChunk(db, 'b.md', 2000, 'the broker and the indexer ran together')
    const c = addChunk(db, 'c.md', 3000, 'the indexer finished its pass')

    const res = rebuildMemoryEdges(db)

    // a→broker, b→broker, b→indexer, c→indexer = 4 entity edges
    expect(count(db, "SELECT COUNT(*) n FROM memory_edges WHERE edge_type='entity'")).toBe(4)
    expect(res.entityEdges).toBe(4)

    const brokerId = entityId(db, 'broker')
    const brokerChunks = db
      .prepare(
        "SELECT src_chunk FROM memory_edges WHERE edge_type='entity' AND dst_entity=? ORDER BY src_chunk",
      )
      .all(brokerId)
      .map((r) => (r as { src_chunk: number }).src_chunk)
    expect(brokerChunks).toEqual([a, b].sort((x, y) => x - y))
    expect(brokerChunks).not.toContain(c)
  })

  it('creates a per-entity temporal predecessor chain ordered by mtime', () => {
    const a = addChunk(db, 'a.md', 1000, 'the broker started')
    const b = addChunk(db, 'b.md', 2000, 'the broker and the indexer ran together')
    const c = addChunk(db, 'c.md', 3000, 'the indexer finished its pass')

    const res = rebuildMemoryEdges(db)

    // broker timeline: a(1000)→b(2000); indexer timeline: b(2000)→c(3000) = 2 temporal edges
    expect(count(db, "SELECT COUNT(*) n FROM memory_edges WHERE edge_type='temporal'")).toBe(2)
    expect(res.temporalEdges).toBe(2)

    const brokerId = entityId(db, 'broker')
    const brokerEdge = db
      .prepare(
        "SELECT src_chunk, dst_chunk FROM memory_edges WHERE edge_type='temporal' AND dst_entity=?",
      )
      .get(brokerId) as { src_chunk: number; dst_chunk: number }
    expect(brokerEdge.src_chunk).toBe(a)
    expect(brokerEdge.dst_chunk).toBe(b)

    const indexerId = entityId(db, 'indexer')
    const indexerEdge = db
      .prepare(
        "SELECT src_chunk, dst_chunk FROM memory_edges WHERE edge_type='temporal' AND dst_entity=?",
      )
      .get(indexerId) as { src_chunk: number; dst_chunk: number }
    expect(indexerEdge.src_chunk).toBe(b)
    expect(indexerEdge.dst_chunk).toBe(c)
  })

  it('orders the temporal chain by mtime regardless of chunk-id/insert order', () => {
    // Insert NEWEST first so id order ≠ time order; mtime must win.
    const late = addChunk(db, 'late.md', 9000, 'broker note three')
    const early = addChunk(db, 'early.md', 1000, 'broker note one')
    const mid = addChunk(db, 'mid.md', 5000, 'broker note two')

    rebuildMemoryEdges(db)
    const brokerId = entityId(db, 'broker')
    const edges = db
      .prepare(
        "SELECT src_chunk, dst_chunk FROM memory_edges WHERE edge_type='temporal' AND dst_entity=? ORDER BY id",
      )
      .all(brokerId)
      .map((r) => r as { src_chunk: number; dst_chunk: number })

    // chain must be early→mid→late by mtime
    expect(edges).toEqual([
      { src_chunk: early, dst_chunk: mid },
      { src_chunk: mid, dst_chunk: late },
    ])
  })

  it('is idempotent — re-running yields an identical edge set with no duplicates', () => {
    addChunk(db, 'a.md', 1000, 'the broker started')
    addChunk(db, 'b.md', 2000, 'the broker and the indexer ran together')
    addChunk(db, 'c.md', 3000, 'the indexer finished its pass')

    rebuildMemoryEdges(db)
    const snapshot = (): string =>
      JSON.stringify(
        db
          .prepare(
            'SELECT src_chunk, edge_type, dst_entity, dst_chunk, source FROM memory_edges ORDER BY edge_type, src_chunk, dst_chunk, dst_entity',
          )
          .all(),
      )
    const first = snapshot()
    const firstCount = count(db, 'SELECT COUNT(*) n FROM memory_edges')

    rebuildMemoryEdges(db)
    rebuildMemoryEdges(db)
    expect(count(db, 'SELECT COUNT(*) n FROM memory_edges')).toBe(firstCount)
    expect(snapshot()).toBe(first)
    // entity catalog must not duplicate either
    expect(count(db, 'SELECT COUNT(*) n FROM memory_entities')).toBe(SCNS_GAZETTEER.length)
  })

  it('edges cascade-delete when a source chunk is deleted', () => {
    const a = addChunk(db, 'a.md', 1000, 'the broker started')
    addChunk(db, 'b.md', 2000, 'the broker again later')
    rebuildMemoryEdges(db)
    expect(count(db, 'SELECT COUNT(*) n FROM memory_edges WHERE src_chunk=?', a)).toBeGreaterThan(0)

    db.prepare('DELETE FROM chunks WHERE id=?').run(a)
    expect(count(db, 'SELECT COUNT(*) n FROM memory_edges WHERE src_chunk=? OR dst_chunk=?', a, a)).toBe(
      0,
    )
  })

  it('produces no edges when no chunk mentions any entity', () => {
    addChunk(db, 'x.md', 1000, 'the quick brown fox jumped over the lazy dog')
    const res = rebuildMemoryEdges(db)
    expect(count(db, 'SELECT COUNT(*) n FROM memory_edges')).toBe(0)
    expect(res.entityEdges).toBe(0)
    expect(res.temporalEdges).toBe(0)
  })

  it('honours a custom gazetteer', () => {
    const custom: GazetteerEntry[] = [
      { canonical: 'widget', kind: 'concept', aliases: ['widgets'] },
    ]
    addChunk(db, 'a.md', 1000, 'a widget here')
    addChunk(db, 'b.md', 2000, 'two widgets there')
    const res = rebuildMemoryEdges(db, custom)
    expect(count(db, 'SELECT COUNT(*) n FROM memory_entities')).toBe(1)
    expect(res.entityEdges).toBe(2)
    expect(res.temporalEdges).toBe(1)
  })

  it('orders an event-node timeline by event-τ, not chunk_index/mtime (event files share mtime 0)', () => {
    // chunk_index ASCENDING but τ SHUFFLED — proves the successor chain keys on the per-node event-τ
    // persisted in event_nodes.tau, NOT the positional chunk_index proxy. All share the event file.
    const march = addEventNode(db, 'event-nodes/conversation.md', 2_000_000, '2023-03-01T00:00:00Z', 'broker note march')
    const january = addEventNode(db, 'event-nodes/conversation.md', 2_000_001, '2023-01-01T00:00:00Z', 'broker note january')
    const june = addEventNode(db, 'event-nodes/conversation.md', 2_000_002, '2023-06-01T00:00:00Z', 'broker note june')

    rebuildMemoryEdges(db)
    const brokerId = entityId(db, 'broker')
    const edges = db
      .prepare(
        "SELECT src_chunk, dst_chunk FROM memory_edges WHERE edge_type='temporal' AND dst_entity=? ORDER BY id",
      )
      .all(brokerId)
      .map((r) => r as { src_chunk: number; dst_chunk: number })

    // τ order Jan→Mar→Jun must win over chunk_index order Mar→Jan→Jun.
    expect(edges).toEqual([
      { src_chunk: january, dst_chunk: march },
      { src_chunk: march, dst_chunk: june },
    ])
  })

  it('orders event nodes across kind-files by τ even when chunk_index + id contradict it', () => {
    // Both kind-files start at EVENT_CHUNK_INDEX_BASE, so chunk_index collides (2_000_000) and the
    // OLD builder tiebreaks on insertion id — here the earlier-τ node is inserted LAST (higher id).
    const may = addEventNode(db, 'event-nodes/broker.md', 2_000_000, '2023-05-01T00:00:00Z', 'broker did the late thing')
    const february = addEventNode(db, 'event-nodes/conversation.md', 2_000_000, '2023-02-01T00:00:00Z', 'broker did the early thing')

    rebuildMemoryEdges(db)
    const brokerId = entityId(db, 'broker')
    const edge = db
      .prepare(
        "SELECT src_chunk, dst_chunk FROM memory_edges WHERE edge_type='temporal' AND dst_entity=?",
      )
      .get(brokerId) as { src_chunk: number; dst_chunk: number }

    // Feb precedes May: chain must be february→may, NOT the insertion-id order may→february.
    expect(edge).toEqual({ src_chunk: february, dst_chunk: may })
  })

  // ── A-DIVERGENCE 2: LEARNED (App-C.1) entities are PRIMARY, not gazetteer-hardcoded ──────────────

  it('promotes a LEARNED non-gazetteer entity into memory_entities + drives an entity edge (source extracted)', () => {
    // "melanie" is NOT in SCNS_GAZETTEER (this DB uses the default gazetteer) — it is LEARNED.
    const chunkId = addLearnedEventNode(
      db,
      'event-nodes/conversation.md',
      1_000_000,
      '2023-05-08T14:00:00.000Z',
      'Melanie decided to join a grief support group.',
      ['melanie'],
    )
    const res = rebuildMemoryEdges(db)

    // POSITIVE: melanie is now a first-class entity row with the generic learned kind 'entity'.
    const mel = db.prepare("SELECT id, kind FROM memory_entities WHERE name='melanie'").get() as
      | { id: number; kind: string }
      | undefined
    expect(mel).toBeDefined()
    expect(mel!.kind).toBe('entity')
    expect(res.learnedEntities).toBe(1)

    // It drives an entity edge chunk→melanie tagged source 'extracted' (not 'gazetteer').
    const edge = db
      .prepare(
        "SELECT source FROM memory_edges WHERE edge_type='entity' AND src_chunk=? AND dst_entity=?",
      )
      .get(chunkId, mel!.id) as { source: string } | undefined
    expect(edge?.source).toBe('extracted')
    expect(res.learnedEntityEdges).toBe(1)
  })

  it('builds a cross-session temporal backbone for a recurring LEARNED entity + it is traversable (object permanence)', () => {
    // Same learned "melanie" in two dated sessions (different τ) ⇒ ONE entity ⇒ a τ-ordered chain.
    const early = addLearnedEventNode(
      db,
      'event-nodes/conversation.md',
      1_000_000,
      '2023-05-08T14:00:00.000Z',
      'Melanie decided to join a grief support group.',
      ['melanie'],
    )
    const late = addLearnedEventNode(
      db,
      'event-nodes/conversation.md',
      1_000_001,
      '2023-05-20T14:00:00.000Z',
      'Melanie reported feeling less alone.',
      ['melanie'],
    )
    const res = rebuildMemoryEdges(db)

    expect(res.learnedEntities).toBe(1) // deduped across sessions ⇒ ONE entity (object permanence)
    const melId = entityId(db, 'melanie')
    const temporal = db
      .prepare(
        "SELECT src_chunk, dst_chunk FROM memory_edges WHERE edge_type='temporal' AND dst_entity=?",
      )
      .all(melId) as Array<{ src_chunk: number; dst_chunk: number }>
    expect(temporal).toEqual([{ src_chunk: early, dst_chunk: late }]) // early τ → late τ

    // REACHABILITY (NO DEAD CODE): the learned entity edge supports the beam's neighbor expansion —
    // this is the EXACT chunk→entity→chunk bridge adaptive-traversal.ts:96-103 (Algorithm 1) runs.
    const neighborsOfEarly = db
      .prepare(
        `SELECT DISTINCT e2.src_chunk AS v
           FROM memory_edges e1
           JOIN memory_edges e2 ON e2.dst_entity = e1.dst_entity AND e2.edge_type = 'entity'
          WHERE e1.src_chunk = ? AND e1.edge_type = 'entity' AND e2.src_chunk != e1.src_chunk`,
      )
      .all(early) as Array<{ v: number }>
    expect(neighborsOfEarly.map((r) => r.v)).toEqual([late])
  })

  it('does not double-link or miscount when a learned entity canonicalizes onto a gazetteer entity', () => {
    // Content mentions 'broker' (gazetteer) AND the learned list repeats 'broker'.
    const ev = addLearnedEventNode(
      db,
      'event-nodes/conversation.md',
      1_000_000,
      '2023-05-08T14:00:00.000Z',
      'the broker made a decision',
      ['broker'],
    )
    const res = rebuildMemoryEdges(db)
    const brokerId = entityId(db, 'broker')

    // Exactly ONE entity edge chunk→broker (no gazetteer+extracted duplicate for the same chunk).
    expect(
      count(
        db,
        "SELECT COUNT(*) n FROM memory_edges WHERE edge_type='entity' AND src_chunk=? AND dst_entity=?",
        ev,
        brokerId,
      ),
    ).toBe(1)
    expect(res.learnedEntities).toBe(0) // 'broker' is a gazetteer entity, never counted as learned
  })

  it('negative control: an event node with no learned entities adds no learned rows/edges; gazetteer still works', () => {
    const ev = addLearnedEventNode(
      db,
      'event-nodes/conversation.md',
      1_000_000,
      '2023-05-08T14:00:00.000Z',
      'the broker started up',
      [],
    )
    const res = rebuildMemoryEdges(db)
    expect(res.learnedEntities).toBe(0)
    expect(res.learnedEntityEdges).toBe(0)

    // The gazetteer pass still links 'broker' from content, tagged source 'gazetteer'.
    const brokerId = entityId(db, 'broker')
    const edge = db
      .prepare(
        "SELECT source FROM memory_edges WHERE edge_type='entity' AND src_chunk=? AND dst_entity=?",
      )
      .get(ev, brokerId) as { source: string } | undefined
    expect(edge?.source).toBe('gazetteer')
  })
})
