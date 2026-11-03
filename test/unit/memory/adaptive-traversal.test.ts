import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openMemoryDb, closeMemoryDb } from '../../../src/memory/db.js'
import { adaptiveTraversalSearch } from '../../../src/memory/adaptive-traversal.js'
import {
  persistCausalEdges,
  materializeCausalEdges,
  causalKey,
} from '../../../src/memory/causal-edges.js'
import type { SearchResult } from '../../../src/memory/search.js'
import type { GazetteerEntry } from '../../../src/memory/entities/gazetteer.js'
import type Database from 'better-sqlite3'

// ── MAGMA Algorithm 1 (Heuristic Beam Search) — the LITERAL Eq-5/Eq-6 transition + Table-6 hyperparams.
// Eq 5 : S(nj|ni,q) = exp( λ1·φ(type(eij),Tq) + λ2·sim(⃗nj,q⃗) )        (§3.3 Stage 3)
// Eq 6 : φ(r,Tq)    = wTq⊤ · 1r                                          (intent weight × one-hot edge type)
// Alg 1: L11 suv = exp(λ1(wTq⊤·1euv)+λ2 sim(v,q)) ; L12 scorev = scoreu·γ + suv ;
//        L17 frontier ← TopK(BeamWidth) ; L19 break if Visited ≥ Budget.
// Table 6: MaxDepth 5, MaxNodes 200, DropThreshold 0.15, λ1 1.0, λ2 0.3–0.7, wentity 2.5–6, wcausal 3–5.
// DropThreshold 0.15 = a RELATIVE per-hop cosine drop (OSS memory/query_engine.py _adaptive_graph_traversal:
//   relative_drop_threshold=0.15 (:1104); prune when parent_sim − child_sim > 0.15 (:1158, :1189-1192), on
//   cosine(query,node)) — NOT a gate on the raw exp score (which with wcausal 3–5 is always ≫0.15).

let seq = 0
function addChunk(db: Database.Database, content: string): number {
  const path = `f${seq}.md`
  db.prepare('INSERT INTO vault_files (path, mtime_ms, size_bytes) VALUES (?, ?, ?)').run(
    path,
    1000 + seq++,
    content.length,
  )
  return db
    .prepare(
      `INSERT INTO chunks (file_path, chunk_index, content, start_offset, end_offset, token_count) VALUES (?, 0, ?, 0, ?, 1)`,
    )
    .run(path, content, content.length).lastInsertRowid as number
}
function addEntity(db: Database.Database, name: string): number {
  return db.prepare(`INSERT INTO memory_entities (name, kind) VALUES (?, 'concept')`).run(name)
    .lastInsertRowid as number
}
function linkEntity(db: Database.Database, chunk: number, entity: number): void {
  db.prepare(
    `INSERT INTO memory_edges (src_chunk, edge_type, dst_entity, source) VALUES (?, 'entity', ?, 'gazetteer')`,
  ).run(chunk, entity)
}
/** A directed typed chunk→chunk edge (temporal/semantic/causal) for chain/depth tests. */
function linkChunk(
  db: Database.Database,
  src: number,
  dst: number,
  type: 'temporal' | 'semantic' | 'causal',
): void {
  db.prepare(
    `INSERT INTO memory_edges (src_chunk, edge_type, dst_chunk, source) VALUES (?, ?, ?, 'test')`,
  ).run(src, type, dst)
}
const result = (chunkId: number): SearchResult => ({
  chunkId,
  filePath: `f${chunkId}.md`,
  content: '',
  score: 1,
  chunkIndex: 0,
})
const GAZ: readonly GazetteerEntry[] = [{ canonical: 'Mel', kind: 'concept', aliases: ['mel'] }]
/** Deterministic injected cosine(query,node) scorer from an explicit table (default 0). */
const simFrom = (table: Record<number, number>) => (ids: readonly number[]) =>
  new Map(ids.map((id) => [id, table[id] ?? 0]))

