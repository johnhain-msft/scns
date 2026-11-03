/**
 * Team Lifecycle Controller — Phase 13.4.
 *
 * Observes agent exits from the spawner, detects when the last member of a team
 * has exited, collects an artifact bundle (staged diff, log tails), and emits a
 * `team_completed` event consumed by the Phase 13.5 quality gate.
 *
 * Also provides a periodic backlog check that triggers agent scale-up when
 * the unread message count for an active team exceeds a configurable threshold.
 */

import { execSync as nodeExecSync } from 'node:child_process'
import {
  readFileSync as fsReadFileSync,
  existsSync as fsExistsSync,
  statSync as fsStatSync,
  realpathSync as fsRealpathSync,
} from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import type { EventLog } from './event-log.js'
import type { AgentSpawner } from './agent-spawner.js'
import { findTeamMembers } from '../storage/repositories/team-repository.js'
import { logger } from '../../shared/logger.js'

// ── Exit reason ──────────────────────────────────────────────

export type AgentExitReason = 'normal' | 'error' | 'killed' | 'zombie'

export interface AgentExitInfo {
  readonly sessionId: string
  readonly teamId: string
  readonly role: string
  readonly name: string
  readonly workingDir: string | null
  readonly logPath: string | null
  readonly launchMethod: 'tmux' | 'detached' | 'acp'
  readonly reason: AgentExitReason
}

// ── Completion payload ───────────────────────────────────────

export type AggregateOutcome = 'success' | 'partial' | 'failed'

export interface TeamCompletionArtifact {
  readonly sessionId: string
  readonly name: string
  readonly role: string
  readonly launchMethod: 'tmux' | 'detached' | 'acp'
  readonly exitReason: AgentExitReason
  readonly logPath: string | null
  readonly logSizeBytes: number | null
}

export interface TeamCompletionLog {
  readonly sessionId: string
  readonly name: string
  readonly tail: string
}

export interface TeamCompletionData {
  readonly teamId: string
  readonly memberSessionIds: ReadonlyArray<string>
  readonly stagedDiff: string
  readonly artifacts: ReadonlyArray<TeamCompletionArtifact>
  readonly logs: ReadonlyArray<TeamCompletionLog>
  readonly aggregateOutcome: AggregateOutcome
  readonly completedAt: string
}

// ── Options & controller ─────────────────────────────────────

export interface TeamLifecycleOptions {
  /** Unread-message count at which we scale up a team. Default 10. */
  readonly backlogThreshold?: number
  /** Hard cap per team (includes existing members). Default 4. */
  readonly maxAgentsPerTeam?: number
  /** Role assigned to scaled-up agents. Default 'helper'. */
  readonly scaleRole?: string
  /** Working dir for scaled-up agents (fallback when team has no member cwd). */
  readonly defaultWorkingDir?: string
  /** Max log tail in bytes per agent. Default 8 KiB. */
  readonly logTailBytes?: number
  /** Override for `git diff --cached` collection (for tests). */
  readonly collectStagedDiff?: (cwd: string) => string
  /** Override for log-tail collection (for tests). */
  readonly readLogTail?: (logPath: string, bytes: number) => string
  /**
   * Gap 1 — base directory of the per-team worktree manager
   * (`worktreeManager.getBaseDir()`). When the exiting team's cwd
   * resolves to a worktree INSIDE this base, the controller auto-stages
   * the agent's work (`git add -A`) before collecting the diff, so
   * untracked/unstaged work the agent wrote but never staged is not
   * lost. Gating to this base means auto-stage NEVER runs in the live
   * main repo. Unset ⇒ no auto-stage (legacy behavior).
   */
  readonly managedWorktreeBaseDir?: string
  /**
   * Override for the Gap 1 auto-stage step (for tests). Receives the
   * exiting agent's cwd and returns the git toplevel it staged from
   * (so diff collection runs from there), or null when no auto-stage
   * happened (cwd is not a managed worktree).
   */
  readonly stageWorktree?: (cwd: string) => string | null
}

export interface TeamLifecycleController {
  handleAgentExit(info: AgentExitInfo): void
  tickBacklog(): Promise<void>
  stop(): void
}

interface TeamState {
  readonly teamId: string
  readonly exits: Map<string, AgentExitInfo>
  readonly primaryCwd: string | null
  completionEmitted: boolean
}

