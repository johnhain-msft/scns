import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { openMemoryDb, closeMemoryDb } from '../../../src/memory/db.js'
import { rebuildMemoryEdges } from '../../../src/memory/entities/edges.js'
import { causalKey } from '../../../src/memory/causal-edges.js'
import { intentAwareSearch, parseFusionWeights } from '../../../src/memory/intent-search.js'
import type { SearchResult } from '../../../src/memory/search.js'
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

function addCausal(
  db: Database.Database,
  cause: string,
  effect: string,
  entity: string,
  confidence: number,
  rationale: string | null = null,
): void {
  db.prepare(
    `INSERT INTO memory_causal (cause_key, effect_key, entity, rationale, confidence, provider)
     VALUES (?, ?, ?, ?, ?, 'acp')`,
  ).run(causalKey(cause), causalKey(effect), entity, rationale, confidence)
}

const SENTINEL: readonly SearchResult[] = [
  {
    chunkId: 999,
    filePath: 'base.md',
    content: 'BASE-RESULT',
    score: 0.5,
    vectorScore: 0.5,
    keywordScore: 0,
    chunkIndex: 0,
  },
]

describe('intentAwareSearch (M1.2 router, default-OFF)', () => {
  let db: Database.Database
  let base: ReturnType<typeof vi.fn>

  beforeEach(() => {
    db = openMemoryDb(':memory:')
    // four broker mentions across time + one unrelated indexer mention
    addChunk(db, 't1.md', 1000, 'the broker first booted')
    addChunk(db, 't2.md', 2000, 'the broker handled a request')
    addChunk(db, 't3.md', 3000, 'the broker restarted')
    addChunk(db, 't4.md', 4000, 'the broker is healthy now')
    addChunk(db, 'idx.md', 5000, 'the indexer ran once')
    rebuildMemoryEdges(db)
    base = vi.fn(async () => SENTINEL)
  })
  afterEach(() => closeMemoryDb(db))

  describe('default-OFF / pass-through (regression-lock)', () => {
    it('enabled=false ⇒ returns baseSearch output verbatim, even for an ENTITY/WHEN query', async () => {
      const out = await intentAwareSearch(db, 'when did the broker run', 5, base, {
        enabled: false,
      })
      expect(out).toBe(SENTINEL)
      expect(base).toHaveBeenCalledTimes(1)
      expect(base).toHaveBeenCalledWith('when did the broker run', 5)
    })

    it('omitting options ⇒ default-OFF pass-through', async () => {
      const out = await intentAwareSearch(db, 'broker', 5, base)
      expect(out).toBe(SENTINEL)
      expect(base).toHaveBeenCalledTimes(1)
    })

    it('DEFAULT intent (enabled) ⇒ pass-through to baseSearch', async () => {
      const out = await intentAwareSearch(db, 'how do I configure logging levels', 5, base, {
        enabled: true,
      })
      expect(out).toBe(SENTINEL)
      expect(base).toHaveBeenCalledTimes(1)
    })

    it('WHY intent (enabled) with no causal edges ⇒ falls back to baseSearch', async () => {
      const out = await intentAwareSearch(db, 'why did the broker crash', 5, base, {
        enabled: true,
      })
      expect(out).toBe(SENTINEL)
      expect(base).toHaveBeenCalledTimes(1)
    })
  })

  describe('ENTITY routing', () => {
    it('returns the entity neighborhood (base NOT called), newest-first, as SearchResult rows', async () => {
      const out = await intentAwareSearch(db, 'broker', 10, base, { enabled: true })
      expect(base).not.toHaveBeenCalled()
      expect(out.map((r) => r.filePath)).toEqual(['t4.md', 't3.md', 't2.md', 't1.md'])
      expect(out.every((r) => r.content.includes('broker'))).toBe(true)
      // SearchResult shape: synthetic positional score (top = 1.0, monotonically decreasing),
      // vector/keyword contributions zero (these are graph hits, not hybrid hits).
      expect(out[0]!.score).toBe(1)
      for (let i = 1; i < out.length; i++) {
        expect(out[i]!.score).toBeLessThan(out[i - 1]!.score)
      }
      expect(out.every((r) => r.vectorScore === 0 && r.keywordScore === 0)).toBe(true)
      expect(out.every((r) => typeof r.chunkId === 'number' && r.chunkId > 0)).toBe(true)
    })

    it('caps the result at topK (newest N)', async () => {
      const out = await intentAwareSearch(db, 'broker', 2, base, { enabled: true })
      expect(out.map((r) => r.filePath)).toEqual(['t4.md', 't3.md'])
    })

    it('aggregates + de-duplicates across multiple matched entities', async () => {
      // a chunk that mentions BOTH broker and indexer must appear exactly once
      addChunk(db, 'both.md', 6000, 'the broker called the indexer')
      rebuildMemoryEdges(db)
      const out = await intentAwareSearch(db, 'broker and indexer', 20, base, { enabled: true })
      expect(base).not.toHaveBeenCalled()
      const bothHits = out.filter((r) => r.filePath === 'both.md')
      expect(bothHits).toHaveLength(1)
      // newest-first: both.md (6000) and idx.md (5000) lead
      expect(out[0]!.filePath).toBe('both.md')
      expect(out[1]!.filePath).toBe('idx.md')
      // no duplicate chunkIds overall
      const ids = out.map((r) => r.chunkId)
      expect(new Set(ids).size).toBe(ids.length)
    })

    it('falls back to baseSearch when the entity has no edges (empty neighborhood)', async () => {
      // 'magma' is a gazetteer entity (⇒ ENTITY intent) but is never mentioned in the fixture
      const out = await intentAwareSearch(db, 'magma', 5, base, { enabled: true })
      expect(out).toBe(SENTINEL)
      expect(base).toHaveBeenCalledWith('magma', 5)
    })
  })

  describe('WHEN routing', () => {
    it('returns the entity neighborhood chronological (oldest-first) — distinct from ENTITY order', async () => {
      const out = await intentAwareSearch(db, 'when did the broker run', 10, base, {
        enabled: true,
      })
      expect(base).not.toHaveBeenCalled()
      expect(out.map((r) => r.filePath)).toEqual(['t1.md', 't2.md', 't3.md', 't4.md'])
      // self-consistent: array order == score-descending order (top of the list = highest score)
      expect(out[0]!.score).toBe(1)
    })

    it('falls back to baseSearch for a temporal query with no entity', async () => {
      const out = await intentAwareSearch(db, 'what happened recently', 5, base, { enabled: true })
      expect(out).toBe(SENTINEL)
      expect(base).toHaveBeenCalledWith('what happened recently', 5)
    })
  })

  describe('WHY routing (causal-edge neighborhood)', () => {
    it('returns the causal chains (base NOT called) when the WHY query names an entity with edges', async () => {
      const cause = 'the broker lock file was left stale after a crash'
      const effect = 'the broker refused to start and logged ELOCKED'
      addChunk(db, 'cause.md', 7000, cause)
      addChunk(db, 'effect.md', 7001, effect)
      addCausal(db, cause, effect, 'broker', 0.9, 'stale lock blocked startup')

      const out = await intentAwareSearch(db, 'why did the broker refuse to start', 5, base, {
        enabled: true,
      })
      expect(base).not.toHaveBeenCalled()
      expect(out).toHaveLength(1)
      // the formatted causal chain carries cause, effect, and rationale
      expect(out[0]!.content).toContain('stale')
      expect(out[0]!.content).toContain('→ led to →')
      expect(out[0]!.content).toContain('ELOCKED')
      expect(out[0]!.content).toContain('Why: stale lock blocked startup')
      // structural hit: positional score (top = 1.0), zero vector/keyword
      expect(out[0]!.score).toBe(1)
      expect(out[0]!.vectorScore === 0 && out[0]!.keywordScore === 0).toBe(true)
    })

    it('orders multiple chains by confidence (descending) and caps at topK', async () => {
      addCausal(db, 'c-lo', 'e-lo', 'broker', 0.72, 'low')
      addCausal(db, 'c-hi', 'e-hi', 'broker', 0.95, 'high')
      addCausal(db, 'c-mid', 'e-mid', 'broker', 0.8, 'mid')
      const out = await intentAwareSearch(db, 'why is the broker like this', 2, base, {
        enabled: true,
      })
      expect(base).not.toHaveBeenCalled()
      expect(out).toHaveLength(2)
      expect(out[0]!.content).toContain('Why: high')
      expect(out[1]!.content).toContain('Why: mid')
      // scores strictly decrease with rank
      expect(out[0]!.score).toBeGreaterThan(out[1]!.score)
    })

    it('causalTopoOrder (default OFF): ON reorders WHY chains into cause→effect order (paper Stage 4)', async () => {
      // A linear causal story A→B→C→D whose confidences MIS-order it under a confidence sort.
      const nA = 'the broker received a self-improvement suggestion'
      const nB = 'the broker spawned a team to implement it'
      const nC = 'the broker quality-gate passed the change'
      const nD = 'the broker auto-merged the branch'
      addChunk(db, 'a.md', 8000, nA)
      addChunk(db, 'b.md', 8001, nB)
      addChunk(db, 'c.md', 8002, nC)
      addChunk(db, 'd.md', 8003, nD)
      addCausal(db, nA, nB, 'broker', 0.5, 'AB')
      addCausal(db, nB, nC, 'broker', 0.95, 'BC')
      addCausal(db, nC, nD, 'broker', 0.7, 'CD')
      const marks = (rs: readonly { content: string }[]) =>
        rs.map((r) => r.content.match(/Why: (\w+)/)?.[1])

      // Default (OFF) ⇒ confidence-descending order.
      const off = await intentAwareSearch(db, 'why is the broker like this', 5, base, {
        enabled: true,
      })
      expect(marks(off)).toEqual(['BC', 'CD', 'AB'])

      // ON ⇒ cause→effect topological order (root cause first).
      const on = await intentAwareSearch(db, 'why is the broker like this', 5, base, {
        enabled: true,
        causalTopoOrder: true,
      })
      expect(marks(on)).toEqual(['AB', 'BC', 'CD'])
    })

    it('a rationale-only edge (chunks re-chunked away) still surfaces via WHY routing', async () => {
      addCausal(db, 'vanished cause', 'vanished effect', 'broker', 0.85, 'surviving rationale')
      const out = await intentAwareSearch(db, 'why did the broker do that', 5, base, {
        enabled: true,
      })
      expect(base).not.toHaveBeenCalled()
      expect(out).toHaveLength(1)
      expect(out[0]!.content).toBe('Why: surviving rationale')
    })

    it('WHY query naming an entity whose only edge has no usable text ⇒ falls back to baseSearch', async () => {
      // edge present but cause/effect re-chunked away AND no rationale ⇒ no usable text
      addCausal(db, 'gone cause', 'gone effect', 'broker', 0.85, null)
      const out = await intentAwareSearch(db, 'why did the broker fail', 5, base, { enabled: true })
      expect(out).toBe(SENTINEL)
      expect(base).toHaveBeenCalledTimes(1)
    })
  })
})