describe('adaptiveTraversalSearch — Eq-5 exp transition + structural lift (MAGMA Alg 1)', () => {
  let db: Database.Database
  beforeEach(() => {
    db = openMemoryDb(':memory:')
    seq = 0
  })
  afterEach(() => closeMemoryDb(db))

  it('POS: exp(λ1·φ+λ2·sim) lifts a buried entity-sibling (gentle cosine drop) above a same-relevance distractor', async () => {
    const easy = addChunk(db, 'Mel plays clarinet') // strong anchor
    const buried = addChunk(db, 'Mel quiet evening violin') // NOT directly retrievable; shares entity Mel
    const distract = addChunk(db, 'someone unrelated') // anchor, comparable cosine, no shared entity
    const mel = addEntity(db, 'Mel')
    linkEntity(db, easy, mel)
    linkEntity(db, buried, mel)
    const base = async (_q: string, k: number) => [result(easy), result(distract)].slice(0, k)
    // Faithful sims: buried's cosine (0.50) is within DropThreshold 0.15 of its parent easy (0.60) ⇒ reachable.
    const sim = simFrom({ [easy]: 0.6, [distract]: 0.45, [buried]: 0.5 })
    const out = await adaptiveTraversalSearch(db, 'Mel instruments', 3, base, {
      gazetteer: GAZ,
      semanticRelevance: sim,
    })
    const ids = out.map((r) => r.chunkId)
    expect(ids).toContain(buried) // reached via the entity edge; exp(λ1·wentity) lifts it
    expect(ids.indexOf(buried)).toBeLessThan(ids.indexOf(distract)) // structural alignment beats the distractor
    expect(
      out.every((r) => typeof r.vectorScore === 'number' && typeof r.keywordScore === 'number'),
    ).toBe(true)
  })

  it('does not contaminate across entities — a different entity neighbor is not pulled in', async () => {
    const aChunk = addChunk(db, 'Mel clarinet')
    const aBuried = addChunk(db, 'Mel violin')
    const bChunk = addChunk(db, 'Bob guitar')
    const bBuried = addChunk(db, 'Bob diving')
    const mel = addEntity(db, 'Mel')
    const bob = addEntity(db, 'Bob')
    linkEntity(db, aChunk, mel)
    linkEntity(db, aBuried, mel)
    linkEntity(db, bChunk, bob)
    linkEntity(db, bBuried, bob)
    const base = async (_q: string, k: number) => [result(aChunk), result(bChunk)].slice(0, k)
    // Mel's buried has a gentle drop (reachable); Bob's buried is a cosine cliff (0.60→0.05) ⇒ drop-pruned.
    const sim = simFrom({ [aChunk]: 0.6, [aBuried]: 0.5, [bChunk]: 0.25, [bBuried]: 0.05 })
    const out = await adaptiveTraversalSearch(db, 'Mel instruments', 2, base, {
      gazetteer: GAZ,
      semanticRelevance: sim,
    })
    const ids = out.map((r) => r.chunkId)
    expect(ids).toContain(aBuried)
    if (ids.includes(bBuried)) expect(ids.indexOf(aBuried)).toBeLessThan(ids.indexOf(bBuried))
  })

  it('falls back to anchors when there are no edges to traverse', async () => {
    const a = addChunk(db, 'one')
    const b = addChunk(db, 'two')
    const base = async (_q: string, k: number) => [result(a), result(b)].slice(0, k)
    const out = await adaptiveTraversalSearch(db, 'q', 2, base, {
      gazetteer: GAZ,
      semanticRelevance: simFrom({ [a]: 0.5, [b]: 0.4 }),
    })
    expect(out.map((r) => r.chunkId).sort()).toEqual([a, b].sort())
  })

  it('returns [] for empty anchors and topK<=0', async () => {
    const base = async () => []
    expect(
      await adaptiveTraversalSearch(db, 'q', 3, base, { semanticRelevance: simFrom({}) }),
    ).toEqual([])
    const base2 = async () => [result(addChunk(db, 'x'))]
    expect(
      await adaptiveTraversalSearch(db, 'q', 0, base2, { semanticRelevance: simFrom({}) }),
    ).toEqual([])
  })

  it('is deterministic across repeated runs', async () => {
    const easy = addChunk(db, 'Mel clarinet')
    const buried = addChunk(db, 'Mel violin')
    const d = addChunk(db, 'noise')
    const mel = addEntity(db, 'Mel')
    linkEntity(db, easy, mel)
    linkEntity(db, buried, mel)
    const base = async (_q: string, k: number) => [result(easy), result(d)].slice(0, k)
    const sim = simFrom({ [easy]: 0.6, [d]: 0.3, [buried]: 0.5 })
    const run = () =>
      adaptiveTraversalSearch(db, 'Mel instruments', 3, base, {
        gazetteer: GAZ,
        semanticRelevance: sim,
      })
    expect((await run()).map((r) => r.chunkId)).toEqual((await run()).map((r) => r.chunkId))
  })
})

