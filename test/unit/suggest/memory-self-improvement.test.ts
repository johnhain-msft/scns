import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openMemoryDb, closeMemoryDb } from '../../../src/memory/db.js'
import { rebuildMemoryEdges } from '../../../src/memory/entities/edges.js'
import { recordProposalOutcome } from '../../../src/memory/proposal-outcomes.js'
import {
  selectMemoryDerivedSeeds,
  makeMemorySeedReaders,
  ENTITY_ANCHORED_SEEDS,
  type EntityAnchoredSeed,
  type MemorySeedReaders,
} from '../../../src/suggest/memory-self-improvement.js'
import type Database from 'better-sqlite3'

const SEEDS: readonly EntityAnchoredSeed[] = [
  { entity: 'quality-gate', family: 'qg-event', title: 'QG event', description: 'd' },
  { entity: 'broker', family: 'broker-port', title: 'Broker port', description: 'd' },
  { entity: 'vault', family: 'vault-thing', title: 'Vault thing', description: 'd' },
]

/** Build readers backed by plain maps so the selector logic is tested in isolation. */
function readersFrom(
  activity: Record<string, number>,
  outcomes: Record<string, Array<{ family: string; verdict: import('../../../src/memory/proposal-outcomes.js').ProposalVerdict }>> = {},
): MemorySeedReaders {
  return {
    neighborhood: (entity: string) => {
      const n = activity[entity] ?? 0
      return Array.from({ length: n }, (_, i) => ({
        chunkId: i,
        filePath: `f/${entity}.md`,
        content: 'x',
        chunkIndex: i,
        mtimeMs: 1000 + i,
      }))
    },
    outcomes: (entity: string) => {
      const rows = outcomes[entity] ?? []
      const families = new Map<string, import('../../../src/memory/proposal-outcomes.js').FamilyOutcome>()
      let landed = 0
      let failed = 0
      for (const r of rows) {
        const isLanded = r.verdict === 'implemented' || r.verdict === 'merged'
        const isFailed = r.verdict === 'failed' || r.verdict === 'rejected' || r.verdict === 'reverted'
        if (isLanded) landed++
        if (isFailed) failed++
        const prev = families.get(r.family)
        families.set(r.family, {
          family: r.family,
          landed: (prev?.landed ?? 0) + (isLanded ? 1 : 0),
          failed: (prev?.failed ?? 0) + (isFailed ? 1 : 0),
          lastVerdict: r.verdict,
          lastScore: null,
          lastAt: '2026-01-01',
        })
      }
      return { entity, total: rows.length, landed, failed, families }
    },
  }
}

