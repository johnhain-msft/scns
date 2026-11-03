/**
 * SCNS selfopt — Phase 1 wedge B: the default-OFF, spawn-bearing validate-loss
 * runner. This is the ONLY place that reads the spawn opt-in env and the ONLY
 * place that may construct a real `AcpReplayBackend`. It is NOT imported by the
 * dream daemon or any live path — its sole entrypoint is the thin
 * `scns selfopt validate-loss` CLI command.
 *
 *   - `SCNS_SELFOPT_VALIDATE_LOSS_ACP` — when truthy, provision an isolated,
 *     detached `git worktree` under the REAL HOME, build an `AcpReplayBackend`
 *     there as the CANDIDATE (the baseline stays `MockBackend`), run the single
 *     real spawn, capture its PID, and reap it by PID. Default OFF ⇒ `MockBackend`
 *     candidate ⇒ NO worktree, NO git, NO spawn, symmetric delta 0.
 *   - `SCNS_SELFOPT_ACP_WORKTREE_DIR` — optional base dir for the throwaway
 *     worktree (honoured by {@link createDetachedWorktree}).
 *
 * Isolation + safety invariants:
 *   - the ACP session `cwd` is a throwaway detached worktree, NEVER the live
 *     checkout; the worktree is ALWAYS torn down in `finally`.
 *   - the spawn PID is captured at spawn time via an injected `spawnFn` wrapper and
 *     reaped by PID only (never pkill/killall).
 *   - every collaborator (`makeWorktree`, `makeBackend`, `killByPid`, `isAlive`,
 *     `env`) is injectable so unit tests never spawn copilot, run git, or kill.
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { createAcpClient } from '../broker/services/acp-client.js'
import type { AcpClient, AcpClientOptions } from '../broker/services/acp-client.js'
import { AcpReplayBackend } from './acp-replay-backend.js'
import { createDetachedWorktree } from './shadow-eval-runner.js'
import type { IsolatedWorktree } from './shadow-eval-runner.js'
import type { ReplayBackend } from './replay.js'
import { resolveValidateLossMode, validateLoss } from './validate-loss.js'
import type { ValidateLossResult } from './validate-loss.js'

/** A candidate backend plus a captured-at-spawn PID accessor. */
export interface BackendWithPid {
  readonly backend: ReplayBackend
  /** The spawn PID once the underlying process has started, else null. */
  readonly getPid: () => number | null
}

export interface ValidateLossRunnerDeps {
  /** Live project root — the worktree is forked off its HEAD (read-only). */
  readonly projectRoot: string
  /** Environment to read the opt-in from. Default `process.env` (injectable). */
  readonly env?: NodeJS.ProcessEnv
  /** Provision the isolated throwaway worktree. Default a detached git worktree. */
  readonly makeWorktree?: () => IsolatedWorktree
  /** Build the real-agent candidate backend for an isolated cwd. */
  readonly makeBackend?: (cwd: string) => BackendWithPid
  /** Reap a captured PID. Default `process.kill`. NEVER pkill/killall. */
  readonly killByPid?: (pid: number, signal: NodeJS.Signals) => void
  /** Liveness probe. Default `process.kill(pid, 0)`. */
  readonly isAlive?: (pid: number) => boolean
}

export interface ValidateLossRunResult extends ValidateLossResult {
  /** True iff a real `AcpReplayBackend` was constructed and run. */
  readonly spawned: boolean
  /** The isolated worktree path used for the spawn, or null when default-OFF. */
  readonly worktree: string | null
  /** The captured spawn PID, or null. */
  readonly pid: number | null
  /** True iff the PID had already exited by the time it was reaped. */
  readonly pidAlreadyExited: boolean
  /** True iff a still-alive PID was killed by PID. */
  readonly killedByPid: boolean
}

const defaultIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const defaultKillByPid = (pid: number, signal: NodeJS.Signals): void => {
  process.kill(pid, signal)
}

/**
 * Default real-agent backend: an `AcpReplayBackend` whose client is built with an
 * injected `spawnFn` that records the child PID the instant the process spawns.
 * `AcpReplayBackend` itself never sets `spawnFn`; the wrapper adds it at the client
 * layer, so the backend's own option-threading invariants are preserved.
 */
function defaultMakeBackend(cwd: string): BackendWithPid {
  let pid: number | null = null
  const spawnFn = ((command: string, args: readonly string[], options: unknown) => {
    const child = nodeSpawn(command, args as string[], {
      ...(options as object),
      windowsHide: true,
    } as never)
    pid = child.pid ?? null
    return child
  }) as typeof nodeSpawn
  const createClient = (opts: AcpClientOptions): AcpClient => createAcpClient({ ...opts, spawnFn })
  const backend = new AcpReplayBackend({ cwd, createClient, allowAllTools: false })
  return { backend, getPid: () => pid }
}

interface PidReap {
  readonly pid: number | null
  readonly killedByPid: boolean
  readonly pidAlreadyExited: boolean
}

function reapPid(
  pid: number | null,
  isAlive: (pid: number) => boolean,
  killByPid: (pid: number, signal: NodeJS.Signals) => void,
): PidReap {
  if (pid === null) return { pid: null, killedByPid: false, pidAlreadyExited: false }
  if (isAlive(pid)) {
    killByPid(pid, 'SIGKILL')
    return { pid, killedByPid: true, pidAlreadyExited: false }
  }
  return { pid, killedByPid: false, pidAlreadyExited: true }
}

/**
 * Run the loss-validation experiment honouring the (default-OFF) spawn opt-in.
 * Default-OFF ⇒ a symmetric Mock measurement with no worktree/git/spawn. Opted-in
 * ⇒ exactly ONE real spawn in a throwaway worktree, PID-reaped, worktree removed in
 * `finally`.
 */
export async function runValidateLossWithOptIns(
  deps: ValidateLossRunnerDeps,
): Promise<ValidateLossRunResult> {
  const env = deps.env ?? process.env
  const { useAcp } = resolveValidateLossMode(env)

  if (!useAcp) {
    const res = await validateLoss()
    return {
      ...res,
      spawned: false,
      worktree: null,
      pid: null,
      pidAlreadyExited: false,
      killedByPid: false,
    }
  }

  const makeWorktree = deps.makeWorktree ?? (() => createDetachedWorktree(deps.projectRoot, env))
  const makeBackend = deps.makeBackend ?? defaultMakeBackend
  const killByPid = deps.killByPid ?? defaultKillByPid
  const isAlive = deps.isAlive ?? defaultIsAlive

  const worktree = makeWorktree()
  try {
    const { backend, getPid } = makeBackend(worktree.cwd)
    const res = await validateLoss({ candidateBackend: backend, backendLabel: 'acp' })
    const reaped = reapPid(getPid(), isAlive, killByPid)
    return {
      ...res,
      spawned: true,
      worktree: worktree.cwd,
      pid: reaped.pid,
      pidAlreadyExited: reaped.pidAlreadyExited,
      killedByPid: reaped.killedByPid,
    }
  } finally {
    worktree.cleanup()
  }
}