describe('adaptiveTraversalSearch — DropThreshold 0.15 relative cosine-drop prune (Table 6 / OSS query_engine.py:1104)', () => {
  let db: Database.Database
  beforeEach(() => {
    db = openMemoryDb(':memory:')
    seq = 0
  })
  afterEach(() => closeMemoryDb(db))

  // Anchor A (cosine 0.60) with two entity-siblings: KEPT (0.50 ⇒ drop 0.10 ≤ 0.15) and DROPPED
  // (0.42 ⇒ drop 0.18 > 0.15). maxDepth 1 so the dropped node cannot be rescued via a second gentle hop.
  // Both share entity Mel with A, so absent the drop gate BOTH would be reached (exp(λ1·wentity) is huge for
  // each) — proving the prune, not the graph, removes the dropped node (not a silent no-op, not a beam-nuke).
  function seedDrop(): {
    anchor: number
    kept: number
    dropped: number
    base: (q: string, k: number) => Promise<readonly SearchResult[]>
  } {
    const anchor = addChunk(db, 'Mel clarinet recital')
    const kept = addChunk(db, 'Mel evening violin practice')
    const dropped = addChunk(db, 'Mel distant unrelated tangent')
    const mel = addEntity(db, 'Mel')
    linkEntity(db, anchor, mel)
    linkEntity(db, kept, mel)
    linkEntity(db, dropped, mel)
    const base = async (_q: string, k: number) => [result(anchor)].slice(0, k)
    return { anchor, kept, dropped, base }
  }
  const ENTITY_ONLY = {
    ENTITY: { entity: 6, semantic: 0, temporal: 0, causal: 0 },
    WHY: { entity: 6, semantic: 0, temporal: 0, causal: 0 },
    WHEN: { entity: 6, semantic: 0, temporal: 0, causal: 0 },
    DEFAULT: { entity: 6, semantic: 0, temporal: 0, causal: 0 },
  } as const

  it('POS: prunes the neighbor whose cosine dropped > 0.15 and KEEPS the one that dropped ≤ 0.15', async () => {
    const { anchor, kept, dropped, base } = seedDrop()
    const sim = simFrom({ [anchor]: 0.6, [kept]: 0.5, [dropped]: 0.42 })
    const out = await adaptiveTraversalSearch(db, 'Mel instruments', 5, base, {
      intentWeights: ENTITY_ONLY,
      semanticRelevance: sim,
      maxDepth: 1,
      dropThreshold: 0.15,
    })
    const ids = out.map((r) => r.chunkId)
    expect(ids).toContain(kept) // drop 0.10 ≤ 0.15 ⇒ traversed
    expect(ids).not.toContain(dropped) // drop 0.18 > 0.15 ⇒ pruned by the relative-drop gate
  })

  it('NEG: raising dropThreshold above 0.18 lets the SAME neighbor through (proves the gate, not the graph)', async () => {
    const { anchor, kept, dropped, base } = seedDrop()
    const sim = simFrom({ [anchor]: 0.6, [kept]: 0.5, [dropped]: 0.42 })
    const out = await adaptiveTraversalSearch(db, 'Mel instruments', 5, base, {
      intentWeights: ENTITY_ONLY,
      semanticRelevance: sim,
      maxDepth: 1,
      dropThreshold: 0.25,
    })
    expect(out.map((r) => r.chunkId)).toContain(dropped) // drop 0.18 ≤ 0.25 ⇒ now kept
  })
})

describe('adaptiveTraversalSearch — MaxDepth / Budget bounds (Alg 1 L19 / Table 6)', () => {
  let db: Database.Database
  beforeEach(() => {
    db = openMemoryDb(':memory:')
    seq = 0
  })
  afterEach(() => closeMemoryDb(db))

  const TEMPORAL_ONLY = {
    ENTITY: { entity: 0, semantic: 0, temporal: 4, causal: 0 },
    WHY: { entity: 0, semantic: 0, temporal: 4, causal: 0 },
    WHEN: { entity: 0, semantic: 0, temporal: 4, causal: 0 },
    DEFAULT: { entity: 0, semantic: 0, temporal: 4, causal: 0 },
  } as const

  it('maxDepth bounds the hop count: a depth-2 node is unreached at maxDepth 1, reached at maxDepth 2', async () => {
    const a = addChunk(db, 'anchor event alpha')
    const b = addChunk(db, 'second event beta')
    const c = addChunk(db, 'third event gamma')
    linkChunk(db, a, b, 'temporal')
    linkChunk(db, b, c, 'temporal') // a→b→c chain, gentle cosine drops
    const base = async (_q: string, k: number) => [result(a)].slice(0, k)
    const sim = simFrom({ [a]: 0.6, [b]: 0.5, [c]: 0.42 })
    const d1 = await adaptiveTraversalSearch(db, 'q', 5, base, {
      intentWeights: TEMPORAL_ONLY,
      semanticRelevance: sim,
      maxDepth: 1,
    })
    expect(d1.map((r) => r.chunkId)).not.toContain(c)
    const d2 = await adaptiveTraversalSearch(db, 'q', 5, base, {
      intentWeights: TEMPORAL_ONLY,
      semanticRelevance: sim,
      maxDepth: 2,
    })
    expect(d2.map((r) => r.chunkId)).toContain(c)
  })

  it('budget halts expansion: with budget 1 only the anchor is returned (no traversal)', async () => {
    const a = addChunk(db, 'anchor')
    const b = addChunk(db, 'neighbor')
    linkChunk(db, a, b, 'temporal')
    const base = async (_q: string, k: number) => [result(a)].slice(0, k)
    const sim = simFrom({ [a]: 0.6, [b]: 0.55 })
    const out = await adaptiveTraversalSearch(db, 'q', 5, base, {
      intentWeights: TEMPORAL_ONLY,
      semanticRelevance: sim,
      budget: 1,
    })
    expect(out.map((r) => r.chunkId)).toEqual([a])
  })
})

