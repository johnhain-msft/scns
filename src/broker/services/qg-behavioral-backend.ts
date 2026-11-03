/**
 * SCNS selfopt — Phase 1 wedge A (go-live): the REAL, bounded backend pair for the
 * quality-gate behavioral-improvement gate.
 *
 * The arbiter's behavioral gate (`behavioral-gate.ts`) is fully built and unit-
 * tested with injected fakes, but production never wired a real backend, so the
 * gate defaulted to a symmetric `MockBackend` (baseline === candidate ⇒ delta 0 ⇒
 * can never veto). This module builds the genuinely-asymmetric pair that lets a
 * landing gate on MEASURED behavior.
 *
 * THE ASYMMETRY CHANNEL (why this is real and not noise). Both agents run under a
 * DENY-ALL permission policy (mandatory — wedge C proved an unrestricted agent
 * runs `npm install` + the full vitest suite in its worktree and blows the
 * timeout). A deny-all agent answers in plain text and CANNOT read its cwd, so the
 * cwd alone carries zero signal. The signal therefore comes from INJECTED
 * GUIDANCE: the baseline backend carries HEAD's `.github/copilot-instructions.md`
 * and the candidate backend carries the post-diff worktree's version. A change
 * that touches that guidance produces genuinely different agent responses the rule
 * judges score; a change that does NOT touch it yields identical guidance ⇒ delta
 * 0 ⇒ the gate is inert and correctly defers to the build/test gate.
 *
 * This is the same mechanism the live-verified wedge-C gated negative-memory
 * writer uses (`gated-negative-memory-runner.defaultMakeBackend`): real ACP, deny-
 * all, bounded `attemptTimeoutMs`, PID captured at spawn and reaped by PID.
 *
 * SAFETY / ISOLATION:
 *   - the baseline agent runs in an ISOLATED detached HEAD worktree (NEVER the
 *     live checkout); the candidate agent runs in the team's existing worktree
 *     (HEAD + diff), which is owned and torn down by the arbiter — this module
 *     NEVER removes it. `dispose()` reaps only the spawn PIDs and removes only the
 *     baseline worktree it created.
 *   - default-OFF: this config is inert unless the arbiter sees
 *     `SCNS_QG_BEHAVIORAL_GATE=1`; nothing here spawns or forks a worktree until
 *     `makeBackends` is actually invoked on the rubric-PASS branch.
 *   - every collaborator (client factory, worktree provisioner, guidance reader,
 *     kill/liveness) is injectable so unit tests never spawn copilot or run git.
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type Database from 'better-sqlite3'
import { createAcpClient, createDenyAllPermissionPolicy } from './acp-client.js'
import type { AcpClient, AcpClientOptions } from './acp-client.js'
import { logger } from '../../shared/logger.js'
import { AcpReplayBackend, createDetachedWorktree } from '../../selfopt/index.js'
import type { InjectedMemoryProvider, IsolatedWorktree, ReplayBackend } from '../../selfopt/index.js'
import type { TaskRecord } from '../../selfopt/types.js'
import {
  retrieveContext,
  makeHybridBaseSearch,
  type RetrievalContextConfig,
} from '../../memory/retrieval-context.js'
import type { BaseSearch } from '../../memory/intent-search.js'
import {
  makeSemanticRelevanceScorer,
  type SemanticRelevanceScorer,
} from '../../memory/semantic-relevance.js'
import type { GazetteerEntry } from '../../memory/entities/gazetteer.js'

const log = logger.child({ module: 'qg-behavioral-backend' })

/**
 * Bounded per-attempt wall-clock for the QG behavioral agent (the value proven in
 * wedge C). Caps each spawn well under the 300s `AcpReplayBackend` default so a
 * wedged or tool-attempting agent can never hang a quality-gate verdict.
 */
export const QG_BEHAVIORAL_ATTEMPT_TIMEOUT_MS = 150_000

/** The guidance artifact injected as the asymmetry channel (HEAD vs post-diff). */
export const QG_GUIDANCE_FILE = '.github/copilot-instructions.md'

/** Hard cap on injected guidance chars so a pathological file can't bloat the prompt. */
export const QG_GUIDANCE_MAX_CHARS = 8000

