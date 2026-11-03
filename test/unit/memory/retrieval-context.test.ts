/**
 * THE BRIDGE — retrieval-context unit tests. Embedding-free: the base search is
 * either the real keyword-only FTS5 path or an injected sentinel, so the suite
 * never spawns the fastembed worker. Proves the routing lever changes what is
 * retrieved, the formatting/cap, and the provenance — the live discrimination
 * (routing beats hybrid on the real vault) is the separate go-live proof's job.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openMemoryDb, closeMemoryDb } from '../../../src/memory/db.js'
import { rebuildMemoryEdges } from '../../../src/memory/entities/edges.js'
import {
  persistCausalEdges,
  materializeCausalEdges,
  causalKey,
} from '../../../src/memory/causal-edges.js'
import {
  retrieveContext,
  formatRetrievedContext,
  synthesizeNarrativeContext,
  hasBrevityCode,
  makeTimedScorer,
  RETRIEVED_CONTEXT_HEADER,
} from '../../../src/memory/retrieval-context.js'
import { openExperienceStore } from '../../../src/memory/experience-store.js'
import type { SearchResult } from '../../../src/memory/search.js'
import type { BaseSearch } from '../../../src/memory/intent-search.js'
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

/** A base search that always returns ONE sentinel result (proves base-vs-routed). */
function sentinelBase(content: string, chunkId = 999): BaseSearch {
  return async (): Promise<readonly SearchResult[]> => [
    {
      chunkId,
      filePath: 'sentinel.md',
      content,
      score: 1,
      vectorScore: 0,
      keywordScore: 1,
      chunkIndex: 0,
    },
  ]
}

describe('retrieveContext — routing lever changes what is injected', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb(':memory:')
    // Broker entity neighborhood: a distinctive config fact + generic mentions.
    addChunk(db, 'b1.md', 1000, 'the broker first booted')
    addChunk(db, 'b2.md', 2000, 'the broker config reads BROKER_DB_PATH from env at startup')
    addChunk(db, 'idx.md', 3000, 'the indexer ran once')
    rebuildMemoryEdges(db)
  })
  afterEach(() => closeMemoryDb(db))

  it('routing OFF uses the base search (classified ENTITY, base still consulted)', async () => {
    const r = await retrieveContext(
      db,
      'Tell me about the broker',
      { intentRouting: false },
      { baseSearch: sentinelBase('SENTINEL-BASE-RESULT') },
    )
    expect(r.intent).toBe('ENTITY')
    expect(r.text).toContain('SENTINEL-BASE-RESULT')
    expect(r.text).not.toContain('BROKER_DB_PATH')
  })

  it('routing ON bypasses the base for an ENTITY query and injects the neighborhood', async () => {
    const r = await retrieveContext(
      db,
      'Tell me about the broker',
      { intentRouting: true },
      { baseSearch: sentinelBase('SENTINEL-BASE-RESULT') },
    )
    expect(r.intent).toBe('ENTITY')
    expect(r.text).toContain('BROKER_DB_PATH') // surfaced via the entity graph
    expect(r.text).not.toContain('SENTINEL-BASE-RESULT') // base bypassed
    expect(r.nResults).toBeGreaterThan(0)
    expect(r.chunkIds.length).toBe(r.nResults)
  })

  it('a DEFAULT (no-entity) query falls back to the base even with routing ON', async () => {
    const r = await retrieveContext(
      db,
      'an unrelated greeting',
      { intentRouting: true },
      { baseSearch: sentinelBase('SENTINEL-BASE-RESULT') },
    )
    expect(r.intent).toBe('DEFAULT')
    expect(r.text).toContain('SENTINEL-BASE-RESULT')
  })

  it('prefixes the header and joins chunk contents', async () => {
    const r = await retrieveContext(
      db,
      'Tell me about the broker',
      { intentRouting: true },
      { baseSearch: sentinelBase('x') },
    )
    expect(r.text.startsWith(RETRIEVED_CONTEXT_HEADER)).toBe(true)
  })

  it('caps the injected block at maxChars', async () => {
    const r = await retrieveContext(
      db,
      'Tell me about the broker',
      { intentRouting: true, maxChars: 20 },
      { baseSearch: sentinelBase('x') },
    )
    expect(r.text.length).toBeLessThanOrEqual(20)
  })

  it('returns empty text (merge no-op) when nothing is retrieved', async () => {
    const r = await retrieveContext(
      db,
      'an unrelated greeting',
      { intentRouting: false },
      { baseSearch: async () => [] },
    )
    expect(r.text).toBe('')
    expect(r.nResults).toBe(0)
  })
})

describe('formatRetrievedContext', () => {
  const mk = (id: number, content: string): SearchResult => ({
    chunkId: id,
    filePath: `f${id}.md`,
    content,
    score: 1,
    vectorScore: 0,
    keywordScore: 0,
    chunkIndex: 0,
  })

  it('joins contents under the header', () => {
    const t = formatRetrievedContext([mk(1, 'alpha'), mk(2, 'beta')])
    expect(t).toBe(`${RETRIEVED_CONTEXT_HEADER}\nalpha\n\nbeta`)
  })

  it('returns empty string for no results', () => {
    expect(formatRetrievedContext([])).toBe('')
  })

  it('drops blank chunk contents', () => {
    const t = formatRetrievedContext([mk(1, '   '), mk(2, 'real')])
    expect(t).toBe(`${RETRIEVED_CONTEXT_HEADER}\nreal`)
  })

  it('caps at maxChars', () => {
    const t = formatRetrievedContext([mk(1, 'x'.repeat(500))], 30)
    expect(t.length).toBe(30)
  })
})

