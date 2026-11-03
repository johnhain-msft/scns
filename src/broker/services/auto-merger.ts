/**
 * Phase 13.12.34 — Auto-Merger Service.
 *
 * Closes the last gap in SCNS's self-healing loop: when the Quality Gate
 * Arbiter emits a verdict-PASS for an `scns/auto/*` branch, this service
 * runs a STRUCTURAL safety pass and — if everything checks out —
 * fast-forwards the branch into `main`. Without this service, every QG-
 * passing branch sits unmerged forever, requiring a human to run
 * `git merge`. With it, the loop is closed: a passing fix lands itself.
 *
 * Three things make this safe enough to ship behind a flag:
 *
 *   1) The safety gates are STRUCTURAL — they do not re-judge the diff's
 *      correctness (the QG already did that); they only ensure the diff
 *      doesn't have any of the *categorical* poison-pill shapes we have
 *      observed in postmortems (symlinks, forbidden files, missing tests,
 *      negative-memories block deletion, runaway size).
 *
 *   2) The merger is opt-in via `BROKER_AUTO_MERGE=1`. Default OFF. No
 *      surprise commits on `main`.
 *
 *   3) Every merge AND every rejection is recorded as an audit event so
 *      a human can review the trail at any time.
 *
 * Design constraints:
 *   - The merger never edits a forbidden file via the merge; it refuses
 *     to merge any branch that touches one. Forbidden files (intentional
 *     hand-curated list): broker plumbing files the system itself was
 *     told never to modify.
 *   - The merger refuses to merge if HEAD is not `main` or the working
 *     tree is dirty (cooperation with concurrent dev work).
 *   - The merger uses `--no-ff` so every auto-merge is a distinct,
 *     reversible commit visible in `git log --first-parent main`.
 */

import type Database from 'better-sqlite3'
import type { EventLog } from './event-log.js'
import type {
  EventDispatcher,
  TypedEvent,
} from '../event-dispatcher.js'
import { logger } from '../../shared/logger.js'
import { defaultRunCommand, type RunResult } from './quality-gate-arbiter.js'
import { classifyChangeset } from './qg-changeset-classifier.js'
import { isSafetyKernelPath } from './safety-kernel/protected-paths.js'

const log = logger.child({ module: 'auto-merger' })

// ── Public types ─────────────────────────────────────────────────────

export interface SafetyGateOutcome {
  readonly gate: string
  readonly passed: boolean
  readonly detail: string
}

export interface SafetyEvaluation {
  readonly ok: boolean
  readonly outcomes: readonly SafetyGateOutcome[]
}

export interface AutoMergerDeps {
  readonly db: Database.Database
  readonly eventLog: EventLog
  readonly dispatcher: EventDispatcher
  readonly projectRoot: string
  readonly enabled: boolean
  readonly runCommand?: (cmd: string, cwd: string) => RunResult
  readonly maxDiffLines?: number
  readonly forbiddenFiles?: readonly string[]
  /**
   * When true, the `no-qg-infra-without-override` gate is bypassed so
   * QG-infrastructure changes can be auto-merged. Default false. The
   * production CLI sets this from `BROKER_AUTO_MERGE_ALLOW_QG_INFRA=1`.
   * Intended only for the rare blue/green rollout of a vetted QG fix
   * where an operator has manually inspected the diff.
   */
  readonly allowQgInfraMerge?: boolean

  /**
   * P0.3: post-merge task completion callback. Invoked after a successful
   * merge with the verdict's team_id and the resulting merge SHA. The
   * implementation runs the status-guarded UPDATE in task-completion-gate
   * (`completeTaskByMerge`) and is idempotent — safe to call even when the
   * verdict subscriber already won the race and transitioned the row.
   *
   * Errors thrown by the callback are caught and logged independently of
   * the merge outcome so a completion glitch never masks a successful
   * merge in the audit trail.
   *
   * Optional: omit to preserve the legacy "merge only, never close the
   * task" behaviour (useful in tests that want to assert the merge step
   * in isolation).
   */
  readonly completeTaskOnMerge?: (input: {
    readonly teamId: string
    readonly mergeSha: string
    readonly qualityCheckId: string | null
  }) => {
    readonly transitioned: boolean
    readonly reason: string
    readonly taskId: number
    readonly ownerSessionId: string | null
    readonly dispatchId: string | null
    readonly completedAtIso: string | null
  }
}