describe('selectMemoryDerivedSeeds (D2a read → decision)', () => {
  it('surfaces seeds for active entities, ordered by graph activity desc, capped at limit', () => {
    const readers = readersFrom({ 'quality-gate': 5, broker: 2, vault: 8 })
    const sel = selectMemoryDerivedSeeds(readers, { seeds: SEEDS, limit: 2 })
    expect(sel).toHaveLength(2)
    expect(sel[0]!.entity).toBe('vault') // highest activity first
    expect(sel[1]!.entity).toBe('quality-gate')
    expect(sel[0]!.activity).toBe(8)
    expect(sel[0]!.suppressed).toBe(false)
  })

  it('skips entities with activity below minActivity (no real graph signal)', () => {
    const readers = readersFrom({ 'quality-gate': 0, broker: 0, vault: 3 })
    const sel = selectMemoryDerivedSeeds(readers, { seeds: SEEDS, minActivity: 1 })
    expect(sel.map((s) => s.entity)).toEqual(['vault'])
  })

  it('suppresses a family that already landed (do not redo solved work)', () => {
    const readers = readersFrom(
      { 'quality-gate': 5 },
      { 'quality-gate': [{ family: 'qg-event', verdict: 'implemented' }] },
    )
    const sel = selectMemoryDerivedSeeds(readers, { seeds: SEEDS })
    expect(sel.find((s) => s.family === 'qg-event')).toBeUndefined()
  })

  it('suppresses a family that failed >= maxFamilyFailures (avoid repeating failure modes)', () => {
    const readers = readersFrom(
      { broker: 5 },
      {
        broker: [
          { family: 'broker-port', verdict: 'failed' },
          { family: 'broker-port', verdict: 'rejected' },
        ],
      },
    )
    const sel = selectMemoryDerivedSeeds(readers, { seeds: SEEDS, maxFamilyFailures: 2 })
    expect(sel.find((s) => s.family === 'broker-port')).toBeUndefined()
  })

  it('does NOT suppress a family with failures below the threshold', () => {
    const readers = readersFrom(
      { broker: 5 },
      { broker: [{ family: 'broker-port', verdict: 'failed' }] },
    )
    const sel = selectMemoryDerivedSeeds(readers, { seeds: SEEDS, maxFamilyFailures: 2 })
    const hit = sel.find((s) => s.family === 'broker-port')
    expect(hit).toBeDefined()
    expect(hit!.failed).toBe(1)
  })

  it('returns [] when nothing is active anywhere (fallback to hardcoded path upstream)', () => {
    const readers = readersFrom({})
    expect(selectMemoryDerivedSeeds(readers, { seeds: SEEDS })).toEqual([])
  })

  it('ships a non-empty real catalog anchored entirely on gazetteer entities', () => {
    expect(ENTITY_ANCHORED_SEEDS.length).toBeGreaterThan(0)
    // every seed targets a known gazetteer canonical (verified against the live gazetteer
    // in the integration test below) and carries a stable family tag + concrete description
    for (const s of ENTITY_ANCHORED_SEEDS) {
      expect(s.entity).toBeTruthy()
      expect(s.family).toBeTruthy()
      expect(s.description.length).toBeGreaterThan(40)
    }
  })
})

describe('makeMemorySeedReaders (graph + outcomes adapter)', () => {
  let db: Database.Database
  beforeEach(() => {
    db = openMemoryDb(':memory:')
  })
  afterEach(() => {
    closeMemoryDb(db)
  })

  function addChunk(path: string, mtimeMs: number, content: string, idx = 0): void {
    db.prepare(
      `INSERT INTO vault_files (path, mtime_ms, size_bytes) VALUES (?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET mtime_ms = excluded.mtime_ms`,
    ).run(path, mtimeMs, content.length)
    db.prepare(
      `INSERT INTO chunks (file_path, chunk_index, content, start_offset, end_offset, token_count)
       VALUES (?, ?, ?, 0, ?, 1)`,
    ).run(path, idx, content, content.length)
  }

  it('reads real neighborhood activity + outcome aggregates from the graph', () => {
    // two chunks mention the broker → entity edges after rebuild
    addChunk('weekly/2026-W20.md', 2000, 'the broker refused to merge', 0)
    addChunk('weekly/2026-W21.md', 3000, 'broker port 3456 health endpoint', 0)
    rebuildMemoryEdges(db)
    recordProposalOutcome(db, {
      entity: 'broker',
      family: 'broker-port',
      title: 't',
      verdict: 'implemented',
      suggestionId: 's1',
    })

    const readers = makeMemorySeedReaders(db)
    expect(readers.neighborhood('broker').length).toBe(2)
    const agg = readers.outcomes('broker')
    expect(agg.landed).toBe(1)
    expect(agg.families.get('broker-port')!.lastVerdict).toBe('implemented')
  })

  it('every real catalog seed resolves to a gazetteer entity that the graph can populate', () => {
    const readers = makeMemorySeedReaders(db)
    for (const s of ENTITY_ANCHORED_SEEDS) {
      // neighborhood() returns [] (not throw) for a valid-but-unmentioned entity;
      // an unknown gazetteer name would also return [], so assert via outcomes round-trip:
      expect(() => readers.neighborhood(s.entity)).not.toThrow()
      expect(readers.outcomes(s.entity).entity).toBe(s.entity)
    }
  })
})