describe('adaptiveTraversalSearch — causal beam dimension (WS-2b write/read-split; faithful sims)', () => {
  let db: Database.Database
  beforeEach(() => {
    db = openMemoryDb(':memory:')
    seq = 0
  })
  afterEach(() => closeMemoryDb(db))

  const CAUSE = 'the broker quality-gate review passed on the branch'
  const EFFECT = 'the broker then auto-merged the branch to main'
  // Isolate the causal dimension: only causal edges carry weight.
  const CAUSAL_ONLY = {
    ENTITY: { entity: 0, semantic: 0, temporal: 0, causal: 4 },
    WHY: { entity: 0, semantic: 0, temporal: 0, causal: 4 },
    WHEN: { entity: 0, semantic: 0, temporal: 0, causal: 4 },
    DEFAULT: { entity: 0, semantic: 0, temporal: 0, causal: 4 },
  } as const

  function seed(): { cause: number; effect: number; distract: number } {
    const cause = addChunk(db, CAUSE)
    const effect = addChunk(db, EFFECT)
    const distract = addChunk(db, 'unrelated telemetry blob about spans and traces')
    persistCausalEdges(
      db,
      [{ causeKey: causalKey(CAUSE), effectKey: causalKey(EFFECT), confidence: 0.9 }],
      { minConfidence: 0.7, provider: 'mock' },
    )
    return { cause, effect, distract }
  }
  const anchorsEffectDistract =
    (effect: number, distract: number) => async (_q: string, k: number) =>
      [result(effect), result(distract)].slice(0, k)
  // Faithful sims: the cause's cosine (0.50) is a gentle drop from the effect anchor (0.60) — reachable under
  // DropThreshold 0.15 (a cosine cliff at 0.05 would be drop-pruned even with the causal edge present).
  const buryCause = (effect: number, cause: number, distract: number) =>
    simFrom({ [effect]: 0.6, [cause]: 0.5, [distract]: 0.3 })
  const WHY_Q = 'why did the broker auto-merge the branch'

  it('RED T030: admits a lower-cosine causal node for WHY when Eq-5 reaches it under tight topK', async () => {
    const anchors = [
      addChunk(db, 'hybrid anchor one about the journey'),
      addChunk(db, 'hybrid anchor two about the journey'),
      addChunk(db, 'hybrid anchor three about the journey'),
      addChunk(db, 'hybrid anchor four about the journey'),
      addChunk(db, 'hybrid anchor five about the journey'),
    ]
    const cause = addChunk(db, 'causal reason: the music collaboration inspired the Japan journey')
    linkChunk(db, anchors[0], cause, 'causal')
    const base = async (_q: string, k: number) => anchors.map(result).slice(0, k)
    const sim = simFrom({
      [anchors[0]]: 0.82,
      [anchors[1]]: 0.8,
      [anchors[2]]: 0.78,
      [anchors[3]]: 0.76,
      [anchors[4]]: 0.75,
      [cause]: 0.68, // lower than every anchor, but within DropThreshold of anchors[0]
    })

    const out = await adaptiveTraversalSearch(db, 'why was the Japan journey inspired', 5, base, {
      intentWeights: CAUSAL_ONLY,
      semanticRelevance: sim,
      maxDepth: 1,
    })
    const ids = out.map((r) => r.chunkId)
    expect(ids).toContain(cause)
    expect(ids).not.toEqual(anchors)
  })

  it('NEG T030: does not admit the lower-cosine causal candidate when the causal edge has zero intent weight', async () => {
    const anchors = [
      addChunk(db, 'hybrid anchor one about the journey'),
      addChunk(db, 'hybrid anchor two about the journey'),
      addChunk(db, 'hybrid anchor three about the journey'),
      addChunk(db, 'hybrid anchor four about the journey'),
      addChunk(db, 'hybrid anchor five about the journey'),
    ]
    const cause = addChunk(db, 'causal reason: the music collaboration inspired the Japan journey')
    linkChunk(db, anchors[0], cause, 'causal')
    const base = async (_q: string, k: number) => anchors.map(result).slice(0, k)
    const sim = simFrom({
      [anchors[0]]: 0.82,
      [anchors[1]]: 0.8,
      [anchors[2]]: 0.78,
      [anchors[3]]: 0.76,
      [anchors[4]]: 0.75,
      [cause]: 0.68,
    })
    const zeroCausal = {
      ENTITY: { entity: 0, semantic: 0, temporal: 0, causal: 0 },
      WHY: { entity: 0, semantic: 0, temporal: 0, causal: 0 },
      WHEN: { entity: 0, semantic: 0, temporal: 0, causal: 0 },
      DEFAULT: { entity: 0, semantic: 0, temporal: 0, causal: 0 },
    } as const

    const out = await adaptiveTraversalSearch(db, 'why was the Japan journey inspired', 5, base, {
      intentWeights: zeroCausal,
      semanticRelevance: sim,
      maxDepth: 1,
    })
    expect(out.map((r) => r.chunkId)).not.toContain(cause)
  })

  it('POS: bidirectional materialized causal edges let a WHY(effect)-anchored beam REACH the buried cause', async () => {
    const { cause, effect, distract } = seed()
    const stats = materializeCausalEdges(db) // default 'both'
    expect(stats.materialized).toBeGreaterThan(0)
    const out = await adaptiveTraversalSearch(
      db,
      WHY_Q,
      3,
      anchorsEffectDistract(effect, distract),
      {
        intentWeights: CAUSAL_ONLY,
        semanticRelevance: buryCause(effect, cause, distract),
      },
    )
    const ids = out.map((r) => r.chunkId)
    expect(ids).toContain(cause) // reached ONLY via the causal edge (all other edge weights are 0)
    expect(ids.indexOf(cause)).toBeLessThan(ids.indexOf(distract))
  })

  it('NEG: without materialization the same causal-only beam does NOT reach the cause', async () => {
    const { cause, effect, distract } = seed() // no materializeCausalEdges ⇒ no memory_edges(causal)
    const out = await adaptiveTraversalSearch(
      db,
      WHY_Q,
      3,
      anchorsEffectDistract(effect, distract),
      {
        intentWeights: CAUSAL_ONLY,
        semanticRelevance: buryCause(effect, cause, distract),
      },
    )
    expect(out.map((r) => r.chunkId)).not.toContain(cause)
  })

  it('DIRECTION: forward-only (cause→effect) does NOT let a WHY(effect) anchor reach the cause', async () => {
    const { cause, effect, distract } = seed()
    materializeCausalEdges(db, { direction: 'forward' })
    const out = await adaptiveTraversalSearch(
      db,
      WHY_Q,
      3,
      anchorsEffectDistract(effect, distract),
      {
        intentWeights: CAUSAL_ONLY,
        semanticRelevance: buryCause(effect, cause, distract),
      },
    )
    expect(out.map((r) => r.chunkId)).not.toContain(cause)
  })
})

