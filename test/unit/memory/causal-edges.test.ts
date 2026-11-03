import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openMemoryDb, closeMemoryDb } from '../../../src/memory/db.js'
import { rebuildMemoryEdges } from '../../../src/memory/entities/edges.js'
import {
  causalKey,
  isCuratedTierPath,
  isLowSignalContent,
  buildCausalCandidates,
  persistCausalEdges,
  materializeCausalEdges,
} from '../../../src/memory/causal-edges.js'
import type { CausalEdge } from '../../../src/memory/causal-provider.js'
import type Database from 'better-sqlite3'

function count(db: Database.Database, sql: string, ...p: unknown[]): number {
  return (db.prepare(sql).get(...p) as { n: number }).n
}

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

describe('causalKey', () => {
  it('is a stable, deterministic function of content (survives re-chunk)', () => {
    const a = causalKey('the broker refused to merge')
    const b = causalKey('the broker refused to merge')
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{16}$/)
  })

  it('differs for different content', () => {
    expect(causalKey('alpha')).not.toBe(causalKey('beta'))
  })

  it('normalises insignificant whitespace so re-chunking the same text yields the same key', () => {
    expect(causalKey('the   broker\n refused')).toBe(causalKey('the broker refused'))
  })
})

describe('isCuratedTierPath', () => {
  it('accepts curated tiers and rejects raw daily/archive telemetry', () => {
    expect(isCuratedTierPath('MEMORY.md')).toBe(true)
    expect(isCuratedTierPath('weekly/2026-W17.md')).toBe(true)
    expect(isCuratedTierPath('monthly/2026-05.md')).toBe(true)
    expect(isCuratedTierPath('daily/2026-05-01.md')).toBe(false)
    expect(isCuratedTierPath('archive/old.md')).toBe(false)
  })
})

describe('isLowSignalContent', () => {
  it('flags telemetry/stat content (session digests, tool-usage patterns)', () => {
    expect(isLowSignalContent('# Session Digest: abc\n**Spans:** 98 **Traces:** 1')).toBe(true)
    expect(isLowSignalContent('Tool usage pattern: unknown(2583), view(1030), bash(374)')).toBe(true)
    expect(isLowSignalContent('> Weekly logs processed: 1 > Stable patterns found: 0')).toBe(true)
  })

  it('flags markdown-table-dominated content', () => {
    expect(isLowSignalContent('| Model | Calls |\n|-------|-------|\n| claude-opus-4.8 | 14 |')).toBe(
      true,
    )
  })

  it('flags trivially short fragments', () => {
    expect(isLowSignalContent('tions?')).toBe(true)
    expect(isLowSignalContent('   ')).toBe(true)
  })

  it('accepts genuine prose narratives', () => {
    expect(
      isLowSignalContent('the auto-merger refused the merge because the working tree was dirty'),
    ).toBe(false)
    expect(
      isLowSignalContent('issue #5 was filed to track the dirty-worktree auto-merge block'),
    ).toBe(false)
  })
})