export interface AutoMerger {
  /** Manually evaluate a branch (returns safety result without merging). */
  evaluate(branch: string): SafetyEvaluation
  /** Manually merge a branch (skips event subscriber). Returns SHA on success. */
  merge(branch: string): { ok: true; sha: string } | { ok: false; reason: string }
  stop(): void
}

// ── Defaults ─────────────────────────────────────────────────────────

const DEFAULT_MAX_DIFF_LINES = 500

/**
 * Files the auto-merger must NEVER allow to be modified via auto-merge.
 * These are the broker plumbing files the self-improve agent was told
 * not to touch. Any branch touching one of these requires explicit
 * human review.
 */
export const DEFAULT_FORBIDDEN_FILES: readonly string[] = [
  'src/broker/services/auto-dispatch.ts',
  'src/broker/services/team-task-autospawner.ts',
  'src/broker/services/self-improve-followup-creator.ts',
  'src/broker/services/task-completion-gate.ts',
  'src/broker/services/gate-evidence.ts',
  'src/broker/services/quality-gate-arbiter.ts',
  'scripts/broker-restart.sh',
  'package.json',
  'package-lock.json',
]

// ── Pure safety-gate evaluation (exported for tests) ─────────────────

/**
 * Run the structural safety gates against a candidate branch. Each gate
 * is independent and returns a pass/fail outcome with a human-readable
 * detail string. The branch is safe-to-merge ONLY when ALL gates pass.
 *
 * Gates:
 *   - no-staged-symlinks: branch tree contains no mode 120000 entries
 *   - no-forbidden-files: diff touches none of `forbiddenFiles`
 *   - no-neg-mem-edit: diff does not touch the SCNS negative-memories block
 *   - has-test-coverage: at least one *.test.* or test/ file is added or modified
 *   - diff-size-bounded: total added+removed lines ≤ `maxDiffLines`
 *   - main-baseline-exists: `main` ref resolves (defensive)
 */
