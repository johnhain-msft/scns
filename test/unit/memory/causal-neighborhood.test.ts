import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openMemoryDb, closeMemoryDb } from '../../../src/memory/db.js'
import { causalKey } from '../../../src/memory/causal-edges.js'
import {
  causalNeighborhood,
  formatCausalChain,
  topologicalOrderCausalChains,
  type CausalChain,
} from '../../../src/memory/causal-neighborhood.js'
import type Database from 'better-sqlite3'

function addChunk(db: Database.Database, path: string, content: string, chunkIndex = 0): number {
  db.prepare(
    `INSERT INTO vault_files (path, mtime_ms, size_bytes) VALUES (?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET mtime_ms = excluded.mtime_ms`,
  ).run(path, 1000, content.length)
  return db
    .prepare(
      `INSERT INTO chunks (file_path, chunk_index, content, start_offset, end_offset, token_count)
       VALUES (?, ?, ?, 0, ?, 1)`,
    )
    .run(path, chunkIndex, content, content.length).lastInsertRowid as number
}

function addCausal(
  db: Database.Database,
  causeContent: string,
  effectContent: string,
  opts: { entity: string | null; confidence: number; rationale?: string | null; provider?: string },
): void {
  db.prepare(
    `INSERT INTO memory_causal (cause_key, effect_key, entity, rationale, confidence, provider)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    causalKey(causeContent),
    causalKey(effectContent),
    opts.entity,
    opts.rationale ?? null,
    opts.confidence,
    opts.provider ?? 'acp',
  )
}

describe('causalNeighborhood (M1.3 WHY reader)', () => {
  let db: Database.Database

  beforeEach(() => {
    db = openMemoryDb(':memory:')
  })
  afterEach(() => closeMemoryDb(db))

  it('returns [] for an unknown (non-gazetteer) entity name', () => {
    expect(causalNeighborhood(db, 'not-a-real-entity')).toEqual([])
  })

  it('returns [] for a known entity with no causal edges', () => {
    addChunk(db, 'a.md', 'the broker started up cleanly')
    expect(causalNeighborhood(db, 'broker')).toEqual([])
  })

  it('returns the entity causal chains, resolving cause/effect content from live chunks', () => {
    const cause = 'the broker lock file was left stale after a crash'
    const effect = 'the broker refused to start and logged ELOCKED'
    const cId = addChunk(db, 'cause.md', cause)
    const eId = addChunk(db, 'effect.md', effect)
    addCausal(db, cause, effect, {
      entity: 'broker',
      confidence: 0.9,
      rationale: 'stale lock blocked startup',
    })

    const chains = causalNeighborhood(db, 'broker')
    expect(chains).toHaveLength(1)
    const c = chains[0]!
    expect(c.entity).toBe('broker')
    expect(c.confidence).toBe(0.9)
    expect(c.rationale).toBe('stale lock blocked startup')
    expect(c.causeContent).toBe(cause)
    expect(c.effectContent).toBe(effect)
    expect(c.causeChunkId).toBe(cId)
    expect(c.effectChunkId).toBe(eId)
    expect(c.causeKey).toBe(causalKey(cause))
    expect(c.effectKey).toBe(causalKey(effect))
  })

  it('resolves via an alias (vault.db → vault) and orders by confidence DESC', () => {
    addCausal(db, 'cause low', 'effect low', { entity: 'vault', confidence: 0.71 })
    addCausal(db, 'cause high', 'effect high', { entity: 'vault', confidence: 0.95 })
    // queried by the alias 'vault.db' (canonicalizes to 'vault')
    const chains = causalNeighborhood(db, 'vault.db')
    expect(chains.map((c) => c.confidence)).toEqual([0.95, 0.71])
  })

  it('caps to the top-N highest-confidence edges with limit', () => {
    addCausal(db, 'c1', 'e1', { entity: 'broker', confidence: 0.99 })
    addCausal(db, 'c2', 'e2', { entity: 'broker', confidence: 0.85 })
    addCausal(db, 'c3', 'e3', { entity: 'broker', confidence: 0.72 })
    const chains = causalNeighborhood(db, 'broker', { limit: 2 })
    expect(chains.map((c) => c.confidence)).toEqual([0.99, 0.85])
  })

  it('only returns edges anchored on the queried entity', () => {
    addCausal(db, 'bx', 'by', { entity: 'broker', confidence: 0.8 })
    addCausal(db, 'ix', 'iy', { entity: 'indexer', confidence: 0.8 })
    const chains = causalNeighborhood(db, 'broker')
    expect(chains).toHaveLength(1)
    expect(chains[0]!.causeKey).toBe(causalKey('bx'))
  })

  it('re-chunk safety: an edge whose chunks were re-chunked away still surfaces (content empty, rationale carried)', () => {
    // No chunks for this cause/effect text — simulates content re-chunked under new ids.
    addCausal(db, 'old cause text', 'old effect text', {
      entity: 'broker',
      confidence: 0.88,
      rationale: 'the only surviving explanation',
    })
    const chains = causalNeighborhood(db, 'broker')
    expect(chains).toHaveLength(1)
    const c = chains[0]!
    expect(c.causeContent).toBe('')
    expect(c.effectContent).toBe('')
    expect(c.causeChunkId).toBeNull()
    expect(c.effectChunkId).toBeNull()
    expect(c.rationale).toBe('the only surviving explanation')
  })
})

describe('formatCausalChain', () => {
  const base: CausalChain = {
    causeKey: 'k1',
    effectKey: 'k2',
    entity: 'broker',
    rationale: null,
    confidence: 0.9,
    causeContent: '',
    effectContent: '',
    causeChunkId: null,
    effectChunkId: null,
  }

  it('joins cause + effect with a causal arrow and appends the rationale', () => {
    const out = formatCausalChain({
      ...base,
      causeContent: 'stale lock',
      effectContent: 'startup refused',
      rationale: 'lock blocked it',
    })
    expect(out).toContain('stale lock')
    expect(out).toContain('→ led to →')
    expect(out).toContain('startup refused')
    expect(out).toContain('Why: lock blocked it')
  })

  it('falls back to the effect alone when the cause is unresolved', () => {
    const out = formatCausalChain({ ...base, effectContent: 'startup refused' })
    expect(out).toBe('startup refused')
  })

  it('surfaces a rationale-only edge (both sides re-chunked away)', () => {
    const out = formatCausalChain({ ...base, rationale: 'the explanation' })
    expect(out).toBe('Why: the explanation')
  })

  it('returns "" when the chain carries no usable text at all', () => {
    expect(formatCausalChain(base)).toBe('')
  })
})

describe('topologicalOrderCausalChains (WS-2b — paper Stage 4 cause-ordering)', () => {
  const chain = (causeKey: string, effectKey: string, confidence: number): CausalChain => ({
    causeKey,
    effectKey,
    entity: 'broker',
    rationale: null,
    confidence,
    causeContent: `cause:${causeKey}`,
    effectContent: `effect:${effectKey}`,
    causeChunkId: null,
    effectChunkId: null,
  })

  it('POS: recovers cause→effect order from a scrambled linear chain (beats confidence-only)', () => {
    // Linear causal story A→B→C→D as three edges, but with confidences that would MIS-order under a
    // confidence sort (B highest, then D-ish), and fed in scrambled order.
    const eAB = chain('kA', 'kB', 0.5)
    const eBC = chain('kB', 'kC', 0.9) // highest confidence — would come FIRST under confidence sort
    const eCD = chain('kC', 'kD', 0.7)
    const ordered = topologicalOrderCausalChains([eCD, eBC, eAB])
    expect(ordered.map((c) => `${c.causeKey}->${c.effectKey}`)).toEqual([
      'kA->kB',
      'kB->kC',
      'kC->kD',
    ])
    // Sanity: this DIFFERS from a pure confidence sort (which would lead with kB->kC).
    const byConfidence = [eCD, eBC, eAB]
      .slice()
      .sort((a, b) => b.confidence - a.confidence)
      .map((c) => `${c.causeKey}->${c.effectKey}`)
    expect(byConfidence[0]).toBe('kB->kC')
    expect(ordered.map((c) => `${c.causeKey}->${c.effectKey}`)[0]).toBe('kA->kB')
  })

  it('NEG: disjoint chains (no shared keys) fall back to deterministic (confidence desc) order', () => {
    const d1 = chain('x0', 'x1', 0.4)
    const d2 = chain('y0', 'y1', 0.8)
    const d3 = chain('z0', 'z1', 0.6)
    const ordered = topologicalOrderCausalChains([d1, d2, d3])
    // No edges among them ⇒ every node is a root ⇒ pure tie-break = confidence desc.
    expect(ordered.map((c) => c.confidence)).toEqual([0.8, 0.6, 0.4])
  })

  it('handles a fork (one cause, two effects) — the cause precedes both effects', () => {
    const root = chain('r', 'a', 0.5) // r → a
    const forkB = chain('a', 'b', 0.9) // a → b
    const forkC = chain('a', 'c', 0.6) // a → c
    const ordered = topologicalOrderCausalChains([forkC, forkB, root]).map(
      (c) => `${c.causeKey}->${c.effectKey}`,
    )
    expect(ordered[0]).toBe('r->a')
    expect(ordered.indexOf('r->a')).toBeLessThan(ordered.indexOf('a->b'))
    expect(ordered.indexOf('r->a')).toBeLessThan(ordered.indexOf('a->c'))
  })

  it('is cycle-safe and deterministic: a cycle terminates and returns all chains', () => {
    const c1 = chain('p', 'q', 0.5) // p → q
    const c2 = chain('q', 'p', 0.9) // q → p  (cycle)
    const a = topologicalOrderCausalChains([c1, c2])
    const b = topologicalOrderCausalChains([c1, c2])
    expect(a.length).toBe(2)
    expect(a.map((c) => c.causeKey)).toEqual(b.map((c) => c.causeKey)) // deterministic
  })

  it('returns the input unchanged for 0 or 1 chains', () => {
    expect(topologicalOrderCausalChains([])).toEqual([])
    const one = chain('a', 'b', 0.5)
    expect(topologicalOrderCausalChains([one])).toEqual([one])
  })
})
