/**
 * SCNS selfopt — Phase 1 wedge 5: the explicit, default-OFF opt-in runner.
 *
 * Wraps `runShadowNegativeMemoryEval` with two env opt-ins, BOTH default-OFF, and
 * the isolated-worktree lifecycle needed for a real-agent run. It is the ONLY
 * place that reads the opt-in env and the ONLY place that may construct a real
 * `AcpReplayBackend`. It is NOT imported by the dream daemon — the sole live
 * entrypoint is the thin `scns selfopt shadow-eval` CLI command.
 *
 *   - `SCNS_SELFOPT_SHADOW_REAL_VAL` — when truthy, mine the broker val split
 *     (READONLY) and attach it as the measurement `reportTasks`. Safe (readonly).
 *   - `SCNS_SELFOPT_ACP_REPLAY` — when truthy, build an isolated `AcpReplayBackend`
 *     in a throwaway worktree under the REAL HOME and use it as the replay backend
 *     (so the rule-judged gate AND the report run on the real agent). This is the
 *     spawn-bearing switch; default off ⇒ MockBackend everywhere, no spawn.
 *   - `SCNS_SELFOPT_ACP_WORKTREE_DIR` — optional base dir for the throwaway
 *     worktree; default a fresh `mkdtemp` under `os.tmpdir()`.
 *
 * With neither opt-in set, behaviour is byte-identical to the default shadow eval
 * (Mock-only, `report: null`). Every collaborator is injectable so unit tests
 * never spawn a real copilot, never run git, and never touch the network.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { Vault } from '../memory/vault.js'
import {
  runShadowNegativeMemoryEval,
  type ShadowEvalResult,
} from '../dream/shadow-negative-memory-eval.js'
import { AcpReplayBackend } from './acp-replay-backend.js'
import { mineValTasks } from './mine-val-tasks.js'
import type { ReplayBackend } from './replay.js'
import type { TaskRecord } from './types.js'

/** Bounded budget for each throwaway-worktree git call (never hang the runner). */
export const WORKTREE_GIT_TIMEOUT_MS = 30_000

/** A throwaway isolated working dir + its teardown. */
export interface IsolatedWorktree {
  readonly cwd: string
  readonly cleanup: () => void
}

export interface ShadowEvalRunnerDeps {
  readonly vault: Vault
  /** Live project root — read-only seed source; never a gated write target. */
  readonly projectRoot: string
  /** Broker DB path (opened READONLY when mining the real val report). */
  readonly brokerDbPath: string
  /** Environment to read opt-ins from. Default `process.env` (injectable for tests). */
  readonly env?: NodeJS.ProcessEnv
  /** Build the real-agent backend for an isolated cwd. Default `new AcpReplayBackend({cwd})`. */
  readonly makeBackend?: (cwd: string) => ReplayBackend
  /** Provision the isolated throwaway worktree. Default a detached git worktree. */
  readonly makeWorktree?: () => IsolatedWorktree
}

function isTruthy(v: string | undefined): boolean {
  if (v === undefined) return false
  const s = v.trim().toLowerCase()
  return s === '1' || s === 'true' || s === 'yes' || s === 'on'
}

/** Injection seam for git invocation so tests never shell out. */
export type GitExec = (args: readonly string[]) => void

const defaultGitExec: GitExec = (args) => {
  execFileSync('git', [...args], {
    timeout: WORKTREE_GIT_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    stdio: 'ignore',
    windowsHide: true,
  })
}

/**
 * Create an isolated, detached git worktree off HEAD under `SCNS_SELFOPT_ACP_WORKTREE_DIR`
 * (or `os.tmpdir()`), returning its path and a best-effort teardown. Bounded git
 * calls so a wedged git can never hang the runner. `exec` is injectable: unit
 * tests pass a spy so no real git runs.
 */
export function createDetachedWorktree(
  projectRoot: string,
  env: NodeJS.ProcessEnv,
  exec: GitExec = defaultGitExec,
): IsolatedWorktree {
  const configured = env.SCNS_SELFOPT_ACP_WORKTREE_DIR
  const base = configured && configured.trim() !== '' ? configured : tmpdir()
  const dir = mkdtempSync(join(base, 'scns-selfopt-wt-'))
  exec(['-C', projectRoot, 'worktree', 'add', '--detach', dir, 'HEAD'])
  const cleanup = (): void => {
    try {
      exec(['-C', projectRoot, 'worktree', 'remove', '--force', dir])
    } catch {
      // best-effort: fall through to rm
    }
    rmSync(dir, { recursive: true, force: true })
  }
  return { cwd: dir, cleanup }
}

/**
 * Run the shadow gated negative-memory eval honouring the (default-OFF) env
 * opt-ins. The isolated worktree, when created, is ALWAYS torn down in `finally`.
 */
export async function runShadowEvalWithOptIns(
  deps: ShadowEvalRunnerDeps,
): Promise<ShadowEvalResult> {
  const env = deps.env ?? process.env
  const wantRealVal = isTruthy(env.SCNS_SELFOPT_SHADOW_REAL_VAL)
  const wantAcp = isTruthy(env.SCNS_SELFOPT_ACP_REPLAY)

  // Opt-in 1 (safe, readonly): mine the REAL broker val split as the report set.
  let reportTasks: readonly TaskRecord[] | undefined
  if (wantRealVal) {
    reportTasks = mineValTasks(deps.brokerDbPath, { project: basename(deps.projectRoot) })
  }

  // Opt-in 2 (spawn-bearing): build an isolated real-agent backend in a throwaway
  // worktree. Default OFF ⇒ no backend constructed ⇒ MockBackend everywhere.
  let backend: ReplayBackend | undefined
  let backendLabel: 'mock' | 'acp' = 'mock'
  let worktree: IsolatedWorktree | undefined
  if (wantAcp) {
    const makeWorktree = deps.makeWorktree ?? (() => createDetachedWorktree(deps.projectRoot, env))
    worktree = makeWorktree()
    const makeBackend = deps.makeBackend ?? ((cwd: string) => new AcpReplayBackend({ cwd }))
    backend = makeBackend(worktree.cwd)
    backendLabel = 'acp'
  }

  try {
    return await runShadowNegativeMemoryEval({
      vault: deps.vault,
      projectRoot: deps.projectRoot,
      backendLabel,
      ...(backend ? { backend } : {}),
      ...(reportTasks ? { reportTasks } : {}),
    })
  } finally {
    worktree?.cleanup()
  }
}
