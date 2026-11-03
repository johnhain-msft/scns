/**
 * WS-2d — PURE, UNIT-TESTED retrieval-scoring for the LoCoMo multi-hop ruler.
 *
 * This module is deliberately DEPENDENCY-FREE (no `src/**` imports, no I/O, no side effects) so the
 * ruler's OWN correctness can be unit-tested with hand-checked fixtures BEFORE any harness number is
 * trusted (anti-mistesting). The harness (`locomo-multihop-harness.ts`) does the real retrieval, then
 * projects each retrieved chunk to its dialog-turn id (`dia_id`) and calls these functions.
 *
 * Scoring is done at the TURN (`dia_id`) level:
 *   - `ranked`  = dialog-turn ids in retrieval order (top-1 first). One retrieved CHUNK = one slot;
 *                 if several chunks map to the same turn they occupy several slots (NOT de-duplicated,
 *                 because "@k" is defined over retrieved items, exactly as the vault returns them).
 *   - `gold`    = the set of `evidence` dia_ids for a LoCoMo question (the gold multi-hop answer path).
 *
 * LoCoMo `dia_id` format: `D{session}:{turn}`, e.g. `D2:8` = session 2, turn 8.
 */

// dia_id parsing + gold normalization moved to locomo-corpus.ts (axis-neutral corpus concerns —
// specs/001-learning-memory-loop T012: the judge harness must never import this recall file).
import { type DiaId } from './locomo-corpus.js'
export { isDiaId, parseDiaId, normalizeGold, mean } from './locomo-corpus.js'
export type { DiaId, ParsedDiaId } from './locomo-corpus.js'

/** The set of distinct dia_ids occupying the first `k` retrieval slots. */
function topKSet(ranked: readonly DiaId[], k: number): Set<DiaId> {
  const out = new Set<DiaId>()
  const lim = Math.min(k, ranked.length)
  for (let i = 0; i < lim; i++) out.add(ranked[i]!)
  return out
}

/**
 * recall@k = |gold ∩ top-k| / |gold|. Turn-level: a gold turn counts as retrieved iff its dia_id
 * appears within the first `k` retrieval slots. Empty gold ⇒ 0 (unscorable; the harness filters
 * these out and reports them separately, so this is a defensive floor, never the reported value).
 */
export function recallAtK(ranked: readonly DiaId[], gold: readonly DiaId[], k: number): number {
  if (gold.length === 0) return 0
  const goldSet = new Set(gold)
  const top = topKSet(ranked, k)
  let hit = 0
  for (const g of goldSet) if (top.has(g)) hit++
  return hit / goldSet.size
}

/**
 * all-hops recall@k = 1 iff EVERY gold turn is within the first `k` retrieval slots — the strict
 * MULTI-HOP metric (the locus of MAGMA's claimed win). Empty gold ⇒ false (unscorable floor).
 */
export function allHopsRecallAtK(
  ranked: readonly DiaId[],
  gold: readonly DiaId[],
  k: number,
): boolean {
  if (gold.length === 0) return false
  const top = topKSet(ranked, k)
  for (const g of new Set(gold)) if (!top.has(g)) return false
  return true
}

/** 1-based rank of the first retrieved slot whose dia_id ∈ gold, or 0 if no gold turn is retrieved. */
export function firstGoldRank(ranked: readonly DiaId[], gold: readonly DiaId[]): number {
  if (gold.length === 0) return 0
  const goldSet = new Set(gold)
  for (let i = 0; i < ranked.length; i++) if (goldSet.has(ranked[i]!)) return i + 1
  return 0
}

/** Reciprocal rank of the FIRST gold turn (1/rank), or 0 if none retrieved. */
export function mrrFirstGold(ranked: readonly DiaId[], gold: readonly DiaId[]): number {
  const r = firstGoldRank(ranked, gold)
  return r === 0 ? 0 : 1 / r
}

/** Fraction of booleans that are true (empty ⇒ 0). For macro-averaging all-hops recall / hit-rates. */
export function fractionTrue(xs: readonly boolean[]): number {
  if (xs.length === 0) return 0
  let n = 0
  for (const x of xs) if (x) n++
  return n / xs.length
}