const DEFAULT_BACKLOG_THRESHOLD = 10
const DEFAULT_MAX_AGENTS_PER_TEAM = 4
const DEFAULT_LOG_TAIL_BYTES = 8 * 1024
const DEFAULT_SCALE_ROLE = 'helper'

/**
 * Hard upper bound (ms) on the synchronous `git diff --cached` staged-diff
 * collection in {@link defaultCollectStagedDiff}. Runs on the main thread in
 * the agent-exit path, so an unbounded git could deadlock the whole broker
 * (postmortem 2026-06-05). 15s is far above a healthy diff (<1s) yet bounds
 * the pathological hang.
 */
export const STAGED_DIFF_TIMEOUT_MS = 15_000

/**
 * Collects the staged diff from a team worktree for the quality-gate
 * arbiter, with two pathspec exclusions mirroring commit 4c3d3c6's
 * commit-side guard.
 *
 * Postmortem qc=c2d6b26d (2026-05-17, task 73 halt on team 1d9d264d):
 * the Phase 13.12.32 / Layer-2 bridge symlinks
 * `<teamWorktree>/node_modules` to the host's project node_modules so
 * vitest/eslint/tsc resolve under the per-team worktree. The project
 * `.gitignore` rule `node_modules/` (trailing slash) only ignores a
 * directory at that path — NOT a symlink — so a dev's broker-
 * instructed `git add -A` sweeps the symlink into the index. The
 * legacy `git diff --cached` (no pathspec) then returned a diff
 * containing a `new file mode 120000 node_modules` entry. Downstream,
 * the QG arbiter bridged node_modules into its own disposable worktree
 * and tried `git apply --index` of that diff; git refused with
 *   error: node_modules: already exists in working directory
 * yielding verdict `diff-apply-failed`, score 0. Three back-to-back
 * verdicts of this shape tripped the 3-consecutive-fail halt-guard.
 *
 * Fix: invoke
 *   git diff --cached -- . ':!node_modules' ':!.git/info/exclude'
 * which uses git pathspec magic (`:!` = exclude) to drop the bridged
 * symlink and the broker-managed local exclude file from the diff at
 * collection time. The `.` argument is required so git treats the
 * remaining `:!` arguments as exclude-only restrictions on the full
 * tree (without it, `:!` patterns become hard pathspecs).
 *
 * Exported for the reproduction-first integration test in
 * `test/unit/broker/services/team-lifecycle.diff-filter.test.ts`,
 * which seeds a real git repo with a bridged node_modules symlink and
 * asserts both the post-fix exclusion and a negative-control proof
 * that the legacy `git diff --cached` would have included it.
 */
export function defaultCollectStagedDiff(
  cwd: string,
  exec: typeof nodeExecSync = nodeExecSync,
): string {
  try {
    // `:!.github/logs` — G3 (scns#36 handoff): broker-assigned agent logs
    // live at `<workingDir>/.github/logs/*.log` (see defaultLogPathFor) and
    // were swept into the index by `git add -A`, so every completion diff
    // BEGAN with the team's own runtime logs (182KB–733KB observed live
    // 2026-08-10 on the Cosmere child). Excluding at collection time also
    // covers logs the agent staged itself.
    const out = exec(
      // Double quotes, not single: execSync goes through cmd.exe on win32,
      // which passes single quotes to git verbatim ("':!node_modules'" is
      // outside repository). Double quotes are stripped by sh AND by the
      // Windows argv parser, so the pathspec magic survives both shells.
      'git diff --cached -- . ":!node_modules" ":!.git/info/exclude" ":!.github/logs"',
      {
        cwd,
        encoding: 'utf8',
        maxBuffer: 2 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
        // Postmortem (2026-06-05 broker hang): this runs synchronously on
        // the main thread inside the ACP child-process 'exit' callback. With
        // no timeout, a wedged `git diff` (e.g. a stuck worktree or an
        // index.lock held by a crashed git) parked the event loop in
        // SyncProcessRunner::Spawn forever and the whole broker (HTTP +
        // self-heal watchdog) went unresponsive. Bound it so the worst case
        // is a brief stall + empty diff, not a permanent deadlock.
        timeout: STAGED_DIFF_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        windowsHide: true,
      },
    )
    return String(out ?? '')
  } catch {
    return ''
  }
}

