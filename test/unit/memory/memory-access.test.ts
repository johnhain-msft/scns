import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openMemoryDb, closeMemoryDb } from '../../../src/memory/db.js'
import {
  recordEntityAccess,
  getAccess,
  staleEntities,
  ensureMemoryAccessSchema,
  accessSignalStats,
} from '../../../src/memory/memory-access.js'
import type Database from 'better-sqlite3'

describe('memory-access (D2 retrieval signal — "use it or lose it")', () => {
  let db: Database.Database
  beforeEach(() => {
    db = openMemoryDb(':memory:')
  })
  afterEach(() => {
    closeMemoryDb(db)
  })

  it('records an entity access and increments the count on repeat', () => {
    recordEntityAccess(db, 'broker', 5)
    let row = getAccess(db, 'entity', 'broker')
    expect(row!.access_count).toBe(1)
    expect(row!.last_cycle).toBe(5)

    recordEntityAccess(db, 'broker', 7)
    row = getAccess(db, 'entity', 'broker')
    expect(row!.access_count).toBe(2)
    expect(row!.last_cycle).toBe(7) // advances to the most recent cycle
  })

  it('returns undefined for an entity that was never accessed', () => {
    expect(getAccess(db, 'entity', 'never')).toBeUndefined()
  })

  it('identifies stale entities: known entities never accessed or not accessed since a cutoff cycle', () => {
    recordEntityAccess(db, 'broker', 10) // fresh
    recordEntityAccess(db, 'vault', 2) // old
    // 'autonomy' is known but never accessed
    const stale = staleEntities(db, ['broker', 'vault', 'autonomy'], 5).sort()
    // broker last_cycle 10 >= 5 → fresh; vault 2 < 5 → stale; autonomy absent → stale
    expect(stale).toEqual(['autonomy', 'vault'])
  })

  it('treats an entity accessed exactly at the cutoff cycle as fresh (inclusive)', () => {
    recordEntityAccess(db, 'broker', 5)
    expect(staleEntities(db, ['broker'], 5)).toEqual([])
  })

  it('ensureMemoryAccessSchema is idempotent', () => {
    const bare = openMemoryDb(':memory:')
    bare.exec('DROP TABLE IF EXISTS memory_access')
    expect(() => {
      ensureMemoryAccessSchema(bare)
      ensureMemoryAccessSchema(bare)
    }).not.toThrow()
    closeMemoryDb(bare)
  })

  it('accessSignalStats reports a fully cold signal when nothing was ever accessed', () => {
    const bare = openMemoryDb(':memory:')
    bare.exec('DROP TABLE IF EXISTS memory_access')
    const stats = accessSignalStats(bare)
    expect(stats).toEqual({
      tableExists: false,
      totalAccesses: 0,
      distinctEntities: 0,
      maxCycle: 0,
    })
    closeMemoryDb(bare)
  })

  it('accessSignalStats aggregates total accesses, distinct entities, and the max cycle', () => {
    recordEntityAccess(db, 'broker', 5)
    recordEntityAccess(db, 'broker', 9) // same entity, count 2, advances cycle to 9
    recordEntityAccess(db, 'quality-gate', 7)
    const stats = accessSignalStats(db)
    expect(stats.tableExists).toBe(true)
    expect(stats.totalAccesses).toBe(3) // 2 (broker) + 1 (quality-gate)
    expect(stats.distinctEntities).toBe(2)
    expect(stats.maxCycle).toBe(9)
  })
})