describe('retrieveContext — fusion + timeline levers (default-OFF pass-through)', () => {
  let db: Database.Database
  let b1: number, b2: number, idx: number

  beforeEach(() => {
    db = openMemoryDb(':memory:')
    b1 = addChunk(db, 'b1.md', 1000, 'the broker first booted')
    b2 = addChunk(db, 'b2.md', 2000, 'the broker config reads BROKER_DB_PATH from env at startup')
    idx = addChunk(db, 'idx.md', 3000, 'the indexer ran once')
    rebuildMemoryEdges(db)
  })
  afterEach(() => closeMemoryDb(db))

  /** A base returning the given real chunks (id+content) in the given order. */
  function realBase(rows: ReadonlyArray<{ id: number; content: string }>): BaseSearch {
    return async () =>
      rows.map((r, i) => ({
        chunkId: r.id,
        filePath: '',
        content: r.content,
        score: 1 - i * 0.1,
        vectorScore: 0,
        keywordScore: 1 - i * 0.1,
        chunkIndex: 0,
      }))
  }

  it('fusion ON fuses hybrid ⊕ entity (both the base hit AND the entity neighborhood surface)', async () => {
    const r = await retrieveContext(
      db,
      'Tell me about the broker',
      { intentRouting: false, fusion: true },
      { baseSearch: sentinelBase('SENTINEL-BASE-RESULT') },
    )
    // fusion is the only mode that injects BOTH the base sentinel AND the entity BROKER_DB_PATH chunk
    expect(r.text).toContain('BROKER_DB_PATH')
    expect(r.text).toContain('SENTINEL-BASE-RESULT')
  })

  it('fusion OFF (omitted) ⇒ binary ENTITY route unchanged (entity only, base bypassed)', async () => {
    const r = await retrieveContext(
      db,
      'Tell me about the broker',
      { intentRouting: true },
      { baseSearch: sentinelBase('SENTINEL-BASE-RESULT') },
    )
    expect(r.text).toContain('BROKER_DB_PATH')
    expect(r.text).not.toContain('SENTINEL-BASE-RESULT')
  })

  it('timeline ON ⇒ a no-entity WHEN query is re-ordered CHRONOLOGICALLY', async () => {
    // base returns the real chunks in a non-chronological relevance order
    const base = realBase([
      { id: idx, content: 'idx-3000' },
      { id: b1, content: 'b1-1000' },
      { id: b2, content: 'b2-2000' },
    ])
    const r = await retrieveContext(
      db,
      'what happened recently',
      { intentRouting: true, timeline: true },
      { baseSearch: base },
    )
    expect(r.intent).toBe('WHEN')
    expect(r.chunkIds).toEqual([b1, b2, idx]) // chronological (mtime asc), not the base order
  })

  it('timeline OFF (omitted) ⇒ no-entity WHEN keeps the base relevance order', async () => {
    const base = realBase([
      { id: idx, content: 'idx-3000' },
      { id: b1, content: 'b1-1000' },
      { id: b2, content: 'b2-2000' },
    ])
    const r = await retrieveContext(
      db,
      'what happened recently',
      { intentRouting: true },
      { baseSearch: base },
    )
    expect(r.chunkIds).toEqual([idx, b1, b2]) // base order preserved
  })

  it('fusion ON + an injected scorer factory ⇒ the relevance scorer is built for the query (faithful fusion)', async () => {
    const built: string[] = []
    await retrieveContext(
      db,
      'Tell me about the broker',
      { intentRouting: false, fusion: true },
      {
        baseSearch: sentinelBase('SENTINEL-BASE-RESULT'),
        makeSemanticRelevanceScorer: (q) => {
          built.push(q)
          return () => new Map<number, number>()
        },
      },
    )
    expect(built).toEqual(['Tell me about the broker'])
  })

  it('binary route (no fusion/semantic) ⇒ the scorer factory is NOT built (default-preserving)', async () => {
    const built: string[] = []
    await retrieveContext(
      db,
      'Tell me about the broker',
      { intentRouting: true },
      {
        baseSearch: sentinelBase('SENTINEL-BASE-RESULT'),
        makeSemanticRelevanceScorer: (q) => {
          built.push(q)
          return () => new Map<number, number>()
        },
      },
    )
    expect(built).toEqual([])
  })

  it('semantic ON also builds the scorer (relevance-ranked 2-hop augmentation)', async () => {
    const built: string[] = []
    await retrieveContext(
      db,
      'what about the indexer',
      { intentRouting: true, semantic: true },
      {
        baseSearch: sentinelBase('SENTINEL-BASE-RESULT'),
        makeSemanticRelevanceScorer: (q) => {
          built.push(q)
          return () => new Map<number, number>()
        },
      },
    )
    expect(built).toEqual(['what about the indexer'])
  })
})

