/**
 * Phase D — PATH-CONDITIONED edge reinforcement (plan §9: "up/down-weight memories on the MAGMA graph
 * by path + context" — the reason the graph substrate matters: a flat index cannot represent
 * path-conditioned value).
 *
 * Mechanics: bounded MULTIPLICATIVE updates on `memory_edges.weight` along a RETRIEVED path —
 * `w ← clamp(w · (1 + η·(2·outcome − 1)), min, max)` — where `outcome` is the settled human
 * accept-vs-waste gradient ([0,1]; 0.5 is exactly neutral ⇒ no-op). Touched edges:
 *   (a) chunk→chunk typed edges whose BOTH endpoints are in the path (the transitions the beam walked);
 *   (b) chunk→entity edges whose entity BRIDGES ≥2 path chunks (the entity hop the beam used).
 *
 * SAFETY / ANTI-DEGENERACY (PRIOR_ART §B pitfalls — Jiang arXiv:1902.10730, Chaney arXiv:1710.11214):
 *   - Weights are CLAMPED to [{@link DEFAULT_WEIGHT_MIN}, {@link DEFAULT_WEIGHT_MAX}] — no runaway.
 *   - {@link decayEdgeWeightsTowardNeutral} relaxes every weight toward the neutral 1.0 — reinforcement
 *     must keep re-earning its influence or it fades (freshness decay).
 *   - Reinforced weights change retrieval ONLY through the default-OFF `useEdgeWeights` beam lever
 *     (adaptive-traversal.ts) — flipping that live is a routing-policy change gated on the judged
 *     evaluator + AWAITING-JOHN (AGENTS.md #9). Writing weights alone alters NOTHING a user sees.
 *   - {@link applyExperienceReinforcement} is idempotent per experience row via a vault-side log table,
 *     touches only `memory_edges` rows (never files, never guardrails), and reads the experience store
 *     WITHOUT writing it.
 */
import type Database from 'better-sqlite3'
import type { ExperienceStore } from './experience-store.js'

/** Learning rate η: outcome 1.0 ⇒ ×(1+η) per application; 0.0 ⇒ ×(1−η). */
export const DEFAULT_REINFORCE_ETA = 0.2
/** Weight clamp floor (a decayed edge stays traversable, just structurally discounted). */
export const DEFAULT_WEIGHT_MIN = 0.25
/** Weight clamp ceiling (a reinforced edge can at most quadruple its structural pull). */
export const DEFAULT_WEIGHT_MAX = 4.0
/** Default relaxation rate toward the neutral 1.0. */
export const DEFAULT_DECAY_RATE = 0.05

export interface ReinforcePathOptions {
  /** The retrieved path (chunk ids) the outcome is being attributed to. */
  readonly chunkIds: readonly number[]
  /** The settled human accept-vs-waste gradient [0,1]. */
  readonly outcome: number
  readonly eta?: number
  readonly min?: number
  readonly max?: number
}

export interface ReinforceResult {
  readonly edgesTouched: number
}

/**
 * Apply one bounded multiplicative update along a retrieved path (see module doc). Returns the number
 * of edges actually updated; 0 for an empty/singleton path, an out-of-range outcome, or a neutral 0.5.
 */
export function reinforceEdgesForPath(
  db: Database.Database,
  opts: ReinforcePathOptions,
): ReinforceResult {
  const ids = [...new Set(opts.chunkIds)]
  const { outcome } = opts
  if (ids.length < 2 || !Number.isFinite(outcome) || outcome < 0 || outcome > 1)
    return { edgesTouched: 0 }
  const eta = opts.eta ?? DEFAULT_REINFORCE_ETA
  const min = opts.min ?? DEFAULT_WEIGHT_MIN
  const max = opts.max ?? DEFAULT_WEIGHT_MAX
  const factor = 1 + eta * (2 * outcome - 1)
  if (factor === 1) return { edgesTouched: 0 }

  const ph = ids.map(() => '?').join(',')
  // (a) chunk→chunk edges with both endpoints in the path.
  const chunkEdges = db
    .prepare(
      `UPDATE memory_edges
          SET weight = MAX(?, MIN(?, weight * ?))
        WHERE dst_chunk IS NOT NULL AND src_chunk IN (${ph}) AND dst_chunk IN (${ph})`,
    )
    .run(min, max, factor, ...ids, ...ids)
  // (b) entity edges whose entity bridges ≥2 path chunks (the entity hop the beam used).
  const entityEdges = db
    .prepare(
      `UPDATE memory_edges
          SET weight = MAX(?, MIN(?, weight * ?))
        WHERE edge_type = 'entity' AND src_chunk IN (${ph})
          AND dst_entity IN (
            SELECT dst_entity FROM memory_edges
             WHERE edge_type = 'entity' AND src_chunk IN (${ph}) AND dst_entity IS NOT NULL
             GROUP BY dst_entity HAVING COUNT(DISTINCT src_chunk) >= 2
          )`,
    )
    .run(min, max, factor, ...ids, ...ids)
  return { edgesTouched: chunkEdges.changes + entityEdges.changes }
}