describe('intentAwareSearch — semantic 2-hop augmentation (default-OFF)', () => {
  let db: Database.Database
  let S: number, M: number, F: number
  let base: ReturnType<typeof vi.fn>

  function addSem(src: number, dst: number, weight: number): void {
    db.prepare(
      `INSERT INTO memory_edges (src_chunk, edge_type, dst_chunk, weight, source, confidence)
       VALUES (?, 'semantic', ?, ?, 'embedding', ?)`,
    ).run(src, dst, weight, weight)
  }

  beforeEach(() => {
    db = openMemoryDb(':memory:')
    S = addChunk(db, 'seed.md', 1000, 'the seed result content')
    M = addChunk(db, 'mid.md', 2000, 'a one-hop bridge chunk')
    F = addChunk(db, 'far.md', 3000, 'distant fact SEMANTIC_2HOP_FACT only reachable by two hops')
    addSem(S, M, 0.9) // seed -> 1-hop bridge
    addSem(M, F, 0.8) // bridge -> 2-hop fact
    // base search returns ONLY the seed (what hybrid would surface)
    base = vi.fn(async () => [
      {
        chunkId: S,
        filePath: 'seed.md',
        content: 'the seed result content',
        score: 0.5,
        vectorScore: 0.5,
        keywordScore: 0,
        chunkIndex: 0,
      },
    ])
  })
  afterEach(() => closeMemoryDb(db))

  it('semantic OFF ⇒ base verbatim (no 2-hop fact); regression-locked', async () => {
    const out = await intentAwareSearch(db, 'neutral default query', 5, base, { enabled: true })
    expect(out.map((r) => r.chunkId)).toEqual([S])
    expect(out.some((r) => r.content.includes('SEMANTIC_2HOP_FACT'))).toBe(false)
  })

  it('semantic ON ⇒ surfaces the 2-hop fact the base/hybrid path misses', async () => {
    const out = await intentAwareSearch(db, 'neutral default query', 5, base, {
      enabled: true,
      semantic: true,
    })
    expect(out.length).toBeLessThanOrEqual(5)
    expect(out.some((r) => r.chunkId === S)).toBe(true) // base hit retained
    expect(out.some((r) => r.content.includes('SEMANTIC_2HOP_FACT'))).toBe(true) // 2-hop added
    // the 1-hop bridge (already vector-reachable) is NOT injected as an addition
    expect(out.some((r) => r.chunkId === M)).toBe(false)
  })

  it('semantic works without intent routing (enabled=false, semantic=true)', async () => {
    const out = await intentAwareSearch(db, 'neutral default query', 5, base, {
      enabled: false,
      semantic: true,
    })
    expect(out.some((r) => r.content.includes('SEMANTIC_2HOP_FACT'))).toBe(true)
  })

  it('semantic ON but no novel 2-hop neighbor ⇒ base unchanged', async () => {
    const lonely = addChunk(db, 'lonely.md', 4000, 'no edges here')
    const lonelyBase = vi.fn(async () => [
      {
        chunkId: lonely,
        filePath: 'lonely.md',
        content: 'no edges here',
        score: 0.5,
        vectorScore: 0.5,
        keywordScore: 0,
        chunkIndex: 0,
      },
    ])
    const out = await intentAwareSearch(db, 'neutral default query', 5, lonelyBase, {
      enabled: false,
      semantic: true,
    })
    expect(out.map((r) => r.chunkId)).toEqual([lonely])
  })
})

