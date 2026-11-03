/**
 * SCNS selfopt — Phase 1 wedge C: the LIVE gated negative-memory writer.
 *
 * Today the dream daemon calls the BLIND `applyNegativeMemories`, which
 * `writeFileSync`s `.github/copilot-instructions.md` every cycle with NO
 * behavioural check (repo issue #5). This runner is the default-OFF, opt-in
 * replacement: it routes the live self-edit through the per-rule non-regression
 * gate (`gatedApplyNegativeMemories`) so a NEW "don't" rule only lands if it does
 * not regress a held-out rule-judged val set.
 *
 * It mirrors `selfopt/validate-loss-runner.ts` + `selfopt/shadow-eval-runner.ts`:
 * every collaborator is injectable, so unit tests never spawn copilot, run git,
 * touch the network, or write a live file. The real `AcpReplayBackend` (the only
 * backend whose signal can actually MOVE the gate — under Mock baseline≈candidate
 * ⇒ delta 0 ⇒ inert) is constructed ONLY when `SCNS_GATED_NEG_MEM_LIVE_ACP` is
 * truthy, inside an isolated detached worktree, PID-captured and reaped by PID,
 * torn down in `finally` — a HARD-STOP spawn that phase (d) drives.
 *
 * Design decisions (wedge-C plan, user-approved):
 *   - Q1 ADD-ONLY: gate only NEW rules (those not already in the managed block);
 *     the existing block is the baseline and is never erased here — the blind
 *     full-block regeneration still owns removal/suppression. Zero eligible ⇒
 *     skip (never erase the guardrails — negative-memory-applicator.ts:185-227).
 *   - Q2 REFUSE-UNDER-MOCK: a Mock/non-ACP backend MUST NOT mutate the target
 *     unless an isolated proof explicitly opts in (`allowMockWrite`). Prod safety:
 *     a fake (inert) signal can never edit the live guardrails; only the real ACP
 *     path writes by default.
 *   - Q3 backups OUTSIDE the work tree (`backupDir`) so adopting a live-root
 *     target leaves no untracked `.bak.N` in the repo.
 *   - Q4 the gate set is `DEFAULT_BEHAVIORAL_VAL_TASKS` (rule-judged; recorded
 *     tasks are excluded — they are constant under any backend).
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createAcpClient, createDenyAllPermissionPolicy } from '../broker/services/acp-client.js'
import type { AcpClient, AcpClientOptions } from '../broker/services/acp-client.js'
import { logger } from '../shared/logger.js'
import {
  AcpReplayBackend,
  createDetachedWorktree,
  DEFAULT_BEHAVIORAL_VAL_TASKS,
  MockBackend,
} from '../selfopt/index.js'
import type { GateMetric, IsolatedWorktree, ReplayBackend, TaskRecord } from '../selfopt/index.js'
import type { Vault } from './vault.js'
import type { NegativeMemory } from './negative-memory-types.js'
import {
  deriveEligibleRules,
  extractManagedBlock,
  updateMemoryApplied,
  BLOCK_START,
  BLOCK_END,
} from './negative-memory-applicator.js'
import { runNegativeMemoryCritic } from './negative-memory-critic.js'
import {
  gatedApplyNegativeMemories,
  TARGET_FILE,
  type GatedApplyResult,
} from './gated-negative-memory-applicator.js'

const log = logger.child({ module: 'gated-negative-memory-runner' })

/** Env opt-in (default-OFF) for the real-agent gate backend — a HARD-STOP spawn. */
export const GATED_NEG_MEM_LIVE_ACP_ENV = 'SCNS_GATED_NEG_MEM_LIVE_ACP'

/**
 * Bounded per-attempt wall-clock for the daemon's real-ACP gated write (the value
 * proven in wedge C phase-c/phase-d). Caps each agent spawn so a wedged or
 * tool-running agent can never hang the daily dream cycle, and is well under the
 * 300s `AcpReplayBackend` default that phase-c attempt 1 blew through.
 */
export const GATED_ACP_ATTEMPT_TIMEOUT_MS = 150_000

/** A candidate backend plus a captured-at-spawn PID accessor. */
export interface BackendWithPid {
  readonly backend: ReplayBackend
  /** The spawn PID once the underlying process has started, else null. */
  readonly getPid: () => number | null
}

