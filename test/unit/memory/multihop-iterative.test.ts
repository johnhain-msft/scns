import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openMemoryDb, closeMemoryDb } from '../../../src/memory/db.js'
import {
  multiHopIterativeSearch,
  bridgeEntityFollowups,
  DEFAULT_MULTIHOP_MAX_ROUNDS,
  DEFAULT_MULTIHOP_MAX_FOLLOWUPS,
} from '../../../src/memory/multihop-iterative.js'
import type { SearchResult } from '../../../src/memory/search.js'
import type { GazetteerEntry } from '../../../src/memory/entities/gazetteer.js'
import type Database from 'better-sqlite3'

// ── C2 — Multi-hop ITERATIVE retrieval on the graph (BEYOND MAGMA). ──────────────────────────────
// MAGMA concedes multi-hop QA (Table 1: 0.528 < Nemori 0.569 / MemoryOS 0.552). This arm adds the
// IRCoT/FLARE-family pattern — interleave retrieval with follow-up queries derived from what was just
// retrieved, stop on zero information gain — with a DETERMINISTIC graph-native follow-up proposer
// (bridge entities: entities linked to retrieved chunks but NOT named in the query). No LLM spawn on
// the default path; an LLM proposer is injectable. Rounds merge via weighted RRF with per-round decay
// so round-0 anchors stay primary.

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
const result = (chunkId: number, content = ''): SearchResult => ({
  chunkId,
  filePath: `f${chunkId}.md`,
  content,
  score: 1,
  vectorScore: 0,
  keywordScore: 0,
  chunkIndex: 0,
})
const GAZ: readonly GazetteerEntry[] = [{ canonical: 'Mel', kind: 'concept', aliases: ['mel'] }]

describe('bridgeEntityFollowups — deterministic graph-native follow-up proposer', () => {
  let db: Database.Database
  beforeEach(() => {
    db = openMemoryDb(':memory:')
    seq = 0
  })
  afterEach(() => closeMemoryDb(db))

  it('proposes follow-ups for entities linked to the retrieved chunks but NOT named in the query', () => {
    const c1 = addChunk(db, 'Mel and Bob went hiking')
    const mel = addEntity(db, 'Mel')
    const bob = addEntity(db, 'Bob')
    linkEntity(db, c1, mel)
    linkEntity(db, c1, bob)
    const out = bridgeEntityFollowups(db, 'What instruments does Mel play?', [result(c1)], {
      gazetteer: GAZ,
    })
    expect(out).toEqual(['Bob What instruments does Mel play?']) // Mel is named in the query ⇒ excluded
  })

  it('ranks bridge entities by link frequency across retrieved chunks (desc), then name (asc), capped', () => {
    const c1 = addChunk(db, 'a')
    const c2 = addChunk(db, 'b')
    const zed = addEntity(db, 'Zed')
    const ann = addEntity(db, 'Ann')
    const bob = addEntity(db, 'Bob')
    // Zed linked to both chunks (freq 2); Ann + Bob once each (tie → name asc).
    linkEntity(db, c1, zed)
    linkEntity(db, c2, zed)
    linkEntity(db, c1, ann)
    linkEntity(db, c2, bob)
    const out = bridgeEntityFollowups(db, 'query', [result(c1), result(c2)], {
      gazetteer: GAZ,
      max: 2,
    })
    expect(out).toEqual(['Zed query', 'Ann query'])
  })

  it('returns [] for no results and for chunks with no entity links', () => {
    const c1 = addChunk(db, 'no links here')
    expect(bridgeEntityFollowups(db, 'q', [], { gazetteer: GAZ })).toEqual([])
    expect(bridgeEntityFollowups(db, 'q', [result(c1)], { gazetteer: GAZ })).toEqual([])
  })

  it('defaults the cap to DEFAULT_MULTIHOP_MAX_FOLLOWUPS', () => {
    const c1 = addChunk(db, 'x')
    for (const name of ['E1', 'E2', 'E3', 'E4', 'E5']) linkEntity(db, c1, addEntity(db, name))
    const out = bridgeEntityFollowups(db, 'q', [result(c1)], { gazetteer: GAZ })
    expect(out).toHaveLength(DEFAULT_MULTIHOP_MAX_FOLLOWUPS)
  })
})

