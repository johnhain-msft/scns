import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openMemoryDb, closeMemoryDb } from '../../../src/memory/db.js'
import { recordEntityAccess } from '../../../src/memory/memory-access.js'
import {
  planMemoryMaintenance,
  executeMemoryMaintenance,
  type MaintenanceVault,
} from '../../../src/dream/memory-maintenance.js'
import type Database from 'better-sqlite3'

/** In-memory fake vault backed by a Map. */
function fakeVault(files: Record<string, string>): MaintenanceVault & { store: Map<string, string> } {
  const store = new Map(Object.entries(files))
  return {
    store,
    listFiles: () =>
      [...store.keys()].map((path) => ({ path, mtimeMs: 1000, sizeBytes: store.get(path)!.length })),
    read: (path: string) => (store.has(path) ? { content: store.get(path)! } : null),
    write: (path: string, content: string) => void store.set(path, content),
    remove: (path: string) => store.delete(path),
  }
}

describe('memory-maintenance (access-aware forgetting — gated, reversible)', () => {
  let db: Database.Database
  beforeEach(() => {
    db = openMemoryDb(':memory:')
  })
  afterEach(() => {
    closeMemoryDb(db)
  })

  it('keeps low-value files about FRESH entities, marks files about only-stale/no entities for decay', () => {
    recordEntityAccess(db, 'broker', 100) // broker was retrieved recently (fresh)
    const vault = fakeVault({
      'sessions/a.md': 'the broker daemon restarted on port 3456', // fresh entity → keep
      'sessions/b.md': 'magma retrieval pipeline notes',           // only stale entity → decay
      'sessions/c.md': 'Spans: 98 Traces: 1 Duration: 14',         // no live entity → decay
      'weekly/w.md': 'broker and magma weekly summary',            // not a low-value tier → never scanned
      'MEMORY.md': 'magma curated lesson',                          // curated → never scanned
    })

    const plan = planMemoryMaintenance({
      db,
      vault,
      cycle: 100,
      staleCycles: 30, // stale if not accessed since cycle 70
      knownEntities: ['broker', 'magma'],
      lowValueTierPrefixes: ['sessions/'],
    })

    const paths = plan.decayCandidates.map((c) => c.path).sort()
    expect(paths).toEqual(['sessions/b.md', 'sessions/c.md'])
    expect(plan.staleBeforeCycle).toBe(70)
    // curated + non-low-value tiers are never even scanned
    expect(plan.decayCandidates.some((c) => c.path === 'weekly/w.md')).toBe(false)
    expect(plan.decayCandidates.some((c) => c.path === 'MEMORY.md')).toBe(false)
  })

  it('execute archives decay candidates reversibly (moved to archive/, original removed)', () => {
    const vault = fakeVault({
      'sessions/b.md': 'magma retrieval pipeline notes',
    })
    const res = executeMemoryMaintenance({
      db,
      vault,
      cycle: 100,
      staleCycles: 30,
      knownEntities: ['magma'],
      lowValueTierPrefixes: ['sessions/'],
    })
    expect(res.archivedCount).toBe(1)
    expect(res.archived).toEqual(['sessions/b.md'])
    // reversible: original gone, content preserved under archive/
    expect(vault.store.has('sessions/b.md')).toBe(false)
    expect(vault.store.get('archive/decayed/sessions/b.md')).toContain('magma retrieval')
  })

  it('dryRun plans but archives nothing', () => {
    const vault = fakeVault({ 'sessions/b.md': 'magma notes' })
    const res = executeMemoryMaintenance({
      db,
      vault,
      cycle: 100,
      staleCycles: 30,
      knownEntities: ['magma'],
      lowValueTierPrefixes: ['sessions/'],
      dryRun: true,
    })
    expect(res.dryRun).toBe(true)
    expect(res.archivedCount).toBe(0)
    expect(res.plan.decayCandidates).toHaveLength(1)
    expect(vault.store.has('sessions/b.md')).toBe(true) // untouched
  })

  it('NEVER touches curated tiers even if their entities are all stale (guardrail safety)', () => {
    const vault = fakeVault({
      'MEMORY.md': 'magma lesson', // stale entity, but curated
      'lessons/x.md': 'magma lesson',
      'negative/y.md': 'magma prohibition',
    })
    const plan = planMemoryMaintenance({
      db,
      vault,
      cycle: 100,
      staleCycles: 30,
      knownEntities: ['magma'],
      lowValueTierPrefixes: ['sessions/'], // only sessions/ is eligible
    })
    expect(plan.decayCandidates).toHaveLength(0)
  })

  // ── Warm-up guard + throttle + age cutoff (cold-start coupling fix) ──

  it('warm-up guard: decays NOTHING while the access signal is cold', () => {
    // No accesses recorded → cold signal → every entity looks stale.
    const vault = fakeVault({
      'sessions/a.md': 'magma retrieval pipeline notes', // would normally decay (stale entity)
      'sessions/b.md': 'Spans: 1 Duration: 2', // would normally decay (no live entity)
    })
    const plan = planMemoryMaintenance({
      db,
      vault,
      cycle: 100,
      staleCycles: 30,
      knownEntities: ['magma', 'broker'],
      lowValueTierPrefixes: ['sessions/'],
      minWarmupAccesses: 20,
      minWarmupEntities: 3,
    })
    expect(plan.decayCandidates).toHaveLength(0)
    expect(plan.accessSignalWarm).toBe(false)
    expect(plan.skippedReason).toBe('cold-access-signal')
    expect(plan.scanned).toBe(0)
  })

  it('warm-up guard: decays normally once the access signal is warm', () => {
    // Warm: >=3 distinct entities, >=20 total accesses (the D2a loop is firing).
    for (let i = 0; i < 10; i++) recordEntityAccess(db, 'broker', 100)
    for (let i = 0; i < 8; i++) recordEntityAccess(db, 'quality-gate', 100)
    for (let i = 0; i < 5; i++) recordEntityAccess(db, 'autonomy', 100)
    const vault = fakeVault({
      'sessions/a.md': 'magma retrieval pipeline notes', // magma never retrieved → stale → decay
      'sessions/b.md': 'the broker daemon on port 3456', // broker fresh → keep
    })
    const plan = planMemoryMaintenance({
      db,
      vault,
      cycle: 100,
      staleCycles: 30,
      knownEntities: ['magma', 'broker', 'quality-gate', 'autonomy'],
      lowValueTierPrefixes: ['sessions/'],
      minWarmupAccesses: 20,
      minWarmupEntities: 3,
    })
    expect(plan.accessSignalWarm).toBe(true)
    expect(plan.skippedReason).toBeUndefined()
    expect(plan.decayCandidates.map((c) => c.path)).toEqual(['sessions/a.md'])
  })

  it('maxArchivePerRun caps how much one run may archive', () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 5; i++) files[`sessions/s${i}.md`] = 'Spans: 1 telemetry (no live entity)'
    const vault = fakeVault(files)
    const plan = planMemoryMaintenance({
      db,
      vault,
      cycle: 100,
      staleCycles: 30,
      knownEntities: ['magma'],
      lowValueTierPrefixes: ['sessions/'],
      maxArchivePerRun: 2,
    })
    expect(plan.scanned).toBe(5)
    expect(plan.decayCandidates).toHaveLength(2) // capped
  })

  it('minFileAgeMs never forgets a freshly-written file', () => {
    const now = 1_000_000_000_000
    const vault: MaintenanceVault = {
      listFiles: () => [
        { path: 'sessions/fresh.md', mtimeMs: now - 1000, sizeBytes: 10 }, // 1s old → protected
        { path: 'sessions/old.md', mtimeMs: now - 100 * 86_400_000, sizeBytes: 10 }, // 100d old → eligible
      ],
      read: () => ({ content: 'Spans: 1 telemetry, no live entity' }),
      write: () => undefined,
      remove: () => true,
    }
    const plan = planMemoryMaintenance({
      db,
      vault,
      cycle: 100,
      staleCycles: 30,
      knownEntities: ['magma'],
      lowValueTierPrefixes: ['sessions/'],
      minFileAgeMs: 14 * 86_400_000,
      now,
    })
    expect(plan.decayCandidates.map((c) => c.path)).toEqual(['sessions/old.md']) // fresh protected
    expect(plan.scanned).toBe(2)
  })
})
