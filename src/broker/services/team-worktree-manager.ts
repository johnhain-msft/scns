/**
 * Task 43 — Per-team git worktree sandbox.
 *
 * Background: SCNS dev agents historically launched with cwd = broker
 * cwd = main repo root. team-lifecycle.defaultCollectStagedDiff then
 * ran `git diff --cached` against that same cwd, so every dev's
 * in-flight edits raced against the broker itself and every other
 * team's dev. Overnight self-improve runs left the main repo dirty
 * after each pass.
 *
 * This manager provisions a per-team git worktree under
 * `<baseDir>/<teamId>/wt` (default `~/.session-broker/team-worktrees`)
 * and persists the path back to `teams.working_dir`. The existing
 * agent-spawner lookup (`findTeamWorkingDir`, commit 2aec701) then
 * pins every spawn for that team to the worktree path, and
 * team-lifecycle's `primaryCwd` follows automatically because it
 * reads from the exiting agent's `workingDir`.
 *
 * Safety properties (per rubber-duck pass):
 *   - All git calls go through `runGit` with an argv array (no shell).
 *   - teamId must be a UUID-v4 OR a safe lowercase `team-…` id
 *     (isValidTeamId) before being interpolated into any filesystem
 *     path or branch name — forbids `/`, `..`, and whitespace.
 *   - Worktrees are DETACHED (no scns/team/<id> branch) so we never
 *     leak branches and never collide with QG's `scns/auto/<slug>`.
 *   - `removeWorktreeForTeam` only deletes when the recorded
 *     `teams.working_dir` resolves to a path *inside* the manager's
 *     baseDir. An external pin (manual neuron-mode pin, task-34 path)
 *     is left untouched.
 *   - `removeWorktreeForTeam` also skips removal when any
 *     `team_members` row still references the team.
 *   - `ensureWorktreeForTeam` returns the EXISTING pin when
 *     `teams.working_dir` is already non-null — task 34 / neuron mode
 *     is preserved verbatim.
 *   - If the UPDATE to write the worktree path back races with another
 *     pin attempt and finds the row already taken, the just-created
 *     worktree is removed and the existing pin is returned. No leak.
 *   - When an existing path is found, it is validated via
 *     `git rev-parse --is-inside-work-tree` before being reused.
 */

import { execFileSync as nodeExecFileSync } from 'node:child_process'
import {
  existsSync as fsExistsSync,
  mkdirSync as fsMkdirSync,
  rmSync as fsRmSync,
} from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import type Database from 'better-sqlite3'
import { logger } from '../../shared/logger.js'
import {
  bridgeNodeModulesIntoWorktree as defaultBridge,
  verifyBridgedTooling as defaultVerify,
  bridgeFallbackAttempted,
  type BridgeResult,
  type VerifyToolingResult,
} from './worktree-tooling-bridge.js'

const log = logger.child({ module: 'team-worktree-manager' })

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Gap 2 — brain-spawned teams use non-UUID ids:
 *   - `team-sugg-${suggestionId.slice(0,8)}` (cli.ts, ApprovedSuggestions),
 *   - `team-${task.id}` (agent-loop.ts, SpawnTeam),
 *   - `brain-solo` (spawn-adapter.ts DEFAULT_SOLO_TEAM — the solo spawn
 *     path: agent-loop HandleSolo/SpawnSolo → onSpawnAgent without a teamId).
 * They MUST be worktree-eligible so autonomous agents never edit the live
 * main checkout. The `brain-solo` family was previously excluded, so brain
 * solo spawns fell back to BROKER_PROJECT_ROOT and bypassed Gap 2 (observed
 * live: agent_launch_started team_id=brain-solo, working_dir=<projectRoot>).
 * This pattern accepts the `team-` and `brain-` families while staying
 * path-traversal-safe: lowercase alphanumerics in hyphen-separated segments
 * only — no `/`, `.`, `..`, whitespace, or uppercase (the last avoids
 * case-insensitive-filesystem collisions between two distinct DB ids mapping
 * to the same worktree dir).
 */