// ── T027 — Briefing budget: serialize ALL of Visited (MAGMA Alg 1 lines 22-23), not a topK slice.
// Alg 1 L22-23: `Csorted ← TopologicalSort(Visited,Tq); return Serialize(Csorted)` — the WHOLE Visited
// subgraph flows to Stage-4 (Eq. 7), which then salience-token-budgets it. Today `adaptiveTraversalSearch`
// slices Visited to `topK` BEFORE Stage-4, forcing a 1-for-1 SWAP (drop an anchor to admit one causal node)
// instead of an AUGMENT (anchors PLUS the reached typed nodes). `returnBudget` lifts that boundary: when set
// (the MAGMA/Stage-4 path passes the traversal `budget`), the return is the full anchor floor ∪ reached nodes.
// Default `returnBudget = topK` ⇒ every existing caller/test is byte-identical.
describe('adaptiveTraversalSearch — T027 briefing budget (serialize all Visited; augment ≠ swap)', () => {
  let db: Database.Database
  beforeEach(() => {
    db = openMemoryDb(':memory:')
    seq = 0
  })
  afterEach(() => closeMemoryDb(db))

  const CAUSAL_ONLY = {
    ENTITY: { entity: 0, semantic: 0, temporal: 0, causal: 4 },
    WHY: { entity: 0, semantic: 0, temporal: 0, causal: 4 },
    WHEN: { entity: 0, semantic: 0, temporal: 0, causal: 4 },
    DEFAULT: { entity: 0, semantic: 0, temporal: 0, causal: 4 },
  } as const

  it('RED T027: returnBudget serializes ALL of Visited (5 anchors + 3 causal), not the topK=5 swap', async () => {
    const anchors = [
      addChunk(db, 'hybrid anchor one about the journey'),
      addChunk(db, 'hybrid anchor two about the journey'),
      addChunk(db, 'hybrid anchor three about the journey'),
      addChunk(db, 'hybrid anchor four about the journey'),
      addChunk(db, 'hybrid anchor five about the journey'),
    ]
    // Three causal neighbors, each reached from a distinct anchor via a causal edge, each a GENTLE cosine
    // drop (≤ DropThreshold 0.15) below its parent so the beam actually walks them.
    const c1 = addChunk(db, 'causal reason one: the collaboration inspired the journey')
    const c2 = addChunk(db, 'causal reason two: the funding unlocked the trip')
    const c3 = addChunk(db, 'causal reason three: the invitation set the date')
    linkChunk(db, anchors[0], c1, 'causal')
    linkChunk(db, anchors[1], c2, 'causal')
    linkChunk(db, anchors[2], c3, 'causal')
    const base = async (_q: string, k: number) => anchors.map(result).slice(0, k)
    const sim = simFrom({
      [anchors[0]]: 0.82,
      [anchors[1]]: 0.8,
      [anchors[2]]: 0.78,
      [anchors[3]]: 0.76,
      [anchors[4]]: 0.75,
      [c1]: 0.7,
      [c2]: 0.69,
      [c3]: 0.68,
    })

    const out = await adaptiveTraversalSearch(db, 'why was the journey inspired', 5, base, {
      intentWeights: CAUSAL_ONLY,
      semanticRelevance: sim,
      maxDepth: 1,
      returnBudget: 200, // MAGMA Stage-4 path: serialize all Visited (Alg 1 L22-23)
    })
    const ids = out.map((r) => r.chunkId)
    // AUGMENT: every anchor is retained AND all three reached causal nodes are added on top — the full
    // Visited subgraph, not a 5-node swap that drops an anchor to fit one causal node.
    expect(ids).toEqual(expect.arrayContaining([...anchors, c1, c2, c3]))
    expect(ids.length).toBeGreaterThanOrEqual(8)
    // Provenance: the hybrid anchors are flagged so Stage-4 can protect them from the token budget.
    const anchorFlagged = out.filter((r) => r.isAnchor).map((r) => r.chunkId)
    expect(anchorFlagged).toEqual(expect.arrayContaining(anchors))
    // …and the causal-reached nodes are NOT flagged as anchors (they augment, they are not seeds).
    expect(anchorFlagged).not.toContain(c1)
  })

  it('NEG T027: returnBudget does NOT invent non-Visited nodes — zero causal weight ⇒ anchors only', async () => {
    const anchors = [
      addChunk(db, 'hybrid anchor one about the journey'),
      addChunk(db, 'hybrid anchor two about the journey'),
      addChunk(db, 'hybrid anchor three about the journey'),
    ]
    const c1 = addChunk(db, 'causal reason one: the collaboration inspired the journey')
    linkChunk(db, anchors[0], c1, 'causal')
    const base = async (_q: string, k: number) => anchors.map(result).slice(0, k)
    const sim = simFrom({ [anchors[0]]: 0.82, [anchors[1]]: 0.8, [anchors[2]]: 0.78, [c1]: 0.7 })
    const zeroCausal = {
      ENTITY: { entity: 0, semantic: 0, temporal: 0, causal: 0 },
      WHY: { entity: 0, semantic: 0, temporal: 0, causal: 0 },
      WHEN: { entity: 0, semantic: 0, temporal: 0, causal: 0 },
      DEFAULT: { entity: 0, semantic: 0, temporal: 0, causal: 0 },
    } as const
    const out = await adaptiveTraversalSearch(db, 'why was the journey inspired', 5, base, {
      intentWeights: zeroCausal,
      semanticRelevance: sim,
      maxDepth: 1,
      returnBudget: 200,
    })
    const ids = out.map((r) => r.chunkId)
    expect(ids).not.toContain(c1) // admission is causal-driven, never indiscriminate padding
    expect(ids).toEqual(expect.arrayContaining(anchors))
  })

  it('default returnBudget = topK ⇒ byte-identical to the legacy topK-bounded return (back-compat)', async () => {
    const anchors = [addChunk(db, 'anchor a'), addChunk(db, 'anchor b'), addChunk(db, 'anchor c')]
    const base = async (_q: string, k: number) => anchors.map(result).slice(0, k)
    const sim = simFrom({ [anchors[0]]: 0.8, [anchors[1]]: 0.78, [anchors[2]]: 0.76 })
    const out = await adaptiveTraversalSearch(db, 'plain query', 2, base, { semanticRelevance: sim })
    expect(out.length).toBe(2) // no returnBudget ⇒ still capped at topK
  })
})