export interface GatedNegMemLiveDeps {
  readonly vault: Vault
  /** The WRITE target root holding `.github/copilot-instructions.md`. */
  readonly projectRoot: string
  /** Environment to read the opt-in from. Default `process.env` (injectable). */
  readonly env?: NodeJS.ProcessEnv
  /** Rule-judged gate set. Default {@link DEFAULT_BEHAVIORAL_VAL_TASKS} (Q4). */
  readonly valTasks?: readonly TaskRecord[]
  /** Forwarded to `deriveEligibleRules` (same source as the blind path). */
  readonly minConfidence?: number
  readonly allowUnjudged?: boolean
  /** Non-regression tolerance forwarded to the gate. */
  readonly epsilon?: number
  /** Metric projecting (hard, soft) to one score. Default 'hard'. */
  readonly metric?: GateMetric
  /**
   * Where the per-accept `.bak.N` backups go — OUTSIDE the work tree (Q3).
   * Default a fresh `mkdtemp` so a live-root adopt never dirties the repo.
   */
  readonly backupDir?: string
  /**
   * ISOLATED-PROOF ESCAPE HATCH (Q2). When false (default) the runner REFUSES to
   * mutate the target under a Mock/non-ACP backend — so a fake (inert) signal can
   * never edit the live guardrails. Set true ONLY by an isolated proof/test
   * pointed at a TEMP root; NEVER by the dream-daemon live wiring.
   */
  readonly allowMockWrite?: boolean
  /** Inject a backend directly (tests force adopt/reject). Non-ACP ⇒ needs `allowMockWrite`. */
  readonly backend?: ReplayBackend
  readonly backendLabel?: 'mock' | 'acp'
  // ── ACP-path seams (mirror validate-loss-runner) ──
  /** Provision the isolated throwaway worktree. Default a detached git worktree. */
  readonly makeWorktree?: () => IsolatedWorktree
  /** Build the real-agent candidate backend for an isolated cwd. */
  readonly makeBackend?: (cwd: string) => BackendWithPid
  /** Reap a captured PID. Default `process.kill`. NEVER pkill/killall. */
  readonly killByPid?: (pid: number, signal: NodeJS.Signals) => void
  /** Liveness probe. Default `process.kill(pid, 0)`. */
  readonly isAlive?: (pid: number) => boolean
  // ── Bookkeeping seams (parity with the blind path) ──
  /** Run the negative-memory critic first. Default `runNegativeMemoryCritic`. */
  readonly criticRunner?: (vault: Vault) => Promise<void>
  /** Mark an adopted memory applied in the vault. Default `updateMemoryApplied`. */
  readonly markApplied?: (vault: Vault, memoryId: string, appliedTo: string) => void
}

export interface GatedNegMemLiveResult {
  /** True iff the gated applicator actually ran against the target. */
  readonly ran: boolean
  /** Why the run was skipped (when `ran === false`). */
  readonly skipReason?: string
  readonly backendLabel: 'mock' | 'acp'
  /** True iff a real `AcpReplayBackend` was constructed and run. */
  readonly spawned: boolean
  /** The isolated worktree path used for the spawn, or null. */
  readonly worktree: string | null
  readonly pid: number | null
  readonly killedByPid: boolean
  readonly pidAlreadyExited: boolean
  /** # of NEW rules gated this run (eligible minus those already in the block). */
  readonly candidateCount: number
  /** # of rules already in the managed block (the ADD-ONLY baseline). */
  readonly currentRuleCount: number
  /** Adopted (non-regressing) rule texts spliced onto the target. */
  readonly adopted: readonly string[]
  /** Rejected (regressing) rule texts — written nowhere. */
  readonly rejected: readonly string[]
  /** Every backup created (one per accept), outside the work tree. */
  readonly backups: readonly string[]
  /** Memory ids marked `targetApplied` (only adopted ones). */
  readonly appliedMemoryIds: readonly string[]
  /** Absolute path of the gated target, or null when skipped early. */
  readonly targetFile: string | null
}

