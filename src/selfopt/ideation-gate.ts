/**
 * D2 outcome-gate (design-m1.md §6, handoff L3 step 3): validate that memory-derived
 * ideation actually IMPROVES on a held-out signal — the historical landing rate of the
 * proposal families — rather than trusting "the diff passed". Mirrors the additive,
 * default-OFF behavioral-gate (`behavioral-gate.ts`): pure, injectable, and able only to
 * DOWNGRADE the memory path back to the static menu on a measured regression.
 *
 * Safety property: with no accumulated outcomes every family scores the neutral prior,
 * so baseline and candidate scores are identical, delta is 0 by construction, and the
 * gate can never veto — exactly the behavioral-gate's symmetric-backend safety. The
 * gate only becomes active once `proposal_outcomes` carries real landing history.
 */

import type Database from 'better-sqlite3'
import { DEFAULT_NONREGRESSION_EPSILON } from './staging.js'
import { FAILED_VERDICTS, LANDED_VERDICTS } from '../memory/proposal-outcomes.js'

/**
 * The verdict sets, rendered as SQL literal lists.
 *
 * FR-059 removed `failed` from `FAILED_VERDICTS` — a build failure is not the human refusing —
 * but this scorer carried its own hardcoded `('failed','rejected','reverted')`, a SECOND definition
 * of "failure verdict" that the change did not reach. It therefore still counted a build failure
 * as a family failure, which is exactly what FR-059 rules out, and Phase 10f makes `failed` rows
 * the routine product of every gate failure. Deriving them here means the two cannot drift again.
 */
const sqlList = (verdicts: ReadonlySet<string>): string =>
  [...verdicts].map((v) => `'${v}'`).join(',')
const landedList = sqlList(LANDED_VERDICTS)
const failedList = sqlList(FAILED_VERDICTS)

/** Env opt-in names (both default-OFF). */
export const IDEATION_GATE_ENV = 'SCNS_IDEATE_GATE'
export const IDEATION_GATE_ENFORCE_ENV = 'SCNS_IDEATE_GATE_ENFORCE'

/** Neutral prior landing rate for a family with no outcome history. */
export const DEFAULT_IDEATION_PRIOR = 0.5

export interface IdeationGateMode {
  /** Measure + attach the landing-rate comparison (advisory). */
  readonly measure: boolean
  /** Allow a measured regression to downgrade the memory path back to the static menu. */
  readonly enforce: boolean
}

function isTruthy(v: string | undefined): boolean {
  if (v === undefined) return false
  const s = v.trim().toLowerCase()
  return s === '1' || s === 'true' || s === 'yes' || s === 'on'
}

/**
 * Resolve the two (default-OFF) env opt-ins.
 *
 * `measure` and `enforce` are INDEPENDENT. An earlier version of this comment claimed "a caller
 * only acts on `enforce` when `measure` is also true", which `cli.ts` has never done — it installs
 * the gate on `enforce` alone, and John's launchd plist sets `SCNS_IDEATE_GATE_ENFORCE=1` without
 * `SCNS_IDEATE_GATE`. Phase 10f's re-grade found the contradiction and escalated it rather than
 * flipping a gate live on his machine; he ruled on 2026-08-04 that the caller is right and the
 * comment was stale. Enforcing without measuring is therefore intended: it downgrades the memory
 * path on a measured regression without also attaching the advisory comparison to every run.
 */
export function resolveIdeationGateMode(env: NodeJS.ProcessEnv): IdeationGateMode {
  return {
    measure: isTruthy(env[IDEATION_GATE_ENV]),
    enforce: isTruthy(env[IDEATION_GATE_ENFORCE_ENV]),
  }
}

export interface FamilyStat {
  readonly landed: number
  readonly failed: number
}

export interface IdeationGateInput {
  /** Families of the STATIC (baseline) seed menu. */
  readonly baselineFamilies: readonly string[]
  /** Families of the memory-derived (candidate) selection. */
  readonly candidateFamilies: readonly string[]
  /** Per-family landing history (landed/failed counts). */
  readonly familyStats: ReadonlyMap<string, FamilyStat>
  /** Non-regression tolerance. Default {@link DEFAULT_NONREGRESSION_EPSILON}. */
  readonly epsilon?: number
  /** Neutral prior for unseen families. Default {@link DEFAULT_IDEATION_PRIOR}. */
  readonly prior?: number
}