export function evaluateSafetyGates(
  run: (cmd: string, cwd: string) => RunResult,
  branch: string,
  projectRoot: string,
  options: {
    maxDiffLines: number
    forbiddenFiles: readonly string[]
    allowQgInfraMerge?: boolean
  },
): SafetyEvaluation {
  const outcomes: SafetyGateOutcome[] = []

  // Gate: main baseline exists
  const mainSha = run('git rev-parse main', projectRoot)
  if (!mainSha.ok) {
    outcomes.push({
      gate: 'main-baseline-exists',
      passed: false,
      detail: `git rev-parse main failed: ${mainSha.stderr || mainSha.stdout}`,
    })
    return { ok: false, outcomes }
  }
  outcomes.push({
    gate: 'main-baseline-exists',
    passed: true,
    detail: `main=${mainSha.stdout.trim().slice(0, 12)}`,
  })

  // Gate: branch ref exists
  const branchSha = run(`git rev-parse ${JSON.stringify(branch)}`, projectRoot)
  if (!branchSha.ok) {
    outcomes.push({
      gate: 'branch-exists',
      passed: false,
      detail: `git rev-parse ${branch} failed: ${branchSha.stderr || branchSha.stdout}`,
    })
    return { ok: false, outcomes }
  }

  // Gate: no symlinks in branch tree
  const lsTree = run(`git ls-tree -r ${JSON.stringify(branch)}`, projectRoot)
  if (!lsTree.ok) {
    outcomes.push({
      gate: 'no-staged-symlinks',
      passed: false,
      detail: `git ls-tree failed: ${lsTree.stderr}`,
    })
  } else {
    const symlinks: string[] = []
    for (const line of (lsTree.stdout || '').split('\n')) {
      if (!line.startsWith('120000 ')) continue
      const tab = line.indexOf('\t')
      if (tab !== -1) symlinks.push(line.slice(tab + 1))
    }
    outcomes.push({
      gate: 'no-staged-symlinks',
      passed: symlinks.length === 0,
      detail:
        symlinks.length === 0
          ? 'no mode-120000 entries in branch tree'
          : `branch contains ${symlinks.length} symlink(s): ${symlinks.slice(0, 3).join(', ')}`,
    })
  }

  // Compute the diff between main and branch (used by next 4 gates).
  const diffNames = run(
    `git diff --name-only main...${JSON.stringify(branch)}`,
    projectRoot,
  )
  const changedFiles = diffNames.ok
    ? (diffNames.stdout || '').split('\n').filter((f) => f.length > 0)
    : []

  // Gate: no forbidden files
  const forbiddenTouched = changedFiles.filter((f) =>
    options.forbiddenFiles.includes(f),
  )
  outcomes.push({
    gate: 'no-forbidden-files',
    passed: forbiddenTouched.length === 0,
    detail:
      forbiddenTouched.length === 0
        ? 'no forbidden files modified'
        : `branch edits forbidden file(s): ${forbiddenTouched.join(', ')}`,
  })

  // WS-0 Gate 3 — no safety-kernel edit. ABSOLUTE: the immutable safety
  // kernel + its human-owned allowlist can NEVER be modified via auto-merge.
  // Unlike the QG-infra gate below, this has NO override — changing the
  // kernel always requires explicit human approval. This is the merge-time
  // backstop behind the QG arbiter's `kernel-self-edit` pre-commit reject.
  const kernelTouched = changedFiles.filter((f) => isSafetyKernelPath(f))
  outcomes.push({
    gate: 'no-safety-kernel-edit',
    passed: kernelTouched.length === 0,
    detail:
      kernelTouched.length === 0
        ? 'no safety-kernel files modified'
        : `branch edits immutable safety-kernel file(s) — human approval required: ${kernelTouched.join(', ')}`,
  })

  // Gate: no QG-infrastructure changes without explicit override.
  // Closes the structural chicken-and-egg: a fix to the QG arbiter
  // (or auto-dispatch, autospawner, gate-evidence, etc.) cannot
  // auto-merge through the very mechanism it patches. An operator
  // who has manually inspected the diff can set
  // BROKER_AUTO_MERGE_ALLOW_QG_INFRA=1 to override.
  const classification = classifyChangeset(changedFiles)
  const allowOverride = options.allowQgInfraMerge === true
  outcomes.push({
    gate: 'no-qg-infra-without-override',
    passed: classification.kind === 'ordinary' || allowOverride,
    detail:
      classification.kind === 'ordinary'
        ? 'no QG-infrastructure files modified'
        : allowOverride
          ? `QG-infrastructure changes allowed via override: ${classification.qgInfraFiles.join(', ')}`
          : `QG-infrastructure change requires human review: ${classification.qgInfraFiles.join(', ')}`,
  })

  // Gate: no negative-memories block edit
  const negMemDiff = run(
    `git diff main...${JSON.stringify(branch)} -- .github/copilot-instructions.md`,
    projectRoot,
  )
  const touchedNegMem =
    negMemDiff.ok && /SCNS:negative-memories/.test(negMemDiff.stdout || '')
  outcomes.push({
    gate: 'no-neg-mem-edit',
    passed: !touchedNegMem,
    detail: touchedNegMem
      ? 'branch touches the negative-memories managed block — requires human review'
      : 'negative-memories block untouched',
  })

  // Gate: has test coverage
  const testFiles = changedFiles.filter(
    (f) => /(^|\/)test\//.test(f) || /\.(test|spec)\.[tj]sx?$/.test(f),
  )
  outcomes.push({
    gate: 'has-test-coverage',
    passed: testFiles.length > 0,
    detail:
      testFiles.length > 0
        ? `${testFiles.length} test file(s) touched`
        : 'no test files added or modified — refuse to auto-merge code without tests',
  })

  // Gate: diff size bounded
  const numstat = run(
    `git diff --numstat main...${JSON.stringify(branch)}`,
    projectRoot,
  )
  let totalLines = 0
  if (numstat.ok) {
    for (const line of (numstat.stdout || '').split('\n')) {
      if (!line) continue
      const parts = line.split('\t')
      const add = parts[0]
      const del = parts[1]
      if (add && del && add !== '-' && del !== '-') {
        const a = Number.parseInt(add, 10)
        const d = Number.parseInt(del, 10)
        if (Number.isFinite(a) && Number.isFinite(d)) {
          totalLines += a + d
        }
      }
    }
  }
  outcomes.push({
    gate: 'diff-size-bounded',
    passed: totalLines <= options.maxDiffLines,
    detail: `${totalLines} lines added+removed (cap=${options.maxDiffLines})`,
  })

  const ok = outcomes.every((o) => o.passed)
  return { ok, outcomes }
}

// ── Pure merge execution (exported for tests) ────────────────────────