// The `traverse` lever wires retrieveContext → intentAwareSearch({traverse}) → adaptiveTraversalSearch (the
// MAGMA Algorithm 1 Heuristic Beam Search). This suite proves ONLY the WIRING (the lever forwards + the beam
// is reached); the beam's own mechanics + positive/negative causal controls live in adaptive-traversal.test.ts.
describe('retrieveContext — traverse lever wires the MAGMA Alg-1 beam (Algorithm 1, Eq. 4–6)', () => {
  let db: Database.Database
  beforeEach(() => {
    db = openMemoryDb(':memory:')
  })
  afterEach(() => closeMemoryDb(db))

  const CAUSE = 'the broker quality-gate review passed on the branch'
  const EFFECT = 'the broker then auto-merged the branch to main'
  const WHY_Q = 'why did the broker auto-merge the branch'

  it('traverse:true builds the query-relevance scorer (Eq. 5 λ2 — proves traverse ∈ wantsSemanticRanking)', async () => {
    const built: string[] = []
    await retrieveContext(
      db,
      WHY_Q,
      { intentRouting: false, traverse: true },
      {
        baseSearch: sentinelBase('SENTINEL-BASE-RESULT'),
        makeSemanticRelevanceScorer: (q) => {
          built.push(q)
          return () => new Map<number, number>()
        },
      },
    )
    expect(built).toEqual([WHY_Q]) // omitted ⇒ NOT built (covered by the binary-route case above)
  })

  it('traverse:true reaches a materialized causal neighbor the hybrid base cannot (beam wired end-to-end)', async () => {
    const cause = addChunk(db, 'cause.md', 1000, CAUSE) // buried: never returned by the base
    const effect = addChunk(db, 'effect.md', 2000, EFFECT) // the WHY anchor
    const distract = addChunk(
      db,
      'noise.md',
      3000,
      'unrelated telemetry blob about spans and traces',
    )
    persistCausalEdges(
      db,
      [{ causeKey: causalKey(CAUSE), effectKey: causalKey(EFFECT), confidence: 0.9 }],
      {
        minConfidence: 0.7,
        provider: 'mock',
      },
    )
    const stats = materializeCausalEdges(db) // direction 'both' ⇒ the effect→cause reverse edge the WHY case needs
    expect(stats.materialized).toBeGreaterThan(0)

    // Base returns ONLY the effect anchor (+ a distractor); the cause is reachable ONLY across the causal edge.
    const base: BaseSearch = async (_q, k) =>
      [
        {
          chunkId: effect,
          filePath: 'effect.md',
          content: EFFECT,
          score: 1,
          vectorScore: 0,
          keywordScore: 1,
          chunkIndex: 0,
        },
        {
          chunkId: distract,
          filePath: 'noise.md',
          content: 'noise',
          score: 0.5,
          vectorScore: 0,
          keywordScore: 0.5,
          chunkIndex: 0,
        },
      ].slice(0, k)
    // Deterministic embedding-free cosine: anchor relevant, cause a GENTLE drop (0.60→0.50 ≤ DropThreshold
    // 0.15) so it survives the relative-drop prune, distractor low ⇒ structural reach does the lift. (A
    // cosine cliff at 0.05 would be drop-pruned even WITH the causal edge — the faithful Table-6 behavior.)
    const makeScorer = (_q: string) => (ids: readonly number[]) =>
      new Map(ids.map((id) => [id, id === effect ? 0.6 : id === cause ? 0.5 : 0.3]))

    const beam = await retrieveContext(
      db,
      WHY_Q,
      { intentRouting: false, traverse: true },
      { baseSearch: base, makeSemanticRelevanceScorer: makeScorer },
    )
    expect(beam.text).toContain(CAUSE) // reached the buried cause across the materialized causal edge

    const hybrid = await retrieveContext(
      db,
      WHY_Q,
      { intentRouting: false },
      { baseSearch: base, makeSemanticRelevanceScorer: makeScorer },
    )
    expect(hybrid.text).not.toContain(CAUSE) // the base alone never surfaces it (isolates the beam as the cause)
  })
})

