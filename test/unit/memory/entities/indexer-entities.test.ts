import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openMemoryDb, closeMemoryDb } from '../../../../src/memory/db.js'
import { createVault } from '../../../../src/memory/vault.js'
import { indexVaultSync } from '../../../../src/memory/indexer.js'
import type Database from 'better-sqlite3'

function count(db: Database.Database, sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n
}

describe('indexVaultSync — entity/temporal extraction option (M1.1, default-OFF)', () => {
  let rootDir: string
  let db: Database.Database
  let vault: ReturnType<typeof createVault>

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'scns-entities-idx-'))
    vault = createVault({ rootDir })
    db = openMemoryDb(':memory:')
  })
  afterEach(() => {
    closeMemoryDb(db)
    rmSync(rootDir, { recursive: true, force: true })
  })

  it('writes NO entity/edge rows by default (default-OFF ⇒ byte-identical index)', () => {
    vault.write('MEMORY.md', 'the broker and the indexer ran during the dream daemon cycle')
    indexVaultSync(db, vault)

    expect(count(db, 'SELECT COUNT(*) n FROM chunks')).toBeGreaterThan(0)
    expect(count(db, 'SELECT COUNT(*) n FROM memory_entities')).toBe(0)
    expect(count(db, 'SELECT COUNT(*) n FROM memory_edges')).toBe(0)
  })

  it('populates entities + edges when extractEntities is on', () => {
    vault.write('a.md', 'the broker started up')
    vault.write('b.md', 'the broker spoke to the indexer')

    indexVaultSync(db, vault, undefined, undefined, { extractEntities: true })

    expect(count(db, 'SELECT COUNT(*) n FROM memory_entities')).toBeGreaterThan(0)
    expect(count(db, "SELECT COUNT(*) n FROM memory_edges WHERE edge_type='entity'")).toBeGreaterThan(
      0,
    )
    // broker appears in both files → a temporal predecessor link
    expect(count(db, "SELECT COUNT(*) n FROM memory_edges WHERE edge_type='temporal'")).toBeGreaterThan(
      0,
    )
  })

  it('does not change chunk/FTS output whether the option is on or off', () => {
    vault.write('a.md', 'the broker started up and called the indexer')

    const offDb = openMemoryDb(':memory:')
    indexVaultSync(offDb, vault)
    const onDb = openMemoryDb(':memory:')
    indexVaultSync(onDb, vault, undefined, undefined, { extractEntities: true })

    const chunksOff = offDb.prepare('SELECT file_path, chunk_index, content FROM chunks ORDER BY id').all()
    const chunksOn = onDb.prepare('SELECT file_path, chunk_index, content FROM chunks ORDER BY id').all()
    expect(chunksOn).toEqual(chunksOff)

    closeMemoryDb(offDb)
    closeMemoryDb(onDb)
  })

  it('idempotent recompute — re-indexing changed content yields no duplicate edges', () => {
    vault.write('a.md', 'the broker started up')
    vault.write('b.md', 'the broker met the indexer')
    indexVaultSync(db, vault, undefined, undefined, { extractEntities: true })
    const firstEdges = count(db, 'SELECT COUNT(*) n FROM memory_edges')
    expect(firstEdges).toBeGreaterThan(0)

    // modify a file → chunks for it are deleted+reinserted (new ids); edges recompute
    vault.write('b.md', 'the broker met the indexer once more, later on')
    indexVaultSync(db, vault, undefined, undefined, { extractEntities: true })

    // no orphaned/duplicate edges: every edge still points at a live chunk
    expect(
      count(
        db,
        'SELECT COUNT(*) n FROM memory_edges e WHERE e.src_chunk NOT IN (SELECT id FROM chunks)',
      ),
    ).toBe(0)
    // entity catalog is not duplicated across passes
    const names = db.prepare('SELECT name FROM memory_entities').all().map((r) => (r as { name: string }).name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('bootstraps edges once when the option is enabled on an already-indexed (unchanged) vault', () => {
    vault.write('a.md', 'the broker started up')
    // first pass with the option OFF — chunks exist, no edges
    indexVaultSync(db, vault)
    expect(count(db, 'SELECT COUNT(*) n FROM memory_edges')).toBe(0)

    // second pass: content unchanged (no work) but option now ON → bootstrap build
    indexVaultSync(db, vault, undefined, undefined, { extractEntities: true })
    expect(count(db, 'SELECT COUNT(*) n FROM memory_entities')).toBeGreaterThan(0)
    expect(count(db, "SELECT COUNT(*) n FROM memory_edges WHERE edge_type='entity'")).toBeGreaterThan(
      0,
    )
  })
})
