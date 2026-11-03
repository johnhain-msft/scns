/**
 * Phase 13.12.24 — task completion gate.
 *
 * Centralizes the logic that decides whether a task may be marked
 * status='completed'. A task can complete only if its owner has produced
 * verifiable evidence of work:
 *
 *   1. A non-empty `git diff --cached` in the owner's working directory, OR
 *   2. A session_handoff for the owner whose latest quality_check passed.
 *
 * Without an owner there is no way to evaluate the gate; the request is
 * rejected. Callers should set status='failed' to abandon a task without
 * artifacts.
 *
 * The git check is injected so tests don't need a real working tree.
 */
import { spawnSync } from 'node:child_process'
import type Database from 'better-sqlite3'
import { findSessionById } from '../storage/repositories/session-repository.js'
import {
  findHandoffsBySession,
  findQualityChecksBySession,
} from '../storage/repositories/quality-repository.js'
import {
  isStaleAgainstDispatch,
  realStagedFileMtimeCollector,
  type StagedFileMtimeCollector,
} from './gate-evidence.js'

export type GitDiffChecker = (cwd: string) => boolean

export interface CompletionGateResult {
  readonly allowed: boolean
  readonly reason: string
}

/**
 * Optional WS G + WS M freshness inputs.
 *
 * - WS G: when `dispatchStartedAt` is supplied the gate refuses to allow
 *   on the staged-diff path if every staged file's mtime predates the
 *   dispatch (returns reason 'stale_diff'). Backwards-compatible:
 *   omitting all freshness fields preserves existing behaviour.
 *
 * - WS M: when `dispatchId` is supplied (without an explicit
 *   `dispatchStartedAt`) the gate uses `resolveDispatchStartedAt` to
 *   look up the canonical dispatch start time. This lets callers prefer
 *   strict dispatch_id-based attribution over caller-supplied mtimes.
 *   If the resolver returns null the freshness check is skipped (no
 *   evidence of a known dispatch → defer to the existing diff verdict).
 *
 *   When BOTH `dispatchStartedAt` and `dispatchId` are supplied, the
 *   explicit timestamp wins and the resolver is not called.
 */
export interface CompletionGateOptions {
  readonly dispatchStartedAt?: Date | number | null
  readonly dispatchId?: string | null
  readonly resolveDispatchStartedAt?: (
    dispatchId: string,
  ) => Date | number | null | undefined
  readonly stagedFileMtimeCollector?: StagedFileMtimeCollector
}

/**
 * Default git diff checker. Returns true when `git -C <cwd> diff --cached`
 * would show staged changes. Falls back to `false` on any error so the
 * gate fails closed (callers must set status=failed if no diff is stageable).
 */
export function realGitDiffChecker(cwd: string): boolean {
  try {
    const result = spawnSync('git', ['-C', cwd, 'diff', '--cached', '--quiet'], {
      stdio: 'ignore',
      timeout: 5000,
      windowsHide: true,
    })
    // `git diff --cached --quiet` exits 0 when no changes, 1 when there are
    // changes, and >1 on error. Treat errors as no-diff (fail closed).
    return result.status === 1
  } catch {
    return false
  }
}

/**
 * Evaluate the completion gate for a task whose owner is `ownerSessionId`.
 * Returns { allowed, reason }. Pass null for ownerless tasks (gate fails).
 */
