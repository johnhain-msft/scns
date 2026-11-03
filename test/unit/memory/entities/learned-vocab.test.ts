import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openMemoryDb, closeMemoryDb } from '../../../../src/memory/db.js'
import { rebuildMemoryEdges } from '../../../../src/memory/entities/edges.js'
import {
  learnedEntityView,
  resolveQueryEntities,
  queryNamesLearnedEntity,
  isLearnedEntityQueryEnabled,
  LEARNED_ENTITY_QUERY_ENV,
} from '../../../../src/memory/entities/learned-vocab.js'
import { matchEntities } from '../../../../src/memory/entities/gazetteer.js'
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

function addLearnedEventNode(
  db: Database.Database,
  file: string,
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
       VALUES (?, 0, ?, 0, ?, 1)`,
    )
    .run(file, content, content.length).lastInsertRowid as number
  db.prepare(
    `INSERT INTO event_nodes (chunk_id, event_key, tau, entity, entities, kind, source_ref)
     VALUES (?, ?, '2026-01-01T00:00:00Z', ?, ?, 'conversation-event', ?)`,
  ).run(chunkId, `evk-${chunkId}`, entities[0] ?? null, JSON.stringify(entities), `src#${chunkId}`)
  return chunkId
}

describe('learned-vocab (A-div2 query-side)', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb(':memory:')
    addChunk(db, 'b.md', 1000, 'the broker booted') // gazetteer entity
    addLearnedEventNode(db, 'event-nodes/s1.md', 'Melanie plays the violin', ['melanie']) // learned
    rebuildMemoryEdges(db)
  })
  afterEach(() => closeMemoryDb(db))

  describe('learnedEntityView', () => {
    it('includes learned rows and EXCLUDES gazetteer canonicals', () => {
      const view = learnedEntityView(db)
      const names = view.map((e) => e.canonical)
      expect(names).toContain('melanie')
      expect(names).not.toContain('broker') // gazetteer canonical, matched by the real gazetteer
      const mel = view.find((e) => e.canonical === 'melanie')
      expect(mel?.kind).toBe('entity') // generic learned kind
      expect(mel?.aliases).toEqual([])
    })
  })

  describe('resolveQueryEntities', () => {
    it('learned=false ⇒ byte-identical to matchEntities(query, gazetteer)', () => {
      const q = 'what did melanie tell the broker'
      expect(resolveQueryEntities(db, q)).toEqual(matchEntities(q))
      expect(resolveQueryEntities(db, q, undefined, false).map((m) => m.canonical)).toEqual(['broker'])
    })

    it('learned=true ⇒ resolves a learned name the gazetteer cannot', () => {
      const got = resolveQueryEntities(db, 'what does melanie play', undefined, true)
      expect(got.map((m) => m.canonical)).toContain('melanie')
    })

    it('learned=true ⇒ gazetteer FIRST, then learned, deduped by canonical', () => {
      const got = resolveQueryEntities(db, 'melanie and the broker', undefined, true)
      const names = got.map((m) => m.canonical)
      expect(names).toEqual(['broker', 'melanie']) // gazetteer match precedes the learned match
      expect(new Set(names).size).toBe(names.length) // no duplicates
    })

    it('NEGATIVE control: a non-entity query resolves to nothing even with learned ON', () => {
      expect(resolveQueryEntities(db, 'nothing relevant here', undefined, true)).toEqual([])
    })
  })

  describe('queryNamesLearnedEntity', () => {
    it('true for a learned name, false for a gazetteer-only or non-entity query', () => {
      expect(queryNamesLearnedEntity(db, 'ask melanie')).toBe(true)
      expect(queryNamesLearnedEntity(db, 'restart the broker')).toBe(false) // gazetteer, not learned
      expect(queryNamesLearnedEntity(db, 'nothing relevant here')).toBe(false)
    })
  })
})

// B-EXPLORE §7a — the DEFAULT-ON flip. The learned-resolution BEHAVIOR itself (learned=true resolves a
// learned name the gazetteer cannot) is proven by the resolveQueryEntities suite above; here we lock the
// env semantics of the flip: default(unset)=ON, and =0 == the pre-flip (learned=false) behavior.
describe('isLearnedEntityQueryEnabled — §7a default-ON flip', () => {
  it('is ON by default (unset) and for any value except the explicit off-switch', () => {
    expect(isLearnedEntityQueryEnabled({})).toBe(true) // DEFAULT-ON
    expect(isLearnedEntityQueryEnabled({ [LEARNED_ENTITY_QUERY_ENV]: '1' })).toBe(true)
    expect(isLearnedEntityQueryEnabled({ [LEARNED_ENTITY_QUERY_ENV]: 'anything' })).toBe(true)
  })
  it("=0 is the ONLY value that disables it (byte-identical to the pre-flip learned=false path)", () => {
    expect(isLearnedEntityQueryEnabled({ [LEARNED_ENTITY_QUERY_ENV]: '0' })).toBe(false)
  })
})
