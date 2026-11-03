/**
 * SCNS selfopt — Phase 0 miner (the held-out task bench).
 *
 * SCNS-native port of the MIT SkillOpt miner (`skillopt_sleep/mine.py`),
 * re-targeted at SCNS's OWN labelled history. The chosen mining source is the
 * broker event log — specifically the `quality_gate_verdict` events, each
 * carrying the quality-gate arbiter's real computed label (`passed`) and a
 * continuous quality score (`score` in [0,1]). This is the only SCNS source
 * with real, labelled task outcomes (OTel session summaries are telemetry-only;
 * the Copilot session store has no explicit pass/fail label).
 *
 * A task == a labelled outcome. Each verdict is paired back to its preceding
 * `team_completed` (same team, nearest lower event-id) for diff context, then
 * turned into a `TaskRecord` whose `recordedScore` IS the loss signal. Identity
 * is the verdict's `qualityCheckId` (unique + stored in the payload), so
 * re-mining the same DB yields identical ids and an identical split.
 *
 * All functions here are pure given their `events` input; the only I/O is the
 * thin `loadOutcomeEvents` DB read, kept separate so the mining logic is
 * unit-testable without a database. Phase 0 is read/measure only.
 */
import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { Event } from '../broker/types.js'
import { getEventsByType } from '../broker/storage/repositories/event-repository.js'
import type { TaskOutcome, TaskRecord, TaskSplit, TeamOutcome } from './types.js'

// ── Tunables / defaults (mirror SkillOpt) ─────────────────────────────────────

export const DEFAULT_VAL_FRACTION = 0.34
export const DEFAULT_TEST_FRACTION = 0.0
export const DEFAULT_SPLIT_SEED = 42
export const DEFAULT_MAX_TASKS = 200
/** Max event-id gap when pairing a verdict back to its team_completed. */
const TC_PAIR_WINDOW = 50

// ── Small helpers ─────────────────────────────────────────────────────────────

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

function taskId(qualityCheckId: string): string {
  return 'task_' + sha256Hex(qualityCheckId).slice(0, 12)
}

function short(text: string, n = 600): string {
  const t = (text ?? '').trim()
  return t.length <= n ? t : t.slice(0, n) + ' …'
}

function safeParse(payload: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(payload)
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      return v as Record<string, unknown>
    }
  } catch {
    // ignore
  }
  return {}
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function teamIdOf(p: Record<string, unknown>): string | null {
  return asString(p['team_id']) ?? asString(p['teamId'])
}

const DIFF_FILE_RE = /^diff --git a\/(\S+) b\//gm

/** Extract the changed-file paths from a unified diff. */
export function changedFilesFromDiff(diff: string): string[] {
  const files: string[] = []
  let m: RegExpExecArray | null
  DIFF_FILE_RE.lastIndex = 0
  while ((m = DIFF_FILE_RE.exec(diff)) !== null) {
    if (m[1]) files.push(m[1])
  }
  return files
}

// ── Stage 1: correlate broker events -> TeamOutcome[] ─────────────────────────

/**
 * Pair each `quality_gate_verdict` with the nearest preceding `team_completed`
 * of the same team (within {@link TC_PAIR_WINDOW} event-ids) to recover the diff
 * context. A verdict with no recoverable team_completed still yields an outcome
 * (the label stands on its own); its diff context is simply empty.
 *
 * Only verdicts are emitted as outcomes — a `team_completed` with no verdict has
 * no label and is therefore not a usable loss-function data point.
 */
