import { describe, it, expect } from 'vitest'
import {
  isDiaId,
  parseDiaId,
  normalizeGold,
  recallAtK,
  allHopsRecallAtK,
  firstGoldRank,
  mrrFirstGold,
  mean,
  fractionTrue,
} from '../../../scripts/locomo-scoring.js'

// Anti-mistesting: every value below is HAND-computed from the LoCoMo turn-level scoring definition
// (one retrieved chunk = one ranked slot; gold = the evidence dia_id set; metrics are turn-level).

describe('locomo-scoring :: dia_id parsing', () => {
  it('parses D{session}:{turn}', () => {
    expect(parseDiaId('D2:8')).toEqual({ session: 2, turn: 8 })
    expect(parseDiaId('D10:1')).toEqual({ session: 10, turn: 1 })
  })
  it('throws on malformed ids', () => {
    expect(() => parseDiaId('X1:2')).toThrow()
    expect(() => parseDiaId('D1')).toThrow()
    expect(() => parseDiaId('D1:')).toThrow()
    expect(() => parseDiaId('')).toThrow()
  })
  it('isDiaId guards non-strings and bad shapes', () => {
    expect(isDiaId('D1:2')).toBe(true)
    expect(isDiaId('foo')).toBe(false)
    expect(isDiaId(5)).toBe(false)
    expect(isDiaId(null)).toBe(false)
    expect(isDiaId(undefined)).toBe(false)
  })
})

describe('locomo-scoring :: normalizeGold', () => {
  it('dedupes valid dia_ids, order-preserving, dropped=0', () => {
    expect(normalizeGold(['D1:2', 'D1:2', 'D2:3'])).toEqual({ gold: ['D1:2', 'D2:3'], dropped: 0 })
  })
  it('drops non-dia entries and counts them', () => {
    expect(normalizeGold(['D1:2', 'bogus', 42, 'D3:4'])).toEqual({
      gold: ['D1:2', 'D3:4'],
      dropped: 2,
    })
  })
  it('empty evidence ⇒ empty gold', () => {
    expect(normalizeGold([])).toEqual({ gold: [], dropped: 0 })
  })
})

describe('locomo-scoring :: recallAtK (turn-level)', () => {
  const ranked = ['D1:1', 'D2:3', 'D1:5', 'D4:2']
  const gold = ['D2:3', 'D4:2']
  it('recall@1 = 0 (top-1 is a non-gold turn)', () => {
    expect(recallAtK(ranked, gold, 1)).toBe(0)
  })
  it('recall@2 = 0.5 (one of two gold turns in top-2)', () => {
    expect(recallAtK(ranked, gold, 2)).toBe(0.5)
  })
  it('recall@3 = 0.5 (second gold turn is at rank 4, still out)', () => {
    expect(recallAtK(ranked, gold, 3)).toBe(0.5)
  })
  it('recall@4 = 1.0 (both gold turns retrieved)', () => {
    expect(recallAtK(ranked, gold, 4)).toBe(1)
  })
  it('duplicate slots collapse in the set AND consume k-slots', () => {
    // top-2 = {D2:3} (dup wastes a slot so D4:2 at rank 3 is unreached)
    expect(recallAtK(['D2:3', 'D2:3', 'D4:2'], gold, 2)).toBe(0.5)
    expect(recallAtK(['D2:3', 'D2:3', 'D4:2'], gold, 3)).toBe(1)
  })
  it('empty gold ⇒ 0 (defensive floor; harness filters these)', () => {
    expect(recallAtK(ranked, [], 5)).toBe(0)
  })
  it('k=0 ⇒ 0', () => {
    expect(recallAtK(ranked, gold, 0)).toBe(0)
  })
})

describe('locomo-scoring :: allHopsRecallAtK (the strict multi-hop metric)', () => {
  const ranked = ['D1:1', 'D2:3', 'D1:5', 'D4:2']
  const gold = ['D2:3', 'D4:2']
  it('false when not all gold in top-k', () => {
    expect(allHopsRecallAtK(ranked, gold, 2)).toBe(false)
    expect(allHopsRecallAtK(ranked, gold, 3)).toBe(false)
  })
  it('true when every gold turn is within top-k', () => {
    expect(allHopsRecallAtK(ranked, gold, 4)).toBe(true)
  })
  it('multi-session evidence requires BOTH sessions retrieved', () => {
    const g = ['D1:9', 'D2:11']
    const r = ['D2:11', 'D3:1', 'D1:9']
    expect(allHopsRecallAtK(r, g, 2)).toBe(false) // D1:9 at rank 3
    expect(allHopsRecallAtK(r, g, 3)).toBe(true)
    expect(recallAtK(r, g, 2)).toBe(0.5)
  })
  it('single-hop gold true once its one turn is in top-k', () => {
    expect(allHopsRecallAtK(ranked, ['D2:3'], 2)).toBe(true)
  })
  it('empty gold ⇒ false (unscorable floor)', () => {
    expect(allHopsRecallAtK(ranked, [], 5)).toBe(false)
  })
})

describe('locomo-scoring :: firstGoldRank / mrr', () => {
  it('rank of first gold turn (1-based)', () => {
    expect(firstGoldRank(['D1:1', 'D2:3', 'D4:2'], ['D4:2', 'D2:3'])).toBe(2)
    expect(mrrFirstGold(['D1:1', 'D2:3', 'D4:2'], ['D4:2', 'D2:3'])).toBeCloseTo(0.5, 10)
  })
  it('gold at rank 1 ⇒ mrr 1.0', () => {
    expect(mrrFirstGold(['D5:5', 'D1:1'], ['D5:5'])).toBe(1)
  })
  it('no gold retrieved ⇒ rank 0, mrr 0', () => {
    expect(firstGoldRank(['D1:1'], ['D9:9'])).toBe(0)
    expect(mrrFirstGold(['D1:1'], ['D9:9'])).toBe(0)
  })
  it('rank 3 ⇒ mrr 1/3', () => {
    expect(mrrFirstGold(['D1:1', 'D1:2', 'D7:7'], ['D7:7'])).toBeCloseTo(1 / 3, 10)
  })
})

describe('locomo-scoring :: macro-average helpers', () => {
  it('mean', () => {
    expect(mean([1, 0, 0.5])).toBeCloseTo(0.5, 10)
    expect(mean([])).toBe(0)
  })
  it('fractionTrue', () => {
    expect(fractionTrue([true, false, true, true])).toBe(0.75)
    expect(fractionTrue([])).toBe(0)
  })
})