/**
 * Tree paths the broker rewrites out-of-band (dream daemon's negative-memory
 * applicator). A pending edit to one of these must NOT block an auto-merge
 * (issue #5), so {@link performMerge} excludes them from the cleanliness check.
 */
export const BROKER_MANAGED_PATHS: ReadonlySet<string> = new Set([
  '.github/copilot-instructions.md',
])

/**
 * Perform the fast-forward-or-no-ff merge. Returns the resulting commit
 * SHA on success, or a structured failure with a human-readable reason.
 *
 * Refuses to merge if:
 *   - HEAD is not on `main`
 *   - working tree has uncommitted changes OTHER than broker-managed paths
 *   - the merge produces a conflict (auto-aborts)
 */
export function performMerge(
  run: (cmd: string, cwd: string) => RunResult,
  branch: string,
  projectRoot: string,
): { ok: true; sha: string } | { ok: false; reason: string } {
  // Must be on main
  const head = run('git rev-parse --abbrev-ref HEAD', projectRoot)
  if (!head.ok) {
    return { ok: false, reason: `git rev-parse HEAD failed: ${head.stderr}` }
  }
  const headBranch = head.stdout.trim()
  if (headBranch !== 'main') {
    return {
      ok: false,
      reason: `HEAD is on '${headBranch}', not 'main' — refusing auto-merge`,
    }
  }

  // Working tree must be clean — except for broker-managed paths the dream daemon
  // rewrites out-of-band (issue #5: negmem applicator leaves .github/copilot-instructions.md
  // dirty). Those are filtered so a pending managed-block edit can't chronically block merges.
  const status = run('git status --porcelain', projectRoot)
  if (!status.ok) {
    return { ok: false, reason: `git status failed: ${status.stderr}` }
  }
  const dirty = (status.stdout || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => !BROKER_MANAGED_PATHS.has(l.replace(/^.{1,2}\s+/, '')))
  if (dirty.length > 0) {
    return {
      ok: false,
      reason: `working tree dirty — refusing auto-merge`,
    }
  }

  // Merge --no-ff so the auto-merge is a distinct, reversible commit
  const merge = run(
    `git -c user.name=scns-auto -c user.email=scns-auto@localhost merge --no-ff --no-edit ${JSON.stringify(branch)}`,
    projectRoot,
  )
  if (!merge.ok) {
    // Abort any half-applied merge state defensively
    run('git merge --abort', projectRoot)
    return {
      ok: false,
      reason: `merge failed: ${(merge.stderr || merge.stdout).slice(0, 300)}`,
    }
  }

  const newSha = run('git rev-parse HEAD', projectRoot)
  return {
    ok: true,
    sha: newSha.ok ? newSha.stdout.trim() : 'unknown',
  }
}

// ── Factory ──────────────────────────────────────────────────────────