export function evaluateCompletionGate(
  db: Database.Database,
  ownerSessionId: string | null,
  gitDiffChecker?: GitDiffChecker,
  options?: CompletionGateOptions,
): CompletionGateResult {
  if (!ownerSessionId) {
    return {
      allowed: false,
      reason: 'task has no owner; cannot verify staged diff or handoff',
    }
  }

  // Path 1: passing QA handoff. We require a handoff row for the owner AND
  // at least one quality_check with passed=true on that session.
  const handoffs = findHandoffsBySession(db, ownerSessionId)
  if (handoffs.length > 0) {
    const checks = findQualityChecksBySession(db, ownerSessionId)
    if (checks.some((c) => c.passed)) {
      return { allowed: true, reason: 'passing QA handoff for owner' }
    }
  }

  // Path 2: non-empty staged diff in the owner's working_dir.
  const session = findSessionById(db, ownerSessionId)
  const workingDir = session?.working_dir ?? null
  if (workingDir && gitDiffChecker && gitDiffChecker(workingDir)) {
    // WS G + WS M — freshness pre-check. Resolve the effective dispatch
    // start time from the explicit option, or fall back to looking it up
    // by dispatch_id. If neither yields a value, skip the freshness
    // check (no evidence of a known dispatch).
    const effectiveStartedAt = resolveEffectiveStartedAt(options)
    if (effectiveStartedAt != null) {
      const collector = options?.stagedFileMtimeCollector ?? realStagedFileMtimeCollector
      const mtimes = collector(workingDir)
      if (
        isStaleAgainstDispatch({
          stagedFileMtimes: mtimes,
          dispatchStartedAt: effectiveStartedAt,
        })
      ) {
        return { allowed: false, reason: 'stale_diff' }
      }
    }
    return { allowed: true, reason: 'non-empty staged diff in owner working_dir' }
  }

  return {
    allowed: false,
    reason:
      workingDir == null
        ? 'owner session has no working_dir; cannot run git diff check'
        : 'no staged diff and no passing QA handoff for owner',
  }
}

/**
 * WS M — resolve the dispatch start time the freshness check should use.
 * Explicit `dispatchStartedAt` always wins. Otherwise, if a `dispatchId`
 * is supplied along with a resolver, the resolver's return value is
 * used. Returns null when no evidence is available (skip freshness).
 */
function resolveEffectiveStartedAt(
  options: CompletionGateOptions | undefined,
): Date | number | null {
  if (!options) return null
  if (options.dispatchStartedAt != null) return options.dispatchStartedAt
  if (options.dispatchId && options.resolveDispatchStartedAt) {
    const resolved = options.resolveDispatchStartedAt(options.dispatchId)
    return resolved ?? null
  }
  return null
}

// ─── WS R — Gate-driven task completion ────────────────────────────────────
//
// Lift from chamber-copilot: lib/job-store.mjs:2836-2858 — `_onVerifyResult`.
// The verify gate IS the status writer. It guards on the current row state
// (`if (job.status !== JOB_STATUS.VERIFYING) return;`) to prevent racing a
// concurrent cancel/dispose. The SCNS analogue:
//
//   UPDATE tasks
//      SET status='completed', quality_check_id=?, completed_at=?
//    WHERE id=? AND status='in_progress' AND dispatch_readback_at IS NOT NULL
//
// The status guard is the protection against double-fire (a flaky verdict
// bus emitting twice for the same team) and against racing a manual PATCH
// to status='failed'.

/** Spawn-failure tokens stamped into dispatch_dev_session_id by WS-P
 * when the dev couldn't be spawned. We refuse to auto-complete tasks
 * whose dispatched dev was never a real registered session — those
 * rows have no working_dir we can validate. Mirrors the rejection
 * isStoredSessionRegistered does in manager-exit-monitor. */
const SPAWN_FAILURE_PREFIXES = ['409:', 'spawn-failed:'] as const

interface TaskRow {
  readonly id: number
  readonly team_id: string
  readonly status: string
  readonly owner: string | null
  readonly dispatch_id: string | null
  readonly dispatch_readback_at: string | null
  readonly dispatch_dev_session_id: string | null
}

export interface CompleteTaskBySystemInput {
  readonly taskId: number
  readonly qualityCheckId: string
  /** Override for tests; falls back to realGitDiffChecker in production. */
  readonly gitDiffChecker?: GitDiffChecker
  readonly stagedFileMtimeCollector?: StagedFileMtimeCollector
  readonly resolveDispatchStartedAt?: (
    dispatchId: string,
  ) => Date | number | null | undefined
  /** Wall-clock ISO timestamp for completed_at. Defaults to now. */
  readonly completedAtIso?: string
}

export interface CompleteTaskBySystemResult {
  readonly transitioned: boolean
  readonly reason: string
  readonly taskId: number
  readonly teamId: string | null
  readonly dispatchId: string | null
  readonly ownerSessionId: string | null
  readonly completedAtIso: string | null
}

