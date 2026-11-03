import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openMemoryDb, closeMemoryDb } from '../../../../src/memory/db.js'
import { rebuildMemoryEdges } from '../../../../src/memory/entities/edges.js'
import { entityNeighborhood } from '../../../../src/memory/entities/neighborhood.js'
import type Database from 'better-sqlite3'

function addChunk(db: Database.Database, path: string, mtimeMs: number, content: string): number {
  db.prepare('INSERT INTO vault_files (path, mtime_ms, size_bytes) VALUES (?, ?, ?)').run(
    path,
    mtimeMs,
    content.length,
  )
  return db
    .prepare(
      `INSERT INTO chunks (file_path, chunk_index, content, start_offset, end_offset, token_count)
       VALUES (?, 0, ?, 0, ?, 1)`,
    )
    .run(path, content, content.length).lastInsertRowid as number
}

/**
 * Insert a synthetic CONVERSATION event-node carrying an App-C.1 LEARNED entity list
 * (`event_nodes.entities` JSON); after `rebuildMemoryEdges` these names become PRIMARY
 * `memory_entities` rows with `source='extracted'` edges (A-div2 build-side). Returns the chunk id.
 */
function addLearnedEventNode(
  db: Database.Database,
  file: string,
  chunkIndex: number,
  tau: string,
  content: string,
  entities: readonly string[],
): number {
  db.prepare('INSERT OR IGNORE INTO vault_files (path, mtime_ms, size_bytes) VALUES (?, 0, ?)').run(
    file,
    content.length,
  )
  const chunkId = db
    .prepare(
      `INSERT INTO chunks (file_path, chunk_index, content, start_offset, end_offset, token_count)
       VALUES (?, ?, ?, 0, ?, 1)`,
    )
    .run(file, chunkIndex, content, content.length).lastInsertRowid as number
  db.prepare(
    `INSERT INTO event_nodes (chunk_id, event_key, tau, entity, entities, kind, source_ref)
     VALUES (?, ?, ?, ?, ?, 'conversation-event', ?)`,
  ).run(
    chunkId,
    `evk-${chunkId}`,
    tau,
    entities[0] ?? null,
    JSON.stringify(entities),
    `src#${chunkId}`,
  )
  return chunkId
}

describe('entityNeighborhood', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb(':memory:')
    // four broker mentions across time; one unrelated entity
    addChunk(db, 't1.md', 1000, 'the broker first booted')
    addChunk(db, 't2.md', 2000, 'the broker handled a request')
    addChunk(db, 't3.md', 3000, 'the broker restarted')
    addChunk(db, 't4.md', 4000, 'the broker is healthy now')
    addChunk(db, 'idx.md', 5000, 'the indexer ran once')
    rebuildMemoryEdges(db)
  })
  afterEach(() => closeMemoryDb(db))

  it('returns all chunks for an entity in chronological (mtime-ascending) order', () => {
    const hits = entityNeighborhood(db, 'broker')
    expect(hits.map((h) => h.mtimeMs)).toEqual([1000, 2000, 3000, 4000])
    expect(hits[0]!.content).toContain('first booted')
    expect(hits.every((h) => h.content.includes('broker'))).toBe(true)
  })

  it('resolves an alias to the canonical entity before lookup', () => {
    // 'hybrid search' is an alias of canonical 'memory-search'
    addChunk(db, 'ms.md', 6000, 'the hybrid search returned five hits')
    rebuildMemoryEdges(db)
    const hits = entityNeighborhood(db, 'hybrid search')
    expect(hits).toHaveLength(1)
    expect(hits[0]!.content).toContain('hybrid search returned')
  })

  it('limit returns the most-recent N, still chronological', () => {
    const hits = entityNeighborhood(db, 'broker', { limit: 2 })
    expect(hits.map((h) => h.mtimeMs)).toEqual([3000, 4000])
  })

  it('since filters out chunks older than the cutoff (inclusive)', () => {
    const hits = entityNeighborhood(db, 'broker', { since: 3000 })
    expect(hits.map((h) => h.mtimeMs)).toEqual([3000, 4000])
  })

  it('returns an empty array for an unknown entity', () => {
    expect(entityNeighborhood(db, 'no-such-entity')).toEqual([])
  })

  it('returns an empty array for a known entity with no mentions', () => {
    // 'magma' is in the gazetteer but never mentioned in the fixture
    expect(entityNeighborhood(db, 'magma')).toEqual([])
  })

  it('exposes chunkId and filePath for each neighborhood hit', () => {
    const hits = entityNeighborhood(db, 'broker', { limit: 1 })
    expect(hits[0]!.chunkId).toBeGreaterThan(0)
    expect(hits[0]!.filePath).toBe('t4.md')
  })
})

// A-div2 QUERY-SIDE: a LEARNED (App-C.1, non-gazetteer) entity is name-queryable only when opted in.
describe('entityNeighborhood — learned entity query (A-div2, default-OFF)', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb(':memory:')
    // 'melanie' is NOT in SCNS_GAZETTEER — she is LEARNED, carried on two conversation event nodes.
    addLearnedEventNode(db, 'event-nodes/s1.md', 0, '2026-01-01T00:00:00Z', 'Melanie plays the violin', ['melanie'])
    addLearnedEventNode(db, 'event-nodes/s2.md', 1, '2026-01-02T00:00:00Z', 'Melanie rehearsed again', ['melanie'])
    rebuildMemoryEdges(db)
  })
  afterEach(() => closeMemoryDb(db))

  it('POSITIVE: with the flag ON a learned name resolves to her memory_entities node + neighborhood', () => {
    // build-side sanity: melanie is a real learned entity row with linked chunks
    const row = db.prepare("SELECT id FROM memory_entities WHERE name='melanie'").get()
    expect(row).toBeTruthy()

    const hits = entityNeighborhood(db, 'melanie', { learnedEntityQuery: true })
    expect(hits.map((h) => h.content)).toEqual(['Melanie plays the violin', 'Melanie rehearsed again'])
  })

  it('NEGATIVE / regression: with the flag OFF (default) a learned name is gazetteer-only ⇒ []', () => {
    expect(entityNeighborhood(db, 'melanie')).toEqual([])
    expect(entityNeighborhood(db, 'melanie', { learnedEntityQuery: false })).toEqual([])
  })

  it('NEGATIVE control: the flag does not invent a neighborhood for a non-entity name', () => {
    expect(entityNeighborhood(db, 'not-an-entity', { learnedEntityQuery: true })).toEqual([])
  })

  it('is ADDITIVE: gazetteer entities still resolve with the flag ON', () => {
    addChunk(db, 'b.md', 9000, 'the broker booted')
    rebuildMemoryEdges(db)
    const hits = entityNeighborhood(db, 'broker', { learnedEntityQuery: true })
    expect(hits).toHaveLength(1)
    expect(hits[0]!.content).toContain('broker booted')
  })
})