export function createAutoMerger(deps: AutoMergerDeps): AutoMerger {
  const run = deps.runCommand ?? defaultRunCommand
  const maxDiffLines = deps.maxDiffLines ?? DEFAULT_MAX_DIFF_LINES
  const forbiddenFiles = deps.forbiddenFiles ?? DEFAULT_FORBIDDEN_FILES
  const allowQgInfraMerge = deps.allowQgInfraMerge === true
  let unsubscribe: (() => void) | null = null

  function evaluate(branch: string): SafetyEvaluation {
    return evaluateSafetyGates(run, branch, deps.projectRoot, {
      maxDiffLines,
      forbiddenFiles,
      allowQgInfraMerge,
    })
  }

  function merge(
    branch: string,
  ): { ok: true; sha: string } | { ok: false; reason: string } {
    return performMerge(run, branch, deps.projectRoot)
  }

  function handleVerdict(evt: TypedEvent): void {
    if (!deps.enabled) return
    try {
      const payload = JSON.parse(evt.payload) as {
        team_id?: string
        passed?: boolean
        branch?: string
        sourceSuggestionId?: string | null
        qualityCheckId?: string | null
      }
      if (payload.passed !== true) return
      const branch = payload.branch
      if (!branch || typeof branch !== 'string') return
      if (!branch.startsWith('scns/auto/')) {
        log.debug(
          { branch, teamId: payload.team_id },
          'auto-merger: ignoring non-scns/auto branch',
        )
        return
      }

      const safety = evaluate(branch)
      if (!safety.ok) {
        const failedGates = safety.outcomes.filter((o) => !o.passed)
        log.warn(
          {
            branch,
            teamId: payload.team_id,
            failedGates: failedGates.map((o) => o.gate),
          },
          'auto-merger: refusing to merge — safety gates failed',
        )
        deps.eventLog.autoMergeRejected(null, {
          branch,
          team_id: payload.team_id ?? null,
          source_suggestion_id: payload.sourceSuggestionId ?? null,
          failedGates: failedGates.map((o) => ({
            gate: o.gate,
            detail: o.detail,
          })),
          allOutcomes: safety.outcomes,
        })
        return
      }

      const mergeResult = merge(branch)
      if (!mergeResult.ok) {
        log.warn(
          { branch, teamId: payload.team_id, reason: mergeResult.reason },
          'auto-merger: merge step failed',
        )
        deps.eventLog.autoMergeRejected(null, {
          branch,
          team_id: payload.team_id ?? null,
          source_suggestion_id: payload.sourceSuggestionId ?? null,
          failedGates: [{ gate: 'merge-execution', detail: mergeResult.reason }],
          allOutcomes: safety.outcomes,
        })
        return
      }

      log.info(
        {
          branch,
          teamId: payload.team_id,
          mergeSha: mergeResult.sha,
        },
        'auto-merger: merged scns/auto branch into main',
      )
      deps.eventLog.autoMerged(null, {
        branch,
        team_id: payload.team_id ?? null,
        source_suggestion_id: payload.sourceSuggestionId ?? null,
        merge_sha: mergeResult.sha,
        gates: safety.outcomes,
      })

      // P0.3: close out the source task. Wrapped in its own try/catch so a
      // completion failure never masks the successful merge in the audit
      // trail — the merge IS done at this point; the task transition is a
      // bookkeeping step on top of it.
      if (payload.team_id && deps.completeTaskOnMerge) {
        try {
          const completion = deps.completeTaskOnMerge({
            teamId: payload.team_id,
            mergeSha: mergeResult.sha,
            qualityCheckId: payload.qualityCheckId ?? null,
          })
          if (completion.transitioned) {
            log.info(
              {
                taskId: completion.taskId,
                teamId: payload.team_id,
                mergeSha: mergeResult.sha,
                reason: completion.reason,
              },
              'auto-merger: closed source task on merge',
            )
            deps.eventLog.taskCompleted(null, {
              task_id: completion.taskId,
              team_id: payload.team_id,
              dispatch_id: completion.dispatchId,
              owner_session_id: completion.ownerSessionId,
              quality_check_id: payload.qualityCheckId ?? null,
              merge_sha: mergeResult.sha,
              completed_at: completion.completedAtIso,
              completion_source: 'auto_merge',
            })
          } else {
            // "already-completed" is the harmless-idempotency case (verdict
            // subscriber won the race). Anything else (no-eligible-task,
            // ambiguous-multiple-in-progress, race-status-changed) is worth
            // surfacing as a warning for monitoring.
            const level =
              completion.reason === 'already-completed' ? log.info : log.warn
            level.call(
              log,
              {
                teamId: payload.team_id,
                mergeSha: mergeResult.sha,
                reason: completion.reason,
              },
              'auto-merger: post-merge task completion skipped',
            )
          }
        } catch (err) {
          log.warn(
            {
              teamId: payload.team_id,
              mergeSha: mergeResult.sha,
              err: err instanceof Error ? err.message : String(err),
            },
            'auto-merger: completeTaskOnMerge threw — merge succeeded but task left in_progress',
          )
        }
      }
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'auto-merger: handler failed (swallowed to keep dispatcher alive)',
      )
    }
  }

  if (deps.enabled) {
    unsubscribe = deps.dispatcher.subscribe(
      { event_types: ['quality_gate_verdict'] },
      handleVerdict,
    )
    log.info(
      {
        projectRoot: deps.projectRoot,
        maxDiffLines,
        forbiddenFileCount: forbiddenFiles.length,
        allowQgInfraMerge,
      },
      'auto-merger started (BROKER_AUTO_MERGE=1)',
    )
  } else {
    log.info('auto-merger NOT started (BROKER_AUTO_MERGE unset or 0)')
  }

  return {
    evaluate,
    merge,
    stop: () => {
      if (unsubscribe) {
        unsubscribe()
        unsubscribe = null
      }
    },
  }
}