/**
 * System-initiated task completion path. Called by the
 * quality_gate_verdict subscriber when the gate passes on a
 * WS-P-attributed task. Reuses the existing WS-G/WS-M validators
 * (staged-diff + dispatch-id freshness) — no validation is skipped.
 *
 * Status-guarded UPDATE mirrors chamber-copilot's `_onVerifyResult`:
 * if the row has already moved off in_progress (e.g. manual PATCH to
 * failed, or a concurrent transition), the UPDATE matches zero rows
 * and `transitioned` is false. Idempotent.
 *
 * Unlike the human PATCH path, this path REQUIRES a fresh staged
 * diff — it does NOT accept the legacy passing-handoff route. The
 * verdict is the auth, the staged diff is the evidence; a stale
 * handoff from an earlier dispatch must not auto-complete a fresh
 * dispatched task that produced no work.
 */
export function completeTaskBySystem(
  db: Database.Database,
  input: CompleteTaskBySystemInput,
): CompleteTaskBySystemResult {
  const row = db
    .prepare(
      `SELECT id, team_id, status, owner,
              dispatch_id, dispatch_readback_at, dispatch_dev_session_id
         FROM tasks WHERE id = ?`,
    )
    .get(input.taskId) as TaskRow | undefined

  const baseFail = (reason: string): CompleteTaskBySystemResult => ({
    transitioned: false,
    reason,
    taskId: input.taskId,
    teamId: row?.team_id ?? null,
    dispatchId: row?.dispatch_id ?? null,
    ownerSessionId: row?.owner ?? null,
    completedAtIso: null,
  })

  if (!row) return baseFail('task-not-found')
  if (row.status !== 'in_progress') return baseFail(`status-not-in-progress:${row.status}`)
  if (!row.dispatch_readback_at) return baseFail('legacy-no-readback')
  if (!row.dispatch_id) return baseFail('legacy-no-dispatch-id')

  // Reject spawn-failure tokens stamped by WS-P. These rows never had a
  // real dev session, so there's no working_dir to validate against.
  const devToken = row.dispatch_dev_session_id ?? ''
  for (const prefix of SPAWN_FAILURE_PREFIXES) {
    if (devToken.startsWith(prefix)) {
      return baseFail(`dev_session-spawn-failed:${prefix.replace(':', '')}`)
    }
  }

  // Reuse the WS-G/WS-M validators. Run only the staged-diff path —
  // skip the handoff path by using a dedicated evaluator below so a
  // stale handoff cannot mask the absence of a fresh dispatched diff.
  const session = row.owner ? findSessionById(db, row.owner) : null
  const workingDir = session?.working_dir ?? null
  if (!workingDir) return baseFail('owner-has-no-working-dir')

  const checker = input.gitDiffChecker ?? realGitDiffChecker
  if (!checker(workingDir)) return baseFail('gate:no-staged-diff')

  // Freshness — reuse WS-G/WS-M check via the existing helper.
  const collector = input.stagedFileMtimeCollector ?? realStagedFileMtimeCollector
  if (input.resolveDispatchStartedAt) {
    const startedAt = input.resolveDispatchStartedAt(row.dispatch_id)
    if (startedAt != null) {
      const mtimes = collector(workingDir)
      if (
        isStaleAgainstDispatch({
          stagedFileMtimes: mtimes,
          dispatchStartedAt: startedAt,
        })
      ) {
        return baseFail('gate:stale_diff')
      }
    }
  }

  const completedAtIso = input.completedAtIso ?? new Date().toISOString()

  // Status-guarded UPDATE — chamber-copilot's _onVerifyResult pattern.
  // The WHERE clause is the protection against double-fire and against
  // racing a manual PATCH. If status moved off 'in_progress' between
  // the SELECT and this UPDATE, changes will be 0.
  const result = db
    .prepare(
      `UPDATE tasks
          SET status = 'completed',
              quality_check_id = ?,
              completed_at = ?,
              updated_at = datetime('now')
        WHERE id = ?
          AND status = 'in_progress'
          AND dispatch_readback_at IS NOT NULL
          AND dispatch_id IS NOT NULL`,
    )
    .run(input.qualityCheckId, completedAtIso, input.taskId)

  if (result.changes === 0) {
    return baseFail('race-status-changed')
  }

  return {
    transitioned: true,
    reason: 'completed',
    taskId: input.taskId,
    teamId: row.team_id,
    dispatchId: row.dispatch_id,
    ownerSessionId: row.owner,
    completedAtIso,
  }
}