export function parseTeamOutcomes(events: ReadonlyArray<Event>): TeamOutcome[] {
  const sorted = [...events].sort((a, b) => a.id - b.id)

  // index team_completed by team for nearest-preceding lookup
  const completions: Array<{ id: number; team: string | null; p: Record<string, unknown> }> = []
  for (const e of sorted) {
    if (e.event_type === 'team_completed') {
      const p = safeParse(e.payload)
      completions.push({ id: e.id, team: teamIdOf(p), p })
    }
  }

  const outcomes: TeamOutcome[] = []
  for (const e of sorted) {
    if (e.event_type !== 'quality_gate_verdict') continue
    const v = safeParse(e.payload)
    const qcid = asString(v['qualityCheckId'])
    if (qcid === null) continue // identity is required for deterministic mining
    const team = teamIdOf(v)

    // nearest preceding team_completed of the same team within the window
    let tc: Record<string, unknown> | null = null
    for (let i = completions.length - 1; i >= 0; i--) {
      const c = completions[i]
      if (c === undefined) continue
      if (c.id >= e.id) continue
      if (e.id - c.id > TC_PAIR_WINDOW) break
      if (c.team === team) {
        tc = c.p
        break
      }
    }

    const stagedDiff = tc ? (asString(tc['stagedDiff']) ?? '') : ''
    const changedFiles = changedFilesFromDiff(stagedDiff)
    const members = Array.isArray(tc?.['memberSessionIds'])
      ? (tc!['memberSessionIds'] as unknown[]).filter((x): x is string => typeof x === 'string')
      : []

    outcomes.push({
      teamId: team ?? 'unknown',
      branch: asString(v['branch']),
      sourceSuggestionId: asString(v['sourceSuggestionId']),
      passed: v['passed'] === true,
      score: asNumber(v['score']) ?? 0,
      reason: asString(v['reason']) ?? '',
      aggregateOutcome: tc ? (asString(tc['aggregateOutcome']) ?? '') : '',
      stagedDiffSummary: summarizeDiff(stagedDiff, changedFiles),
      changedFiles,
      memberSessionIds: members,
      completedAt: tc ? asString(tc['completedAt']) : null,
      qualityCheckId: qcid,
    })
  }
  return outcomes
}

function summarizeDiff(diff: string, changedFiles: readonly string[]): string {
  if (changedFiles.length === 0) return diff.length > 0 ? short(diff, 400) : '(empty diff)'
  const head = changedFiles.slice(0, 8).join(', ')
  const more = changedFiles.length > 8 ? ` (+${changedFiles.length - 8} more)` : ''
  return `Changed ${changedFiles.length} file(s): ${head}${more}`
}

// ── Stage 2: TeamOutcome[] -> TaskRecord[] ────────────────────────────────────

/** Resolves a suggestion id to a human intent string (e.g. its title). */
export type IntentResolver = (suggestionId: string) => string | null

export interface OutcomesToTasksOptions {
  readonly project: string
  readonly intentResolver?: IntentResolver
}

function outcomeLabel(o: TeamOutcome): TaskOutcome {
  if (o.passed) return 'success'
  if (o.score > 0) return 'mixed'
  return 'fail'
}

function deriveIntent(o: TeamOutcome, resolver?: IntentResolver): string {
  if (o.sourceSuggestionId && resolver) {
    const title = resolver(o.sourceSuggestionId)
    if (title) return short(title, 400)
  }
  if (o.changedFiles.length > 0) {
    const primary = o.changedFiles[0]
    const extra = o.changedFiles.length > 1 ? ` and ${o.changedFiles.length - 1} other file(s)` : ''
    return short(`Implement change touching ${primary}${extra}`, 400)
  }
  if (o.reason) return short(`Team work (${o.reason})`, 400)
  return short(`Team work on ${o.teamId}`, 400)
}

export function outcomesToTaskRecords(
  outcomes: ReadonlyArray<TeamOutcome>,
  options: OutcomesToTasksOptions,
): TaskRecord[] {
  const { project, intentResolver } = options
  return outcomes.map((o) => {
    const tags: string[] = []
    if (o.branch) tags.push('branch:' + o.branch)
    if (o.sourceSuggestionId) tags.push('suggestion:' + o.sourceSuggestionId)
    tags.push('team:' + o.teamId)
    if (o.changedFiles[0]) tags.push('file:' + o.changedFiles[0])

    return {
      id: taskId(o.qualityCheckId),
      project,
      intent: deriveIntent(o, intentResolver),
      contextExcerpt: short(o.stagedDiffSummary, 600),
      attemptedSolution: short(o.stagedDiffSummary, 600),
      outcome: outcomeLabel(o),
      referenceKind: 'recorded',
      reference: '',
      recordedScore: Math.max(0, Math.min(1, o.score)),
      judge: null,
      tags,
      sourceSessions: o.memberSessionIds,
      split: 'train',
      origin: 'real',
      derivedFrom: '',
    } satisfies TaskRecord
  })
}

// ── Stage 2b: dedup (merge tasks sharing an id) ───────────────────────────────

const OUTCOME_ORDER: Record<TaskOutcome, number> = { success: 3, fail: 2, mixed: 1, unknown: 0 }

/**
 * Merge tasks sharing an id (defensive — identity is the unique qualityCheckId,
 * so collisions only arise from duplicate reads). Mirrors SkillOpt `dedup_tasks`:
 * unions source sessions and keeps the most-resolved outcome.
 */