describe('buildCausalCandidates', () => {
  let db: Database.Database
  beforeEach(() => {
    db = openMemoryDb(':memory:')
  })
  afterEach(() => closeMemoryDb(db))

  it('derives (cause→effect) candidates from the temporal backbone over curated tiers', () => {
    // two curated-tier chunks mentioning the same entity, ordered in time
    addChunk(db, 'weekly/2026-W16.md', 1000, 'the auto-merger refused the merge')
    addChunk(db, 'weekly/2026-W17.md', 2000, 'later the auto-merger merged cleanly')
    rebuildMemoryEdges(db)

    const cands = buildCausalCandidates(db)
    expect(cands.length).toBeGreaterThanOrEqual(1)
    const c = cands[0]!
    expect(c.entity).toBe('auto-merger')
    // cause precedes effect in time
    expect(c.causeContent).toContain('refused')
    expect(c.effectContent).toContain('merged cleanly')
    // keys are content-hashes (stable)
    expect(c.causeKey).toBe(causalKey(c.causeContent))
    expect(c.effectKey).toBe(causalKey(c.effectContent))
  })

  it('excludes raw daily telemetry from candidates', () => {
    addChunk(db, 'daily/2026-05-01.md', 1000, 'the auto-merger refused the merge')
    addChunk(db, 'daily/2026-05-02.md', 2000, 'the auto-merger merged cleanly')
    rebuildMemoryEdges(db)

    const cands = buildCausalCandidates(db)
    expect(cands).toEqual([])
  })

  it('caps the number of candidates', () => {
    for (let i = 0; i < 10; i++) {
      addChunk(db, `weekly/w${i}.md`, 1000 + i, `the broker did thing number ${i}`)
    }
    rebuildMemoryEdges(db)
    const cands = buildCausalCandidates(db, { maxCandidates: 3 })
    expect(cands.length).toBeLessThanOrEqual(3)
  })

  it('excludes same-file (document-split fragment) pairs by default', () => {
    // Same entity, SAME file, two chunks → a same-file temporal pair (overlapping
    // fragments of one document, not two distinct events).
    addChunk(db, 'monthly/m.md', 1000, 'the broker started a fresh consolidation run', 0)
    addChunk(db, 'monthly/m.md', 1000, 'the broker then archived the old lessons cleanly', 1)
    rebuildMemoryEdges(db)
    expect(buildCausalCandidates(db)).toEqual([])
    expect(buildCausalCandidates(db, { excludeSameFile: false }).length).toBeGreaterThanOrEqual(1)
  })

  it('excludes low-signal telemetry chunks from candidates by default', () => {
    addChunk(db, 'weekly/w1.md', 1000, 'the broker refused to merge because the tree was dirty', 0)
    addChunk(
      db,
      'monthly/m1.md',
      2000,
      'broker tool usage pattern: view(1030), bash(374), broker(50)',
      0,
    )
    rebuildMemoryEdges(db)
    // the telemetry effect chunk is filtered ⇒ the cross-file pair is dropped by default
    expect(buildCausalCandidates(db)).toEqual([])
    // …but it survives when the low-signal filter is disabled (proves the filter is the cause)
    expect(buildCausalCandidates(db, { excludeLowSignal: false }).length).toBeGreaterThanOrEqual(1)
  })
})