describe('multiHopIterativeSearch — iterative retrieval with information-gain stop (IRCoT/FLARE family)', () => {
  let db: Database.Database
  beforeEach(() => {
    db = openMemoryDb(':memory:')
    seq = 0
  })
  afterEach(() => closeMemoryDb(db))

  /** A scripted base search keyed on the exact query string; records every call. */
  function scriptedBase(table: Record<string, number[]>): {
    base: (q: string, k: number) => Promise<readonly SearchResult[]>
    calls: string[]
  } {
    const calls: string[] = []
    return {
      calls,
      base: async (q: string, k: number) => (table[q] ?? []).slice(0, k).map((id) => result(id)),
    }
  }

  it('POS (the bridge hop): reaches a chunk only findable via a follow-up query the round-0 results propose', async () => {
    // Round 0: query about Mel returns c1 (linked to bridge entity Bob).
    // Round 1: the proposed follow-up 'Bob <query>' retrieves c2 — unreachable from the original query.
    const c1 = addChunk(db, 'Mel talked to Bob about the trip')
    const c2 = addChunk(db, 'Bob organized the Yosemite trip')
    const mel = addEntity(db, 'Mel')
    const bob = addEntity(db, 'Bob')
    linkEntity(db, c1, mel)
    linkEntity(db, c1, bob)
    linkEntity(db, c2, bob)
    const q = 'What trip did Mel discuss?'
    const { base } = scriptedBase({ [q]: [c1], [`Bob ${q}`]: [c2] })
    const out = await multiHopIterativeSearch(db, q, 5, base, {
      gazetteer: GAZ,
      innerSearch: 'base',
    })
    const ids = out.map((r) => r.chunkId)
    expect(ids).toContain(c1)
    expect(ids).toContain(c2) // the multi-hop bridge — flat single-round retrieval cannot reach it
  })

  it('round-0 anchors outrank equally-placed follow-up finds (per-round RRF decay)', async () => {
    const c1 = addChunk(db, 'anchor')
    const c2 = addChunk(db, 'bridge find')
    const bob = addEntity(db, 'Bob')
    linkEntity(db, c1, bob)
    linkEntity(db, c2, bob)
    const q = 'anchor query'
    const { base } = scriptedBase({ [q]: [c1], [`Bob ${q}`]: [c2] })
    const out = await multiHopIterativeSearch(db, q, 5, base, {
      gazetteer: GAZ,
      innerSearch: 'base',
    })
    const ids = out.map((r) => r.chunkId)
    expect(ids.indexOf(c1)).toBeLessThan(ids.indexOf(c2))
  })

  it('stops on ZERO information gain: a round that rediscovers only seen chunks ends the loop', async () => {
    const c1 = addChunk(db, 'self-referential')
    const bob = addEntity(db, 'Bob')
    linkEntity(db, c1, bob)
    const q = 'q'
    // Follow-up 'Bob q' returns the SAME chunk ⇒ no new info ⇒ stop after round 1 (never a round 2).
    const { base, calls } = scriptedBase({ [q]: [c1], [`Bob ${q}`]: [c1] })
    const spied = async (qq: string, k: number) => {
      calls.push(qq)
      return base(qq, k)
    }
    const out = await multiHopIterativeSearch(db, q, 5, spied, {
      gazetteer: GAZ,
      innerSearch: 'base',
      maxRounds: 5,
    })
    expect(out.map((r) => r.chunkId)).toEqual([c1])
    // round 0 (q) + round 1 (Bob q) — the zero-gain stop prevents rounds 2..5 re-issuing 'Bob q'.
    expect(calls).toEqual([q, `Bob ${q}`])
  })

  it('returns the round-0 results verbatim when no follow-ups are proposed', async () => {
    const c1 = addChunk(db, 'lonely chunk, no entities')
    const q = 'q'
    const { base, calls } = scriptedBase({ [q]: [c1] })
    const spied = async (qq: string, k: number) => {
      calls.push(qq)
      return base(qq, k)
    }
    const out = await multiHopIterativeSearch(db, q, 5, spied, {
      gazetteer: GAZ,
      innerSearch: 'base',
    })
    expect(out.map((r) => r.chunkId)).toEqual([c1])
    expect(calls).toEqual([q])
  })

  it('respects maxRounds and never re-issues an already-asked query', async () => {
    // Chain: c1 —Bob→ c2 —Cat→ c3 —Dog→ c4; with maxRounds=1 only Bob's round runs.
    const c1 = addChunk(db, 'start')
    const c2 = addChunk(db, 'via bob')
    const c3 = addChunk(db, 'via cat')
    const bob = addEntity(db, 'Bob')
    const cat = addEntity(db, 'Cat')
    linkEntity(db, c1, bob)
    linkEntity(db, c2, bob)
    linkEntity(db, c2, cat)
    linkEntity(db, c3, cat)
    const q = 'q'
    const table = { [q]: [c1], [`Bob ${q}`]: [c2], [`Cat ${q}`]: [c3] }
    const { base } = scriptedBase(table)
    const one = await multiHopIterativeSearch(db, q, 5, base, {
      gazetteer: GAZ,
      innerSearch: 'base',
      maxRounds: 1,
    })
    expect(one.map((r) => r.chunkId).sort()).toEqual([c1, c2].sort())
    const two = await multiHopIterativeSearch(db, q, 5, base, {
      gazetteer: GAZ,
      innerSearch: 'base',
      maxRounds: 2,
    })
    expect(two.map((r) => r.chunkId).sort()).toEqual([c1, c2, c3].sort())
    expect(DEFAULT_MULTIHOP_MAX_ROUNDS).toBe(2)
  })

  it('uses an injected proposeFollowups (the LLM/IRCoT seam) instead of the graph-native default', async () => {
    const c1 = addChunk(db, 'round zero')
    const c2 = addChunk(db, 'llm-proposed find')
    const q = 'q'
    const { base } = scriptedBase({ [q]: [c1], 'custom follow-up': [c2] })
    let sawRound = -1
    const out = await multiHopIterativeSearch(db, q, 5, base, {
      gazetteer: GAZ,
      innerSearch: 'base',
      proposeFollowups: async (_query, results, round) => {
        sawRound = round
        expect(results.map((r) => r.chunkId)).toContain(c1)
        return round === 1 ? ['custom follow-up'] : []
      },
    })
    expect(sawRound).toBeGreaterThanOrEqual(1)
    expect(out.map((r) => r.chunkId).sort()).toEqual([c1, c2].sort())
  })

  it('returns [] for topK<=0 and for empty round-0 results', async () => {
    const { base } = scriptedBase({})
    expect(await multiHopIterativeSearch(db, 'q', 0, base, { innerSearch: 'base' })).toEqual([])
    expect(await multiHopIterativeSearch(db, 'q', 5, base, { innerSearch: 'base' })).toEqual([])
  })
})

