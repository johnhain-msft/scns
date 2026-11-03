import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openMemoryDb, closeMemoryDb } from '../../../src/memory/db.js'
import { recordProposalOutcome } from '../../../src/memory/proposal-outcomes.js'
import { buildOutcomeCausalCandidates } from '../../../src/memory/outcome-causal-candidates.js'
import { causalKey } from '../../../src/memory/causal-edges.js'
import type Database from 'better-sqlite3'

function add(
  db: Database.Database,
  entity: string,
  title: string,
  verdict: string,
  rationale: string | null = null,
  family = 'fam',
): void {
  recordProposalOutcome(db, {
    entity,
    family,
    title,
    verdict,
    rationale: rationale ?? undefined,
    // distinct suggestionId per call so the UNIQUE(suggestion_id,entity,family) never collapses rows
    suggestionId: `${entity}-${title}-${Math.random().toString(36).slice(2)}`,
  })
}

describe('buildOutcomeCausalCandidates (event-level causal source)', () => {
  let db: Database.Database
  beforeEach(() => {
    db = openMemoryDb(':memory:')
  })
  afterEach(() => closeMemoryDb(db))

  it('returns [] when no entity has >= 2 outcomes', () => {
    add(db, 'broker', 'add retry backoff', 'implemented')
    add(db, 'indexer', 'prune orphans', 'merged')
    expect(buildOutcomeCausalCandidates(db)).toEqual([])
  })

  it('pairs an entity\u2019s chronologically-consecutive outcomes as cause\u2192effect', () => {
    add(db, 'broker', 'add retry backoff', 'implemented', 'flaky network')
    add(db, 'broker', 'retry backoff regressed latency', 'reverted', 'p99 spike')
    const out = buildOutcomeCausalCandidates(db)
    expect(out).toHaveLength(1)
    expect(out[0]!.entity).toBe('broker')
    expect(out[0]!.causeContent).toContain('add retry backoff')
    expect(out[0]!.causeContent).toContain('verdict: implemented')
    expect(out[0]!.effectContent).toContain('reverted')
    // stable content-hash keys (re-chunk-proof) + synthetic outcome provenance
    expect(out[0]!.causeKey).toBe(causalKey(out[0]!.causeContent))
    expect(out[0]!.causeFilePath).toMatch(/^proposal_outcomes#\d+$/)
    expect(out[0]!.effectFilePath).toMatch(/^proposal_outcomes#\d+$/)
  })

  it('chains N outcomes into N-1 consecutive pairs, per entity', () => {
    add(db, 'broker', 'o1', 'implemented')
    add(db, 'broker', 'o2', 'passed-gate')
    add(db, 'broker', 'o3', 'merged')
    const out = buildOutcomeCausalCandidates(db)
    expect(out).toHaveLength(2) // o1->o2, o2->o3
    expect(out.map((c) => c.effectContent.includes('o2') || c.effectContent.includes('o3'))).toEqual([true, true])
  })

  it('keeps entities separate (no cross-entity pairing)', () => {
    add(db, 'broker', 'broker-alpha', 'implemented')
    add(db, 'broker', 'broker-beta', 'merged')
    add(db, 'indexer', 'indexer-gamma', 'implemented')
    add(db, 'indexer', 'indexer-delta', 'reverted')
    const out = buildOutcomeCausalCandidates(db)
    expect(out).toHaveLength(2)
    expect(new Set(out.map((c) => c.entity))).toEqual(new Set(['broker', 'indexer']))
    // no pair mixes a broker outcome with an indexer outcome
    for (const c of out) {
      const text = `${c.causeContent} ${c.effectContent}`
      const mixed = text.includes('broker-') && text.includes('indexer-')
      expect(mixed).toBe(false)
    }
  })

  it('onlyVerdictTransitions drops same-verdict consecutive pairs', () => {
    add(db, 'broker', 'o1', 'implemented')
    add(db, 'broker', 'o2', 'implemented') // same verdict ⇒ dropped under transitions
    add(db, 'broker', 'o3', 'reverted') // verdict change ⇒ kept
    const all = buildOutcomeCausalCandidates(db)
    expect(all).toHaveLength(2)
    const transitions = buildOutcomeCausalCandidates(db, { onlyVerdictTransitions: true })
    expect(transitions).toHaveLength(1)
    expect(transitions[0]!.effectContent).toContain('reverted')
  })

  it('caps at maxCandidates and returns [] for maxCandidates <= 0', () => {
    add(db, 'broker', 'o1', 'implemented')
    add(db, 'broker', 'o2', 'passed-gate')
    add(db, 'broker', 'o3', 'merged')
    expect(buildOutcomeCausalCandidates(db, { maxCandidates: 1 })).toHaveLength(1)
    expect(buildOutcomeCausalCandidates(db, { maxCandidates: 0 })).toEqual([])
  })

  it('is side-effect-free when the proposal_outcomes table is absent', () => {
    const bare = openMemoryDb(':memory:')
    bare.exec('DROP TABLE IF EXISTS proposal_outcomes')
    expect(buildOutcomeCausalCandidates(bare)).toEqual([])
    closeMemoryDb(bare)
  })
})