// ── MAGMA Stage 4: Narrative Synthesis via Graph Linearization (Eq. 7 / §S4) ──────────────────────
// Cprompt = ⊕_{ni∈Sort(Gsub)} [<t:τi> ni.content <ref:ni.id>].  Three phases:
//   (1) Topological Ordering  — WHEN: sort by τ ; WHY: causal topo-sort (causes precede effects).
//   (2) Provenance Scaffold   — each node serialized as [<t:τ> content <ref:id>].
//   (3) Salience Token Budget — high-salience nodes kept full; the low-salience tail that overflows the
//       budget collapses into a brevity code ("...N intermediate events...") ⇒ measurable char drop.
describe('synthesizeNarrativeContext — Stage 4 provenance scaffold (Eq. 7)', () => {
  let db: Database.Database
  beforeEach(() => {
    db = openMemoryDb(':memory:')
  })
  afterEach(() => closeMemoryDb(db))

  const sr = (chunkId: number, content: string, score: number): SearchResult => ({
    chunkId,
    filePath: `f${chunkId}.md`,
    content,
    score,
    vectorScore: 0,
    keywordScore: 0,
    chunkIndex: 0,
  })

  it('serializes each kept node as [<t:τ> content <ref:id>] with a real τ (event τ preferred, mtime fallback)', () => {
    const a = addChunk(db, 'a.md', 1_700_000_000_000, 'alpha fact about the broker')
    const b = addChunk(db, 'b.md', 1_700_000_100_000, 'beta fact about the indexer')
    // b is an event node with a first-class τ; a falls back to file mtime.
    db.prepare(
      `INSERT INTO event_nodes (chunk_id, event_key, tau, entity, kind, decision, action, outcome, source_ref)
       VALUES (?, 'k-b', '2023-05-08T13:56:00.000Z', NULL, 'conversation-event', NULL, NULL, NULL, 'ref-b')`,
    ).run(b)
    const out = synthesizeNarrativeContext(
      db,
      [sr(a, 'alpha fact about the broker', 0.9), sr(b, 'beta fact about the indexer', 0.8)],
      {
        intent: 'DEFAULT',
        maxChars: 4000,
      },
    )
    expect(out).toContain(`<ref:${a}>`)
    expect(out).toContain(`<ref:${b}>`)
    expect(out).toContain('alpha fact about the broker')
    expect(out).toContain('2023-05-08T13:56:00.000Z') // event_nodes.tau used verbatim for b
    expect(out).toMatch(new RegExp(`\\[<t:[^>]+> alpha fact about the broker <ref:${a}>\\]`))
  })

  it('POS/NEG salience budgeting: top-salience node kept VERBATIM, low-salience tail collapses to a brevity code (chars DROP)', () => {
    const big = (c: string) => c.repeat(60) // 60-char blocks so a small budget forces compression
    const n1 = addChunk(db, 'n1.md', 1000, big('A'))
    const n2 = addChunk(db, 'n2.md', 2000, big('B'))
    const n3 = addChunk(db, 'n3.md', 3000, big('C'))
    const n4 = addChunk(db, 'n4.md', 4000, big('D'))
    const results = [
      sr(n1, big('A'), 0.95),
      sr(n2, big('B'), 0.5),
      sr(n3, big('C'), 0.3),
      sr(n4, big('D'), 0.1),
    ]
    const full = synthesizeNarrativeContext(db, results, { intent: 'DEFAULT', maxChars: 100000 }) // no compression
    const budgeted = synthesizeNarrativeContext(db, results, { intent: 'DEFAULT', maxChars: 200 }) // forces compression
    expect(budgeted).toContain(big('A')) // POSITIVE control: the top-salience node is retained verbatim
    expect(budgeted).not.toContain(big('D')) // NEGATIVE control: the lowest-salience node's content is dropped
    expect(budgeted).toMatch(/intermediate event/i) // the low-salience tail collapsed into a brevity code
    expect(budgeted.length).toBeLessThan(full.length) // the efficiency mechanism: measurable char drop
    expect(budgeted).toMatch(new RegExp(`elided <ref:[^>]*\\b${n4}\\b`)) // elided node's id retained (not its content)
    expect(hasBrevityCode(budgeted)).toBe(true) // detector fires when compression triggered (POS)
    expect(hasBrevityCode(full)).toBe(false) // no overflow ⇒ no brevity code ⇒ detector silent (NEG)
  })

  it('WHY intent causally topo-orders the nodes (cause precedes effect via topologicalOrderCausalChains)', () => {
    const CAUSE = 'the review passed on the branch'
    const EFFECT = 'the branch was then auto-merged to main'
    const cause = addChunk(db, 'cause.md', 1000, CAUSE)
    const effect = addChunk(db, 'effect.md', 2000, EFFECT)
    persistCausalEdges(
      db,
      [{ causeKey: causalKey(CAUSE), effectKey: causalKey(EFFECT), confidence: 0.9 }],
      { minConfidence: 0.7, provider: 'mock' },
    )
    materializeCausalEdges(db) // direction 'both'
    // Feed the effect FIRST + higher salience: only the causal topo-sort can put the cause ahead of it.
    const out = synthesizeNarrativeContext(db, [sr(effect, EFFECT, 0.9), sr(cause, CAUSE, 0.4)], {
      intent: 'WHY',
      maxChars: 4000,
    })
    expect(out.indexOf(CAUSE)).toBeGreaterThanOrEqual(0)
    expect(out.indexOf(CAUSE)).toBeLessThan(out.indexOf(EFFECT)) // cause before effect
  })

  it('WHEN intent orders nodes chronologically by τ ascending', () => {
    const later = addChunk(db, 'later.md', 3000, 'the later event happened')
    const earlier = addChunk(db, 'earlier.md', 1000, 'the earlier event happened')
    // Feed later first + higher salience: only the τ sort can put the earlier event ahead.
    const out = synthesizeNarrativeContext(
      db,
      [sr(later, 'the later event happened', 0.9), sr(earlier, 'the earlier event happened', 0.4)],
      {
        intent: 'WHEN',
        maxChars: 4000,
      },
    )
    expect(out.indexOf('the earlier event happened')).toBeLessThan(
      out.indexOf('the later event happened'),
    )
  })

  it('returns "" for an all-empty result set', () => {
    expect(synthesizeNarrativeContext(db, [], { intent: 'DEFAULT', maxChars: 4000 })).toBe('')
  })
})