/** A backend plus a captured-at-spawn PID accessor (reaped by PID after the gate). */
export interface BackendWithPid {
  readonly backend: ReplayBackend
  /** The spawn PID once the underlying process has started, else null. */
  readonly getPid: () => number | null
}

/** The per-completion asymmetric backend pair plus its lifecycle disposer. */
export interface QgBehavioralBackends {
  readonly baseline: ReplayBackend
  readonly candidate: ReplayBackend
  /** Reap spawn PIDs and remove the baseline worktree. NEVER removes the team worktree. */
  readonly dispose: () => void
}

/** Injection seam for {@link defaultMakeBoundedBackend} (tests assert wiring, no spawn). */
export interface BoundedBackendDeps {
  readonly createClientFn?: (opts: AcpClientOptions) => AcpClient
  readonly makeReplayBackend?: (opts: {
    cwd: string
    createClient: (opts: AcpClientOptions) => AcpClient
    allowAllTools: boolean
    attemptTimeoutMs: number
    injectedMemory: InjectedMemoryProvider
  }) => ReplayBackend
}

export interface QgBehavioralDeps {
  /** Live project root (HEAD). The baseline worktree is forked off its HEAD. */
  readonly projectRoot: string
  /** Environment used for worktree base dir resolution. Default `process.env`. */
  readonly env?: NodeJS.ProcessEnv
  /** Provision the isolated baseline worktree. Default a detached HEAD git worktree. */
  readonly makeWorktree?: (projectRoot: string, env: NodeJS.ProcessEnv) => IsolatedWorktree
  /** Build one bounded real-agent backend for an isolated cwd + injected guidance. */
  readonly makeBackend?: (cwd: string, injectedMemory: InjectedMemoryProvider) => BackendWithPid
  /** Read the guidance artifact from a worktree cwd. Default {@link readGuidanceFile}. */
  readonly readGuidance?: (cwd: string) => string
  /** Reap a captured PID. Default `process.kill`. NEVER pkill/killall. */
  readonly killByPid?: (pid: number, signal: NodeJS.Signals) => void
  /** Liveness probe. Default `process.kill(pid, 0)`. */
  readonly isAlive?: (pid: number) => boolean
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

function reapPid(
  pid: number | null,
  isAlive: (pid: number) => boolean,
  killByPid: (pid: number, signal: NodeJS.Signals) => void,
): void {
  if (pid === null) return
  try {
    if (isAlive(pid)) killByPid(pid, 'SIGKILL')
  } catch (err) {
    log.warn({ err: String(err), pid }, 'qg-behavioral: failed to reap spawn pid')
  }
}

/** Read `.github/copilot-instructions.md` from `cwd`, capped; '' when absent/unreadable. */
export function readGuidanceFile(cwd: string): string {
  const p = join(resolve(cwd), QG_GUIDANCE_FILE)
  if (!existsSync(p)) return ''
  try {
    return readFileSync(p, 'utf-8').slice(0, QG_GUIDANCE_MAX_CHARS)
  } catch {
    return ''
  }
}

/**
 * Default bounded real-agent backend: an `AcpReplayBackend` whose client is built
 * with an injected `spawnFn` (records the child PID at spawn) and a DENY-ALL
 * permission policy, capped at {@link QG_BEHAVIORAL_ATTEMPT_TIMEOUT_MS}, carrying
 * `injectedMemory` (the asymmetry channel). Mirrors wedge C's `defaultMakeBackend`.
 */
export function defaultMakeBoundedBackend(
  cwd: string,
  injectedMemory: InjectedMemoryProvider,
  deps: BoundedBackendDeps = {},
): BackendWithPid {
  const createAcp = deps.createClientFn ?? createAcpClient
  const makeReplayBackend = deps.makeReplayBackend ?? ((opts) => new AcpReplayBackend(opts))
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
    attemptTimeoutMs: QG_BEHAVIORAL_ATTEMPT_TIMEOUT_MS,
    injectedMemory,
  })
  return { backend, getPid: () => pid }
}

/** The `behavioralGate.makeBackends` shape consumed by the quality-gate arbiter. */
export interface QgBehavioralGateConfig {
  readonly makeBackends: (input: {
    readonly headCwd: string
    readonly candidateCwd: string
  }) => QgBehavioralBackends
}