export function dedupTasks(tasks: ReadonlyArray<TaskRecord>): TaskRecord[] {
  const byId = new Map<string, TaskRecord>()
  for (const t of tasks) {
    const existing = byId.get(t.id)
    if (!existing) {
      byId.set(t.id, t)
      continue
    }
    const mergedSessions = [...new Set([...existing.sourceSessions, ...t.sourceSessions])]
    const better = OUTCOME_ORDER[t.outcome] > OUTCOME_ORDER[existing.outcome]
    byId.set(t.id, {
      ...existing,
      sourceSessions: mergedSessions,
      outcome: better ? t.outcome : existing.outcome,
    })
  }
  return [...byId.values()]
}

// ── Stage 3: deterministic train/val/test split ───────────────────────────────

export interface AssignSplitsOptions {
  readonly valFraction?: number
  readonly testFraction?: number
  readonly seed?: number
}

/** Stable bucket in [0,100) from sha256(seed + id) — same task, same split. */
function splitBucket(seed: number, id: string): number {
  const hex = sha256Hex(String(seed) + id)
  return Number(BigInt('0x' + hex) % 100n)
}

/**
 * Deterministically split tasks into train / val / test.
 *
 * Anti-overfitting contract (ported from SkillOpt `assign_splits`):
 *   - `val` and `test` are drawn ONLY from real mined tasks (origin==='real')
 *     and never overlap. val gates updates; test is the final held-out measure.
 *   - dream-augmented tasks (origin==='dream') ALWAYS go to train, unconditionally.
 *   - A stable hash of the task id keeps the same real task in the same split
 *     across runs (a fixed held-out gate).
 *
 * Returns NEW records (immutable input) with `split` assigned.
 */
export function assignSplits(
  tasks: ReadonlyArray<TaskRecord>,
  options: AssignSplitsOptions = {},
): TaskRecord[] {
  const valFraction = options.valFraction ?? DEFAULT_VAL_FRACTION
  const testFraction = options.testFraction ?? DEFAULT_TEST_FRACTION
  const seed = options.seed ?? DEFAULT_SPLIT_SEED

  const valCut = Math.round(valFraction * 100)
  const testCut = valCut + Math.round(testFraction * 100)

  const out: TaskRecord[] = tasks.map((t) => {
    if (t.origin === 'dream') return { ...t, split: 'train' as TaskSplit }
    const bucket = splitBucket(seed, t.id)
    let split: TaskSplit
    if (bucket < valCut) split = 'val'
    else if (bucket < testCut) split = 'test'
    else split = 'train'
    return { ...t, split }
  })

  const realIdx = out.map((t, i) => ({ t, i })).filter((x) => x.t.origin !== 'dream')

  // guarantee val (the gate) is non-empty when we have >= 2 real tasks
  if (realIdx.length >= 2 && !realIdx.some((x) => x.t.split === 'val')) {
    const last = realIdx[realIdx.length - 1]!
    out[last.i] = { ...out[last.i]!, split: 'val' }
  }
  // guarantee a train pool exists when possible
  if (!out.some((t) => t.split === 'train') && realIdx.length >= 2) {
    const first = realIdx[0]!
    out[first.i] = { ...out[first.i]!, split: 'train' }
  }
  // if test was requested but ended up empty with >= 3 real tasks, carve one
  if (testFraction > 0 && realIdx.length >= 3 && !out.some((t) => t.split === 'test')) {
    for (const x of realIdx) {
      if (out[x.i]!.split === 'train') {
        out[x.i] = { ...out[x.i]!, split: 'test' }
        break
      }
    }
  }
  return out
}

// ── Top-level compose ─────────────────────────────────────────────────────────

export interface MineOptions extends OutcomesToTasksOptions, AssignSplitsOptions {
  readonly maxTasks?: number
}

/** Mine TaskRecords from already-loaded broker events (pure). */
export function mineTaskRecords(events: ReadonlyArray<Event>, options: MineOptions): TaskRecord[] {
  const maxTasks = options.maxTasks ?? DEFAULT_MAX_TASKS
  const outcomes = parseTeamOutcomes(events).slice(0, maxTasks)
  const tasks = outcomesToTaskRecords(outcomes, options)
  const deduped = dedupTasks(tasks)
  return assignSplits(deduped, options)
}

// ── Thin DB read (the only I/O) ───────────────────────────────────────────────

/**
 * Load the outcome-bearing events from a broker database. Open the DB readonly
 * at the call site — Phase 0 must never mutate broker state.
 */
export function loadOutcomeEvents(db: Database.Database): Event[] {
  return [
    ...getEventsByType(db, 'team_completed'),
    ...getEventsByType(db, 'quality_gate_verdict'),
  ]
}
