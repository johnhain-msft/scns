/**
 * SCNS selfopt — Phase 1 wedge 5: mine the REAL held-out val split.
 *
 * Thin convenience over the Phase-0 miner (`mineTaskRecords`) that returns only
 * one split (default `val`) — the real, deterministic gate/report set drawn from
 * SCNS's own labelled broker history. Two surfaces:
 *
 *   - `mineValTasksFromEvents` — PURE (CI-safe, no DB): mine + filter to a split.
 *     Unit-tested with injected synthetic events; never opens a database.
 *   - `mineValTasks` — the thin I/O wrapper: open a broker DB READONLY, load the
 *     outcome-bearing events, mine the split, and ALWAYS close the handle. Phase
 *     1 stays read/measure only — it must never mutate broker state.
 *
 * The mined tasks are `referenceKind:'recorded'`: their score is the historical
 * quality-gate label, which the replay judge surfaces verbatim. They therefore
 * back a measurement REPORT (reproducing SCNS's own measured performance), NOT a
 * non-regression gate — a recorded task's score is constant under any backend, so
 * it cannot move an adopt/reject decision. The rule-judged gate set stays the
 * thing that actually gates.
 */
import Database from 'better-sqlite3'
import type { Event } from '../broker/types.js'
import { loadOutcomeEvents, mineTaskRecords } from './mine.js'
import type { IntentResolver } from './mine.js'
import type { TaskRecord, TaskSplit } from './types.js'

export interface MineValTasksOptions {
  /** Project name stamped onto each TaskRecord. Default 'scns'. */
  readonly project?: string
  /** Resolves a suggestion id to a human intent string. Optional. */
  readonly intentResolver?: IntentResolver
  /** Deterministic split tunables (forwarded to `assignSplits`). */
  readonly valFraction?: number
  readonly testFraction?: number
  readonly seed?: number
  readonly maxTasks?: number
  /** Which split to return. Default 'val' (the held-out gate/report set). */
  readonly split?: TaskSplit
}

/**
 * Mine TaskRecords from already-loaded broker events and return ONLY the
 * requested split (default `val`). Pure — no I/O, deterministic given `events`.
 */
export function mineValTasksFromEvents(
  events: ReadonlyArray<Event>,
  opts: MineValTasksOptions = {},
): TaskRecord[] {
  const split = opts.split ?? 'val'
  const tasks = mineTaskRecords(events, {
    project: opts.project ?? 'scns',
    ...(opts.intentResolver ? { intentResolver: opts.intentResolver } : {}),
    ...(opts.valFraction !== undefined ? { valFraction: opts.valFraction } : {}),
    ...(opts.testFraction !== undefined ? { testFraction: opts.testFraction } : {}),
    ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
    ...(opts.maxTasks !== undefined ? { maxTasks: opts.maxTasks } : {}),
  })
  return tasks.filter((t) => t.split === split)
}

/**
 * Open a broker database READONLY, mine the requested split, and close the
 * handle. The DB is opened with `{ readonly: true, fileMustExist: true }` so
 * Phase 1 never creates or mutates broker state.
 */
export function mineValTasks(
  brokerDbPath: string,
  opts: MineValTasksOptions = {},
): TaskRecord[] {
  const db = new Database(brokerDbPath, { readonly: true, fileMustExist: true })
  try {
    const events = loadOutcomeEvents(db)
    return mineValTasksFromEvents(events, opts)
  } finally {
    db.close()
  }
}
