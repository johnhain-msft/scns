import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openMemoryDb, closeMemoryDb, EMBEDDING_DIMENSIONS } from '../../../src/memory/db.js'
import type Database from 'better-sqlite3'

describe('Memory Database', () => {
  let db: Database.Database

  afterEach(() => {
    if (db) closeMemoryDb(db)
  })

  it('opens an in-memory database', () => {
    db = openMemoryDb(':memory:')
    expect(db.open).toBe(true)
  })

  it('creates vault_files table', () => {
    db = openMemoryDb(':memory:')
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vault_files'")
      .all()
    expect(tables).toHaveLength(1)
  })

  it('creates chunks table', () => {
    db = openMemoryDb(':memory:')
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chunks'")
      .all()
    expect(tables).toHaveLength(1)
  })

  it('creates FTS5 virtual table', () => {
    db = openMemoryDb(':memory:')
    // FTS5 tables show up in sqlite_master
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE name='chunks_fts'").all()
    expect(tables.length).toBeGreaterThan(0)
  })

  it('creates chunk_embeddings vec0 table', () => {
    db = openMemoryDb(':memory:')
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE name='chunk_embeddings'").all()
    expect(tables.length).toBeGreaterThan(0)
  })

  it('has sqlite-vec loaded', () => {
    db = openMemoryDb(':memory:')
    const row = db.prepare('SELECT vec_version() as v').get() as { v: string }
    expect(row.v).toBeTruthy()
  })

  it('FTS5 triggers sync inserts', () => {
    db = openMemoryDb(':memory:')
    db.prepare(
      "INSERT INTO vault_files (path, mtime_ms, size_bytes) VALUES ('test.md', 1000, 50)",
    ).run()
    db.prepare(
      "INSERT INTO chunks (file_path, chunk_index, content, start_offset, end_offset, token_count) VALUES ('test.md', 0, 'hello world searchable', 0, 22, 3)",
    ).run()

    const results = db
      .prepare(
        `SELECT c.* FROM chunks_fts
         JOIN chunks c ON c.id = chunks_fts.rowid
         WHERE chunks_fts MATCH '"hello"'`,
      )
      .all() as Array<{ content: string }>

    expect(results).toHaveLength(1)
    expect(results[0]!.content).toContain('hello')
  })

  it('FTS5 trigger syncs deletes', () => {
    db = openMemoryDb(':memory:')
    db.prepare(
      "INSERT INTO vault_files (path, mtime_ms, size_bytes) VALUES ('del.md', 1000, 50)",
    ).run()
    db.prepare(
      "INSERT INTO chunks (file_path, chunk_index, content, start_offset, end_offset, token_count) VALUES ('del.md', 0, 'deletable content', 0, 17, 2)",
    ).run()

    // Delete the chunk
    db.prepare("DELETE FROM chunks WHERE file_path = 'del.md'").run()

    const results = db
      .prepare('SELECT * FROM chunks_fts WHERE chunks_fts MATCH \'"deletable"\'')
      .all()
    expect(results).toHaveLength(0)
  })

  it('vec0 table accepts and queries embeddings', () => {
    db = openMemoryDb(':memory:')
    const embedding = new Float32Array(EMBEDDING_DIMENSIONS).fill(0.1)
    const buf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength)

    db.prepare('INSERT INTO chunk_embeddings (chunk_id, embedding) VALUES (?, ?)').run(
      BigInt(1),
      buf,
    )

    const results = db
      .prepare(
        'SELECT chunk_id, distance FROM chunk_embeddings WHERE embedding MATCH ? ORDER BY distance LIMIT 1',
      )
      .all(buf) as Array<{ chunk_id: number; distance: number }>

    expect(results).toHaveLength(1)
    expect(results[0]!.distance).toBe(0) // exact match
  })

  it('cascade deletes chunks when vault_file is deleted', () => {
    db = openMemoryDb(':memory:')
    db.prepare(
      "INSERT INTO vault_files (path, mtime_ms, size_bytes) VALUES ('cascade.md', 1000, 50)",
    ).run()
    db.prepare(
      "INSERT INTO chunks (file_path, chunk_index, content, start_offset, end_offset, token_count) VALUES ('cascade.md', 0, 'cascade test', 0, 12, 2)",
    ).run()

    db.prepare("DELETE FROM vault_files WHERE path = 'cascade.md'").run()

    const chunks = db.prepare("SELECT * FROM chunks WHERE file_path = 'cascade.md'").all()
    expect(chunks).toHaveLength(0)
  })

  // ── M1.1 relational layer schema ──
  it('creates memory_entities table', () => {
    db = openMemoryDb(':memory:')
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_entities'")
      .all()
    expect(tables).toHaveLength(1)
  })

  it('creates memory_edges table with its indexes', () => {
    db = openMemoryDb(':memory:')
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_edges'")
      .all()
    expect(tables).toHaveLength(1)
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='memory_edges'")
      .all() as Array<{ name: string }>
    const names = idx.map((i) => i.name)
    expect(names).toContain('idx_edges_src')
    expect(names).toContain('idx_edges_entity')
  })

  it('memory_entities.name is UNIQUE', () => {
    db = openMemoryDb(':memory:')
    db.prepare("INSERT INTO memory_entities (name, kind) VALUES ('broker', 'component')").run()
    expect(() =>
      db.prepare("INSERT INTO memory_entities (name, kind) VALUES ('broker', 'component')").run(),
    ).toThrow()
  })

  it('memory_edges.src_chunk cascade-deletes when its chunk is deleted', () => {
    db = openMemoryDb(':memory:')
    db.prepare(
      "INSERT INTO vault_files (path, mtime_ms, size_bytes) VALUES ('e.md', 1000, 50)",
    ).run()
    const chunkId = db
      .prepare(
        "INSERT INTO chunks (file_path, chunk_index, content, start_offset, end_offset, token_count) VALUES ('e.md', 0, 'broker text', 0, 11, 2)",
      )
      .run().lastInsertRowid
    const entityId = db
      .prepare("INSERT INTO memory_entities (name, kind) VALUES ('broker', 'component')")
      .run().lastInsertRowid
    db.prepare(
      "INSERT INTO memory_edges (src_chunk, edge_type, dst_entity, source) VALUES (?, 'entity', ?, 'gazetteer')",
    ).run(chunkId, entityId)

    expect((db.prepare('SELECT COUNT(*) n FROM memory_edges').get() as { n: number }).n).toBe(1)
    db.prepare('DELETE FROM chunks WHERE id = ?').run(chunkId)
    expect((db.prepare('SELECT COUNT(*) n FROM memory_edges').get() as { n: number }).n).toBe(0)
  })
})