// ── T027 — Briefing budget: serialize ALL of Visited (Alg 1 L22-23) → Eq-7 salience TOKEN budget with
// ANCHOR PROTECTION. The magma arm must AUGMENT (anchors PLUS the reached typed nodes) rather than SWAP one
// node under topK=5. Stage-4 keeps every Stage-1 anchor (isAnchor) verbatim regardless of its low cumulative
// beam score, fills the remaining TOKEN budget by Eq-5 salience, and elides the low-salience NON-anchor tail.
describe('synthesizeNarrativeContext — T027 token budget + anchor protection (Eq. 7)', () => {
  let db: Database.Database
  beforeEach(() => {
    db = openMemoryDb(':memory:')
  })
  afterEach(() => closeMemoryDb(db))

  const srA = (
    chunkId: number,
    content: string,
    score: number,
    isAnchor: boolean,
  ): SearchResult => ({
    chunkId,
    filePath: `f${chunkId}.md`,
    content,
    score,
    vectorScore: 0,
    keywordScore: 0,
    chunkIndex: 0,
    ...(isAnchor ? { isAnchor: true } : {}),
  })
  const big = (c: string): string => c.repeat(60)

  it('RED T027: a low-salience ANCHOR is protected from the token budget; a low-salience non-anchor tail elides', () => {
    const anchor = addChunk(db, 'anchor.md', 1000, big('A'))
    const causal = addChunk(db, 'causal.md', 2000, big('C'))
    const tail = addChunk(db, 'tail.md', 3000, big('B'))
    const results = [
      srA(anchor, big('A'), 0.01, true), // ANCHOR, LOWEST cumulative beam score
      srA(causal, big('C'), 5.0, false), // reached typed node, HIGH Eq-5 salience
      srA(tail, big('B'), 0.02, false), // non-anchor low-salience tail (score > anchor's!)
    ]
    // Token budget with room for ~2 nodes. Without anchor protection the low-score anchor elides FIRST.
    const budgeted = synthesizeNarrativeContext(db, results, { intent: 'DEFAULT', maxTokens: 60 })
    expect(budgeted).toContain(big('A')) // POS: anchor kept verbatim DESPITE lowest salience (protected)
    expect(budgeted).toContain(big('C')) // the high-salience reached node is kept (augment)
    expect(budgeted).not.toContain(big('B')) // NEG: the low-salience NON-anchor tail is elided
    expect(hasBrevityCode(budgeted)).toBe(true)
    expect(budgeted).toMatch(new RegExp(`elided <ref:[^>]*\\b${tail}\\b`)) // elided id retained, content dropped
  })

  it('NEG T027: with NO anchor flag the same lowest-salience node is NOT protected (it elides under budget)', () => {
    const low = addChunk(db, 'low.md', 1000, big('A'))
    const hi = addChunk(db, 'hi.md', 2000, big('C'))
    const mid = addChunk(db, 'mid.md', 3000, big('B'))
    const results = [
      srA(low, big('A'), 0.01, false), // NOT flagged as an anchor
      srA(hi, big('C'), 5.0, false),
      srA(mid, big('B'), 0.02, false),
    ]
    const budgeted = synthesizeNarrativeContext(db, results, { intent: 'DEFAULT', maxTokens: 60 })
    expect(budgeted).toContain(big('C')) // highest salience kept
    expect(budgeted).not.toContain(big('A')) // NEG: lowest-salience non-anchor elided (no protection)
  })

  it('maxTokens budgets by TOKENS not chars: a block that fits maxChars still compresses under a small maxTokens', () => {
    const n1 = addChunk(db, 'n1.md', 1000, big('A'))
    const n2 = addChunk(db, 'n2.md', 2000, big('B'))
    const n3 = addChunk(db, 'n3.md', 3000, big('C'))
    const results = [srA(n1, big('A'), 0.9, false), srA(n2, big('B'), 0.5, false), srA(n3, big('C'), 0.1, false)]
    // maxChars is huge (no char compression) — only the TOKEN budget can force the elision.
    const full = synthesizeNarrativeContext(db, results, { intent: 'DEFAULT', maxChars: 100000 })
    const tokenBudgeted = synthesizeNarrativeContext(db, results, {
      intent: 'DEFAULT',
      maxChars: 100000,
      maxTokens: 30,
    })
    expect(hasBrevityCode(full)).toBe(false) // no char overflow ⇒ no compression
    expect(hasBrevityCode(tokenBudgeted)).toBe(true) // the TOKEN budget compressed it
    expect(tokenBudgeted.length).toBeLessThan(full.length)
  })
})