describe('intentAwareSearch — MAGMA Algorithm 1 fusion (default-OFF)', () => {
  let db: Database.Database
  let id1: number, id2: number, id3: number, id4: number, idIdx: number
  let base: ReturnType<typeof vi.fn>

  /** A SearchResult row (hybrid candidate) for the fake base search. */
  function mk(chunkId: number, filePath: string, content: string, score: number): SearchResult {
    return { chunkId, filePath, content, score, vectorScore: score, keywordScore: 0, chunkIndex: 0 }
  }

  beforeEach(() => {
    db = openMemoryDb(':memory:')
    // four broker mentions across time (recency ascending), one unrelated indexer mention
    id1 = addChunk(db, 't1.md', 1000, 'the broker first booted with BROKER_DB_PATH set')
    id2 = addChunk(db, 't2.md', 2000, 'the broker handled a request')
    id3 = addChunk(db, 't3.md', 3000, 'the broker restarted')
    id4 = addChunk(db, 't4.md', 4000, 'the broker is healthy now')
    idIdx = addChunk(db, 'idx.md', 5000, 'the indexer ran once')
    rebuildMemoryEdges(db)
    base = vi.fn(async () => SENTINEL)
  })
  afterEach(() => closeMemoryDb(db))

  it('fusion=false (and omitted) ⇒ unchanged base/binary path (regression-lock)', async () => {
    const off = await intentAwareSearch(db, 'broker', 5, base, { fusion: false })
    expect(off).toBe(SENTINEL) // enabled+semantic+fusion all off ⇒ pure pass-through
    // and the binary router is still reachable independently of the fusion lever
    base.mockClear()
    const binary = await intentAwareSearch(db, 'broker', 5, base, { enabled: true })
    expect(base).not.toHaveBeenCalled() // ENTITY route, not fusion
    expect(binary.map((r) => r.filePath)).toEqual(['t4.md', 't3.md', 't2.md', 't1.md'])
  })

  it('fusion=true with only a hybrid source ⇒ preserves hybrid order (never worse than today)', async () => {
    const hybridOut = [
      mk(901, 'a.md', 'alpha', 0.9),
      mk(902, 'b.md', 'beta', 0.5),
      mk(903, 'c.md', 'gamma', 0.1),
    ]
    const b = vi.fn(async () => hybridOut)
    const out = await intentAwareSearch(db, 'how do I configure logging levels', 3, b, {
      fusion: true,
    })
    // ids 901-903 are not real chunks ⇒ entity/semantic/temporal empty ⇒ hybrid order kept
    expect(out.map((r) => r.chunkId)).toEqual([901, 902, 903])
    expect(out[0]!.score).toBe(1) // normalised top = 1.0
    expect(out.every((r) => r.vectorScore === 0 && r.keywordScore === 0)).toBe(true) // fused score
    // fusion gathers a WIDER beam than topK (max(topK*4, 20)) so RRF has material to fuse
    expect(b).toHaveBeenCalledWith('how do I configure logging levels', 20)
  })

  it('THE FLAT-DUMP FIX: a relevant-in-hybrid entity chunk is pulled to the TOP, not left positional', async () => {
    // The live bug: an ENTITY query returns the entity neighborhood as a flat POSITIONAL dump,
    // newest-first, so the genuinely relevant chunk (t1, holding BROKER_DB_PATH) lands LAST.
    const binary = await intentAwareSearch(db, 'broker', 5, base, { enabled: true })
    expect(binary.map((r) => r.filePath)).toEqual(['t4.md', 't3.md', 't2.md', 't1.md'])
    expect(binary[binary.length - 1]!.filePath).toBe('t1.md') // relevant chunk is dead last

    // Fusion: hybrid ranks t1 #1 (it is what the query is about); entity contributes the broker
    // neighborhood; the chunk present in MULTIPLE subspaces (t1: hybrid+entity+temporal) wins.
    const hybrid = vi.fn(async () => [
      mk(id1, 't1.md', 'the broker first booted with BROKER_DB_PATH set', 0.95),
      mk(idIdx, 'idx.md', 'the indexer ran once', 0.4),
    ])
    const fused = await intentAwareSearch(db, 'broker', 5, hybrid, { fusion: true })
    expect(hybrid).toHaveBeenCalled() // fusion DOES consult the hybrid base (unlike binary ENTITY)
    expect(fused[0]!.filePath).toBe('t1.md') // relevance-ranked: BROKER_DB_PATH chunk now FIRST
    expect(fused[0]!.content).toContain('BROKER_DB_PATH')
    expect(fused[0]!.score).toBe(1)
    // no duplicate chunks despite t1 appearing in hybrid + entity + temporal
    const ids = fused.map((r) => r.chunkId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('fusion supersedes the binary router even when enabled=true', async () => {
    const hybrid = vi.fn(async () => [mk(id4, 't4.md', 'the broker is healthy now', 0.9)])
    const out = await intentAwareSearch(db, 'broker', 5, hybrid, { enabled: true, fusion: true })
    expect(hybrid).toHaveBeenCalled() // fusion path taken (binary ENTITY route never calls base)
    expect(out.length).toBeGreaterThan(0)
  })

  it('respects fusionWeights (zeroing entity ⇒ pure hybrid+temporal, no entity-only chunks)', async () => {
    // Only t1 is relevant in hybrid; with entity weight 0 the other broker chunks (entity-only)
    // must NOT appear — they have no hybrid/temporal-pool support of their own.
    const hybrid = vi.fn(async () => [mk(id1, 't1.md', 'broker boot', 0.9)])
    const out = await intentAwareSearch(db, 'broker', 5, hybrid, {
      fusion: true,
      fusionWeights: { entity: 0 },
    })
    expect(out.map((r) => r.chunkId)).toEqual([id1]) // entity neighbors excluded
    expect(out.some((r) => [id2, id3, id4].includes(r.chunkId))).toBe(false)
  })

  it('fusion folds the SEMANTIC tier in by relevance (2-hop association, not an appended slot)', async () => {
    // Wire a 2-hop semantic chain off the hybrid seed: id1 -> id2 -> idIdx.
    const addSem = (src: number, dst: number, w: number): void => {
      db.prepare(
        `INSERT INTO memory_edges (src_chunk, edge_type, dst_chunk, weight, source, confidence)
         VALUES (?, 'semantic', ?, ?, 'embedding', ?)`,
      ).run(src, dst, w, w)
    }
    addSem(id1, id2, 0.9)
    addSem(id2, idIdx, 0.8)
    const hybrid = vi.fn(async () => [mk(id1, 't1.md', 'broker boot', 0.9)])
    const out = await intentAwareSearch(db, 'broker', 10, hybrid, { fusion: true })
    // idIdx is reachable only at hop 2 from the seed; fusion includes it as a fused candidate
    expect(out.some((r) => r.chunkId === idIdx)).toBe(true)
    // and it ranks BELOW the seed (the directly-relevant hit), not above it
    const seedRank = out.findIndex((r) => r.chunkId === id1)
    const farRank = out.findIndex((r) => r.chunkId === idIdx)
    expect(seedRank).toBeGreaterThanOrEqual(0)
    expect(farRank).toBeGreaterThan(seedRank)
  })

  it('topK=0 ⇒ empty result', async () => {
    const out = await intentAwareSearch(db, 'broker', 0, base, { fusion: true })
    expect(out).toEqual([])
  })
})

describe('intentAwareSearch — relevance-ranked ENTITY route (entityRelevanceRank, default-OFF)', () => {
  let db: Database.Database
  let id1: number, idIdx: number
  let base: ReturnType<typeof vi.fn>
  function mk(chunkId: number, filePath: string, content: string, score: number): SearchResult {
    return { chunkId, filePath, content, score, vectorScore: score, keywordScore: 0, chunkIndex: 0 }
  }
  beforeEach(() => {
    db = openMemoryDb(':memory:')
    id1 = addChunk(db, 't1.md', 1000, 'the broker first booted with BROKER_DB_PATH set')
    addChunk(db, 't2.md', 2000, 'the broker handled a request')
    addChunk(db, 't3.md', 3000, 'the broker restarted')
    addChunk(db, 't4.md', 4000, 'the broker is healthy now')
    idIdx = addChunk(db, 'idx.md', 5000, 'the indexer ran once')
    rebuildMemoryEdges(db)
    base = vi.fn(async () => SENTINEL)
  })
  afterEach(() => closeMemoryDb(db))

  it('default OFF ⇒ binary ENTITY route stays a recency dump (relevant chunk last, base NOT called)', async () => {
    const out = await intentAwareSearch(db, 'broker', 5, base, { enabled: true })
    expect(base).not.toHaveBeenCalled()
    expect(out.map((r) => r.filePath)).toEqual(['t4.md', 't3.md', 't2.md', 't1.md'])
    expect(out[out.length - 1]!.filePath).toBe('t1.md') // the BROKER_DB_PATH chunk is dead last
  })

  it('entityRelevanceRank ⇒ consults hybrid base and pulls the relevant entity chunk to the TOP', async () => {
    const hybrid = vi.fn(async () => [
      mk(id1, 't1.md', 'the broker first booted with BROKER_DB_PATH set', 0.95),
      mk(idIdx, 'idx.md', 'the indexer ran once', 0.4),
    ])
    const out = await intentAwareSearch(db, 'broker', 5, hybrid, {
      enabled: true,
      entityRelevanceRank: true,
    })
    expect(hybrid).toHaveBeenCalled() // relevance route consults the base (binary ENTITY never does)
    expect(out[0]!.filePath).toBe('t1.md') // relevance-anchored: BROKER_DB_PATH chunk now FIRST
    expect(out[0]!.content).toContain('BROKER_DB_PATH')
    expect(out[0]!.score).toBe(1)
    const ids = out.map((r) => r.chunkId)
    expect(new Set(ids).size).toBe(ids.length) // no dupes despite hybrid⊕entity overlap
  })

  it('WHEN routing is unaffected by entityRelevanceRank (still chronological)', async () => {
    const out = await intentAwareSearch(db, 'what happened to the broker recently', 5, base, {
      enabled: true,
      entityRelevanceRank: true,
    })
    expect(base).not.toHaveBeenCalled() // ENTITY-relevance only intercepts ENTITY, not WHEN
    expect(out.map((r) => r.filePath)).toEqual(['t1.md', 't2.md', 't3.md', 't4.md']) // oldest-first
  })
})

describe('intentAwareSearch — fusion semantic source relevance ranking (item 6, default-preserving)', () => {
  let db: Database.Database
  let S: number, F1: number, F2: number

  function addSem(src: number, dst: number, weight: number): void {
    db.prepare(
      `INSERT INTO memory_edges (src_chunk, edge_type, dst_chunk, weight, source, confidence)
       VALUES (?, 'semantic', ?, ?, 'embedding', ?)`,
    ).run(src, dst, weight, weight)
  }

  // Hybrid returns ONLY the seed; the two competing 2-hop facts enter the fusion exclusively via
  // the semantic source, so the semantic ORDER alone decides whether F1 or F2 ranks higher.
  // entity+temporal are zeroed to isolate the effect (temporal recency would otherwise co-rank
  // F2>F1 by mtime and mask the re-ranking).
  beforeEach(() => {
    db = openMemoryDb(':memory:')
    S = addChunk(db, 'seed.md', 1000, 'the seed result content')
    const M = addChunk(db, 'mid.md', 2000, 'a one-hop bridge chunk')
    F1 = addChunk(db, 'f1.md', 3000, 'FACT_ONE weak-edge but query-relevant')
    F2 = addChunk(db, 'f2.md', 4000, 'FACT_TWO strong-edge but tangential')
    addSem(S, M, 0.9) // seed -> bridge
    addSem(M, F1, 0.6) // bridge -> weak-edge 2-hop fact
    addSem(M, F2, 0.9) // bridge -> strong-edge 2-hop fact
  })
  afterEach(() => closeMemoryDb(db))

  function hybridSeedOnly(): ReturnType<typeof vi.fn> {
    return vi.fn(async () => [
      {
        chunkId: S,
        filePath: 'seed.md',
        content: 'the seed result content',
        score: 0.9,
        vectorScore: 0.9,
        keywordScore: 0,
        chunkIndex: 0,
      },
    ])
  }

  it('without a scorer ⇒ fusion semantic source keeps GRAPH order (strong-edge F2 outranks F1)', async () => {
    const out = await intentAwareSearch(db, 'broker config', 10, hybridSeedOnly(), {
      fusion: true,
      fusionWeights: { entity: 0, temporal: 0 },
    })
    const iF1 = out.findIndex((r) => r.chunkId === F1)
    const iF2 = out.findIndex((r) => r.chunkId === F2)
    expect(iF1).toBeGreaterThanOrEqual(0)
    expect(iF2).toBeGreaterThanOrEqual(0)
    expect(iF2).toBeLessThan(iF1) // strong-edge F2 ranks ABOVE weak-edge F1 (today's behavior)
  })

  it('with a relevance scorer ⇒ fusion semantic source is RELEVANCE-ranked (query-relevant F1 overtakes F2)', async () => {
    // scorer ranks the weak-edge F1 well above the strong-edge F2 (the item-2 cosine signal)
    const scorer = vi.fn(async (ids: readonly number[]) => {
      const m = new Map<number, number>()
      for (const id of ids) m.set(id, id === F1 ? 0.95 : 0.3)
      return m
    })
    const out = await intentAwareSearch(db, 'broker config', 10, hybridSeedOnly(), {
      fusion: true,
      fusionWeights: { entity: 0, temporal: 0 },
      semanticRelevance: scorer,
    })
    expect(scorer).toHaveBeenCalled() // fusion DOES consult the injected scorer
    const iF1 = out.findIndex((r) => r.chunkId === F1)
    const iF2 = out.findIndex((r) => r.chunkId === F2)
    expect(iF1).toBeGreaterThanOrEqual(0)
    expect(iF2).toBeGreaterThanOrEqual(0)
    expect(iF1).toBeLessThan(iF2) // THE FLIP: relevance promoted F1 above the strong-edge F2
  })

  it('a scorer that throws ⇒ falls back to graph order (search never breaks)', async () => {
    const scorer = vi.fn(async () => {
      throw new Error('cold embedding worker')
    })
    const out = await intentAwareSearch(db, 'broker config', 10, hybridSeedOnly(), {
      fusion: true,
      fusionWeights: { entity: 0, temporal: 0 },
      semanticRelevance: scorer,
    })
    const iF1 = out.findIndex((r) => r.chunkId === F1)
    const iF2 = out.findIndex((r) => r.chunkId === F2)
    expect(out.some((r) => r.chunkId === S)).toBe(true) // seed retained
    expect(iF2).toBeLessThan(iF1) // graph-order fallback: strong-edge F2 above F1
  })
})

describe('intentAwareSearch — semantic 2-hop relevance hardening (default-OFF)', () => {
  let db: Database.Database
  let S: number, M: number, F1: number, F2: number
  let base: ReturnType<typeof vi.fn>

  function addSem(src: number, dst: number, weight: number): void {
    db.prepare(
      `INSERT INTO memory_edges (src_chunk, edge_type, dst_chunk, weight, source, confidence)
       VALUES (?, 'semantic', ?, ?, 'embedding', ?)`,
    ).run(src, dst, weight, weight)
  }

  beforeEach(() => {
    db = openMemoryDb(':memory:')
    S = addChunk(db, 'seed.md', 1000, 'the seed result content')
    M = addChunk(db, 'mid.md', 2000, 'a one-hop bridge chunk')
    // two competing 2-hop facts reached via the same bridge, with DIFFERENT edge weights
    F1 = addChunk(db, 'f1.md', 3000, 'FACT_ONE weak-edge but query-relevant')
    F2 = addChunk(db, 'f2.md', 4000, 'FACT_TWO strong-edge but tangential')
    addSem(S, M, 0.9) // seed -> bridge
    addSem(M, F1, 0.6) // bridge -> weak-edge 2-hop fact
    addSem(M, F2, 0.9) // bridge -> strong-edge 2-hop fact
    base = vi.fn(async () => [
      {
        chunkId: S,
        filePath: 'seed.md',
        content: 'the seed result content',
        score: 0.5,
        vectorScore: 0.5,
        keywordScore: 0,
        chunkIndex: 0,
      },
    ])
  })
  afterEach(() => closeMemoryDb(db))

  it('without a scorer ⇒ edge-weight order (strong-edge F2 injected); unchanged from today', async () => {
    const out = await intentAwareSearch(db, 'neutral query', 5, base, { semantic: true })
    expect(out.some((r) => r.chunkId === F2)).toBe(true) // strongest edge wins by default
    expect(out.some((r) => r.chunkId === F1)).toBe(false)
  })

  it('with a relevance scorer ⇒ injects the MOST query-relevant candidate, not the strongest-edge one', async () => {
    // scorer ranks the weak-edge F1 above the strong-edge F2 (the hardening signal)
    const scorer = vi.fn(async (ids: readonly number[]) => {
      const m = new Map<number, number>()
      for (const id of ids) m.set(id, id === F1 ? 0.95 : 0.3)
      return m
    })
    const out = await intentAwareSearch(db, 'neutral query', 5, base, {
      semantic: true,
      semanticRelevance: scorer,
    })
    expect(scorer).toHaveBeenCalled()
    expect(out.some((r) => r.chunkId === F1)).toBe(true) // relevance promoted F1
    expect(out.some((r) => r.chunkId === F2)).toBe(false)
  })

  it('minSemanticWeight gates weak edges before injection', async () => {
    // 0.7 drops F1 (edge 0.6); even a scorer favouring F1 cannot resurrect a gated candidate
    const scorer = vi.fn(
      async (ids: readonly number[]) => new Map(ids.map((id) => [id, id === F1 ? 1 : 0])),
    )
    const out = await intentAwareSearch(db, 'neutral query', 5, base, {
      semantic: true,
      minSemanticWeight: 0.7,
      semanticRelevance: scorer,
    })
    expect(out.some((r) => r.chunkId === F1)).toBe(false) // gated out
    expect(out.some((r) => r.chunkId === F2)).toBe(true) // survives the gate
  })

  it('a scorer that rejects ⇒ falls back to edge-weight order (search never breaks)', async () => {
    const scorer = vi.fn(async () => {
      throw new Error('cold embedding worker')
    })
    const out = await intentAwareSearch(db, 'neutral query', 5, base, {
      semantic: true,
      semanticRelevance: scorer,
    })
    expect(out.some((r) => r.chunkId === S)).toBe(true) // base retained
    expect(out.some((r) => r.chunkId === F2)).toBe(true) // weight-order fallback injected F2
  })
})

describe('intentAwareSearch — WHEN temporal timeline (no-entity, default-OFF)', () => {
  let db: Database.Database
  let n1: number, n2: number, n3: number
  let base: ReturnType<typeof vi.fn>

  beforeEach(() => {
    db = openMemoryDb(':memory:')
    // three NON-entity chunks across time (no gazetteer term ⇒ a WHEN query stays unanchored)
    n1 = addChunk(db, 'log1.md', 1000, 'first thing we shipped')
    n2 = addChunk(db, 'log2.md', 2000, 'second thing we shipped')
    n3 = addChunk(db, 'log3.md', 3000, 'third thing we shipped')
    // base returns them in a NON-chronological relevance order
    base = vi.fn(async () => [
      {
        chunkId: n2,
        filePath: 'log2.md',
        content: 'second thing we shipped',
        score: 0.9,
        vectorScore: 0.9,
        keywordScore: 0,
        chunkIndex: 0,
      },
      {
        chunkId: n1,
        filePath: 'log1.md',
        content: 'first thing we shipped',
        score: 0.6,
        vectorScore: 0.6,
        keywordScore: 0,
        chunkIndex: 0,
      },
      {
        chunkId: n3,
        filePath: 'log3.md',
        content: 'third thing we shipped',
        score: 0.3,
        vectorScore: 0.3,
        keywordScore: 0,
        chunkIndex: 0,
      },
    ])
  })
  afterEach(() => closeMemoryDb(db))

  it('timeline OFF (default) ⇒ no-entity WHEN falls back to baseSearch (regression-lock)', async () => {
    const out = await intentAwareSearch(db, 'what happened recently', 5, base, { enabled: true })
    // base relevance order preserved (NOT reordered)
    expect(out.map((r) => r.chunkId)).toEqual([n2, n1, n3])
  })

  it('timeline ON ⇒ no-entity WHEN returns a CHRONOLOGICAL timeline (oldest-first), not relevance order', async () => {
    const out = await intentAwareSearch(db, 'what happened recently', 5, base, {
      enabled: true,
      timeline: true,
    })
    expect(base).toHaveBeenCalled() // the timeline draws from the relevance pool
    expect(out.map((r) => r.chunkId)).toEqual([n1, n2, n3]) // mtime ascending, NOT [n2,n1,n3]
    expect(out[0]!.score).toBe(1) // positional chronological score, top = 1.0
  })

  it('timeline ON but the WHEN query names an entity ⇒ entity-neighborhood, not the timeline', async () => {
    const bId = addChunk(db, 'brk.md', 5000, 'the broker started up')
    rebuildMemoryEdges(db)
    const out = await intentAwareSearch(db, 'when did the broker run', 5, base, {
      enabled: true,
      timeline: true,
    })
    expect(base).not.toHaveBeenCalled() // entity route, base never consulted
    expect(out.map((r) => r.chunkId)).toEqual([bId])
  })

  it('timeline ON ⇒ DEFAULT-intent (non-WHEN) query is unaffected', async () => {
    const out = await intentAwareSearch(db, 'configure the logging level', 5, base, {
      enabled: true,
      timeline: true,
    })
    // DEFAULT intent ⇒ pass-through to baseSearch (relevance order), timeline not triggered
    expect(out.map((r) => r.chunkId)).toEqual([n2, n1, n3])
  })
})

describe('parseFusionWeights — SCNS_FUSION_WEIGHTS env parsing (default-preserving)', () => {
  it('undefined / empty / whitespace ⇒ undefined (defaults unchanged)', () => {
    expect(parseFusionWeights(undefined)).toBeUndefined()
    expect(parseFusionWeights('')).toBeUndefined()
    expect(parseFusionWeights('   ')).toBeUndefined()
  })

  it('parses the four recognised keys (a 0 weight is honoured as "disable")', () => {
    expect(parseFusionWeights('hybrid=1,entity=0.5,semantic=0.8,temporal=0')).toEqual({
      hybrid: 1,
      entity: 0.5,
      semantic: 0.8,
      temporal: 0,
    })
  })

  it('ignores unknown keys, malformed pairs, and negative/non-finite values', () => {
    expect(parseFusionWeights('entity=0.5,bogus=9,hybrid=,temporal=-1,semantic=abc')).toEqual({
      entity: 0.5,
    })
  })

  it('yields undefined when nothing valid parses (defaults unchanged)', () => {
    expect(parseFusionWeights('bogus=1,temporal=-2')).toBeUndefined()
  })

  it('tolerates surrounding whitespace around keys and values', () => {
    expect(parseFusionWeights(' hybrid = 1 , semantic = 0.25 ')).toEqual({
      hybrid: 1,
      semantic: 0.25,
    })
  })

  it('a parsed override flows through fusion to change the result (env→behavior)', async () => {
    const db = openMemoryDb(':memory:')
    try {
      const e1 = addChunk(db, 't1.md', 1000, 'the broker first booted')
      addChunk(db, 't2.md', 2000, 'the broker handled a request')
      addChunk(db, 't3.md', 3000, 'the broker restarted')
      rebuildMemoryEdges(db)
      const hybrid = vi.fn(async () => [
        {
          chunkId: e1,
          filePath: 't1.md',
          content: 'broker boot',
          score: 0.9,
          vectorScore: 0.9,
          keywordScore: 0,
          chunkIndex: 0,
        },
      ])
      // SCNS_FUSION_WEIGHTS="entity=0" ⇒ entity neighbors excluded (only the hybrid hit survives)
      const weights = parseFusionWeights('entity=0,temporal=0')
      const out = await intentAwareSearch(db, 'broker', 5, hybrid, {
        fusion: true,
        fusionWeights: weights,
      })
      expect(out.map((r) => r.chunkId)).toEqual([e1])
    } finally {
      closeMemoryDb(db)
    }
  })
})

// A-div2 QUERY-SIDE: a LEARNED (App-C.1, non-gazetteer) entity becomes name-queryable end-to-end
// only when opted in (SCNS_LEARNED_ENTITY_QUERY). Deterministic — no ACP, no embeddings.
describe('intentAwareSearch — learned entity query (A-div2, default-OFF)', () => {
  let db: Database.Database
  let base: ReturnType<typeof vi.fn>

  function addLearnedEventNode(
    file: string,
    chunkIndex: number,
    tau: string,
    content: string,
    entities: readonly string[],
  ): number {
    db.prepare(
      'INSERT OR IGNORE INTO vault_files (path, mtime_ms, size_bytes) VALUES (?, 0, ?)',
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

  beforeEach(() => {
    db = openMemoryDb(':memory:')
    // 'melanie' — a LEARNED entity (not in SCNS_GAZETTEER) — on two conversation event nodes.
    addLearnedEventNode(
      'event-nodes/s1.md',
      0,
      '2026-01-01T00:00:00Z',
      'Melanie plays the violin',
      ['melanie'],
    )
    addLearnedEventNode(
      'event-nodes/s2.md',
      1,
      '2026-01-02T00:00:00Z',
      'Melanie rehearses weekly',
      ['melanie'],
    )
    rebuildMemoryEdges(db)
    base = vi.fn(async () => SENTINEL)
  })
  afterEach(() => closeMemoryDb(db))

  it('POSITIVE (fusion): flag ON ⇒ a learned name contributes its entity neighborhood to the fusion', async () => {
    const hybrid = vi.fn(async () => SENTINEL) // hybrid holds no melanie chunk
    const out = await intentAwareSearch(db, 'what does melanie play', 5, hybrid, {
      fusion: true,
      learnedEntityQuery: true,
    })
    const files = out.map((r) => r.filePath)
    // melanie's chunk is reached BY NAME through the entity source, not from hybrid
    expect(files).toContain('event-nodes/s1.md')
  })

  it('NEGATIVE / regression (fusion): flag OFF ⇒ learned name unresolved ⇒ hybrid-only (unchanged)', async () => {
    const hybrid = vi.fn(async () => SENTINEL)
    const out = await intentAwareSearch(db, 'what does melanie play', 5, hybrid, { fusion: true })
    expect(out.map((r) => r.chunkId)).toEqual([999]) // only the hybrid SENTINEL chunk; no melanie
  })

  it('POSITIVE (binary router): flag ON makes classifyIntent learned-aware ⇒ ENTITY route resolves her', async () => {
    const out = await intentAwareSearch(db, 'tell me about melanie', 5, base, {
      enabled: true,
      learnedEntityQuery: true,
    })
    expect(base).not.toHaveBeenCalled() // ENTITY route taken, not the DEFAULT base fallback
    const files = out.map((r) => r.filePath)
    expect(new Set(files)).toEqual(new Set(['event-nodes/s1.md', 'event-nodes/s2.md']))
  })

  it('NEGATIVE / regression (binary router): flag OFF ⇒ learned-only query classifies DEFAULT ⇒ base', async () => {
    const out = await intentAwareSearch(db, 'tell me about melanie', 5, base, { enabled: true })
    expect(base).toHaveBeenCalled() // gazetteer sees no entity ⇒ DEFAULT ⇒ hybrid base
    expect(out).toBe(SENTINEL)
  })

  it('POSITIVE (WHY): flag ON resolves a learned entity for the causal route', async () => {
    addCausal(
      db,
      'work stress',
      'melanie left the ensemble',
      'melanie',
      0.9,
      'work stress led her to leave',
    )
    const out = await intentAwareSearch(db, 'why did melanie leave', 5, base, {
      enabled: true,
      learnedEntityQuery: true,
    })
    expect(base).not.toHaveBeenCalled()
    expect(out.length).toBeGreaterThan(0)
    expect(out[0]!.content).toContain('work stress') // the causal chain surfaced
  })

  it('NEGATIVE / regression (WHY): flag OFF ⇒ learned entity unresolved ⇒ falls back to base', async () => {
    addCausal(
      db,
      'work stress',
      'melanie left the ensemble',
      'melanie',
      0.9,
      'work stress led her to leave',
    )
    const out = await intentAwareSearch(db, 'why did melanie leave', 5, base, { enabled: true })
    expect(out).toBe(SENTINEL) // WHY route empty (melanie unresolved) ⇒ base fallback
  })
})

describe('intentAwareSearch — multiHop iterative arm (C2, default-OFF)', () => {
  let db: Database.Database
  beforeEach(() => {
    db = openMemoryDb(':memory:')
  })
  afterEach(() => closeMemoryDb(db))

  /** c1 (anchor) shares entity Bob with c2 (the bridge target only a follow-up query can reach). */
  function bridgeFixture(): { c1: number; c2: number } {
    const c1 = addChunk(db, 'a.md', 1000, 'Mel talked to Bob about the trip')
    const c2 = addChunk(db, 'b.md', 1001, 'Bob organized the Yosemite trip')
    const bob = db
      .prepare(`INSERT INTO memory_entities (name, kind) VALUES ('Bob', 'concept')`)
      .run().lastInsertRowid as number
    for (const c of [c1, c2])
      db.prepare(
        `INSERT INTO memory_edges (src_chunk, edge_type, dst_entity, source) VALUES (?, 'entity', ?, 'gazetteer')`,
      ).run(c, bob)
    return { c1, c2 }
  }
  const mk = (id: number): SearchResult => ({
    chunkId: id,
    filePath: `${id}.md`,
    content: 'x',
    score: 1,
    vectorScore: 0,
    keywordScore: 0,
    chunkIndex: 0,
  })

  it('multiHop:true dispatches the iterative loop (issues follow-up queries; reaches the bridge chunk)', async () => {
    const { c1, c2 } = bridgeFixture()
    const q = 'What trip did Mel discuss?'
    const calls: string[] = []
    const base = async (qq: string, k: number): Promise<readonly SearchResult[]> => {
      calls.push(qq)
      if (qq === q) return [mk(c1)].slice(0, k)
      if (qq === `Bob ${q}`) return [mk(c2)].slice(0, k)
      return []
    }
    const out = await intentAwareSearch(db, q, 5, base, {
      multiHop: true,
      multiHopOptions: { innerSearch: 'base' },
    })
    expect(calls).toContain(`Bob ${q}`) // the iterative loop actually re-queried
    expect(out.map((r) => r.chunkId)).toContain(c2)
  })

  it('multiHop supersedes traverse when both are on (a distinct arm, not a beam variant)', async () => {
    const { c1, c2 } = bridgeFixture()
    const q = 'What trip did Mel discuss?'
    const calls: string[] = []
    const base = async (qq: string, _k: number): Promise<readonly SearchResult[]> => {
      calls.push(qq)
      return qq === `Bob ${q}` ? [mk(c2)] : qq === q ? [mk(c1)] : []
    }
    await intentAwareSearch(db, q, 5, base, {
      multiHop: true,
      traverse: true,
      multiHopOptions: { innerSearch: 'base' },
    })
    // The multiHop loop issues follow-up queries; the Alg-1 beam never rewrites the query string.
    expect(calls).toContain(`Bob ${q}`)
  })

  it('all levers OFF ⇒ exactly baseSearch (multiHop participates in the fast-path gate)', async () => {
    const base = async (): Promise<readonly SearchResult[]> => SENTINEL
    const out = await intentAwareSearch(db, 'q', 5, base, { multiHop: false })
    expect(out).toBe(SENTINEL)
  })
})