// ── Phase D — learned edge-weight readout (BEYOND the paper; plan §9 "make the beam actually read
// memory_edges.weight"). Eq-5 extension: suv = exp(λ1·φ·w_edge + λ2·sim) when useEdgeWeights is ON.
// Default OFF ⇒ byte-identical to the faithful literal Eq-5 beam; with every weight at the schema
// default 1.0, ON is ALSO identical (multiplying φ by 1) — so reinforcement changes retrieval ONLY
// after weights move AND the lever is certified on the judged gate.
describe('adaptiveTraversalSearch — useEdgeWeights (Phase D readout, default-OFF)', () => {
  let db: Database.Database
  beforeEach(() => {
    db = openMemoryDb(':memory:')
    seq = 0
  })
  afterEach(() => closeMemoryDb(db))

  function weightedPair(): { anchor: number; strong: number; weak: number } {
    const anchor = addChunk(db, 'anchor event')
    const strong = addChunk(db, 'reinforced neighbor')
    const weak = addChunk(db, 'decayed neighbor')
    db.prepare(
      `INSERT INTO memory_edges (src_chunk, edge_type, dst_chunk, weight, source) VALUES (?, 'semantic', ?, 2.0, 'test')`,
    ).run(anchor, strong)
    db.prepare(
      `INSERT INTO memory_edges (src_chunk, edge_type, dst_chunk, weight, source) VALUES (?, 'semantic', ?, 0.25, 'test')`,
    ).run(anchor, weak)
    return { anchor, strong, weak }
  }
  const base = (anchor: number) => async (_q: string, k: number) => [result(anchor)].slice(0, k)

  it('OFF (default): learned weights are IGNORED — equal-sim neighbors rank by discovery, not weight', async () => {
    const { anchor, strong, weak } = weightedPair()
    const sim = simFrom({ [anchor]: 0.6, [strong]: 0.5, [weak]: 0.5 })
    const out = await adaptiveTraversalSearch(db, 'q', 3, base(anchor), {
      gazetteer: GAZ,
      semanticRelevance: sim,
    })
    const ids = out.map((r) => r.chunkId)
    expect(ids).toContain(strong)
    expect(ids).toContain(weak)
    const s = out.find((r) => r.chunkId === strong)!.score
    const w = out.find((r) => r.chunkId === weak)!.score
    expect(s).toBeCloseTo(w, 10) // identical transition score — weight not read
  })

  it('ON: a reinforced (w=2.0) edge outranks a decayed (w=0.25) edge at identical sim', async () => {
    const { anchor, strong, weak } = weightedPair()
    const sim = simFrom({ [anchor]: 0.6, [strong]: 0.5, [weak]: 0.5 })
    const out = await adaptiveTraversalSearch(db, 'q', 3, base(anchor), {
      gazetteer: GAZ,
      semanticRelevance: sim,
      useEdgeWeights: true,
    })
    const s = out.find((r) => r.chunkId === strong)!.score
    const w = out.find((r) => r.chunkId === weak)!.score
    expect(s).toBeGreaterThan(w)
    expect(out.map((r) => r.chunkId).indexOf(strong)).toBeLessThan(
      out.map((r) => r.chunkId).indexOf(weak),
    )
  })

  it('ON with all weights at the schema default 1.0 ≡ OFF (reinforcement is the only divergence source)', async () => {
    const anchor = addChunk(db, 'anchor')
    const nb = addChunk(db, 'neighbor')
    linkChunk(db, anchor, nb, 'semantic') // default weight 1.0
    const sim = simFrom({ [anchor]: 0.6, [nb]: 0.5 })
    const off = await adaptiveTraversalSearch(db, 'q', 2, base(anchor), {
      gazetteer: GAZ,
      semanticRelevance: sim,
    })
    const on = await adaptiveTraversalSearch(db, 'q', 2, base(anchor), {
      gazetteer: GAZ,
      semanticRelevance: sim,
      useEdgeWeights: true,
    })
    expect(on.map((r) => ({ id: r.chunkId, s: r.score }))).toEqual(
      off.map((r) => ({ id: r.chunkId, s: r.score })),
    )
  })
})

