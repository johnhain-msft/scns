/**
 * Event-level causal-candidate source from `proposal_outcomes` (design-m1.md §3; M1.3 follow-up).
 *
 * The original {@link ./causal-edges.ts buildCausalCandidates} derives (cause→effect) pairs from
 * the chunk-level TEMPORAL backbone. On a telemetry-heavy vault those pairs are mid-word fragments
 * of consolidation tiers, and the conservative judge correctly infers ~0 edges from them (the M1.3
 * L2 go-live finding). The fix is to source candidates from genuine EVENTS rather than chunk
 * windows: the `proposal_outcomes` table records, per gazetteer entity, a real decision→result
 * history (title + verdict + rationale + timestamp). Consecutive outcomes for the same entity are
 * exactly the "decision led to result" pairs a causal judge can reason about — the broker
 * decision→result shape MAGMA's WHY subspace wants.
 *
 * Deterministic + LLM-free + read-only: it only PROPOSES {@link CausalCandidate} pairs for the
 * existing gate (`persistCausalEdges`), which still drops everything under the NULL provider, so
 * this is inert until a real judge is wired (a HARD-STOP). Outcome pairs are not chunk-backed, so
 * the cause/effect resolve to rationale-only causal edges — the same path the WHY reader already
 * handles (`causalNeighborhood` → `formatCausalChain`).
 */

import type Database from 'better-sqlite3'
import type { CausalCandidate } from './causal-provider.js'
import { causalKey, DEFAULT_MAX_CANDIDATES } from './causal-edges.js'

export interface OutcomeCandidatesOptions {
  /** Cap the number of candidate pairs. Default {@link DEFAULT_MAX_CANDIDATES}. */
  readonly maxCandidates?: number
  /**
   * Only pair consecutive outcomes whose VERDICT differs (a decision that changed state —
   * e.g. `implemented` → `reverted`). Default false (pair every consecutive outcome).
   */
  readonly onlyVerdictTransitions?: boolean
}

interface OutcomeRow {
  id: number
  entity: string
  family: string
  title: string
  verdict: string
  rationale: string | null
}

/** True iff the `proposal_outcomes` table exists (so the reader stays side-effect-free). */
function outcomesTableExists(db: Database.Database): boolean {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='proposal_outcomes'")
      .get() !== undefined
  )
}

/** A narratable one-line description of an outcome event (the causal judge reasons over this). */
function describeOutcome(r: OutcomeRow): string {
  const base = `${r.title} [${r.family}] — verdict: ${r.verdict}`
  return r.rationale && r.rationale.trim() !== '' ? `${base} (${r.rationale.trim()})` : base
}

/**
 * Derive (cause→effect) candidate pairs from `proposal_outcomes`: for each entity with ≥2
 * recorded outcomes, the chronologically-consecutive outcomes form decision→result pairs (the
 * earlier outcome is the candidate cause, its successor the candidate effect). Pairs are keyed
 * on stable content hashes (re-chunk-proof), deduped, and capped at `maxCandidates`.
 *
 * Returns [] when the table is absent or no entity has ≥2 outcomes — i.e. real candidates only
 * form once the autonomous loop has ACCUMULATED outcomes per entity (the data precondition the
 * chunk backbone could never satisfy with narratable events).
 */
export function buildOutcomeCausalCandidates(
  db: Database.Database,
  options: OutcomeCandidatesOptions = {},
): CausalCandidate[] {
  const max = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES
  if (max <= 0) return []
  if (!outcomesTableExists(db)) return []
  const onlyTransitions = options.onlyVerdictTransitions ?? false

  const rows = db
    .prepare(
      `SELECT id, entity, family, title, verdict, rationale
       FROM proposal_outcomes
       ORDER BY entity ASC, created_at ASC, id ASC`,
    )
    .all() as OutcomeRow[]

  const out: CausalCandidate[] = []
  const seen = new Set<string>()

  let i = 0
  while (i < rows.length) {
    // Gather this entity's contiguous run (rows are ordered by entity then time).
    const entity = rows[i]!.entity
    let j = i
    while (j < rows.length && rows[j]!.entity === entity) j++
    const run = rows.slice(i, j)
    i = j

    if (run.length < 2) continue // need ≥2 outcomes to form a cause→effect pair

    for (let k = 0; k + 1 < run.length; k++) {
      const cause = run[k]!
      const effect = run[k + 1]!
      if (onlyTransitions && cause.verdict === effect.verdict) continue

      const causeContent = describeOutcome(cause)
      const effectContent = describeOutcome(effect)
      const causeKey = causalKey(causeContent)
      const effectKey = causalKey(effectContent)
      if (causeKey === effectKey) continue

      const pair = `${causeKey}\u0000${effectKey}`
      if (seen.has(pair)) continue
      seen.add(pair)

      out.push({
        causeKey,
        effectKey,
        causeContent,
        effectContent,
        entity,
        causeFilePath: `proposal_outcomes#${cause.id}`,
        effectFilePath: `proposal_outcomes#${effect.id}`,
      })
      if (out.length >= max) return out
    }
  }

  return out
}