/**
 * OS-level canonical form of a path. `realpathSync.native` (not the JS
 * implementation): on win32 it expands 8.3 short names (`RUNNER~1` →
 * `runneradmin`), without which a git-reported long-name toplevel never
 * compares equal/contained against a short-name temp base. On posix both
 * implementations agree (symlinks resolved, `/var`→`/private/var` etc.).
 */
function canonicalPath(p: string): string {
  return fsRealpathSync.native(p)
}

/**
 * Canonical, fail-closed containment check: is `child` strictly inside
 * `baseDir`? Both paths are resolved with realpath so macOS
 * `/var`→`/private/var` symlinks (and similar) cannot be used to slip a
 * path past the boundary. Equal paths are NOT "inside". Any error
 * (missing path, permission) fails closed (returns false). This is the
 * load-bearing safety boundary for {@link defaultStageWorktree}: it must
 * never run `git add -A` outside the managed worktree base.
 */
function isInsideManagedBase(child: string, baseDir: string): boolean {
  try {
    const base = canonicalPath(baseDir)
    const c = canonicalPath(child)
    if (base === c) return false
    const rel = path.relative(base, c)
    return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel)
  } catch {
    return false
  }
}

/**
 * Gap 1 — auto-stage an agent's work in a managed per-team worktree so
 * untracked/unstaged work the agent wrote but never `git add`-ed is
 * captured by the completion diff (closing the delivery loop).
 *
 * Safety (per rubber-duck pass):
 *   - Resolves the git worktree ROOT via `git rev-parse --show-toplevel`
 *     and stages from there, so changes anywhere in the worktree are
 *     captured even if the agent exited from a subdirectory.
 *   - Only stages when that toplevel is strictly INSIDE `baseDir`
 *     ({@link isInsideManagedBase}, canonical + fail-closed) — it NEVER
 *     touches the live main repo.
 *   - Excludes the node_modules bridge symlink, the broker-managed local
 *     exclude file, QA scratch artifacts (`QA-NOTES.md` at any depth), and
 *     the broker-assigned agent runtime logs (`.github/logs/`, G3).
 *   - Bounded (timeout + SIGKILL) like the staged-diff collection, since
 *     it runs synchronously on the main thread in the agent-exit path.
 *
 * Returns the toplevel it staged from (so diff collection runs from the
 * same root), or null when no auto-stage happened (cwd not a managed
 * worktree / not a git repo / git failed).
 */
export function defaultStageWorktree(
  cwd: string,
  baseDir: string,
  exec: typeof nodeExecSync = nodeExecSync,
): string | null {
  let toplevel: string
  try {
    toplevel = String(
      exec('git rev-parse --show-toplevel', {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: STAGED_DIFF_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        windowsHide: true,
      }) ?? '',
    ).trim()
  } catch {
    return null
  }
  if (!toplevel) return null
  // Canonicalize before the containment check and before returning: git
  // prints the toplevel with forward slashes (and possibly 8.3 short names)
  // on win32, while callers compare it against native paths.
  try {
    toplevel = canonicalPath(toplevel)
  } catch {
    return null
  }
  if (!isInsideManagedBase(toplevel, baseDir)) return null
  try {
    exec(
      // Double quotes for cmd.exe compatibility — see defaultCollectStagedDiff.
      'git add -A -- . ":!node_modules" ":!.git/info/exclude" ":!QA-NOTES.md" ":!*QA-NOTES.md" ":!.github/logs"',
      {
        cwd: toplevel,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: STAGED_DIFF_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        windowsHide: true,
      },
    )
    return toplevel
  } catch {
    return null
  }
}

function defaultReadLogTail(logPath: string, bytes: number): string {
  try {
    if (!fsExistsSync(logPath)) return ''
    const stat = fsStatSync(logPath)
    const start = Math.max(0, stat.size - bytes)
    const buf = fsReadFileSync(logPath)
    return buf.subarray(start).toString('utf8')
  } catch {
    return ''
  }
}