describe('retrieveContext — T027 magma AUGMENTS (traverse + synthesize serialize-all-visited + maxTokens)', () => {
  let db: Database.Database
  // Isolate the causal dimension so only causal-edge nodes are reached (deterministic augment).
  const CAUSAL_ONLY = {
    ENTITY: { entity: 0, semantic: 0, temporal: 0, causal: 4 },
    WHY: { entity: 0, semantic: 0, temporal: 0, causal: 4 },
    WHEN: { entity: 0, semantic: 0, temporal: 0, causal: 4 },
    DEFAULT: { entity: 0, semantic: 0, temporal: 0, causal: 4 },
  } as const
  beforeEach(() => {
    db = openMemoryDb(':memory:')
  })
  afterEach(() => closeMemoryDb(db))

  const linkCausal = (src: number, dst: number): void => {
    db.prepare(
      `INSERT INTO memory_edges (src_chunk, edge_type, dst_chunk, source) VALUES (?, 'causal', ?, 'test')`,
    ).run(src, dst)
  }

  it('RED T027: the magma briefing contains the anchors AND >=2 reached causal chunks (augment, not a topK=5 swap)', async () => {
    const aC = ['ANCHORONE journey', 'ANCHORTWO journey', 'ANCHORTHREE journey', 'ANCHORFOUR journey', 'ANCHORFIVE journey']
    const anchors = aC.map((c, i) => addChunk(db, `a${i}.md`, 1000 + i, c))
    const cC = ['CAUSALONE the collaboration inspired it', 'CAUSALTWO the funding unlocked it', 'CAUSALTHREE the invitation set the date']
    const causal = cC.map((c, i) => addChunk(db, `c${i}.md`, 2000 + i, c))
    linkCausal(anchors[0]!, causal[0]!)
    linkCausal(anchors[1]!, causal[1]!)
    linkCausal(anchors[2]!, causal[2]!)
    const base: BaseSearch = async (_q, k) =>
      anchors.slice(0, k).map((id, i) => ({
        chunkId: id,
        filePath: `a${i}.md`,
        content: aC[i]!,
        score: 1,
        vectorScore: 0,
        keywordScore: 1,
        chunkIndex: 0,
      }))
    const simTable: Record<number, number> = {
      [anchors[0]!]: 0.82,
      [anchors[1]!]: 0.8,
      [anchors[2]!]: 0.78,
      [anchors[3]!]: 0.76,
      [anchors[4]!]: 0.75,
      [causal[0]!]: 0.7,
      [causal[1]!]: 0.69,
      [causal[2]!]: 0.68,
    }
    const out = await retrieveContext(
      db,
      'why was the journey inspired',
      {
        intentRouting: false,
        traverse: true,
        synthesize: true,
        traversalOptions: { maxDepth: 1, budget: 200, intentWeights: CAUSAL_ONLY },
        maxTokens: 3000,
        topK: 5,
      },
      {
        baseSearch: base,
        makeSemanticRelevanceScorer: () => (ids: readonly number[]) =>
          new Map(ids.map((id) => [id, simTable[id] ?? 0])),
      },
    )
    // AUGMENT: the full Visited subgraph flows to Stage-4 — all three reached causal chunks appear alongside
    // the anchors, not a single-swap 5-node briefing.
    for (const c of cC) expect(out.text).toContain(c.split(' ')[0]!) // CAUSALONE / CAUSALTWO / CAUSALTHREE
    expect(out.text).toContain('ANCHORONE')
    expect(out.chunkIds.length).toBeGreaterThanOrEqual(8) // 5 anchors ∪ 3 causal (serialize all Visited)
  })

  it('Increment-2 full-context arm: explicit returnBudget serializes ALL Visited as PLAIN context (no Eq-7), same subgraph as magma', async () => {
    const anchors = ['ANCHORONE journey', 'ANCHORTWO journey', 'ANCHORTHREE journey'].map((c, i) =>
      addChunk(db, `a${i}.md`, 1000 + i, c),
    )
    const causal = ['CAUSALONE reason', 'CAUSALTWO reason'].map((c, i) => addChunk(db, `c${i}.md`, 2000 + i, c))
    linkCausal(anchors[0]!, causal[0]!)
    linkCausal(anchors[1]!, causal[1]!)
    const base: BaseSearch = async (_q, k) =>
      anchors.slice(0, k).map((id, i) => ({
        chunkId: id,
        filePath: `a${i}.md`,
        content: `ANCHOR${i} journey`,
        score: 1,
        vectorScore: 0,
        keywordScore: 1,
        chunkIndex: 0,
      }))
    const simTable: Record<number, number> = {
      [anchors[0]!]: 0.82,
      [anchors[1]!]: 0.8,
      [anchors[2]!]: 0.78,
      [causal[0]!]: 0.7,
      [causal[1]!]: 0.69,
    }
    const out = await retrieveContext(
      db,
      'why was the journey inspired',
      {
        intentRouting: false,
        traverse: true,
        synthesize: false, // full-context arm = plain join, NO Eq-7 ordering/budget
        returnBudget: 200, // …but still the FULL Visited subgraph (same as magma)
        traversalOptions: { maxDepth: 1, budget: 200, intentWeights: CAUSAL_ONLY },
        maxChars: 100000, // huge cap ⇒ nothing truncated (the "full context" baseline)
        topK: 5,
      },
      {
        baseSearch: base,
        makeSemanticRelevanceScorer: () => (ids: readonly number[]) =>
          new Map(ids.map((id) => [id, simTable[id] ?? 0])),
      },
    )
    expect(out.text).not.toContain('<ref:') // NO Eq-7 provenance scaffold (plain full context)
    expect(out.chunkIds.length).toBeGreaterThanOrEqual(5) // 3 anchors ∪ 2 causal — same subgraph, unordered
    expect(out.text).toContain('CAUSALONE')
    expect(out.text).toContain('CAUSALTWO')
  })
})