// ─── WS R — Quality-gate verdict subscriber ────────────────────────────────

export interface SystemCompletionEventLog {
  taskCompleted(sessionId: string | null, data: Record<string, unknown>): unknown
}

export interface VerdictPayload {
  readonly team_id?: string
  readonly passed?: boolean
  readonly qualityCheckId?: string | null
}

export interface HandleVerdictInput {
  readonly db: Database.Database
  readonly eventLog: SystemCompletionEventLog
  readonly verdict: VerdictPayload
  readonly gitDiffChecker?: GitDiffChecker
  readonly stagedFileMtimeCollector?: StagedFileMtimeCollector
  readonly resolveDispatchStartedAt?: (
    dispatchId: string,
  ) => Date | number | null | undefined
}

/**
 * Subscriber wired to the `quality_gate_verdict` event. Skips
 * verdicts that aren't passing, aren't WS-R-eligible, or are
 * ambiguous (multiple in_progress WS-P-stamped tasks on the same
 * team). On a successful transition, emits `task_completed` with
 * sessionId=null (system actor) and the owner_session_id in the
 * payload — matches chamber-copilot's audit-trail semantics.
 *
 * Wrapped by startup.ts in a try/catch so a malformed payload or DB
 * blip never kills the broker.
 */
export function handleQualityGateVerdictForTaskCompletion(
  input: HandleVerdictInput,
): { transitioned: boolean; reason: string } {
  const { db, eventLog, verdict } = input
  if (verdict.passed !== true) return { transitioned: false, reason: 'not-passed' }
  if (!verdict.qualityCheckId) return { transitioned: false, reason: 'no-quality-check-id' }
  if (!verdict.team_id) return { transitioned: false, reason: 'no-team-id' }

  // WS-R correlation: select the (single) in_progress WS-P-stamped task
  // for this team. If there are multiple, refuse to guess — log + skip.
  const candidates = db
    .prepare(
      `SELECT id FROM tasks
        WHERE team_id = ?
          AND status = 'in_progress'
          AND dispatch_readback_at IS NOT NULL
          AND dispatch_id IS NOT NULL
        ORDER BY dispatch_readback_at DESC`,
    )
    .all(verdict.team_id) as Array<{ id: number }>

  if (candidates.length === 0) {
    return { transitioned: false, reason: 'no-eligible-task' }
  }
  if (candidates.length > 1) {
    return { transitioned: false, reason: 'ambiguous-multiple-in-progress' }
  }

  const candidate = candidates[0]
  if (!candidate) return { transitioned: false, reason: 'no-eligible-task' }

  const result = completeTaskBySystem(db, {
    taskId: candidate.id,
    qualityCheckId: verdict.qualityCheckId,
    gitDiffChecker: input.gitDiffChecker,
    stagedFileMtimeCollector: input.stagedFileMtimeCollector,
    resolveDispatchStartedAt: input.resolveDispatchStartedAt,
  })

  if (!result.transitioned) {
    return { transitioned: false, reason: result.reason }
  }

  // System actor — emit with sessionId=null; owner goes in payload.
  eventLog.taskCompleted(null, {
    task_id: result.taskId,
    team_id: result.teamId,
    dispatch_id: result.dispatchId,
    owner_session_id: result.ownerSessionId,
    quality_check_id: verdict.qualityCheckId,
    completed_at: result.completedAtIso,
    completion_source: 'quality_gate_verdict',
  })

  return { transitioned: true, reason: 'completed' }
}