describe('persistCausalEdges', () => {
  let db: Database.Database
  beforeEach(() => {
    db = openMemoryDb(':memory:')
  })
  afterEach(() => closeMemoryDb(db))

  const edge = (over: Partial<CausalEdge> = {}): CausalEdge => ({
    causeKey: 'aaaa000000000000',
    effectKey: 'bbbb000000000000',
    confidence: 0.9,
    rationale: 'because reasons',
    ...over,
  })

  it('persists edges above the confidence threshold', () => {
    const stats = persistCausalEdges(db, [edge()], { minConfidence: 0.7, provider: 'mock' })
    expect(stats.persisted).toBe(1)
    expect(count(db, 'SELECT COUNT(*) n FROM memory_causal')).toBe(1)
    const row = db.prepare('SELECT * FROM memory_causal').get() as {
      provider: string
      confidence: number
    }
    expect(row.provider).toBe('mock')
    expect(row.confidence).toBe(0.9)
  })

  it('rejects edges below the confidence threshold (the gate)', () => {
    const stats = persistCausalEdges(
      db,
      [edge({ confidence: 0.4 }), edge({ causeKey: 'cccc000000000000', confidence: 0.95 })],
      { minConfidence: 0.7, provider: 'mock' },
    )
    expect(stats.rejectedLowConfidence).toBe(1)
    expect(stats.persisted).toBe(1)
    expect(count(db, 'SELECT COUNT(*) n FROM memory_causal')).toBe(1)
  })

  it('caps the number of edges persisted per run, keeping the highest-confidence ones', () => {
    const edges: CausalEdge[] = [
      edge({ causeKey: 'k1', confidence: 0.71 }),
      edge({ causeKey: 'k2', confidence: 0.99 }),
      edge({ causeKey: 'k3', confidence: 0.85 }),
    ]
    const stats = persistCausalEdges(db, edges, { minConfidence: 0.7, maxEdges: 2, provider: 'mock' })
    expect(stats.persisted).toBe(2)
    expect(stats.cappedOut).toBe(1)
    const kept = db
      .prepare('SELECT cause_key FROM memory_causal ORDER BY confidence DESC')
      .all()
      .map((r) => (r as { cause_key: string }).cause_key)
    expect(kept).toEqual(['k2', 'k3'])
  })

  it('dedupes on (cause_key, effect_key) across runs (idempotent)', () => {
    persistCausalEdges(db, [edge()], { minConfidence: 0.7, provider: 'mock' })
    persistCausalEdges(db, [edge({ rationale: 'different wording' })], {
      minConfidence: 0.7,
      provider: 'mock',
    })
    expect(count(db, 'SELECT COUNT(*) n FROM memory_causal')).toBe(1)
  })

  it('causal rows survive a re-chunk (keyed on content-hash, not chunk id)', () => {
    addChunk(db, 'weekly/w1.md', 1000, 'the broker refused')
    addChunk(db, 'weekly/w2.md', 2000, 'the broker recovered')
    rebuildMemoryEdges(db)
    const cands = buildCausalCandidates(db)
    expect(cands.length).toBeGreaterThanOrEqual(1)
    const c = cands[0]!
    persistCausalEdges(
      db,
      [{ causeKey: c.causeKey, effectKey: c.effectKey, confidence: 0.9, rationale: 'r' }],
      { minConfidence: 0.7, provider: 'mock' },
    )
    expect(count(db, 'SELECT COUNT(*) n FROM memory_causal')).toBe(1)

    // Simulate a re-chunk: delete + reinsert chunks (NEW ids), rebuild deterministic edges.
    db.prepare('DELETE FROM chunks').run()
    addChunk(db, 'weekly/w1.md', 1000, 'the broker refused')
    addChunk(db, 'weekly/w2.md', 2000, 'the broker recovered')
    rebuildMemoryEdges(db)

    // memory_edges (entity/temporal) were rebuilt, but the causal row persists unchanged.
    expect(count(db, 'SELECT COUNT(*) n FROM memory_causal')).toBe(1)
    const stillThere = buildCausalCandidates(db)[0]!
    const row = db
      .prepare('SELECT confidence FROM memory_causal WHERE cause_key=? AND effect_key=?')
      .get(stillThere.causeKey, stillThere.effectKey) as { confidence: number } | undefined
    expect(row?.confidence).toBe(0.9)
  })
})