export interface PerFamilyRate {
  readonly family: string
  readonly side: 'baseline' | 'candidate'
  readonly rate: number
  readonly landed: number
  readonly failed: number
  /** True iff the family had any outcome history (else scored the prior). */
  readonly seen: boolean
}

export interface IdeationGateResult {
  readonly ran: boolean
  readonly skipReason?: string
  /** Mean landing rate of the baseline (static) families. */
  readonly baselineScore: number
  /** Mean landing rate of the candidate (memory-derived) families. */
  readonly candidateScore: number
  /** `candidateScore - baselineScore`. Positive = the memory path is expected to land more. */
  readonly delta: number
  /** True iff `delta < -epsilon` (the memory path is measurably worse). */
  readonly regressed: boolean
  readonly epsilon: number
  readonly perFamily: readonly PerFamilyRate[]
  readonly disclosure: string
}

const DISCLOSURE =
  'Held-out landing-rate non-regression over proposal families. It can only DOWNGRADE the ' +
  'memory-derived ideation path back to the static menu on a measured regression. With no ' +
  'accumulated outcomes every family scores the neutral prior, so delta is 0 by construction ' +
  'and the gate cannot veto.'

function rateFor(
  family: string,
  stats: ReadonlyMap<string, FamilyStat>,
  prior: number,
): { rate: number; landed: number; failed: number; seen: boolean } {
  const s = stats.get(family)
  const total = (s?.landed ?? 0) + (s?.failed ?? 0)
  if (!s || total === 0) return { rate: prior, landed: s?.landed ?? 0, failed: s?.failed ?? 0, seen: false }
  return { rate: s.landed / total, landed: s.landed, failed: s.failed, seen: true }
}

function meanRate(
  families: readonly string[],
  side: 'baseline' | 'candidate',
  stats: ReadonlyMap<string, FamilyStat>,
  prior: number,
): { score: number; perFamily: PerFamilyRate[] } {
  const perFamily: PerFamilyRate[] = []
  let sum = 0
  for (const family of families) {
    const r = rateFor(family, stats, prior)
    perFamily.push({ family, side, rate: r.rate, landed: r.landed, failed: r.failed, seen: r.seen })
    sum += r.rate
  }
  return { score: families.length > 0 ? sum / families.length : prior, perFamily }
}

/**
 * Compare the expected landing rate of the candidate (memory-derived) families against the
 * baseline (static menu) families. Pure: deterministic given its inputs, no I/O.
 */
export function evaluateIdeationGate(input: IdeationGateInput): IdeationGateResult {
  const epsilon = input.epsilon ?? DEFAULT_NONREGRESSION_EPSILON
  const prior = input.prior ?? DEFAULT_IDEATION_PRIOR

  if (input.baselineFamilies.length === 0 && input.candidateFamilies.length === 0) {
    return {
      ran: false,
      skipReason: 'no-families',
      baselineScore: prior,
      candidateScore: prior,
      delta: 0,
      regressed: false,
      epsilon,
      perFamily: [],
      disclosure: DISCLOSURE,
    }
  }

  const baseline = meanRate(input.baselineFamilies, 'baseline', input.familyStats, prior)
  const candidate = meanRate(input.candidateFamilies, 'candidate', input.familyStats, prior)
  const delta = candidate.score - baseline.score

  return {
    ran: true,
    baselineScore: baseline.score,
    candidateScore: candidate.score,
    delta,
    regressed: delta < -epsilon,
    epsilon,
    perFamily: [...baseline.perFamily, ...candidate.perFamily],
    disclosure: DISCLOSURE,
  }
}

/**
 * Aggregate per-family landing stats across all entities from `proposal_outcomes`.
 * Side-effect-free: returns an empty map when the table is absent.
 */
export function familyLandingStats(db: Database.Database): Map<string, FamilyStat> {
  const exists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='proposal_outcomes'")
    .get() as { name?: string } | undefined
  if (!exists?.name) return new Map()

  const rows = db
    .prepare(
      `SELECT family,
              SUM(CASE WHEN verdict IN (${landedList}) THEN 1 ELSE 0 END) AS landed,
              SUM(CASE WHEN verdict IN (${failedList}) THEN 1 ELSE 0 END) AS failed
       FROM proposal_outcomes
       GROUP BY family`,
    )
    .all() as Array<{ family: string; landed: number; failed: number }>

  const out = new Map<string, FamilyStat>()
  for (const r of rows) out.set(r.family, { landed: r.landed, failed: r.failed })
  return out
}