/**
 * Freshness decay: relax every non-neutral weight toward 1.0 by `rate` (`w ← w + rate·(1 − w)`).
 * Anti-ossification — reinforcement must keep re-earning its influence (degenerate-loop caution).
 */
export function decayEdgeWeightsTowardNeutral(
  db: Database.Database,
  opts: { readonly rate?: number } = {},
): ReinforceResult {
  const rate = opts.rate ?? DEFAULT_DECAY_RATE
  if (!Number.isFinite(rate) || rate <= 0 || rate > 1) return { edgesTouched: 0 }
  const info = db
    .prepare(`UPDATE memory_edges SET weight = weight + ? * (1.0 - weight) WHERE weight != 1.0`)
    .run(rate)
  return { edgesTouched: info.changes }
}

const REINFORCEMENT_LOG_SCHEMA = `
CREATE TABLE IF NOT EXISTS edge_reinforcement_log (
  experience_id INTEGER PRIMARY KEY,
  outcome       REAL NOT NULL,
  edges_touched INTEGER NOT NULL,
  applied_at    TEXT NOT NULL DEFAULT (datetime('now'))
);`

export interface ApplyReinforcementResult {
  /** Settled magma rows applied THIS run (already-applied rows are skipped via the vault log). */
  readonly rowsApplied: number
  readonly edgesTouched: number
}

/**
 * Apply every SETTLED magma-family experience row's outcome to the target vault's edge weights, ONCE
 * per row (idempotent via the vault-side `edge_reinforcement_log`). Reads the experience store
 * (SELECT-only); writes ONLY `memory_edges.weight` + the log table in the TARGET vault. Rows without a
 * magma_path (hybrid/full) or without a settled human_outcome are skipped.
 */
export function applyExperienceReinforcement(
  vaultDb: Database.Database,
  store: ExperienceStore,
  opts: { readonly eta?: number; readonly min?: number; readonly max?: number } = {},
): ApplyReinforcementResult {
  vaultDb.exec(REINFORCEMENT_LOG_SCHEMA)
  const rows = store.db
    .prepare(
      `SELECT id, magma_path, human_outcome FROM retrieval_experience
        WHERE human_outcome IS NOT NULL AND magma_path IS NOT NULL
        ORDER BY id`,
    )
    .all() as Array<{ id: number; magma_path: string; human_outcome: number }>
  const seen = vaultDb.prepare(`SELECT 1 FROM edge_reinforcement_log WHERE experience_id = ?`)
  const logIt = vaultDb.prepare(
    `INSERT INTO edge_reinforcement_log (experience_id, outcome, edges_touched) VALUES (?, ?, ?)`,
  )
  let rowsApplied = 0
  let edgesTouched = 0
  for (const r of rows) {
    if (seen.get(r.id)) continue
    let chunkIds: number[]
    try {
      const parsed = JSON.parse(r.magma_path) as unknown
      if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === 'number')) continue
      chunkIds = parsed
    } catch {
      continue
    }
    const res = reinforceEdgesForPath(vaultDb, { chunkIds, outcome: r.human_outcome, ...opts })
    logIt.run(r.id, r.human_outcome, res.edgesTouched)
    rowsApplied++
    edgesTouched += res.edgesTouched
  }
  return { rowsApplied, edgesTouched }
}