// ─── P0.3 — Auto-merge-driven task completion ──────────────────────────────
//
// Closes the last gap in the self-improve loop: when the auto-merger lands an
// `scns/auto/*` branch into main, the source task should transition off
// in_progress. The verdict subscriber (`handleQualityGateVerdictForTaskCompletion`)
// is the primary path, but it requires a fresh staged diff in the dev session's
// working_dir. That requirement is brittle:
//   - The dev session may have already deregistered when the verdict fires.
//   - The worktree may be in mid-merge by the QG arbiter's commit step.
//   - cleanupStaleSessionsOnStartup purges sessions on broker restart.
//
// `completeTaskByMerge` treats the successful merge_sha as authoritative
// evidence: the auto-merger has already passed 7 structural safety gates AND
// produced a verifiable merge commit. No diff check needed.
//
// Idempotency: the status-guarded UPDATE returns changes=0 if the row already
// moved off in_progress (e.g. the verdict subscriber won the race when the
// staged-diff path was viable). Surfaces `already-completed` vs `no-eligible-task`
// distinctly so monitoring can tell a harmless idempotency event apart from
// a true attribution miss.

export interface CompleteTaskByMergeInput {
  readonly teamId: string
  readonly mergeSha: string
  readonly qualityCheckId: string | null
  readonly completedAtIso?: string
}

/**
 * Auto-merge-driven completion. Selects the single in_progress WS-P-stamped
 * task for the team and stamps merge_sha + completion_source='auto_merge'.
 *
 * Attribution risk (acknowledged in P0.3): selection is team-only. If a team
 * has had multiple sequential dispatches (only the latest in_progress at any
 * time), this remains correct. Strengthening attribution by propagating
 * dispatch_id through the verdict payload is tracked in p0-3b.
 */
export function completeTaskByMerge(
  db: Database.Database,
  input: CompleteTaskByMergeInput,
): CompleteTaskBySystemResult {
  const candidates = db
    .prepare(
      `SELECT id, team_id, status, owner,
              dispatch_id, dispatch_readback_at, dispatch_dev_session_id
         FROM tasks
        WHERE team_id = ?
          AND status = 'in_progress'
          AND dispatch_readback_at IS NOT NULL
          AND dispatch_id IS NOT NULL
        ORDER BY dispatch_readback_at DESC`,
    )
    .all(input.teamId) as TaskRow[]

  const baseFail = (reason: string, row?: TaskRow): CompleteTaskBySystemResult => ({
    transitioned: false,
    reason,
    taskId: row?.id ?? -1,
    teamId: row?.team_id ?? input.teamId,
    dispatchId: row?.dispatch_id ?? null,
    ownerSessionId: row?.owner ?? null,
    completedAtIso: null,
  })

  if (candidates.length === 0) {
    // Distinguish "verdict subscriber already won the race" from "no task found".
    // A recently-completed task for the same team with the same quality_check_id
    // is the harmless-idempotency case (return already-completed for clean logging).
    if (input.qualityCheckId) {
      const already = db
        .prepare(
          `SELECT id FROM tasks
            WHERE team_id = ?
              AND status = 'completed'
              AND quality_check_id = ?
            ORDER BY completed_at DESC
            LIMIT 1`,
        )
        .get(input.teamId, input.qualityCheckId) as { id: number } | undefined
      if (already) return baseFail('already-completed')
    }
    return baseFail('no-eligible-task')
  }
  if (candidates.length > 1) {
    return baseFail('ambiguous-multiple-in-progress')
  }

  const row = candidates[0]
  if (!row) return baseFail('no-eligible-task')

  const completedAtIso = input.completedAtIso ?? new Date().toISOString()

  // Status-guarded UPDATE — idempotent against the verdict subscriber and
  // any manual PATCH to status='failed'. COALESCE preserves a verdict-set
  // quality_check_id if it already populated the row.
  const result = db
    .prepare(
      `UPDATE tasks
          SET status = 'completed',
              quality_check_id = COALESCE(?, quality_check_id),
              merge_sha = ?,
              completion_source = 'auto_merge',
              completed_at = ?,
              updated_at = datetime('now')
        WHERE id = ?
          AND status = 'in_progress'`,
    )
    .run(input.qualityCheckId, input.mergeSha, completedAtIso, row.id)

  if (result.changes === 0) {
    return baseFail('race-status-changed', row)
  }

  return {
    transitioned: true,
    reason: 'completed',
    taskId: row.id,
    teamId: row.team_id,
    dispatchId: row.dispatch_id,
    ownerSessionId: row.owner,
    completedAtIso,
  }
}