describe('retrieveContext — synthesize lever (Stage 4, default-OFF byte-identical)', () => {
  let db: Database.Database
  beforeEach(() => {
    db = openMemoryDb(':memory:')
    addChunk(db, 's1.md', 1000, 'the broker booted and read its config')
    addChunk(db, 's2.md', 2000, 'the indexer ran a pass')
    rebuildMemoryEdges(db)
  })
  afterEach(() => closeMemoryDb(db))

  it('synthesize:false (default) is BYTE-IDENTICAL to formatRetrievedContext(join.slice) — prod path untouched', async () => {
    const base = sentinelBase('the broker booted and read its config', 1)
    const off = await retrieveContext(db, 'broker', { intentRouting: false }, { baseSearch: base })
    // Reconstruct today's plain-join output for the SAME retrieved results.
    const results = await base('broker', 5)
    expect(off.text).toBe(formatRetrievedContext(results, 4000))
    expect(off.text).not.toContain('<ref:') // no scaffold when synthesize is off
  })

  it('synthesize:true emits the Eq-7 provenance scaffold', async () => {
    const base = sentinelBase('the broker booted and read its config', 1)
    const on = await retrieveContext(
      db,
      'broker',
      { intentRouting: false, synthesize: true },
      { baseSearch: base },
    )
    expect(on.text).toContain('<ref:1>')
    expect(on.text).toContain('<t:')
    expect(on.text).toContain('the broker booted and read its config')
  })
})

// The `multiHop` lever wires retrieveContext → intentAwareSearch({multiHop}) → multiHopIterativeSearch
// (C2, the beyond-MAGMA iterative arm). WIRING only; the loop's mechanics live in multihop-iterative.test.ts.
describe('retrieveContext — multiHop lever wires the C2 iterative arm', () => {
  let db: Database.Database
  beforeEach(() => {
    db = openMemoryDb(':memory:')
  })
  afterEach(() => closeMemoryDb(db))

  it('multiHop:true issues follow-up queries and folds bridge finds into the context (+ levers logged)', async () => {
    const c1 = addChunk(db, 'a.md', 1000, 'Mel talked to Bob about the trip')
    const c2 = addChunk(db, 'b.md', 2000, 'Bob organized the Yosemite trip')
    const bob = db
      .prepare(`INSERT INTO memory_entities (name, kind) VALUES ('Bob', 'concept')`)
      .run().lastInsertRowid as number
    for (const c of [c1, c2])
      db.prepare(
        `INSERT INTO memory_edges (src_chunk, edge_type, dst_entity, source) VALUES (?, 'entity', ?, 'gazetteer')`,
      ).run(c, bob)
    const q = 'What trip did Mel discuss?'
    const calls: string[] = []
    const base: BaseSearch = async (qq, k) => {
      calls.push(qq)
      const hit = (id: number, path: string, content: string) => ({
        chunkId: id,
        filePath: path,
        content,
        score: 1,
        vectorScore: 0,
        keywordScore: 1,
        chunkIndex: 0,
      })
      if (qq === q) return [hit(c1, 'a.md', 'Mel talked to Bob about the trip')].slice(0, k)
      if (qq === `Bob ${q}`) return [hit(c2, 'b.md', 'Bob organized the Yosemite trip')].slice(0, k)
      return []
    }
    const store = openExperienceStore(':memory:')
    const r = await retrieveContext(
      db,
      q,
      { intentRouting: false, multiHop: true, multiHopOptions: { innerSearch: 'base' } },
      { baseSearch: base, experienceLog: { store, episode: { conversationId: 'conv-t' } } },
    )
    expect(calls).toContain(`Bob ${q}`) // the iterative loop ran through the prod funnel
    expect(r.text).toContain('Yosemite') // the bridge find made it into the injected block
    const row = store.db
      .prepare(`SELECT retriever, flag_state FROM retrieval_experience WHERE id = ?`)
      .get(r.experienceId) as { retriever: string; flag_state: string }
    expect(row.retriever).toBe('magma')
    expect(JSON.parse(row.flag_state)).toMatchObject({ multiHop: true })
    store.close()
  })
})