// ── T010 [US1] (specs/001-learning-memory-loop) — literal Eq-5 closed-form fidelity ──────────────
// S(nj|ni,q) = exp(λ1·φ(type,Tq) + λ2·sim(nj,q)) ; cumulative: score_v = score_u·γ + suv (Alg 1 L11-12).
// A fixed 2-node graph + injected sims ⇒ the returned scores must EQUAL the closed-form values.
describe('T010 — literal Eq-5 transition equals the closed form on a fixed 2-node graph', () => {
  let db: Database.Database
  beforeEach(() => {
    db = openMemoryDb(':memory:')
    seq = 0
  })
  afterEach(() => closeMemoryDb(db))
  const base = (anchor: number) => async (_q: string, k: number) => [result(anchor)].slice(0, k)

  it('anchor = exp(λ2·simA); neighbor = anchor·γ + exp(λ1·φ_semantic + λ2·simB) — exact (toBeCloseTo 10dp)', async () => {
    const anchor = addChunk(db, 'anchor node')
    const nb = addChunk(db, 'neighbor node')
    linkChunk(db, anchor, nb, 'semantic') // DEFAULT intent ⇒ φ(semantic) = 3.0 (Eq. 6 table)
    const simA = 0.6
    const simB = 0.5
    const sim = simFrom({ [anchor]: simA, [nb]: simB })
    const out = await adaptiveTraversalSearch(db, 'q', 2, base(anchor), {
      gazetteer: GAZ,
      semanticRelevance: sim,
    })
    const lambda1 = 1.0
    const lambda2 = 0.5
    const gamma = 0.5
    const phiSemantic = 3.0
    const expectAnchor = Math.exp(lambda2 * simA)
    const expectNb = expectAnchor * gamma + Math.exp(lambda1 * phiSemantic + lambda2 * simB)
    expect(out.find((r) => r.chunkId === anchor)!.score).toBeCloseTo(expectAnchor, 10)
    expect(out.find((r) => r.chunkId === nb)!.score).toBeCloseTo(expectNb, 10)
  })

  it('with useEdgeWeights ON the SAME closed form holds with φ·w_edge (w=2.0); a neutral 1.0 edge is unchanged', async () => {
    const anchor = addChunk(db, 'anchor node')
    const nb = addChunk(db, 'weighted neighbor')
    db.prepare(
      `INSERT INTO memory_edges (src_chunk, edge_type, dst_chunk, weight, source) VALUES (?, 'semantic', ?, 2.0, 'test')`,
    ).run(anchor, nb)
    const sim = simFrom({ [anchor]: 0.6, [nb]: 0.5 })
    const on = await adaptiveTraversalSearch(db, 'q', 2, base(anchor), {
      gazetteer: GAZ,
      semanticRelevance: sim,
      useEdgeWeights: true,
    })
    const expectOn = Math.exp(0.5 * 0.6) * 0.5 + Math.exp(1.0 * 3.0 * 2.0 + 0.5 * 0.5)
    expect(on.find((r) => r.chunkId === nb)!.score).toBeCloseTo(expectOn, 10)

    // NEGATIVE control: neutral weight 1.0 ⇒ ON produces the plain Eq-5 value (no divergence source).
    const db2 = openMemoryDb(':memory:')
    try {
      seq = 0
      const a2 = addChunk(db2, 'anchor node')
      const n2 = addChunk(db2, 'neutral neighbor')
      linkChunk(db2, a2, n2, 'semantic') // weight defaults 1.0
      const sim2 = simFrom({ [a2]: 0.6, [n2]: 0.5 })
      const onNeutral = await adaptiveTraversalSearch(db2, 'q', 2, base(a2), {
        gazetteer: GAZ,
        semanticRelevance: sim2,
        useEdgeWeights: true,
      })
      const expectNeutral = Math.exp(0.5 * 0.6) * 0.5 + Math.exp(1.0 * 3.0 + 0.5 * 0.5)
      expect(onNeutral.find((r) => r.chunkId === n2)!.score).toBeCloseTo(expectNeutral, 10)
    } finally {
      closeMemoryDb(db2)
    }
  })
})