describe('materializeCausalEdges (WS-2b write/read-split fix)', () => {
  let db: Database.Database
  beforeEach(() => {
    db = openMemoryDb(':memory:')
  })
  afterEach(() => closeMemoryDb(db))

  const CAUSE = 'On 2026-06-04T02:07:57Z the broker quality-gate review passed'
  const EFFECT = 'On 2026-06-04T02:07:58Z the broker auto-merged the branch'

  /** Neighbors of `chunkId` over the causal edge graph, exactly as adaptive-traversal reads them. */
  function causalNeighbors(database: Database.Database, chunkId: number): number[] {
    return (
      database
        .prepare(
          "SELECT dst_chunk AS v FROM memory_edges WHERE src_chunk=? AND edge_type='causal' AND dst_chunk IS NOT NULL",
        )
        .all(chunkId) as Array<{ v: number }>
    ).map((r) => r.v)
  }

  /** Seed two event-node chunks + one inferred causal row over them; return their chunk ids. */
  function seedPair(): { cause: number; effect: number } {
    const cause = addChunk(db, 'event-nodes/broker.md', 1000, CAUSE, 2_000_000)
    const effect = addChunk(db, 'event-nodes/broker.md', 1000, EFFECT, 2_000_001)
    persistCausalEdges(
      db,
      [{ causeKey: causalKey(CAUSE), effectKey: causalKey(EFFECT), confidence: 0.9, rationale: 'gate pass enabled the merge' }],
      { minConfidence: 0.7, provider: 'mock', entityByPair: new Map([[`${causalKey(CAUSE)}\u0000${causalKey(EFFECT)}`, 'broker']]) },
    )
    return { cause, effect }
  }

  it('resolves memory_causal keys to live chunks and writes chunk→chunk memory_edges(causal) the beam reads', () => {
    const { cause, effect } = seedPair()
    const stats = materializeCausalEdges(db)
    expect(stats.consideredRows).toBe(1)
    expect(stats.unresolved).toBe(0)
    expect(stats.materialized).toBeGreaterThanOrEqual(1)
    // Default 'both': the beam can reach the effect from the cause AND the cause from the effect.
    expect(causalNeighbors(db, cause)).toContain(effect)
    expect(causalNeighbors(db, effect)).toContain(cause)
  })

  it('direction is explicit, not assumed: forward-only writes cause→effect but NOT the reverse', () => {
    const { cause, effect } = seedPair()
    materializeCausalEdges(db, { direction: 'forward' })
    expect(causalNeighbors(db, cause)).toContain(effect)
    expect(causalNeighbors(db, effect)).not.toContain(cause)
  })

  it('is idempotent (scoped-delete + rebuild): a second call yields the same causal edge set', () => {
    seedPair()
    materializeCausalEdges(db)
    const n1 = count(db, "SELECT COUNT(*) n FROM memory_edges WHERE edge_type='causal'")
    materializeCausalEdges(db)
    const n2 = count(db, "SELECT COUNT(*) n FROM memory_edges WHERE edge_type='causal'")
    expect(n1).toBeGreaterThan(0)
    expect(n2).toBe(n1)
  })

  it('SURVIVES rebuildMemoryEdges — the split-fix regression guard (entity/temporal rebuild leaves causal intact)', () => {
    seedPair()
    materializeCausalEdges(db)
    const before = count(db, "SELECT COUNT(*) n FROM memory_edges WHERE edge_type='causal'")
    expect(before).toBeGreaterThan(0)
    rebuildMemoryEdges(db) // scoped delete is entity/temporal ONLY
    const after = count(db, "SELECT COUNT(*) n FROM memory_edges WHERE edge_type='causal'")
    expect(after).toBe(before)
  })

  it('skips causal rows whose keys do not resolve to a live chunk (counted unresolved, none written)', () => {
    // A rationale-only edge (no backing chunk for either key) — e.g. an outcome-only causal edge.
    persistCausalEdges(
      db,
      [{ causeKey: 'deadbeefdeadbeef', effectKey: 'feedfacefeedface', confidence: 0.9 }],
      { minConfidence: 0.7, provider: 'mock' },
    )
    const stats = materializeCausalEdges(db)
    expect(stats.consideredRows).toBe(1)
    expect(stats.unresolved).toBe(1)
    expect(stats.materialized).toBe(0)
    expect(count(db, "SELECT COUNT(*) n FROM memory_edges WHERE edge_type='causal'")).toBe(0)
  })

  it('no memory_causal rows ⇒ scoped-clears the causal tier and reports zero (do-no-harm)', () => {
    const stats = materializeCausalEdges(db)
    expect(stats).toEqual({ consideredRows: 0, materialized: 0, unresolved: 0 })
    expect(count(db, "SELECT COUNT(*) n FROM memory_edges WHERE edge_type='causal'")).toBe(0)
  })
})