/**
 * Build the arbiter `behavioralGate` config that constructs the REAL asymmetric
 * backend pair per completion. Returns `{ makeBackends }`: the arbiter calls it on
 * the rubric-PASS branch ONLY when `SCNS_QG_BEHAVIORAL_GATE` is set, so this is
 * fully inert by default (no worktree, no spawn) until opted in.
 */
export function makeQgBehavioralGateConfig(deps: QgBehavioralDeps): QgBehavioralGateConfig {
  const env = deps.env ?? process.env
  const makeWorktree =
    deps.makeWorktree ?? ((root: string, e: NodeJS.ProcessEnv) => createDetachedWorktree(root, e))
  const makeBackend =
    deps.makeBackend ?? ((cwd: string, mem: string) => defaultMakeBoundedBackend(cwd, mem))
  const readGuidance = deps.readGuidance ?? readGuidanceFile
  const killByPid = deps.killByPid ?? defaultKillByPid
  const isAlive = deps.isAlive ?? defaultIsAlive

  const makeBackends = (input: {
    readonly headCwd: string
    readonly candidateCwd: string
  }): QgBehavioralBackends => {
    // Baseline runs in an ISOLATED detached HEAD worktree (never the live
    // checkout), carrying pure-HEAD guidance. Candidate runs in the team worktree
    // (HEAD + diff), carrying the post-diff guidance. We own/teardown ONLY the
    // baseline worktree; the team worktree belongs to the arbiter.
    let baselineWt: IsolatedWorktree | null = null
    try {
      baselineWt = makeWorktree(deps.projectRoot, env)
      const headGuidance = readGuidance(baselineWt.cwd)
      const candidateGuidance = readGuidance(input.candidateCwd)
      const baselinePair = makeBackend(baselineWt.cwd, headGuidance)
      const candidatePair = makeBackend(input.candidateCwd, candidateGuidance)
      const wt = baselineWt
      return {
        baseline: baselinePair.backend,
        candidate: candidatePair.backend,
        dispose: (): void => {
          reapPid(baselinePair.getPid(), isAlive, killByPid)
          reapPid(candidatePair.getPid(), isAlive, killByPid)
          try {
            wt.cleanup()
          } catch (err) {
            log.warn({ err: String(err) }, 'qg-behavioral: baseline worktree cleanup failed')
          }
        },
      }
    } catch (err) {
      // Setup failed — clean up any partial worktree and rethrow. The arbiter
      // swallows a thrown gate as no-signal, so this can never flip a decision.
      if (baselineWt) {
        try {
          baselineWt.cleanup()
        } catch {
          /* best-effort */
        }
      }
      throw err
    }
  }

  return { makeBackends }
}

// ────────────────────────────────────────────────────────────────────────────
// THE BRIDGE — retrieval-mode gate config (measure MAGMA memory quality)
//
// The wedge-A config above injects a STATIC guidance file (HEAD vs post-diff) as
// the asymmetry channel — inert for a memory/retrieval change (identical file ⇒
// delta 0). This config instead injects RETRIEVED MEMORY computed PER VAL-TASK
// from the live vault via the REAL retrieval path: the baseline backend retrieves
// with the HEAD retrieval config and the candidate backend with the candidate's
// config, over the SAME vault. A retrieval-sensitive val task then scores the
// candidate higher exactly when its retrieval surfaces the answer — so the gate
// MEASURES MAGMA memory quality (the `intentRouting` lever is MAGMA's #1 retrieval
// lever) rather than just guarding a guidance file.
//
// Asymmetry source = the retrieval CONFIG (not cwd, not a worktree): every MAGMA
// tier in SCNS lands behind a default-OFF flag (`SCNS_INTENT_ROUTING`,
// `SCNS_DREAM_CAUSAL`, …), so "does flipping this retrieval flag improve answers?"
// is exactly "is this MAGMA tier flip a behaviorally-validated self-improvement?".
// The agent cwds are neutral isolated temp dirs (deny-all ⇒ cwd is invisible), so
// the only signal is the injected retrieved memory.
// ────────────────────────────────────────────────────────────────────────────

