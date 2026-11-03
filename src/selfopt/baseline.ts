/**
 * SCNS selfopt — Phase 0 baseline (the reproducible held-out score).
 *
 * Computes the held-out baseline: replay a chosen split (default `val`) against
 * the current artifact under a deterministic backend and aggregate the score.
 * Because the split is a stable hash of the task id and the MockBackend replays
 * recorded labels verbatim, two runs over the same DB produce an IDENTICAL
 * baseline — this is the reproducibility the Phase-0 verification bar requires
 * and the reference point the strict-improve gate later compares candidates to.
 *
 * Phase 0 is read/measure only: this produces a number, it adopts nothing.
 */
import { aggregateCost, aggregateScores, MockBackend, replayBatch } from './replay.js'
import type { ReplayBackend } from './replay.js'
import type { GateMetric, TaskRecord, TaskSplit } from './types.js'
import { selectGateScore } from './gate.js'

export interface BaselineOptions {
  /** Which split to score. Default 'val' (the gate set). */
  readonly split?: TaskSplit
  /** Backend to replay against. Default a deterministic MockBackend. */
  readonly backend?: ReplayBackend
  /** Candidate artifact under test (defaults to empty = current/no-op). */
  readonly skill?: string
  readonly memory?: string
  /** Metric used to project (hard, soft) to a single score. Default 'hard'. */
  readonly metric?: GateMetric
  readonly mixedWeight?: number
}

export interface BaselineResult {
  readonly split: TaskSplit
  readonly nTasks: number
  readonly hard: number
  readonly soft: number
  /** The single comparison score (selectGateScore over hard/soft). */
  readonly score: number
  readonly metric: GateMetric
  readonly meanTokens: number
  readonly meanLatencyMs: number
  /** Per-task (id, score) — deterministic, ordered by task id for stable output. */
  readonly perTask: ReadonlyArray<{ readonly id: string; readonly hard: number; readonly soft: number }>
}

/**
 * Score the held-out split and return a reproducible baseline.
 */
export async function computeBaseline(
  tasks: ReadonlyArray<TaskRecord>,
  options: BaselineOptions = {},
): Promise<BaselineResult> {
  const split = options.split ?? 'val'
  const backend = options.backend ?? new MockBackend()
  const metric = options.metric ?? 'hard'
  const mixedWeight = options.mixedWeight ?? 0.5

  // deterministic ordering by id so the per-task report is stable across runs
  const selected = tasks
    .filter((t) => t.split === split)
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  const pairs = await replayBatch(backend, selected, {
    skill: options.skill ?? '',
    memory: options.memory ?? '',
  })
  const { hard, soft } = aggregateScores(pairs)
  const { tokens, latencyMs } = aggregateCost(pairs)
  const score = selectGateScore(hard, soft, metric, mixedWeight)

  return {
    split,
    nTasks: selected.length,
    hard,
    soft,
    score,
    metric,
    meanTokens: tokens,
    meanLatencyMs: latencyMs,
    perTask: pairs.map((p) => ({ id: p.result.id, hard: p.result.hard, soft: p.result.soft })),
  }
}