const SAFE_GENERATED_TEAM_ID_RE = /^(?:team|brain)-[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Upper bound on any team id we interpolate into a filesystem path. */
const MAX_TEAM_ID_LEN = 128

export interface TeamWorktreeManager {
  /**
   * Idempotent. Returns the worktree path the team should run in, or
   * null if the team is unknown / archived / a non-UUID / the manager
   * is disabled. If `teams.working_dir` is already set, that value is
   * returned without touching the filesystem.
   */
  ensureWorktreeForTeam(teamId: string): string | null
  /**
   * Best-effort cleanup. No-ops on missing worktrees, non-UUID team
   * ids, paths outside `baseDir`, and teams that still have live
   * team_members rows.
   */
  removeWorktreeForTeam(teamId: string): void
  /** Configured base directory for diagnostics / tests. */
  getBaseDir(): string
}

export interface TeamWorktreeManagerDeps {
  readonly db: Database.Database
  /** The repo whose HEAD is the source for new worktrees (broker cwd in prod). */
  readonly projectRoot: string
  /** Override baseDir. Default: `~/.session-broker/team-worktrees`. */
  readonly baseDir?: string
  /** Disable the manager entirely; every call returns null / no-op. */
  readonly enabled?: boolean
  /** Test seam for git CLI execution. */
  readonly runGit?: (args: ReadonlyArray<string>, cwd: string) => string
  /**
   * Layer-2 fix — node_modules bridge invoked after `git worktree add`
   * so that vitest/eslint/tsc resolve under
   * `<worktreePath>/node_modules/.bin/`. Defaults to the production
   * `bridgeNodeModulesIntoWorktree`. Strategy is always 'symlink'
   * (the bridge falls back to cpSync internally on verify-failure).
   *
   * Without the bridge, ACP-spawned dev/qa agents exit after the first
   * turn with no `message_sent` events because the npm scripts in their
   * task prompts (`npm run typecheck`, `vitest run …`, etc.) return
   * "command not found" instantly. See plan.md "Symptom" + "Root cause"
   * sections for the live observation (team 4fde2759, 2026-05-16).
   */
  readonly bridge?: typeof defaultBridge
  /**
   * Test seam for the post-bridge tooling verification probe. Used by
   * the idempotent re-ensure path (already-pinned worktree → verify
   * tooling still resolves → re-bridge in place if not). Defaults to
   * the production `verifyBridgedTooling`.
   */
  readonly verify?: (worktreePath: string) => VerifyToolingResult
  /**
   * Optional event sink so `worktree_provisioning` events from the
   * per-team bridge land in the same channel as the QG arbiter's
   * Phase-13.12.32 emissions. Wrapped in try/catch internally —
   * observability MUST NOT gate worktree provisioning.
   */
  readonly eventLog?: TeamWorktreeManagerEventSink
}

/**
 * Subset of the broker's EventLog the worktree-manager needs. Decouples
 * the manager from the full EventLog surface so tests can pass a single
 * vi.fn() spy without stubbing the entire interface.
 */
export interface TeamWorktreeManagerEventSink {
  worktreeProvisioning(
    sessionId: string | null,
    data: Record<string, unknown>,
  ): unknown
}

function defaultRunGit(args: ReadonlyArray<string>, cwd: string): string {
  // execFileSync with argv (NOT shell) — no quoting concerns even if
  // teamId/baseDir contain spaces, and no command-injection surface.
  return nodeExecFileSync('git', args as string[], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
}

function defaultBaseDir(): string {
  return path.join(homedir(), '.session-broker', 'team-worktrees')
}

/**
 * A team id is worktree-eligible when it is EITHER a UUID-v4 (the
 * orchestrator/autospawner path) OR a safe brain-generated `team-…` id.
 * Both branches forbid path separators, `..`, and whitespace so the id
 * is safe to interpolate into `path.join(baseDir, teamId, 'wt')`.
 * Exported for direct unit testing of the boundary cases.
 */
export function isValidTeamId(teamId: string): boolean {
  if (typeof teamId !== 'string') return false
  if (teamId.length === 0 || teamId.length > MAX_TEAM_ID_LEN) return false
  return UUID_RE.test(teamId) || SAFE_GENERATED_TEAM_ID_RE.test(teamId)
}

function pathIsInside(parent: string, child: string): boolean {
  const p = path.resolve(parent)
  const c = path.resolve(child)
  if (p === c) return false
  const rel = path.relative(p, c)
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel)
}

interface TeamRow {
  readonly id: string
  readonly working_dir: string | null
  readonly archived_at: string | null
  readonly status: string
}

function readTeamRow(db: Database.Database, teamId: string): TeamRow | null {
  const row = db
    .prepare(
      'SELECT id, working_dir, archived_at, status FROM teams WHERE id = ?',
    )
    .get(teamId) as TeamRow | undefined
  return row ?? null
}

function teamMemberCount(db: Database.Database, teamId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS c FROM team_members WHERE team_id = ?')
    .get(teamId) as { c: number }
  return row.c
}

export function createTeamWorktreeManager(
  deps: TeamWorktreeManagerDeps,
): TeamWorktreeManager {
  const db = deps.db
  const projectRoot = deps.projectRoot
  const baseDir = deps.baseDir ?? defaultBaseDir()
  const enabled = deps.enabled !== false
  const runGit = deps.runGit ?? defaultRunGit
  const bridge = deps.bridge ?? defaultBridge
  const verify = deps.verify ?? defaultVerify
  const eventLog = deps.eventLog ?? null

  function worktreePathFor(teamId: string): string {
    return path.join(baseDir, teamId, 'wt')
  }

  function isExistingWorktree(wtPath: string): boolean {
    if (!fsExistsSync(wtPath)) return false
    try {
      const out = runGit(['rev-parse', '--is-inside-work-tree'], wtPath).trim()
      return out === 'true'
    } catch {
      return false
    }
  }

  function safeCreateWorktree(wtPath: string): boolean {
    fsMkdirSync(path.dirname(wtPath), { recursive: true })
    try {
      // Detached worktree → no scns/team/<id> branch leaks, no
      // collisions with QG's scns/auto/<slug> branches.
      runGit(['worktree', 'add', '--detach', wtPath, 'HEAD'], projectRoot)
      return true
    } catch (err) {
      log.warn(
        { err: (err as Error).message, wtPath, projectRoot },
        'team-worktree: git worktree add failed',
      )
      return false
    }
  }

  function safeRemoveWorktree(wtPath: string): void {
    // Try `git worktree remove --force` first so the registry stays
    // consistent. Fall back to rm + worktree-prune so a partially
    // failed creation is still cleaned up.
    try {
      runGit(['worktree', 'remove', '--force', wtPath], projectRoot)
    } catch (err) {
      log.debug(
        { err: (err as Error).message, wtPath },
        'team-worktree: git worktree remove failed (falling back to rm)',
      )
    }
    try {
      if (fsExistsSync(wtPath)) {
        fsRmSync(wtPath, { recursive: true, force: true })
      }
    } catch (err) {
      log.warn(
        { err: (err as Error).message, wtPath },
        'team-worktree: rm of worktree path failed',
      )
    }
    try {
      runGit(['worktree', 'prune'], projectRoot)
    } catch {
      /* prune is best-effort */
    }
  }

  /**
   * Layer-2 fix — invoke the node_modules bridge so the worktree can
   * actually spawn vitest/eslint/tsc. Logs on linked:false but NEVER
   * fails provisioning: agents can still read source from the worktree.
   * Emits a structured `worktree_provisioning` event matching the QG
   * arbiter's Phase-13.12.32 shape (so operators get one unified
   * audit feed). Both log and event emissions are wrapped — broken
   * observability must not block agent spawning.
   */
  function applyBridge(teamId: string, wtPath: string, trigger: string): BridgeResult {
    let result: BridgeResult
    try {
      result = bridge(projectRoot, wtPath, 'symlink')
    } catch (err) {
      // The bridge contract says it never throws, but defense in depth:
      // if a future refactor regresses that, do NOT propagate the throw
      // to the spawner. Synthesize a failure-shaped result.
      const errMsg = (err as Error).message ?? String(err)
      log.warn(
        { err: errMsg, teamId, wtPath, trigger },
        'team-worktree: node_modules bridge threw unexpectedly (treated as tooling-unresolved)',
      )
      result = {
        linked: false,
        reason: 'tooling-unresolved',
        srcPath: path.join(projectRoot, 'node_modules'),
        destPath: path.join(wtPath, 'node_modules'),
        error: `bridge threw: ${errMsg}`,
      }
    }
    if (!result.linked && result.reason !== 'strategy-none') {
      log.warn(
        {
          teamId,
          wtPath,
          trigger,
          reason: result.reason,
          missing: result.missing,
          binDirRealpath: result.binDirRealpath,
          error: result.error,
        },
        'team-worktree: node_modules bridge did not link (agents may fail to spawn vitest/eslint)',
      )
    } else {
      log.info(
        {
          teamId,
          wtPath,
          trigger,
          reason: result.reason,
          binDirRealpath: result.binDirRealpath,
        },
        'team-worktree: node_modules bridge linked',
      )
    }
    if (eventLog) {
      try {
        const missingArr = result.missing ?? []
        const fallbackAttempted = bridgeFallbackAttempted(result.reason)
        eventLog.worktreeProvisioning(null, {
          team_id: teamId,
          worktreePath: wtPath,
          trigger,
          npmStrategy: 'symlink',
          linked: result.linked,
          reason: result.reason,
          missing: missingArr,
          vitestResolved: result.linked && !missingArr.includes('vitest'),
          eslintResolved: result.linked && !missingArr.includes('eslint'),
          fallbackAttempted,
          fallbackOk: result.reason === 'copied',
          binDirRealpath: result.binDirRealpath ?? null,
          error: result.error ?? null,
        })
      } catch (eventErr) {
        log.warn(
          { teamId, wtPath, err: (eventErr as Error).message },
          'team-worktree: failed to emit worktree_provisioning event (non-fatal)',
        )
      }
    }
    return result
  }

  /**
   * Layer-2 fix — repair path. When `teams.working_dir` is already
   * pinned to a path inside our baseDir (i.e., a worktree we own that
   * was provisioned before the bridge wiring landed, OR a worktree
   * whose node_modules link was severed by an external process), run
   * the cheap verify probe. If tooling resolves, return early. If it
   * does not, re-invoke the bridge in place so the next agent spawn
   * picks up a healthy worktree.
   *
   * External pins (paths OUTSIDE baseDir) are never touched — the
   * worktree-manager has no authority over those.
   */
  function ensureBridgeForExistingPin(teamId: string, pinned: string): void {
    if (!pathIsInside(baseDir, pinned)) {
      // External / neuron-mode pin — out of our authority.
      return
    }
    if (!fsExistsSync(pinned)) {
      // Pinned path was nuked underneath us. Nothing to bridge into;
      // the spawner will fall back gracefully on cwd. We do not
      // unilaterally re-create the worktree here — that's the job of
      // a future ensure call where the team's row gets cleared first.
      return
    }
    let probe: VerifyToolingResult
    try {
      probe = verify(pinned)
    } catch (err) {
      log.warn(
        { err: (err as Error).message, teamId, pinned },
        'team-worktree: verifyBridgedTooling threw on existing pin (re-bridging)',
      )
      applyBridge(teamId, pinned, 're-bridge-verify-threw')
      return
    }
    if (probe.ok) {
      log.debug(
        { teamId, pinned, binDirRealpath: probe.binDirRealpath },
        'team-worktree: existing pin already has working tooling — skipping bridge',
      )
      return
    }
    log.info(
      { teamId, pinned, missing: probe.missing },
      'team-worktree: existing pin missing required binaries — re-bridging',
    )
    applyBridge(teamId, pinned, 're-bridge')
  }

  function ensureWorktreeForTeam(teamId: string): string | null {
    if (!enabled) return null
    if (!isValidTeamId(teamId)) {
      log.debug({ teamId }, 'team-worktree: ignoring non-UUID team id')
      return null
    }
    const team = readTeamRow(db, teamId)
    if (!team || team.archived_at != null || team.status === 'disbanded') {
      return null
    }
    // Task 34 / neuron mode: an existing pin always wins. Layer-2 fix
    // adds an idempotency tweak — if the pin is one of OURS (inside
    // baseDir), verify the bridge is still healthy and re-bridge if
    // not. External pins are returned untouched.
    if (team.working_dir != null && team.working_dir !== '') {
      ensureBridgeForExistingPin(teamId, team.working_dir)
      return team.working_dir
    }

    const wtPath = worktreePathFor(teamId)

    if (isExistingWorktree(wtPath)) {
      // Reuse — only need to persist the pin.
      const res = db
        .prepare(
          'UPDATE teams SET working_dir = ? WHERE id = ? AND working_dir IS NULL',
        )
        .run(wtPath, teamId)
      if (res.changes === 0) {
        // Someone else pinned in between — defer to the persisted value.
        const fresh = readTeamRow(db, teamId)
        const resolved = fresh?.working_dir ?? wtPath
        ensureBridgeForExistingPin(teamId, resolved)
        return resolved
      }
      // Newly persisted pin on an existing worktree — bridge it.
      applyBridge(teamId, wtPath, 'reuse-existing-worktree')
      return wtPath
    }

    // Path is missing OR exists but is not a valid worktree. If a stale
    // dir is squatting on the path, remove it first so `git worktree add`
    // can take the path. Only remove paths inside baseDir for safety.
    if (fsExistsSync(wtPath) && pathIsInside(baseDir, wtPath)) {
      try {
        fsRmSync(wtPath, { recursive: true, force: true })
      } catch (err) {
        log.warn(
          { err: (err as Error).message, wtPath },
          'team-worktree: failed to clear stale path before worktree add',
        )
        return null
      }
    }

    if (!safeCreateWorktree(wtPath)) return null

    const res = db
      .prepare(
        'UPDATE teams SET working_dir = ? WHERE id = ? AND working_dir IS NULL',
      )
      .run(wtPath, teamId)
    if (res.changes === 0) {
      // Concurrent pin won. Roll back the just-created worktree so we
      // don't leak a dir/branch.
      const fresh = readTeamRow(db, teamId)
      safeRemoveWorktree(wtPath)
      try {
        const parent = path.dirname(wtPath)
        if (fsExistsSync(parent)) fsRmSync(parent, { recursive: true, force: true })
      } catch {
        /* noop */
      }
      return fresh?.working_dir ?? null
    }

    log.info({ teamId, wtPath }, 'team-worktree: created sandbox worktree')
    // Layer-2 fix — bridge node_modules so the worktree can actually
    // spawn vitest/eslint/tsc. Runs AFTER the DB pin is persisted so a
    // racing concurrent ensure cannot double-bridge.
    applyBridge(teamId, wtPath, 'fresh-create')
    return wtPath
  }

  function removeWorktreeForTeam(teamId: string): void {
    if (!enabled) return
    if (!isValidTeamId(teamId)) return

    const team = readTeamRow(db, teamId)
    if (!team) return

    // Defensive liveness check: never rm under a live agent.
    if (teamMemberCount(db, teamId) > 0) {
      log.info(
        { teamId },
        'team-worktree: skipping removal — team still has live members',
      )
      return
    }

    const pinned = team.working_dir
    if (!pinned) return

    // Ownership: only delete paths inside OUR baseDir. An external pin
    // (manual neuron-mode pin, operator-chosen checkout) must never be
    // touched by the worktree manager.
    if (!pathIsInside(baseDir, pinned)) {
      log.info(
        { teamId, pinned, baseDir },
        'team-worktree: skipping removal — path is outside managed baseDir',
      )
      return
    }

    safeRemoveWorktree(pinned)

    // Remove the teamId-scoped parent so leftover `<baseDir>/<teamId>`
    // does not linger. baseDir itself is preserved (it hosts other teams).
    try {
      const parent = path.dirname(pinned)
      if (
        pathIsInside(baseDir, parent) &&
        fsExistsSync(parent)
      ) {
        fsRmSync(parent, { recursive: true, force: true })
      }
    } catch (err) {
      log.warn(
        { err: (err as Error).message, pinned },
        'team-worktree: rm of teamId-scoped parent failed',
      )
    }

    // Clear the DB pin so a future ensure() reprovisions cleanly.
    try {
      db.prepare(
        'UPDATE teams SET working_dir = NULL WHERE id = ? AND working_dir = ?',
      ).run(teamId, pinned)
    } catch (err) {
      log.warn(
        { err: (err as Error).message, teamId },
        'team-worktree: failed to clear teams.working_dir on removal',
      )
    }
  }

  function getBaseDir(): string {
    return baseDir
  }

  return { ensureWorktreeForTeam, removeWorktreeForTeam, getBaseDir }
}