/** Routing OFF — the production opt-out (today's base hybrid only). The HEAD side. */
export const BASELINE_RETRIEVAL_CONFIG: RetrievalContextConfig = { intentRouting: false }
/** Routing ON — the MAGMA entity/temporal router. The candidate (improved) side. */
export const CANDIDATE_RETRIEVAL_CONFIG: RetrievalContextConfig = { intentRouting: true }

/**
 * Resolve the CANDIDATE retrieval config from env so a real-ACP run can MEASURE additional MAGMA
 * retrieval levers against the binary-router baseline, INDEPENDENTLY of the production defaults
 * (you want to gate-test a lever before flipping it in prod). Always routing-ON; each further
 * lever is opt-in and default-OFF, so with no flags this is byte-identical to
 * {@link CANDIDATE_RETRIEVAL_CONFIG} (`{ intentRouting: true }`):
 *   - `SCNS_QG_RETRIEVAL_FUSION=1`   ⇒ `fusion: true`   (measure MAGMA Alg.1 fusion vs binary)
 *   - `SCNS_QG_RETRIEVAL_SEMANTIC=1` ⇒ `semantic: true` (measure the 2-hop semantic tier)
 *   - `SCNS_QG_RETRIEVAL_TIMELINE=1` ⇒ `timeline: true` (measure the WHEN chronological timeline)
 */
export function resolveQgRetrievalCandidateConfig(
  env: NodeJS.ProcessEnv = process.env,
): RetrievalContextConfig {
  return {
    intentRouting: true,
    ...(env.SCNS_QG_RETRIEVAL_FUSION === '1' ? { fusion: true } : {}),
    ...(env.SCNS_QG_RETRIEVAL_SEMANTIC === '1' ? { semantic: true } : {}),
    ...(env.SCNS_QG_RETRIEVAL_TIMELINE === '1' ? { timeline: true } : {}),
  }
}

/** A neutral isolated working dir for a deny-all agent (cwd carries no signal). */
export interface IsolatedDir {
  readonly cwd: string
  readonly cleanup: () => void
}

const defaultMakeIsolatedDir = (): IsolatedDir => {
  const dir = mkdtempSync(join(tmpdir(), 'qg-retr-'))
  return {
    cwd: dir,
    cleanup: (): void => {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch (err) {
        log.warn({ err: String(err) }, 'qg-retrieval: isolated dir cleanup failed')
      }
    },
  }
}

export interface QgRetrievalDeps {
  /**
   * The live memory vault DB (used READ-ONLY for retrieval), or a provider resolved
   * lazily inside `makeBackends`. The provider form lets the cli wire this BEFORE
   * the vault is opened (the arbiter is constructed early; `makeBackends` only runs
   * later on the rubric-PASS branch, by which point the vault is open). A provider
   * returning `null` makes the gate throw ⇒ the arbiter treats it as no-signal.
   */
  readonly db: Database.Database | (() => Database.Database | null)
  /**
   * Base search the intent router falls back to. Default the production HYBRID path
   * over `db` with keyword-only fallback ({@link makeHybridBaseSearch}) so the gate
   * measures retrieval over the real production base, not a degraded one.
   */
  readonly baseSearch?: BaseSearch
  /** HEAD-side retrieval config. Default {@link BASELINE_RETRIEVAL_CONFIG} (routing OFF). */
  readonly baselineConfig?: RetrievalContextConfig
  /** Candidate-side retrieval config. Default {@link CANDIDATE_RETRIEVAL_CONFIG} (routing ON). */
  readonly candidateConfig?: RetrievalContextConfig
  /** Override the gazetteer used for intent + entity routing. */
  readonly gazetteer?: readonly GazetteerEntry[]
  /**
   * Factory for the query-bound semantic-relevance scorer used to rank fusion's semantic source
   * (and the 2-hop augmentation) by QUERY relevance — so the gate measures the SAME fusion the
   * production CLI deploys, not a degraded graph-order one. Default {@link makeSemanticRelevanceScorer}.
   * Only consulted when the candidate config enables `fusion`/`semantic`.
   */
  readonly makeSemanticRelevanceScorer?: (
    db: Database.Database,
    query: string,
  ) => SemanticRelevanceScorer
  /** Build one bounded real-agent backend for an isolated cwd + per-task injected memory. */
  readonly makeBackend?: (cwd: string, injectedMemory: InjectedMemoryProvider) => BackendWithPid
  /** Provision a neutral isolated agent cwd. Default a temp dir. */
  readonly makeIsolatedDir?: () => IsolatedDir
  /** Reap a captured PID. Default `process.kill`. NEVER pkill/killall. */
  readonly killByPid?: (pid: number, signal: NodeJS.Signals) => void
  /** Liveness probe. Default `process.kill(pid, 0)`. */
  readonly isAlive?: (pid: number) => boolean
}