// ── returnBudget fidelity (2026-07-27) ───────────────────────────────────────────────────────────
// DEFECT FOUND WHILE MEASURING THE EXPLORATION CHALLENGER ARM.
//
// `retrieveContext` sets `serializeAllVisited` when a GRAPH arm is Stage-4 token-budgeted
// (`synthesize && maxTokens != null && (traverse || multiHop)` — retrieval-context.ts:532) and
// forwards the resulting `returnBudget` (DEFAULT_BUDGET = 200) through `traversalOptions`. That is
// MAGMA Alg 1 L22-23: the whole visited subgraph flows to Stage-4 so the graph AUGMENTS the anchors
// instead of being forced into a topK-sized 1-for-1 swap.
//
// `adaptiveTraversalSearch` honors it. `multiHopIterativeSearch` did NOT: it forwarded the budget to
// its INNER beams but then capped its OUTER fusion at `topK`, so the arm paid for up to 7 traversals
// and discarded ~94% of what it retrieved.
//
// MEASURED live (isolated broker, copy of the production vault, briefing topK=5): magma returned 421
// chars of chunk-ids, multihop-iter returned 36 — the challenger delivered ~1/16th the context for
// ~2.7x the latency. That is not an accuracy/latency trade-off, it is a truncation bug, and it made
// the exploration challenger arm STRICTLY DOMINATED by construction.
describe('multiHopIterativeSearch — honors returnBudget like the traversal arm', () => {
  let db: Database.Database
  beforeEach(() => {
    db = openMemoryDb(':memory:')
    seq = 0
  })
  afterEach(() => closeMemoryDb(db))

  /**
   * A corpus where follow-up rounds genuinely find NEW chunks, so the fused union exceeds topK.
   * Round 0 retrieves the anchor slice; the bridge entity 'Mel' (linked to the anchors but not named
   * in the query) drives a follow-up whose base search returns a DIFFERENT slice.
   */
  function bridgedCorpus(): (q: string, k: number) => Promise<readonly SearchResult[]> {
    const anchors = Array.from({ length: 5 }, (_, i) => addChunk(db, `anchor ${i}`))
    const bridged = Array.from({ length: 20 }, (_, i) => addChunk(db, `bridged ${i}`))
    const mel = addEntity(db, 'Mel')
    for (const id of anchors) linkEntity(db, id, mel)
    return async (q: string, k: number) =>
      (q.toLowerCase().includes('mel') ? bridged : anchors).slice(0, k).map((id) => result(id))
  }

  it('returns the FULL visited set (up to returnBudget), not just topK, when a budget is given', async () => {
    const base = bridgedCorpus()
    const out = await multiHopIterativeSearch(db, 'anchor query', 5, base, {
      innerSearch: 'base',
      gazetteer: GAZ,
      traversalOptions: { returnBudget: 200 },
    })
    expect(out.length).toBeGreaterThan(5)
  })

  it('still caps at topK when NO returnBudget is supplied (byte-identical legacy behaviour)', async () => {
    const base = bridgedCorpus()
    const out = await multiHopIterativeSearch(db, 'anchor query', 5, base, {
      innerSearch: 'base',
      gazetteer: GAZ,
    })
    expect(out.length).toBe(5)
  })

  it('never exceeds the returnBudget itself', async () => {
    const base = bridgedCorpus()
    const out = await multiHopIterativeSearch(db, 'anchor query', 5, base, {
      innerSearch: 'base',
      gazetteer: GAZ,
      traversalOptions: { returnBudget: 7 },
    })
    expect(out.length).toBeLessThanOrEqual(7)
  })
})
