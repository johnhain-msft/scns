import { describe, it, expect } from 'vitest'
import {
  reciprocalRankFusion,
  fusedResultsToSearchResults,
  DEFAULT_RRF_K,
  type FusionSource,
  type RankedItem,
} from '../../../src/memory/fusion.js'

/** Build a RankedItem with a given id (content/path derived from the id for assertions). */
function item(id: number): RankedItem {
  return { chunkId: id, filePath: `f${id}.md`, content: `chunk-${id}`, chunkIndex: 0 }
}

/** Build a source from a weight + an ordered list of chunk ids. */
function source(name: string, weight: number, ids: readonly number[]): FusionSource {
  return { name, weight, items: ids.map(item) }
}

describe('reciprocalRankFusion (MAGMA Algorithm 1)', () => {
  describe('single source', () => {
    it('preserves the source order and normalises the top to 1.0', () => {
      const out = reciprocalRankFusion([source('hybrid', 1, [10, 20, 30])])
      expect(out.map((r) => r.chunkId)).toEqual([10, 20, 30])
      expect(out[0]!.score).toBe(1)
      // strictly decreasing normalised scores
      expect(out[1]!.score).toBeLessThan(out[0]!.score)
      expect(out[2]!.score).toBeLessThan(out[1]!.score)
    })

    it('emits the raw weighted RRF score = w / (k + rank)', () => {
      const out = reciprocalRankFusion([source('hybrid', 1, [10, 20])], { k: DEFAULT_RRF_K })
      expect(out[0]!.rrf).toBeCloseTo(1 / (DEFAULT_RRF_K + 1), 12)
      expect(out[1]!.rrf).toBeCloseTo(1 / (DEFAULT_RRF_K + 2), 12)
    })

    it('records the contributing source name(s) for provenance', () => {
      const out = reciprocalRankFusion([source('entity', 1, [5])])
      expect(out[0]!.sources).toEqual(['entity'])
    })
  })

  describe('multi-source aggregation (the fusion win)', () => {
    it('ranks a chunk present in TWO sources above one present in only ONE', () => {
      // 99 is rank-2 in hybrid AND rank-2 in entity; 10 is rank-1 in hybrid only.
      // RRF: 99 = 2 * 1/(k+2); 10 = 1/(k+1). With k=60: 99≈0.03226 > 10≈0.01639.
      const out = reciprocalRankFusion([
        source('hybrid', 1, [10, 99]),
        source('entity', 1, [20, 99]),
      ])
      expect(out[0]!.chunkId).toBe(99)
      expect(out[0]!.sources).toEqual(['hybrid', 'entity'])
      expect(out[0]!.rrf).toBeGreaterThan(out[1]!.rrf)
    })

    it('this is the flat-dump fix: a relevant+entity chunk beats a purely-entity chunk', () => {
      // Simulate the live bug: the entity neighborhood leads with noise (rank 1-2) and the
      // genuinely relevant chunk (BROKER_DB_PATH = id 7) sits LAST positionally. But it is
      // rank-1 in the hybrid relevance source. Fusion must surface it first.
      const hybrid = source('hybrid', 1, [7, 1])
      const entity = source('entity', 1, [101, 102, 7])
      const out = reciprocalRankFusion([hybrid, entity])
      expect(out[0]!.chunkId).toBe(7)
      // and the positional-only noise chunks rank below it
      const idsAbove7 = out.slice(0, out.findIndex((r) => r.chunkId === 7))
      expect(idsAbove7).toHaveLength(0)
    })

    it('respects per-source weights (a heavier source dominates a lighter one)', () => {
      // 10 leads the heavy source, 20 leads the light source. The heavy-source leader wins.
      const out = reciprocalRankFusion([
        source('hybrid', 2, [10]),
        source('semantic', 0.1, [20]),
      ])
      expect(out[0]!.chunkId).toBe(10)
      expect(out[0]!.rrf).toBeCloseTo(2 / (DEFAULT_RRF_K + 1), 12)
      expect(out[1]!.rrf).toBeCloseTo(0.1 / (DEFAULT_RRF_K + 1), 12)
    })

    it('skips a zero-weight source entirely (no contribution, no provenance)', () => {
      const out = reciprocalRankFusion([
        source('hybrid', 1, [10]),
        source('temporal', 0, [10, 20]),
      ])
      expect(out.map((r) => r.chunkId)).toEqual([10])
      expect(out[0]!.sources).toEqual(['hybrid'])
    })
  })

  describe('within-source de-duplication', () => {
    it('counts a repeated chunk once at its best (earliest) rank', () => {
      // 10 appears at rank 1 and rank 3 in the same source — must be counted once at rank 1.
      const out = reciprocalRankFusion([source('hybrid', 1, [10, 20, 10])])
      expect(out.map((r) => r.chunkId)).toEqual([10, 20])
      expect(out[0]!.rrf).toBeCloseTo(1 / (DEFAULT_RRF_K + 1), 12)
      // 20 is the SECOND distinct chunk ⇒ rank 2 (the duplicate did not advance the rank)
      expect(out[1]!.rrf).toBeCloseTo(1 / (DEFAULT_RRF_K + 2), 12)
    })
  })

  describe('sentinel / synthetic id handling', () => {
    it('skips chunkId <= 0 (e.g. unresolved rationale-only causal chains)', () => {
      const out = reciprocalRankFusion([
        { name: 'causal', weight: 1, items: [item(-1), item(0), item(42)] },
      ])
      expect(out.map((r) => r.chunkId)).toEqual([42])
      // 42 was the FIRST real chunk ⇒ rank 1 (sentinels did not advance the rank)
      expect(out[0]!.rrf).toBeCloseTo(1 / (DEFAULT_RRF_K + 1), 12)
    })
  })

  describe('beam + limit', () => {
    it('beamWidth caps how many candidates each source contributes', () => {
      // With beamWidth 2, only ids 10,20 from the source count; 30,40 are dropped.
      const out = reciprocalRankFusion([source('hybrid', 1, [10, 20, 30, 40])], {
        beamWidth: 2,
      })
      expect(out.map((r) => r.chunkId)).toEqual([10, 20])
    })

    it('limit caps the fused output size', () => {
      const out = reciprocalRankFusion([source('hybrid', 1, [10, 20, 30, 40])], { limit: 2 })
      expect(out.map((r) => r.chunkId)).toEqual([10, 20])
    })
  })

  describe('determinism + edge cases', () => {
    it('tie-breaks equal scores by best rank then chunk id', () => {
      // Two singleton sources each contributing one rank-1 chunk ⇒ equal rrf.
      // Tie-break: equal bestRank (1) ⇒ lower chunkId first.
      const out = reciprocalRankFusion([source('a', 1, [50]), source('b', 1, [9])])
      expect(out.map((r) => r.chunkId)).toEqual([9, 50])
      expect(out[0]!.rrf).toBeCloseTo(out[1]!.rrf, 12)
    })

    it('a larger k flattens the contribution curve (later ranks matter relatively more)', () => {
      const small = reciprocalRankFusion([source('h', 1, [10, 20])], { k: 1 })
      const large = reciprocalRankFusion([source('h', 1, [10, 20])], { k: 1000 })
      // rank-2/rank-1 ratio is closer to 1 for large k
      const ratioSmall = small[1]!.rrf / small[0]!.rrf
      const ratioLarge = large[1]!.rrf / large[0]!.rrf
      expect(ratioLarge).toBeGreaterThan(ratioSmall)
    })

    it('returns [] for no sources / empty sources / all-sentinel sources', () => {
      expect(reciprocalRankFusion([])).toEqual([])
      expect(reciprocalRankFusion([source('h', 1, [])])).toEqual([])
      expect(
        reciprocalRankFusion([{ name: 'c', weight: 1, items: [item(-1), item(0)] }]),
      ).toEqual([])
    })
  })

  describe('fusedResultsToSearchResults', () => {
    it('maps fused rows to SearchResult with zeroed vector/keyword components', () => {
      const fused = reciprocalRankFusion([source('hybrid', 1, [10, 20])])
      const rows = fusedResultsToSearchResults(fused)
      expect(rows.map((r) => r.chunkId)).toEqual([10, 20])
      expect(rows[0]!.score).toBe(1)
      expect(rows.every((r) => r.vectorScore === 0 && r.keywordScore === 0)).toBe(true)
      expect(rows[0]!.filePath).toBe('f10.md')
      expect(rows[0]!.content).toBe('chunk-10')
    })
  })
})