/** Resolve the retrieval query for a task (the decoupled probe, defaulting to intent). */
function retrievalQueryOf(task: TaskRecord): string {
  return task.retrievalQuery && task.retrievalQuery.trim() !== '' ? task.retrievalQuery : task.intent
}

/**
 * Build the arbiter `behavioralGate` config that injects RETRIEVED MEMORY as the
 * asymmetry channel (THE BRIDGE). Drop-in alternative to
 * {@link makeQgBehavioralGateConfig} with the SAME `{ makeBackends }` shape, so the
 * arbiter/cli wire it identically (behind the same default-OFF env opt-ins). Inert
 * until `makeBackends` is invoked on the rubric-PASS branch.
 */
export function makeQgRetrievalGateConfig(deps: QgRetrievalDeps): QgBehavioralGateConfig {
  const baselineConfig = deps.baselineConfig ?? BASELINE_RETRIEVAL_CONFIG
  const candidateConfig = deps.candidateConfig ?? CANDIDATE_RETRIEVAL_CONFIG
  const makeBackend =
    deps.makeBackend ?? ((cwd: string, mem: InjectedMemoryProvider) => defaultMakeBoundedBackend(cwd, mem))
  const makeIsolatedDir = deps.makeIsolatedDir ?? defaultMakeIsolatedDir
  const killByPid = deps.killByPid ?? defaultKillByPid
  const isAlive = deps.isAlive ?? defaultIsAlive

  const resolveDb = (): Database.Database => {
    const db = typeof deps.db === 'function' ? deps.db() : deps.db
    if (!db) throw new Error('qg-retrieval: memory vault DB unavailable')
    return db
  }

  // The arbiter passes { headCwd, candidateCwd }; for retrieval-mode the asymmetry
  // is the per-side retrieval CONFIG over the shared vault, so those cwds carry no
  // signal — both agents run in neutral isolated temp dirs.
  const makeBackends = (_input: {
    readonly headCwd: string
    readonly candidateCwd: string
  }): QgBehavioralBackends => {
    const db = resolveDb()
    const baseSearch = deps.baseSearch ?? makeHybridBaseSearch(db)
    const makeScorer = deps.makeSemanticRelevanceScorer ?? makeSemanticRelevanceScorer
    const retrievalDeps = {
      // Phase B — deliberately NO `experienceLog`: quality-gate shadow-eval retrievals are synthetic
      // A/B probes, not real episodes, so they must NOT pollute the retrieval-experience store.
      baseSearch,
      ...(deps.gazetteer ? { gazetteer: deps.gazetteer } : {}),
      makeSemanticRelevanceScorer: (q: string): SemanticRelevanceScorer => makeScorer(db, q),
    }
    const resolverFor =
      (config: RetrievalContextConfig): InjectedMemoryProvider =>
      async (task: TaskRecord): Promise<string> => {
        const { text } = await retrieveContext(db, retrievalQueryOf(task), config, retrievalDeps)
        return text
      }

    const baselineDir = makeIsolatedDir()
    let candidateDir: IsolatedDir | null = null
    try {
      candidateDir = makeIsolatedDir()
      const baselinePair = makeBackend(baselineDir.cwd, resolverFor(baselineConfig))
      const candidatePair = makeBackend(candidateDir.cwd, resolverFor(candidateConfig))
      const candDir = candidateDir
      return {
        baseline: baselinePair.backend,
        candidate: candidatePair.backend,
        dispose: (): void => {
          reapPid(baselinePair.getPid(), isAlive, killByPid)
          reapPid(candidatePair.getPid(), isAlive, killByPid)
          baselineDir.cleanup()
          candDir.cleanup()
        },
      }
    } catch (err) {
      baselineDir.cleanup()
      if (candidateDir) candidateDir.cleanup()
      throw err
    }
  }

  return { makeBackends }
}