export function createTeamLifecycleController(deps: {
  readonly db: Database.Database
  readonly eventLog: EventLog
  readonly spawner: AgentSpawner
  readonly options?: TeamLifecycleOptions
}): TeamLifecycleController {
  const { db, eventLog, spawner } = deps
  const opts = deps.options ?? {}
  const backlogThreshold = opts.backlogThreshold ?? DEFAULT_BACKLOG_THRESHOLD
  const maxAgentsPerTeam = opts.maxAgentsPerTeam ?? DEFAULT_MAX_AGENTS_PER_TEAM
  const scaleRole = opts.scaleRole ?? DEFAULT_SCALE_ROLE
  const logTailBytes = opts.logTailBytes ?? DEFAULT_LOG_TAIL_BYTES
  const collectDiff = opts.collectStagedDiff ?? defaultCollectStagedDiff
  const readTail = opts.readLogTail ?? defaultReadLogTail
  // Gap 1 — auto-stage agent work in a managed worktree before diff
  // collection. Gated to opts.managedWorktreeBaseDir so it can never
  // touch the live main repo; unset ⇒ no-op (legacy behavior).
  const managedBaseDir = opts.managedWorktreeBaseDir
  const stageWorktree =
    opts.stageWorktree ??
    ((cwd: string): string | null =>
      managedBaseDir ? defaultStageWorktree(cwd, managedBaseDir) : null)

  const log = logger.child({ module: 'team-lifecycle' })
  const teamStates = new Map<string, TeamState>()
  /** Teams we've already scaled this session (soft-dedup within scaling window). */
  const scalingInFlight = new Set<string>()

  function trackExit(info: AgentExitInfo): TeamState {
    let state = teamStates.get(info.teamId)
    // Phase 13.12.33 — start a fresh completion cycle when the prior
    // cycle already emitted AND this exit is from a session we have
    // not seen in the current cycle. The self-improve loop reuses a
    // single team across many tasks; without this reset, the in-memory
    // `completionEmitted` flag was sticky for the broker's lifetime
    // and every follow-up task's clean exit went silently un-gated.
    // The (!state.exits.has(info.sessionId)) guard preserves the
    // existing idempotent behavior for replayed exit events on the
    // SAME session — those still no-op on emitCompletion.
    if (state && state.completionEmitted && !state.exits.has(info.sessionId)) {
      state = undefined
    }
    if (!state) {
      state = {
        teamId: info.teamId,
        exits: new Map<string, AgentExitInfo>(),
        primaryCwd: info.workingDir,
        completionEmitted: false,
      }
      teamStates.set(info.teamId, state)
    }
    state.exits.set(info.sessionId, info)
    return state
  }

  function aggregateOutcome(exits: ReadonlyMap<string, AgentExitInfo>): AggregateOutcome {
    let killed = 0
    let ok = 0
    for (const info of exits.values()) {
      if (info.reason === 'normal') ok += 1
      else killed += 1
    }
    if (killed === 0) return 'success'
    if (ok === 0) return 'failed'
    return 'partial'
  }

  function emitCompletion(state: TeamState): void {
    if (state.completionEmitted) return
    state.completionEmitted = true

    const exits = [...state.exits.values()]
    const memberSessionIds = exits.map((e) => e.sessionId)

    const cwd = state.primaryCwd ?? exits.find((e) => e.workingDir)?.workingDir ?? null
    // Gap 1 — close the delivery loop. If the cwd is a managed per-team
    // worktree, auto-stage the agent's work (`git add -A` from the git
    // toplevel) before collecting, so untracked/unstaged work the agent
    // wrote but never staged is captured. `stageWorktree` returns the
    // toplevel it staged from (collect from there) or null when it did
    // not auto-stage (cwd outside the managed base → unchanged legacy
    // behavior, never touches the live main repo).
    const stageDir = cwd ? stageWorktree(cwd) : null
    const stagedDiff = cwd ? collectDiff(stageDir ?? cwd) : ''

    const artifacts: TeamCompletionArtifact[] = exits.map((e) => {
      let size: number | null = null
      if (e.logPath) {
        try {
          if (fsExistsSync(e.logPath)) size = fsStatSync(e.logPath).size
        } catch {
          size = null
        }
      }
      return {
        sessionId: e.sessionId,
        name: e.name,
        role: e.role,
        launchMethod: e.launchMethod,
        exitReason: e.reason,
        logPath: e.logPath,
        logSizeBytes: size,
      }
    })

    const logs: TeamCompletionLog[] = exits.map((e) => ({
      sessionId: e.sessionId,
      name: e.name,
      tail: e.logPath ? readTail(e.logPath, logTailBytes) : '',
    }))

    const data: TeamCompletionData = {
      teamId: state.teamId,
      memberSessionIds,
      stagedDiff,
      artifacts,
      logs,
      aggregateOutcome: aggregateOutcome(state.exits),
      completedAt: new Date().toISOString(),
    }

    try {
      eventLog.teamCompleted(null, data as unknown as Record<string, unknown>)
      log.info(
        {
          teamId: state.teamId,
          members: memberSessionIds.length,
          outcome: data.aggregateOutcome,
          diffBytes: stagedDiff.length,
        },
        'Team completion emitted',
      )
    } catch (err) {
      log.error({ err, teamId: state.teamId }, 'Failed to emit team_completed event')
    }

    scalingInFlight.delete(state.teamId)
  }

  function handleAgentExit(info: AgentExitInfo): void {
    const state = trackExit(info)

    // After the spawner's cleanup, the exiting member's row is already gone,
    // so findTeamMembers shows the remaining live members.
    let remaining: ReadonlyArray<unknown>
    try {
      remaining = findTeamMembers(db, info.teamId)
    } catch (err) {
      log.warn({ err, teamId: info.teamId }, 'Failed to query remaining team members')
      remaining = []
    }

    if (remaining.length === 0) {
      emitCompletion(state)
    }
  }

  async function tickBacklog(): Promise<void> {
    let rows: Array<{ team_id: string; backlog: number; member_count: number }>
    try {
      rows = db
        .prepare(
          `SELECT tm.team_id AS team_id,
                  COALESCE(SUM(CASE WHEN m.read_at IS NULL THEN 1 ELSE 0 END), 0) AS backlog,
                  COUNT(DISTINCT tm.session_id) AS member_count
           FROM team_members tm
           LEFT JOIN messages m
             ON (m.receiver_id = tm.session_id OR m.receiver_id IS NULL)
            AND m.sender_id != tm.session_id
           JOIN teams t ON t.id = tm.team_id
           WHERE t.status = 'active'
           GROUP BY tm.team_id`,
        )
        .all() as Array<{ team_id: string; backlog: number; member_count: number }>
    } catch (err) {
      log.warn({ err }, 'tickBacklog: query failed')
      return
    }

    for (const row of rows) {
      if (row.backlog < backlogThreshold) continue
      if (row.member_count >= maxAgentsPerTeam) continue
      if (scalingInFlight.has(row.team_id)) continue

      scalingInFlight.add(row.team_id)
      log.info(
        { teamId: row.team_id, backlog: row.backlog, members: row.member_count },
        'Backlog exceeds threshold — scaling up team',
      )

      try {
        const cwd =
          opts.defaultWorkingDir ??
          (
            db
              .prepare(
                `SELECT s.working_dir FROM sessions s
               JOIN team_members tm ON tm.session_id = s.id
               WHERE tm.team_id = ? LIMIT 1`,
              )
              .get(row.team_id) as { working_dir: string | null } | undefined
          )?.working_dir ??
          undefined

        await spawner.spawn({
          team_id: row.team_id,
          name: `${scaleRole}-${Date.now()}`,
          role: scaleRole,
          prompt: `Team backlog exceeded ${backlogThreshold} unread messages; help drain it.`,
          launch_method: 'detached',
          working_dir: cwd,
        })
      } catch (err) {
        log.warn({ err, teamId: row.team_id }, 'Scale-up spawn failed')
        scalingInFlight.delete(row.team_id)
        continue
      }

      // Release the scaling latch shortly after; the new member will be visible
      // on the next tick and keep member_count honest.
      setTimeout(() => scalingInFlight.delete(row.team_id), 5_000).unref?.()
    }
  }

  function stop(): void {
    teamStates.clear()
    scalingInFlight.clear()
  }

  return { handleAgentExit, tickBacklog, stop }
}

// Re-export helper used by startup paths that need a relative fallback.
export function defaultLogPathFor(workingDir: string, sessionId: string): string {
  return path.join(workingDir, '.github', 'logs', `agent-${sessionId}.log`)
}
