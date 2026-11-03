import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openMemoryDb, closeMemoryDb } from '../../../src/memory/db.js'
import {
  routeQueryArm,
  shouldSkipRetrieval,
  ROUTER_ARMS,
  DEFAULT_ROUTER_LAMBDA,
  ROUTER_DEEP_LAMBDA_CUTOFF,
} from '../../../src/memory/arm-router.js'
import type { GazetteerEntry } from '../../../src/memory/entities/gazetteer.js'
import type Database from 'better-sqlite3'

// ── C3 — deterministic router over the FAITHFUL arms (Adaptive-RAG complexity classifier recast +
// SKR-lite skip gate; PRIOR_ART §C). The router NEVER flips a default itself: it is a PURE POLICY
// evaluated OFFLINE by the arm-frontier gate (policy value vs always-hybrid, HCOPE LB); live routing
// stays exploit-only hybrid until John certifies + flips.

const GAZ: readonly GazetteerEntry[] = [
  { canonical: 'Mel', kind: 'concept', aliases: ['mel', 'melanie'] },
  { canonical: 'Bob', kind: 'concept', aliases: ['bob'] },
]

describe('shouldSkipRetrieval — SKR-lite cheap skip gate (conservative: only clear no-memory-need)', () => {
  it('skips bare greetings/acknowledgements', () => {
    for (const q of ['thanks', 'ok', 'hello', 'thank you!', 'got it', 'yes']) {
      expect(shouldSkipRetrieval(q), q).toBe(true)
    }
  })
  it('never skips a question or a contentful query', () => {
    for (const q of [
      'why did the deploy fail',
      'ok what did Mel say about the trip?',
      'thanks — and when is the meeting?',
      'update the config',
    ]) {
      expect(shouldSkipRetrieval(q), q).toBe(false)
    }
  })
  it('never skips empty/whitespace (nothing to answer either way — caller decides)', () => {
    expect(shouldSkipRetrieval('')).toBe(false)
    expect(shouldSkipRetrieval('   ')).toBe(false)
  })
})

describe('routeQueryArm — complexity-classified arm choice over the faithful arms', () => {
  let db: Database.Database
  beforeEach(() => {
    db = openMemoryDb(':memory:')
  })
  afterEach(() => closeMemoryDb(db))

  it('exposes exactly the faithful arm set with hybrid the incumbent', () => {
    expect(ROUTER_ARMS).toEqual(['hybrid', 'magma', 'multihop-iter'])
  })

  it('routes comparison / multi-entity queries to multihop-iter', () => {
    const d1 = routeQueryArm(db, 'What do both Mel and Bob have in common?', { gazetteer: GAZ })
    expect(d1.arm).toBe('multihop-iter')
    const d2 = routeQueryArm(db, 'Did Mel and Bob go to the same school?', { gazetteer: GAZ })
    expect(d2.arm).toBe('multihop-iter') // two distinct entity anchors ⇒ multi-hop shape
  })

  it('routes WHY (causal) queries to magma (Table 5: causal is the strongest single graph)', () => {
    const d = routeQueryArm(db, 'Why did Mel move to Portland?', { gazetteer: GAZ })
    expect(d.arm).toBe('magma')
  })

  it('routes WHEN (temporal) queries to magma (Table 5: temporal graph best on temporal Qs)', () => {
    const d = routeQueryArm(db, 'When did Mel start the pottery class?', { gazetteer: GAZ })
    expect(d.arm).toBe('magma')
  })

  it('defaults everything else to hybrid (the incumbent)', () => {
    for (const q of [
      'What instruments does Mel play?',
      'list open tickets',
      'pottery class details',
    ]) {
      expect(routeQueryArm(db, q, { gazetteer: GAZ }).arm, q).toBe('hybrid')
    }
  })

  it('a token-averse λ ≥ cutoff pins the deep arms back to hybrid (the single-λ trade-off knob)', () => {
    const q = 'Why did Mel move to Portland?'
    expect(routeQueryArm(db, q, { gazetteer: GAZ, lambda: ROUTER_DEEP_LAMBDA_CUTOFF }).arm).toBe(
      'hybrid',
    )
    expect(routeQueryArm(db, q, { gazetteer: GAZ, lambda: 0 }).arm).toBe('magma')
    expect(DEFAULT_ROUTER_LAMBDA).toBeLessThan(ROUTER_DEEP_LAMBDA_CUTOFF)
  })

  it('the skip gate short-circuits routing (skip ⇒ hybrid arm label, skipRetrieval true)', () => {
    const d = routeQueryArm(db, 'thanks', { gazetteer: GAZ })
    expect(d.skipRetrieval).toBe(true)
    expect(d.arm).toBe('hybrid')
  })

  it('is deterministic and carries its features + reason (attribution, trap #1)', () => {
    const a = routeQueryArm(db, 'Why did Mel move?', { gazetteer: GAZ })
    const b = routeQueryArm(db, 'Why did Mel move?', { gazetteer: GAZ })
    expect(a).toEqual(b)
    expect(a.reason).toBeTruthy()
    expect(a.features.intent).toBe('WHY')
    expect(a.features.entityCount).toBeGreaterThanOrEqual(1)
  })
})

// T049 [US4] `episodeAdvice` and its tests were DELETED with the dead CBR vertical (DP-F5, 2026-08-02):
// its only producer, `adviseFromEpisodes`/`similar-episode.ts`, had zero callers anywhere in src/, test/
// or scripts/, and its `(intent, target)` key was unmatchable (`target` NULL on all 2060 live rows).
// `routeQueryArm` itself is LIVE — `scripts/locomo-judge-harness.ts:2483` calls it as the C3
// router-as-policy arm of the arm-frontier gate — so only the unfeedable option was removed.