function isTruthy(v: string | undefined): boolean {
  if (v === undefined) return false
  const s = v.trim().toLowerCase()
  return s === '1' || s === 'true' || s === 'yes' || s === 'on'
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

/** Injection seam for {@link defaultMakeBackend} so tests can assert the bounded
 *  controls (deny-all permission policy + attemptTimeoutMs) without spawning. */
export interface DefaultBackendDeps {
  readonly createClientFn?: (opts: AcpClientOptions) => AcpClient
  readonly makeReplayBackend?: (opts: {
    cwd: string
    createClient: (opts: AcpClientOptions) => AcpClient
    allowAllTools: boolean
    attemptTimeoutMs: number
  }) => ReplayBackend
}

/**
 * Default real-agent backend: an `AcpReplayBackend` whose client is built with an
 * injected `spawnFn` that records the child PID the instant the process spawns —
 * mirrors validate-loss-runner so the backend's option-threading is preserved.
 *
 * BOUNDED CONTROLS (mandatory for the autonomous daily self-edit, proven in wedge C
 * phase-c/d): the client is given a DENY-ALL permission policy so the agent cannot
 * run any tool (no `npm install` / vitest in the worktree ⇒ a bounded text answer),
 * and the backend is capped at {@link GATED_ACP_ATTEMPT_TIMEOUT_MS}.
 */
export function defaultMakeBackend(cwd: string, deps: DefaultBackendDeps = {}): BackendWithPid {
  const createAcp = deps.createClientFn ?? createAcpClient
  const makeReplayBackend =
    deps.makeReplayBackend ?? ((opts) => new AcpReplayBackend(opts))
  let pid: number | null = null
  const spawnFn = ((command: string, args: readonly string[], options: unknown) => {
    const child = nodeSpawn(command, args as string[], {
      ...(options as object),
      windowsHide: true,
    } as never)
    pid = child.pid ?? null
    return child
  }) as typeof nodeSpawn
  const createClient = (opts: AcpClientOptions): AcpClient =>
    createAcp({ ...opts, spawnFn, permissionPolicy: createDenyAllPermissionPolicy() })
  const backend = makeReplayBackend({
    cwd,
    createClient,
    allowAllTools: false,
    attemptTimeoutMs: GATED_ACP_ATTEMPT_TIMEOUT_MS,
  })
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

/** Parse the "- " bullet rules out of the managed block (ADD-ONLY baseline). */
function parseManagedBlockRules(content: string): string[] {
  const { block } = extractManagedBlock(content)
  if (!block) return []
  const inner = block.slice(BLOCK_START.length, block.length - BLOCK_END.length)
  const rules: string[] = []
  for (const raw of inner.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('- ')) rules.push(line.slice(2).trim())
  }
  return rules
}

/** Mark each adopted rule's source memory applied; tolerate per-memory failures. */
function markAdopted(
  adopted: GatedApplyResult['adopted'],
  ruleToMemory: ReadonlyMap<string, NegativeMemory>,
  vault: Vault,
  markApplied: (vault: Vault, memoryId: string, appliedTo: string) => void,
): string[] {
  const ids: string[] = []
  for (const a of adopted) {
    const mem = ruleToMemory.get(a.rule)
    if (!mem) continue
    if (mem.targetApplied) {
      ids.push(mem.id)
      continue
    }
    try {
      markApplied(vault, mem.id, TARGET_FILE)
      ids.push(mem.id)
    } catch (err) {
      log.warn({ err: String(err), memoryId: mem.id }, 'gated-live: failed to mark memory applied')
    }
  }
  return ids
}

/**
 * Run the LIVE gated negative-memory apply honouring the (default-OFF) spawn
 * opt-in. Default-OFF + no `allowMockWrite` ⇒ refuses to mutate the target (no
 * write). Opted-in ⇒ exactly the gate's spawns in a throwaway worktree, reaped by
 * PID, worktree removed in `finally`. NEVER erases the existing block (ADD-ONLY).
 */
export async function runGatedNegativeMemoryApplyLive(
  deps: GatedNegMemLiveDeps,
): Promise<GatedNegMemLiveResult> {
  const env = deps.env ?? process.env
  const useAcp = isTruthy(env[GATED_NEG_MEM_LIVE_ACP_ENV])
  const valTasks = deps.valTasks ?? DEFAULT_BEHAVIORAL_VAL_TASKS
  const criticRunner =
    deps.criticRunner ??
    (async (v: Vault) => {
      await runNegativeMemoryCritic({ vault: v })
    })
  const markApplied = deps.markApplied ?? updateMemoryApplied

  const skipped = (
    skipReason: string,
    extra: Partial<GatedNegMemLiveResult> = {},
  ): GatedNegMemLiveResult => ({
    ran: false,
    skipReason,
    backendLabel: useAcp ? 'acp' : (deps.backendLabel ?? 'mock'),
    spawned: false,
    worktree: null,
    pid: null,
    killedByPid: false,
    pidAlreadyExited: false,
    candidateCount: 0,
    currentRuleCount: 0,
    adopted: [],
    rejected: [],
    backups: [],
    appliedMemoryIds: [],
    targetFile: null,
    ...extra,
  })

  // critic-first (parity with the blind path).
  await criticRunner(deps.vault)

  // Eligible "don't" rules — SAME source the blind/shadow paths use. Map rule
  // text → its source memory so only ADOPTED rules get marked applied.
  const { eligible, rules } = deriveEligibleRules(deps.vault, {
    ...(deps.minConfidence !== undefined ? { minConfidence: deps.minConfidence } : {}),
    ...(deps.allowUnjudged !== undefined ? { allowUnjudged: deps.allowUnjudged } : {}),
  })
  if (eligible.length === 0) return skipped('no-eligible-rules') // Q1: never erase, just skip

  const ruleToMemory = new Map<string, NegativeMemory>()
  rules.forEach((r, i) => {
    if (!ruleToMemory.has(r)) ruleToMemory.set(r, eligible[i]!)
  })

  // Read the target read-only to compute the ADD-ONLY baseline (current block).
  const targetPath = join(resolve(deps.projectRoot), TARGET_FILE)
  if (!existsSync(targetPath)) return skipped('no-live-instructions-file')
  const currentRules = parseManagedBlockRules(readFileSync(targetPath, 'utf-8'))
  const currentSet = new Set(currentRules)
  const candidateRules = rules.filter((r) => !currentSet.has(r))
  if (candidateRules.length === 0) {
    return skipped('no-new-candidate-rules', { currentRuleCount: currentRules.length })
  }

  // Q2 guard: a Mock/non-ACP backend must not mutate the (live) target unless an
  // isolated proof explicitly opts in. Only the real ACP path writes by default.
  if (!useAcp && !deps.allowMockWrite) {
    return skipped('mock-backend-refused-live-write', {
      candidateCount: candidateRules.length,
      currentRuleCount: currentRules.length,
    })
  }

  // Backups land OUTSIDE the work tree (Q3) — default a throwaway temp dir.
  const backupDir = deps.backupDir ?? mkdtempSync(join(tmpdir(), 'scns-negmem-live-bak-'))

  const gateInput = {
    projectRoot: deps.projectRoot,
    candidateRules,
    currentRules,
    valTasks,
    backupDir,
    ...(deps.epsilon !== undefined ? { epsilon: deps.epsilon } : {}),
    ...(deps.metric ? { metric: deps.metric } : {}),
  }

  const finish = (
    applied: GatedApplyResult,
    lifecycle: {
      backendLabel: 'mock' | 'acp'
      spawned: boolean
      worktree: string | null
      pid: number | null
      killedByPid: boolean
      pidAlreadyExited: boolean
    },
    appliedMemoryIds: readonly string[],
  ): GatedNegMemLiveResult => ({
    ran: true,
    backendLabel: lifecycle.backendLabel,
    spawned: lifecycle.spawned,
    worktree: lifecycle.worktree,
    pid: lifecycle.pid,
    killedByPid: lifecycle.killedByPid,
    pidAlreadyExited: lifecycle.pidAlreadyExited,
    candidateCount: candidateRules.length,
    currentRuleCount: currentRules.length,
    adopted: applied.adopted.map((a) => a.rule),
    rejected: applied.rejections.map((r) => r.rule),
    backups: applied.backups,
    appliedMemoryIds,
    targetFile: applied.targetFile,
  })

  if (useAcp) {
    // Real-agent gate (HARD-STOP spawn). The agent's cwd is a throwaway worktree;
    // the WRITE target stays the real projectRoot. PID reaped; worktree torn down.
    const makeWorktree = deps.makeWorktree ?? (() => createDetachedWorktree(deps.projectRoot, env))
    const makeBackend = deps.makeBackend ?? defaultMakeBackend
    const killByPid = deps.killByPid ?? defaultKillByPid
    const isAlive = deps.isAlive ?? defaultIsAlive

    const worktree = makeWorktree()
    try {
      const { backend, getPid } = makeBackend(worktree.cwd)
      const applied = await gatedApplyNegativeMemories({ ...gateInput, backend })
      const appliedMemoryIds = markAdopted(applied.adopted, ruleToMemory, deps.vault, markApplied)
      const reaped = reapPid(getPid(), isAlive, killByPid)
      return finish(
        applied,
        {
          backendLabel: 'acp',
          spawned: true,
          worktree: worktree.cwd,
          pid: reaped.pid,
          killedByPid: reaped.killedByPid,
          pidAlreadyExited: reaped.pidAlreadyExited,
        },
        appliedMemoryIds,
      )
    } finally {
      worktree.cleanup()
    }
  }

  // Non-ACP write path — reached ONLY via the isolated-proof escape hatch
  // (`allowMockWrite`). The Mock gate is inert (delta 0 ⇒ adopt-all); it exists to
  // exercise the wiring against a TEMP root, never the live guardrails.
  const backend = deps.backend ?? new MockBackend()
  const applied = await gatedApplyNegativeMemories({ ...gateInput, backend })
  const appliedMemoryIds = markAdopted(applied.adopted, ruleToMemory, deps.vault, markApplied)
  return finish(
    applied,
    {
      backendLabel: deps.backendLabel ?? 'mock',
      spawned: false,
      worktree: null,
      pid: null,
      killedByPid: false,
      pidAlreadyExited: false,
    },
    appliedMemoryIds,
  )
}