// ── T021 — Anchor retention (MAGMA Algorithm 1 return contract, US2 / research R1).
// The reference (query_engine.py:816-848) returns `all_candidates` = vector/RRF anchors ⊕ deduped
// traversed nodes, reranked by query relevance (_rerank_and_filter :1282/:1606) and trimmed to top_k
// AFTER the rerank — so hybrid anchors are NEVER structurally evicted (augment, not replace; AGENTS.md #7).
// Bug today: the return is ranked by the CUMULATIVE BEAM score, where a φ-lifted reached node scores
// exp(λ1·φ+λ2·sim) ≫ an anchor's exp(λ2·sim) ceiling ≈1.65 — so lower-relevance traversed nodes out-rank
// and slice out the higher-relevance anchors. AnchorRetention (data-model.md:76-79) = returned/in MUST be 1.0.
describe('adaptiveTraversalSearch — T021 anchor retention (R1 return-contract fix; augment ≠ replace)', () => {
  let db: Database.Database
  beforeEach(() => {
    db = openMemoryDb(':memory:')
    seq = 0
  })
  afterEach(() => closeMemoryDb(db))

  it('keeps a minimum anchor guarantee while AUGMENTING with a reached neighbor (not wiping anchors)', async () => {
    // 3 pure hybrid anchors (high query relevance), + 2 buried Mel-siblings reached from a1 via the
    // entity edge (φ=wentity ≫ 0), each a GENTLE cosine drop (≤ DropThreshold 0.15) so both are reachable.
    const a1 = addChunk(db, 'Mel primary topic') // anchor + entity Mel (the traversal parent)
    const a2 = addChunk(db, 'second anchor topic') // pure anchor (no entity)
    const a3 = addChunk(db, 'third anchor topic') // pure anchor (no entity)
    const b1 = addChunk(db, 'Mel buried fact one') // reached via Mel entity edge
    const b2 = addChunk(db, 'Mel buried fact two') // reached via Mel entity edge
    const mel = addEntity(db, 'Mel')
    linkEntity(db, a1, mel)
    linkEntity(db, b1, mel)
    linkEntity(db, b2, mel)
    const anchorsIn = [a1, a2, a3]
    const base = async (_q: string, k: number) => anchorsIn.map(result).slice(0, k)
    // Anchors 0.60/0.58/0.56 (all > any neighbor); neighbors 0.50/0.48 are ≤0.15 below parent a1(0.60).
    const sim = simFrom({ [a1]: 0.6, [a2]: 0.58, [a3]: 0.56, [b1]: 0.5, [b2]: 0.48 })
    // topK=4 < |anchors ∪ traversed|=5 ⇒ the return may admit one structurally relevant neighbor, but it
    // must keep the anchor-seeded subgraph intact enough that high-structural-score nodes cannot wipe anchors.
    const out = await adaptiveTraversalSearch(db, 'Mel instruments', 4, base, {
      gazetteer: GAZ,
      semanticRelevance: sim,
    })
    const ids = out.map((r) => r.chunkId)
    const anchorsReturned = anchorsIn.filter((id) => ids.includes(id)).length
    expect(anchorsReturned).toBeGreaterThanOrEqual(3) // minimum anchor guarantee: anchors are not wiped out
    expect(ids).toContain(b1) // AUGMENT: the most-relevant reached neighbor is added alongside the anchors
    expect(ids).not.toContain(b2) // the least-relevant reached node is trimmed by top_k
  })
})