// ── STAGE ATTRIBUTION ────────────────────────────────────────────────────────────────────────────
// `latency_ms` wrapped only intentAwareSearch, with no breakdown, so a slow briefing could not be
// attributed to a stage — and it EXCLUDED synthesis, meaning the recorded time understated what the
// client actually waited for. These pin the breakdown that makes the p90 tail attributable.
describe('stage timings — the retrieval tail must be attributable, not guessed', () => {
  it('makeTimedScorer accumulates elapsed ms and call count without changing the result', async () => {
    const inner = async (ids: readonly number[]) => new Map(ids.map((i) => [i, i / 10]))
    const acc = { ms: 0, calls: 0 }
    const timed = makeTimedScorer(inner, acc)
    const out = await timed([1, 2, 3])
    expect(out).toEqual(new Map([
      [1, 0.1],
      [2, 0.2],
      [3, 0.3],
    ]))
    expect(acc.calls).toBe(1)
    expect(acc.ms).toBeGreaterThanOrEqual(0)
    await timed([4])
    expect(acc.calls).toBe(2)
  })

  it('is FAIL-SAFE: a throwing scorer still records the call and propagates the original error', async () => {
    const boom = async () => {
      throw new Error('scorer exploded')
    }
    const acc = { ms: 0, calls: 0 }
    const timed = makeTimedScorer(boom, acc)
    await expect(timed([1])).rejects.toThrow('scorer exploded')
    expect(acc.calls).toBe(1)
  })

  it('records a stage breakdown on the experience row, and total covers synthesis', async () => {
    const db = openMemoryDb(':memory:')
    const store = openExperienceStore(':memory:')
    const base = async () => [
      {
        chunkId: 1,
        filePath: 'a.md',
        content: 'Bob organized the Yosemite trip with Mel in June',
        score: 1,
        vectorScore: 0,
        keywordScore: 1,
        chunkIndex: 0,
      },
    ]
    const r = await retrieveContext(
      db,
      'who organized the trip',
      { intentRouting: false, synthesize: true },
      { baseSearch: base, experienceLog: { store, episode: { conversationId: 'conv-stage' } } },
    )
    const row = store.db
      .prepare(`SELECT stage_timings FROM retrieval_experience WHERE id = ?`)
      .get(r.experienceId) as { stage_timings: string | null }
    expect(row.stage_timings).not.toBeNull()
    const t = JSON.parse(row.stage_timings as string) as Record<string, number>
    for (const k of ['searchMs', 'semanticMs', 'semanticCalls', 'synthMs', 'totalMs']) {
      expect(typeof t[k]).toBe('number')
    }
    // The whole point: total is what the human waited for, so it cannot be less than the search leg.
    expect(t.totalMs).toBeGreaterThanOrEqual(t.searchMs as number)
    db.close()
    store.close()
  })
})

// ── T009/T013 [US1] (specs/001-learning-memory-loop) — synthesis fidelity + env lever ────────────
describe('T009 — narrative-synthesis fidelity: 100% provenance, budget ≪ full join, env lever', () => {
  let db: Database.Database
  const CONTENTS = [
    'the broker booted and read its config from disk after the restart completed',
    'the indexer ran a full pass over the vault and rebuilt every stale chunk row',
    'the kernel audit chain was verified end to end with zero broken rows found',
    'the embedding worker warmed its model cache and answered the first request',
    'the scheduler resumed the soak run and appended its evidence file cleanly',
  ]
  let ids: number[] = []
  beforeEach(() => {
    db = openMemoryDb(':memory:')
    ids = CONTENTS.map((c, i) => addChunk(db, `t9-${i}.md`, 1000 * (i + 1), c))
    rebuildMemoryEdges(db)
  })
  afterEach(() => closeMemoryDb(db))

  const multiBase: BaseSearch = async (_q, k) =>
    ids
      .map((chunkId, i) => ({
        chunkId,
        filePath: `t9-${i}.md`,
        content: CONTENTS[i]!,
        score: 1 - i * 0.1,
        vectorScore: 0,
        keywordScore: 1,
        chunkIndex: 0,
      }))
      .slice(0, k)

  it('FIDELITY: every retrieved item is source-attributed — a <ref:id> for 100% of chunk ids, kept or elided', async () => {
    const out = await retrieveContext(
      db,
      'broker',
      { intentRouting: false, synthesize: true, maxChars: 220 },
      { baseSearch: multiBase },
    )
    for (const id of ids) {
      expect(out.text).toMatch(new RegExp(`<ref:[^>]*\\b${id}\\b`)) // attributed even when elided
    }
  })

  it('FIDELITY (SC-004 shape): the budgeted briefing is a small fraction of the full-context join', async () => {
    const fullJoin = CONTENTS.join('\n\n') // what full-context injection would carry for these items
    const out = await retrieveContext(
      db,
      'broker',
      { intentRouting: false, synthesize: true, maxChars: 220 },
      { baseSearch: multiBase },
    )
    expect(out.text.length).toBeLessThan(fullJoin.length / 1.5) // materially fewer chars ⇒ fewer tokens
    expect(out.text.length).toBeGreaterThan(0)
  })

  it('T013: SCNS_NARRATIVE_SYNTHESIS=1 turns the lever ON when config omits synthesize', async () => {
    process.env.SCNS_NARRATIVE_SYNTHESIS = '1'
    try {
      const on = await retrieveContext(db, 'broker', { intentRouting: false }, { baseSearch: multiBase })
      expect(on.text).toContain('<ref:')
    } finally {
      delete process.env.SCNS_NARRATIVE_SYNTHESIS
    }
  })

  it('T013 NEGATIVE control: env unset ⇒ byte-identical plain join; explicit synthesize:false beats env=1', async () => {
    const results = await multiBase('broker', 5)
    const off = await retrieveContext(db, 'broker', { intentRouting: false }, { baseSearch: multiBase })
    expect(off.text).toBe(formatRetrievedContext(results, 4000))
    expect(off.text).not.toContain('<ref:')

    process.env.SCNS_NARRATIVE_SYNTHESIS = '1'
    try {
      const forcedOff = await retrieveContext(
        db,
        'broker',
        { intentRouting: false, synthesize: false },
        { baseSearch: multiBase },
      )
      expect(forcedOff.text).toBe(formatRetrievedContext(results, 4000))
    } finally {
      delete process.env.SCNS_NARRATIVE_SYNTHESIS
    }
  })
})