// ── T008 (Foundational, specs/001-learning-memory-loop) — vault-schema invariant locks ───────────
// The vault stays READ-ONLY for this feature; these tests LOCK the existing schema invariants the
// stories consume: memory_edges.weight (US1/US4 reinforcement substrate), event_nodes.tau (US1
// synthesis WHEN-ordering), chunk_embeddings vec0 float[384] (US4 similar-episode KNN key-compat).

describe('T008 — vault schema invariants', () => {
  let db: Database.Database

  afterEach(() => {
    if (db) closeMemoryDb(db)
  })

  function addChunkRow(path: string, content: string): number | bigint {
    db.prepare('INSERT INTO vault_files (path, mtime_ms, size_bytes) VALUES (?, 1000, 10)').run(path)
    return db
      .prepare(
        `INSERT INTO chunks (file_path, chunk_index, content, start_offset, end_offset, token_count)
         VALUES (?, 0, ?, 0, ?, 1)`,
      )
      .run(path, content, content.length).lastInsertRowid
  }

  it('memory_edges.weight is REAL NOT NULL DEFAULT 1.0', () => {
    db = openMemoryDb(':memory:')
    const col = (
      db.prepare('PRAGMA table_info(memory_edges)').all() as {
        name: string
        type: string
        notnull: number
        dflt_value: string | null
      }[]
    ).find((c) => c.name === 'weight')
    expect(col).toBeDefined()
    expect(col!.type).toBe('REAL')
    expect(col!.notnull).toBe(1)
    expect(col!.dflt_value).toBe('1.0')
  })

  it('POSITIVE: an edge inserted without weight lands at neutral 1.0; NEGATIVE: explicit NULL weight is rejected', () => {
    db = openMemoryDb(':memory:')
    const chunkId = addChunkRow('w.md', 'weighted edge text')
    const entityId = db
      .prepare("INSERT INTO memory_entities (name, kind) VALUES ('kernel', 'component')")
      .run().lastInsertRowid
    db.prepare(
      "INSERT INTO memory_edges (src_chunk, edge_type, dst_entity, source) VALUES (?, 'entity', ?, 'gazetteer')",
    ).run(chunkId, entityId)
    const w = db.prepare('SELECT weight FROM memory_edges LIMIT 1').get() as { weight: number }
    expect(w.weight).toBe(1.0)
    expect(() =>
      db
        .prepare(
          "INSERT INTO memory_edges (src_chunk, edge_type, dst_entity, source, weight) VALUES (?, 'entity', ?, 'gazetteer', NULL)",
        )
        .run(chunkId, entityId),
    ).toThrow(/NOT NULL/i)
  })

  it('event_nodes.tau is TEXT NOT NULL with idx_event_nodes_tau, and τ-ascending IS chronological for ISO-8601', () => {
    db = openMemoryDb(':memory:')
    const tauCol = (
      db.prepare('PRAGMA table_info(event_nodes)').all() as {
        name: string
        type: string
        notnull: number
      }[]
    ).find((c) => c.name === 'tau')
    expect(tauCol!.type).toBe('TEXT')
    expect(tauCol!.notnull).toBe(1)
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='event_nodes'")
      .all() as { name: string }[]
    expect(idx.map((i) => i.name)).toContain('idx_event_nodes_tau')

    // POSITIVE: two events inserted out of order come back τ-ascending == chronological (Eq-7 WHEN).
    const c1 = addChunkRow('ev1.md', 'later event')
    const c2 = addChunkRow('ev2.md', 'earlier event')
    const ins = db.prepare(
      `INSERT INTO event_nodes (chunk_id, event_key, tau, kind, source_ref)
       VALUES (?, ?, ?, 'conversation-event', 'events#1')`,
    )
    ins.run(c1, 'k-later', '2026-05-02T10:00:00Z')
    ins.run(c2, 'k-earlier', '2026-05-01T09:00:00Z')
    const ordered = db.prepare('SELECT event_key FROM event_nodes ORDER BY tau ASC').all() as {
      event_key: string
    }[]
    expect(ordered.map((r) => r.event_key)).toEqual(['k-earlier', 'k-later'])

    // NEGATIVE: a NULL tau is rejected.
    const c3 = addChunkRow('ev3.md', 'no tau')
    expect(() =>
      db
        .prepare(
          `INSERT INTO event_nodes (chunk_id, event_key, tau, kind, source_ref)
           VALUES (?, 'k-null', NULL, 'conversation-event', 'events#2')`,
        )
        .run(c3),
    ).toThrow(/NOT NULL/i)
  })

  it('chunk_embeddings is vec0 with float[384] and EMBEDDING_DIMENSIONS === 384; a wrong-dim vector is rejected', () => {
    db = openMemoryDb(':memory:')
    expect(EMBEDDING_DIMENSIONS).toBe(384)
    const ddl = db
      .prepare("SELECT sql FROM sqlite_master WHERE name='chunk_embeddings'")
      .get() as { sql: string }
    expect(ddl.sql).toContain('vec0')
    expect(ddl.sql).toContain('float[384]')

    // POSITIVE: a 384-dim vector inserts; NEGATIVE: a 3-dim vector throws (dimension enforced).
    const ok = new Float32Array(EMBEDDING_DIMENSIONS).fill(0.5)
    db.prepare('INSERT INTO chunk_embeddings (chunk_id, embedding) VALUES (?, ?)').run(
      BigInt(1),
      Buffer.from(ok.buffer, ok.byteOffset, ok.byteLength),
    )
    const bad = new Float32Array(3).fill(0.5)
    expect(() =>
      db
        .prepare('INSERT INTO chunk_embeddings (chunk_id, embedding) VALUES (?, ?)')
        .run(BigInt(2), Buffer.from(bad.buffer, bad.byteOffset, bad.byteLength)),
    ).toThrow(/dimension|384|size/i)
  })
})

// ── WI-3 first-run fix: fresh SCNS_HOME has no memory/ dir yet ────────────
// Without mkdir, openMemoryDb throws SQLITE_CANTOPEN on a brand-new home
// (fresh Mac dev broker, first run on the Windows work machine), the daemon's
// silent catch leaves memoryDb null, and memory search stays "available:false"
// for the whole process lifetime.

describe('openMemoryDb — first run on a fresh home', () => {
  it('creates missing parent directories instead of failing CANTOPEN', () => {
    const root = mkdtempSync(join(tmpdir(), 'scns-memdb-freshhome-'))
    try {
      const dbPath = join(root, '.scns', 'memory', 'vault.db')
      const db = openMemoryDb(dbPath)
      expect(existsSync(dbPath)).toBe(true)
      db.close()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
