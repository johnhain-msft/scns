/**
 * P7 — Meta-broker supervisor (live process management).
 *
 * Orchestrates per-project child broker processes:
 *   - Polls registry every `intervalMs`
 *   - Asks `planTick` what to do for each project
 *   - Executes spawn / probe / restart / suspend side effects
 *   - Updates registry state after each side effect
 *
 * Per rubber-duck (2026-06-03):
 *   - Children are spawned as ordinary `scns broker --port <p>` with
 *     BROKER_PROJECT_ROOT + BROKER_PROJECT_ID + SCNS_INSTANCE_ID env so
 *     the child's /api/health echoes the instance_id back for identity verification.
 *   - Children bind 127.0.0.1 only (default broker behavior).
 *   - Each child gets its own DB at ~/.session-broker/projects/<projectId>/data.db
 *     via BROKER_DB_PATH (NEW env variable consumed by single-broker startup).
 *   - SIGTERM-then-SIGKILL drain pattern with grace window.
 *
 * NOTE: this module is opt-in and orthogonal to the existing single broker.
 * It does NOT auto-stop the singleton — the coexistence rule from the
 * rubber-duck is enforced by the CLI (refusing to start if singleton is
 * already serving the same project).
 */
import type { ChildProcess } from 'node:child_process'
import { spawn as spawnProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type Database from 'better-sqlite3'
import { logger } from '../shared/logger.js'
import { isPortInUse } from '../shared/ports.js'
export { isPortInUse } from '../shared/ports.js'
import {
  buildStopCommand,
  createPlatformRestarter,
  runRestartCommand,
  type RestartOutcome,
} from '../broker/services/platform-restart.js'
import {
  applyMetaSchema,
  getProject,
  listProjects,
  persistDesiredPort,
  recordHealthFailure,
  resetHealthFailures,
  stickyDesiredPort,
  updateChildState,
  type ProjectChildState,
} from './registry.js'
import { allocatePort } from './port-allocator.js'
import { swapChildBroker, type ChildSwapConfig, type ChildSwapResult } from './child-blue-green.js'
import { planTick, DEFAULT_IDLE_TIMEOUT_MS, type TickPolicy } from './supervisor-tick.js'

const log = logger.child({ module: 'meta-supervisor' })

/**
 * Working directory for spawned child brokers.
 *
 * `spawn` otherwise inherits the supervisor's CWD, which is set by whatever
 * launched it (the LaunchAgent points at `dist/`). That made children resolve
 * CWD-relative paths differently from the top-level broker — which runs from
 * the package root — and silently diverge from it. Pinning children to the
 * package root makes their environment explicit and identical to the broker's.
 */
const CHILD_CWD = fileURLToPath(new URL('../..', import.meta.url))

export interface MetaSupervisorConfig {
  readonly db: Database.Database
  /** Path to the `scns` CLI binary (or node entry). Defaults to `dist/cli.js`. */
  readonly brokerEntry: string
  /** Per-project DB directory. Default `~/.session-broker/projects`. */
  readonly projectDbDir: string
  /** Tick interval. Default 5s. */
  readonly intervalMs?: number
  readonly policy?: TickPolicy
  /** Optional clock (testing). */
  readonly now?: () => number
  /** Optional fetch (testing). Must throw / non-2xx on failure. */
  readonly httpProbe?: (port: number, instanceId: string) => Promise<boolean>
  /**
   * Structured probe (testing). Takes precedence over {@link httpProbe}, which
   * is kept as the boolean-only shim so existing callers keep compiling — a
   * boolean probe simply reports idleness as unknown, and unknown never reaps.
   */
  readonly childProbe?: (port: number, instanceId: string) => Promise<ChildProbeResult>
  /**
   * Last-resort force stop for a pid that ignored SIGTERM and SIGKILL
   * (testing). Defaults to the same platform command the restart path uses.
   * Must throw when the stop could not be issued.
   */
  readonly forceStopPid?: (pid: number) => void
  /**
   * Bind-probe for a port (testing). Defaults to the real one. Used by every
   * port decision the supervisor makes — allocation, same-port recovery, and
   * the verified stop — so a test cannot have them disagree.
   */
  readonly isPortInUse?: (port: number) => Promise<boolean>
}

/** What one identity-checked health probe learned about a child. */
export interface ChildProbeResult {
  /** The child answered AND echoed the instance id we spawned it with. */
  readonly ok: boolean
  /**
   * Ms since the child last served a non-monitoring request, per its
   * `/api/health` payload. Null when the child did not report it (an older
   * build, or a probe that did not get a parseable body) — which the planner
   * reads as "idleness unknown" and therefore never reaps on.
   */
  readonly lastRequestAgeMs: number | null
  /**
   * The child's SELF-REPORTED pid, from the same payload. Null when the child
   * is too old to report it. Required to adopt a child this supervisor did not
   * spawn — see `adoptChild`. Deliberately not sourced from the registry's
   * `child_pid`, which is advisory and may name a recycled pid.
   */
  readonly pid: number | null
}

export interface MetaSupervisor {
  start(): void
  stop(): Promise<void>
  tickOnce(): Promise<void>
  /** #61 option C — replace a child with a fresh one on a new port, no gap. */
  swapChild(projectId: string, config?: Partial<ChildSwapConfig>): Promise<ChildSwapResult>
  /** Currently-running children (for tests + ops). */
  livePids(): ReadonlyMap<string, number>
}

/**
 * Admin-endpoint headers for a child. The child inherits this supervisor's env,
 * so its auth middleware is keyed on the same `BROKER_TOKEN` — and unlike
 * `/health*`, `/api/admin/*` is NOT exempt from auth.
 */
function adminHeaders(): Record<string, string> {
  const token = process.env['BROKER_TOKEN']?.trim()
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`
  return headers
}

// `failedRetryBackoffMs` is deliberately absent: the planner owns its default
// (DEFAULT_FAILED_RETRY_BACKOFF_MS), so it is not restated here.
const DEFAULT_POLICY: TickPolicy = {
  minFailures: 3,
  cooldownMs: 30_000,
  maxRestartsPerWindow: 3,
  windowMs: 600_000,
  idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
}

const DEFAULT_INTERVAL_MS = 5_000

/** Grace for each escalation step of a deliberate stop to take effect. */
const STOP_GRACE_MS = 5_000
/**
 * Grace for a dead child's port to become bindable again. Separate from
 * {@link STOP_GRACE_MS} because this is the check that decides whether the
 * project can be respawned at all — see `stopChildVerified`.
 */
const PORT_RELEASE_GRACE_MS = 5_000
const STOP_POLL_MS = 100
/** Hard bound on the synchronous last-resort force stop. */
const FORCE_STOP_TIMEOUT_MS = 10_000

export interface ChildSpawnSpecInput {
  readonly brokerEntry: string
  readonly projectRoot: string
  readonly projectId: string
  readonly dbPath: string
  /**
   * Per-project SCNS data home (e.g. `~/.session-broker/projects/<id>/home`).
   * Threaded to the child as `SCNS_HOME` so `resolveScnsHome()` relocates the
   * child's ENTIRE `~/.scns` tree (vault/experience/dream/suggestions/secrets/
   * state/telemetry/logs). REQUIRED: without it the child falls back to
   * `homedir()` and shares the singleton's `~/.scns` memory — the cross-project
   * muddying Track-2 exists to prevent. Does NOT relocate the GLOBAL
   * `~/.scns/meta-broker.db` (owned by the parent supervisor, not the child).
   */
  readonly scnsHome: string
  readonly port: number
  readonly instanceId: string
  /** Gap 5 — per-project autonomy (default 0). */
  readonly autonomyLevel?: number | null
  /** Gap 5 — per-project SCNS_SUGGEST_AUTO_APPROVE_THRESHOLD (omitted when null). */
  readonly autoApproveThreshold?: number | null
  /**
   * Track-2 — per-project GitHub `owner/name` for the child's self-issue-ingest,
   * threaded as `SCNS_SELF_ISSUE_REPO` (omitted when null/blank so the child does
   * NOT ingest the singleton's SCNS issues).
   */
  readonly selfIssueRepo?: string | null
}

export interface ChildSpawnSpec {
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

/**
 * Gap 5 — build the argv + env for a child broker. Uses the real `start`
 * command (the legacy `broker` subcommand never existed, so prod spawns
 * always errored) and threads per-project autonomy/threshold so each
 * project runs at its own configured autonomy.
 *
 * Track-2 Phase 1 — also threads a per-project `SCNS_HOME` so each child owns
 * an isolated `~/.scns` memory tree (vault/experience/dream/suggestions/secrets/
 * state/telemetry/logs) instead of sharing the singleton's. The GLOBAL
 * `~/.scns/meta-broker.db` is unaffected — it is opened by the parent supervisor
 * (whose env is unchanged), never by the child `start` process.
 */
export function buildChildSpawnSpec(input: ChildSpawnSpecInput): ChildSpawnSpec {
  const autonomy = input.autonomyLevel ?? 0
  const args = [
    input.brokerEntry,
    'start',
    '--port',
    String(input.port),
    '--autonomy',
    String(autonomy),
  ]
  const env: Record<string, string> = {
    BROKER_PROJECT_ROOT: input.projectRoot,
    BROKER_PROJECT_ID: input.projectId,
    BROKER_DB_PATH: input.dbPath,
    BROKER_PORT: String(input.port),
    SCNS_INSTANCE_ID: input.instanceId,
    SCNS_HOME: input.scnsHome,
    // Track-2: scope git + file observation to THIS project so the child's
    // projectFocus (and the automation/build/lint/workflow suggestions derived
    // from it) are about its OWN repo — not the user's global git/file activity
    // across every repo under ~/Coding_Projects (the default auto-detect).
    OBSERVE_GIT_REPOS: input.projectRoot,
    OBSERVE_FILE_DIRS: input.projectRoot,
    // Track-2 ENCAPSULATION: a child is an isolated per-project brain — it must
    // NOT be affected by anything outside its project. Disable the machine-wide
    // observers: foreground-app usage, and the shared ~/.copilot/session-store.db
    // that holds EVERY Copilot session on the machine (no project filter). The
    // singleton/"big brain" retains global visibility (it sees down into every
    // project); the child observes only itself (its scoped git/files + its own
    // agents' session-hooks).
    OBSERVE_ACTIVE_APP_ENABLED: 'false',
    OBSERVE_SESSION_STORE_ENABLED: 'false',
    // WI-6: the supervisor owns port assignment. A child that hits
    // EADDRINUSE must FAIL (supervisor reallocates) — never kill whatever
    // process holds the port to take it.
    BROKER_LISTEN_KILL_STALE: 'false',
  }
  if (input.autoApproveThreshold != null) {
    env['SCNS_SUGGEST_AUTO_APPROVE_THRESHOLD'] = String(input.autoApproveThreshold)
  }
  if (input.selfIssueRepo != null && input.selfIssueRepo.trim() !== '') {
    env['SCNS_SELF_ISSUE_REPO'] = input.selfIssueRepo.trim()
  }
  return { args, env }
}

interface LiveChild {
  /**
   * The handle for a child THIS supervisor spawned, or null for an ADOPTED
   * one — a child that was already running and was identity-verified over
   * HTTP. An adopted child has no `exit` event and cannot be `proc.kill()`ed;
   * everything that touches a child must therefore go through `signalChild`,
   * `childHasExited` and `child.pid` rather than reaching for `.proc`.
   */
  readonly proc: ChildProcess | null
  /**
   * Always present. For a spawned child this is `proc.pid`; for an adopted one
   * it is the pid the child reported about ITSELF on an identity-checked
   * probe.
   */
  readonly pid: number
  readonly port: number
  readonly instanceId: string
}

/** True when `pid` names a live process. EPERM counts as alive. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * A pid we are willing to manage a process by.
 *
 * Deliberately stricter than a null check: `ChildProbeResult.pid` crosses an
 * injectable boundary, and a probe that simply omits the field yields
 * `undefined`, which satisfies `!== null` and would then be handed to
 * `process.kill`. Adoption must never record a child it cannot actually
 * signal.
 */
function isUsablePid(pid: number | null | undefined): pid is number {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0
}

/**
 * Pick the probe implementation: the structured one when supplied, otherwise a
 * caller-supplied boolean probe lifted into the structured shape (reporting
 * idleness as unknown), otherwise the real HTTP probe.
 */
function resolveProbe(
  cfg: MetaSupervisorConfig,
): (port: number, instanceId: string) => Promise<ChildProbeResult> {
  if (cfg.childProbe) return cfg.childProbe
  const boolProbe = cfg.httpProbe
  if (boolProbe) {
    return async (port, instanceId) => ({
      ok: await boolProbe(port, instanceId),
      lastRequestAgeMs: null,
      // No self-reported pid from a boolean probe, so a caller-supplied
      // `httpProbe` can never adopt. Conservative on purpose: adoption needs a
      // pid it can trust, and this shim has none to give.
      pid: null,
    })
  }
  return defaultChildProbe
}

export function createMetaSupervisor(cfg: MetaSupervisorConfig): MetaSupervisor {
  applyMetaSchema(cfg.db)
  const intervalMs = cfg.intervalMs ?? DEFAULT_INTERVAL_MS
  const policy = cfg.policy ?? DEFAULT_POLICY
  const now = cfg.now ?? ((): number => Date.now())
  const probe = resolveProbe(cfg)
  const portInUse = cfg.isPortInUse ?? isPortInUse
  const forceStopPid =
    cfg.forceStopPid ??
    ((pid: number): void =>
      runRestartCommand(buildStopCommand(process.platform, pid), {
        timeoutMs: FORCE_STOP_TIMEOUT_MS,
      }))
  const live = new Map<string, LiveChild>()
  const restartHistory = new Map<string, number[]>()
  const lastRestart = new Map<string, number>()
  /**
   * Ms since each child last served a non-monitoring request, as of its last
   * SUCCESSFUL probe. A project is absent until a probe actually reports the
   * figure, and `planTick` never reaps on an absent entry — so a child the
   * supervisor cannot reach, or one too old to report it, keeps running.
   */
  const lastRequestAgeMs = new Map<string, number>()
  /**
   * PIDs we are deliberately stopping, keyed by pid and NOT by projectId.
   *
   * This set is the fix for the bug that made stopping a child impossible: the
   * exit handler below used to record EVERY exit as `failing`, including an
   * exit we asked for. `planForProject` treats `failing` as restart-worthy, so
   * a deliberate stop was overwritten within one tick and the child came
   * straight back — 12 of them did exactly that, within 50 seconds, when they
   * were stopped by hand.
   *
   * Keyed by PID because a project can have two processes in flight at once. A
   * projectId-keyed flag was consumed by whichever exit fired first: a stale
   * blue's exit would take the flag, return at the live-map pid guard without
   * using it, and the SURVIVING child's later exit would then see
   * `deliberate === false` and write `failing` — reintroducing the exact bug
   * this commit exists to kill. A pid is unambiguous about which process the
   * intent was about.
   *
   * Only ever added for a process we actually hold a handle to and actually
   * signal, so an entry cannot leak for a stop that never happened.
   */
  const intentionalStops = new Set<number>()
  /**
   * When a reap was last ATTEMPTED per project, successful or not. A refused
   * reap must not be retried every tick: the escalation below can spend
   * seconds per attempt, ticks are serial, and hammering it would make exactly
   * the loaded machine that caused the refusal worse.
   */
  const lastReapAttempt = new Map<string, number>()
  /**
   * Per project, an adopted pid that was later found dead. Keeps a port that
   * keeps answering from re-adopting the same unusable pid every tick — see
   * `adoptChild`. Cleared whenever a different pid is adopted or spawned.
   */
  const prunedAdoptions = new Map<string, number>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  /** Signal a child, whether we spawned it or adopted it. */
  function signalChild(child: LiveChild, sig: NodeJS.Signals): void {
    if (child.proc) child.proc.kill(sig)
    else process.kill(child.pid, sig)
  }

  /**
   * Has this child gone?
   *
   * A spawned child answers from its own process object. An ADOPTED one has no
   * such object, so liveness is a pid probe — which is why the port check in
   * `stopChildVerified` matters even more for adopted children: a pid probe
   * can be fooled by pid reuse, a bound port cannot.
   */
  function childHasExited(child: LiveChild): boolean {
    if (child.proc) return child.proc.exitCode !== null || child.proc.signalCode !== null
    return !isPidAlive(child.pid)
  }

  /**
   * Take management of a child that is already running and has proved, over an
   * identity-checked probe, that it belongs to this project.
   *
   * This is the answer to a gap that produced two separate failures:
   *
   *  - A child spawned `detached:false` SURVIVES a non-clean supervisor
   *    restart on Windows. The new supervisor starts with an empty `live` map
   *    while the orphan serves happily on the anchored port, so nothing could
   *    ever stop it — the exact resource leak idle reaping exists to remove.
   *  - An unverified suspension leaves a row whose pinned port is held by the
   *    child we failed to kill, and `spawnChild` then refuses every retry
   *    forever.
   *
   * Both were previously "refuse and hope". Refusal was right only because the
   * supervisor could not tell "my own child is on that port" from "a stranger
   * is on that port" — and spawning a second broker onto one project's SQLite
   * DB is worse than either. A probe that echoes this project's `instance_id`
   * settles exactly that question, so adoption is the refusal's missing arm,
   * not a replacement for it.
   *
   * `pid` is the child's SELF-REPORTED pid, never the registry's advisory
   * `child_pid`. Without a trustworthy pid the child can be routed to but not
   * stopped, so adoption refuses rather than record a child it cannot manage.
   *
   * @returns false when the child was NOT adopted.
   */
  function adoptChild(projectId: string, port: number, instanceId: string, pid: number): boolean {
    // Adoption is established from a PORT probe; `pruneDeadAdopted` later
    // judges the same child by a PID probe. Where they disagree, the PORT wins
    // for routing — a port answering with the right identity is a broker that
    // is genuinely serving, whatever a pid probe says — but the disagreement
    // must not become a loop: adopt, prune, adopt, prune, each pass writing to
    // the registry at tick rate. Remembering the pid we already pruned bounds
    // it to one adoption per distinct pid.
    //
    // A pid we cannot signal is still safe to hold: `stopChildVerified` checks
    // the port as well, so a reap against such a child REFUSES rather than
    // recording a stop that did not happen.
    if (prunedAdoptions.get(projectId) === pid) {
      log.debug(
        { projectId, port, pid },
        'meta-supervisor: not re-adopting a pid already pruned as dead for this project',
      )
      return false
    }
    log.warn(
      { projectId, port, pid, instanceId },
      'meta-supervisor: adopting an already-running child for this project (identity verified) ' +
        '— it survived a previous supervisor, or outlived a stop we could not complete',
    )
    live.set(projectId, { proc: null, pid, port, instanceId })
    lastReapAttempt.delete(projectId)
    prunedAdoptions.delete(projectId)
    try {
      resetHealthFailures(cfg.db, projectId)
      updateChildState(cfg.db, projectId, {
        status: 'running',
        boundPort: port,
        childPid: pid,
        instanceId,
        lastSeenAt: new Date().toISOString(),
      })
      // The adopted child's own address becomes the anchor again. It is
      // serving on it, so it is by definition the right one.
      persistDesiredPort(cfg.db, projectId, port)
    } catch {
      /* project may have been removed */
    }
    return true
  }

  /**
   * Drop adopted entries whose process has gone.
   *
   * A spawned child's `exit` event clears `live`. An adopted child has no exit
   * event, so without this sweep a dead adopted entry would linger and block
   * the `spawn` action (`if (!live.has(...))`) forever.
   */
  function pruneDeadAdopted(): void {
    for (const [projectId, child] of live) {
      if (child.proc === null && !isPidAlive(child.pid)) {
        log.info(
          { projectId, pid: child.pid },
          'meta-supervisor: adopted child is gone — releasing the live slot',
        )
        live.delete(projectId)
        lastRequestAgeMs.delete(projectId)
        // Remember WHICH pid went, so a port that keeps answering cannot make
        // us re-adopt the same dead pid on every tick. See `adoptChild`.
        prunedAdoptions.set(projectId, child.pid)
      }
    }
  }

  /** Poll `predicate` until true or the deadline passes. */
  async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = now() + timeoutMs
    while (!predicate() && now() < deadline) {
      await sleep(STOP_POLL_MS)
    }
    return predicate()
  }

  /** Poll until the port is bindable again, or the deadline passes. */
  async function waitForPortFree(port: number, timeoutMs: number): Promise<boolean> {
    const deadline = now() + timeoutMs
    for (;;) {
      if (!(await portInUse(port))) return true
      if (now() >= deadline) return false
      await sleep(STOP_POLL_MS)
    }
  }

  /**
   * Stop a child and PROVE it stopped. Returns false when it could not.
   *
   * The thing this exists to prevent: writing a terminal-ish row for a kill
   * that never landed. A `stopped` row says the port is free, and `spawnChild`
   * refuses to respawn onto an occupied port — so a reap that only *claimed*
   * to kill left the project permanently unspawnable. Every wake then failed,
   * `/api/meta/resolve` never returned `resolved:true`, and the session latched
   * `global:fallback`: writes refused for its whole life, which is the precise
   * outcome this feature was supposed to make impossible.
   *
   * Verification is deliberately TWO checks, because either alone is a lie:
   *   - the process object reports it exited, AND
   *   - the bound port is bindable again.
   * The port check is the load-bearing one: it is the identical condition
   * `spawnChild` tests, so passing it means the respawn can actually succeed.
   *
   * Escalation mirrors the contract `createPlatformRestarter` established —
   * signal, wait, escalate, and REFUSE rather than proceed on an unverified
   * stop.
   */
  async function stopChildVerified(
    projectId: string,
    boundPort: number | null,
  ): Promise<{ stopped: boolean; detail: string }> {
    const child = live.get(projectId)
    const pid = child?.pid
    if (!child || pid === undefined) {
      // No handle, nothing to kill. Refusing is the whole point: the registry
      // row must never claim a stop the supervisor did not perform. Reaching
      // here now means adoption also declined — the occupant did not prove it
      // belongs to this project — so refusing is doubly correct.
      return {
        stopped: false,
        detail:
          'no tracked child process for this project — refusing to record a stop that did ' +
          'not happen (orphan that could not be identity-verified?)',
      }
    }

    // An adopted child has no exit event to consume the flag, so marking one
    // would leak. The flag exists solely to stop `claimChild`'s exit handler
    // writing `failing` over a deliberate stop; a child with no such handler
    // needs no flag.
    if (child.proc !== null) intentionalStops.add(pid)
    const notes: string[] = [child.proc === null ? 'adopted' : 'spawned']
    const exited = (): boolean => childHasExited(child)

    const signal = (sig: NodeJS.Signals): void => {
      try {
        signalChild(child, sig)
        notes.push(sig)
      } catch (err) {
        notes.push(`${sig} failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    signal('SIGTERM')
    await waitUntil(exited, STOP_GRACE_MS)
    if (!exited()) {
      signal('SIGKILL')
      await waitUntil(exited, STOP_GRACE_MS)
    }
    if (!exited()) {
      // Last resort, same command the restart path uses. Synchronous and
      // bounded; only reached when both signals failed, which is rare.
      try {
        forceStopPid(pid)
        notes.push('force-stop')
      } catch (err) {
        notes.push(`force-stop failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      await waitUntil(exited, STOP_GRACE_MS)
    }

    if (!exited()) {
      if (child.proc !== null) intentionalStops.delete(pid)
      return {
        stopped: false,
        detail: `pid ${pid} still alive after SIGTERM/SIGKILL/force-stop (${notes.join('; ')})`,
      }
    }

    if (boundPort !== null && !(await waitForPortFree(boundPort, PORT_RELEASE_GRACE_MS))) {
      // The process is gone but something still holds its port — a surviving
      // grandchild, or a socket not yet released. Recording `stopped` here
      // would produce the same unspawnable project as not killing at all.
      if (child.proc !== null) intentionalStops.delete(pid)
      return {
        stopped: false,
        detail: `pid ${pid} exited but port ${boundPort} is still occupied (${notes.join('; ')})`,
      }
    }

    live.delete(projectId)
    lastRequestAgeMs.delete(projectId)
    return { stopped: true, detail: notes.join('; ') }
  }

  async function spawnChild(projectId: string, projectRoot: string): Promise<void> {
    const project = getProject(cfg.db, projectId)
    const anchored = project ? stickyDesiredPort(project) : undefined
    if (
      anchored !== undefined &&
      (takenPortsFor(projectId).has(anchored) || (await portInUse(anchored)))
    ) {
      // ADOPT, or refuse — never reallocate.
      //
      // Taking a fresh port here is the obvious cure and the wrong one: the
      // most likely occupant of a project's OWN anchor is that project's OWN
      // surviving child, and a second broker on one per-project SQLite DB is
      // worse than a project that will not start. `same-port-recovery.test.ts`
      // ("never silently reallocates an occupied anchor on a cold start")
      // encodes that, and it still holds.
      //
      // What was missing was the other arm. If the occupant PROVES it is this
      // project's child — answering `/api/health` with the `instance_id` this
      // row stores — then the right move is neither to refuse nor to start a
      // rival, but to take it over.
      //
      // A row with no stored `instance_id` has nothing to verify against and
      // is refused unchanged. That is the cold-start case, and it is why the
      // pre-existing invariant survives this change intact.
      const identity = project?.instanceId ?? null
      if (identity !== null) {
        const seen = await probe(anchored, identity)
        if (seen.ok && isUsablePid(seen.pid) && adoptChild(projectId, anchored, identity, seen.pid))
          return
        if (seen.ok && !isUsablePid(seen.pid)) {
          log.warn(
            { projectId, anchored },
            'meta-supervisor: the occupant of this anchor identified itself but reported no ' +
              'pid, so it cannot be managed — refusing rather than adopting a child we could ' +
              'never stop (an older child broker predating the self-reported pid)',
          )
        }
      }
      const detail = `port ${anchored} is occupied by a process this supervisor could not identify as ${projectId}'s own child; refusing to spawn a second broker`
      try {
        recordHealthFailure(cfg.db, projectId, detail)
      } catch {
        /* project may have been removed */
      }
      throw new Error(detail)
    }
    const port = anchored ?? (await pickPort(projectId))
    const instanceId = randomUUID()
    const proc = launchChild(projectId, projectRoot, port, instanceId)
    claimChild(projectId, proc, port, instanceId)
  }

  function claimChild(
    projectId: string,
    proc: ChildProcess,
    port: number,
    instanceId: string,
  ): void {
    live.set(projectId, { proc, pid: proc.pid ?? -1, port, instanceId })
    proc.on('exit', (code, signal) => {
      // Keyed by THIS process's pid, so a stale sibling's exit cannot consume
      // the intent that belonged to a different process.
      const deliberate = proc.pid !== undefined && intentionalStops.delete(proc.pid)
      log.info(
        { projectId, pid: proc.pid, code, signal, deliberate },
        'meta-supervisor: child exited',
      )
      // A swap deliberately replaces the live entry before stopping blue; blue's
      // exit must not then clear green's registry row.
      if (live.get(projectId)?.pid !== proc.pid) return
      live.delete(projectId)
      if (deliberate) return
      try {
        updateChildState(cfg.db, projectId, {
          status: 'failing',
          boundPort: null,
          childPid: null,
          instanceId: null,
          lastSeenAt: new Date().toISOString(),
        })
      } catch {
        /* project may have been removed */
      }
    })
    // A child that is starting has no measured idleness yet; a stale reading
    // from its previous life must not reap the new one on its first tick.
    lastRequestAgeMs.delete(projectId)
    lastReapAttempt.delete(projectId)
    prunedAdoptions.delete(projectId)
    resetHealthFailures(cfg.db, projectId)
    updateChildState(cfg.db, projectId, {
      status: 'starting',
      boundPort: port,
      childPid: proc.pid ?? null,
      instanceId,
      lastSeenAt: new Date().toISOString(),
    })
  }

  /** Ports held by live children or registered to OTHER projects. */
  function takenPortsFor(projectId: string): Set<number> {
    const taken = new Set<number>()
    for (const [id, c] of live) {
      if (id !== projectId) taken.add(c.port)
    }
    for (const p of listProjects(cfg.db)) {
      if (p.boundPort !== null && p.projectId !== projectId) taken.add(p.boundPort)
      if (p.desiredPort !== null && p.projectId !== projectId) taken.add(p.desiredPort)
    }
    return taken
  }

  async function pickPort(projectId: string, extraTaken?: ReadonlySet<number>): Promise<number> {
    const taken = takenPortsFor(projectId)
    const liveSelf = live.get(projectId)
    if (liveSelf) taken.add(liveSelf.port)
    for (const p of extraTaken ?? []) taken.add(p)
    const existing = getProject(cfg.db, projectId)
    const desired = existing ? stickyDesiredPort(existing) : undefined
    return allocatePort({
      ...(desired !== undefined && !taken.has(desired) ? { desired } : {}),
      taken,
      isPortInUse: portInUse,
    })
  }

  /**
   * Start a child process on an explicit port/instance WITHOUT touching the
   * registry. `spawnChild` claims the row immediately; a blue/green swap must
   * not, because the row still has to point at blue until green is verified.
   */
  function launchChild(
    projectId: string,
    projectRoot: string,
    port: number,
    instanceId: string,
  ): ChildProcess {
    const dbPath = join(cfg.projectDbDir, projectId, 'data.db')
    const scnsHome = join(cfg.projectDbDir, projectId, 'home')
    try {
      mkdirSync(dirname(dbPath), { recursive: true })
    } catch {
      /* dir may already exist */
    }
    const existing = getProject(cfg.db, projectId)
    log.info(
      { projectId, projectRoot, port, instanceId, dbPath, scnsHome },
      'meta-supervisor: spawning child broker',
    )
    const spec = buildChildSpawnSpec({
      brokerEntry: cfg.brokerEntry,
      projectRoot,
      projectId,
      dbPath,
      scnsHome,
      port,
      instanceId,
      autonomyLevel: existing?.autonomyLevel,
      autoApproveThreshold: existing?.autoApproveThreshold,
      selfIssueRepo: existing?.selfIssueRepo,
    })
    // Capture the child's stdout+stderr to a per-project log so an operator can
    // diagnose it (children are detached from the supervisor's console; without
    // this their logs are lost). Append mode so it survives restarts.
    const childLogPath = join(cfg.projectDbDir, projectId, 'child.log')
    let childStdio: 'ignore' | ['ignore', number, number] = 'ignore'
    try {
      const fd = openSync(childLogPath, 'a')
      childStdio = ['ignore', fd, fd]
    } catch {
      /* fall back to ignore if the log can't be opened */
    }
    let proc: ChildProcess
    try {
      proc = spawnProcess(process.execPath, [...spec.args], {
        env: { ...process.env, ...spec.env },
        cwd: CHILD_CWD,
        stdio: childStdio,
        detached: false,
        windowsHide: true,
      })
    } finally {
      if (Array.isArray(childStdio)) {
        try {
          closeSync(childStdio[1])
        } catch (err) {
          log.warn({ err, childLogPath }, 'meta-supervisor: parent log descriptor close failed')
        }
      }
    }
    if (!proc.pid) {
      throw new Error(`spawn returned no pid for ${projectId}`)
    }
    return proc
  }

  async function probeChild(projectId: string, port: number, instanceId: string): Promise<void> {
    try {
      const result = await probe(port, instanceId)
      if (result.ok) {
        // The orphan path. A successful probe has just PROVED that a process
        // on this port carries this project's instance id; if we hold no
        // handle for it, it survived a previous supervisor and is ours to
        // take back. Without this, such a child is probed forever, never
        // managed, and never reapable — the leak this feature exists to close.
        if (!live.has(projectId) && isUsablePid(result.pid)) {
          adoptChild(projectId, port, instanceId, result.pid)
        }
        // Record the demand signal ONLY on a verified-identity success. A
        // failed probe leaves the previous reading in place rather than
        // inventing one, and a child that never reports the field stays absent
        // from the map — both of which mean "do not reap".
        if (result.lastRequestAgeMs !== null) {
          lastRequestAgeMs.set(projectId, result.lastRequestAgeMs)
        }
        resetHealthFailures(cfg.db, projectId)
        // A port that passed identity verification is known-good: pin it so a
        // restart reclaims it instead of re-dealing the pool under live
        // sessions. `bound_port` alone is cleared on exit and cannot persist.
        persistDesiredPort(cfg.db, projectId, port)
        updateChildState(cfg.db, projectId, {
          status: 'running',
          boundPort: port,
          childPid: live.get(projectId)?.pid ?? null,
          instanceId,
          lastSeenAt: new Date().toISOString(),
        })
      } else {
        recordHealthFailure(cfg.db, projectId, 'probe returned non-OK / identity mismatch')
        // #48 — routing tolerance must match the restart policy's tolerance.
        // The restart policy treats < minFailures consecutive failures as a
        // transient blip (restart-policy.ts), but flipping `status` here on the
        // FIRST failure made /api/meta/resolve refuse the child immediately,
        // and a session starting in that window latches global:fallback for
        // its entire life. Keep the current status until the threshold;
        // recordHealthFailure above keeps restart/suspend bookkeeping intact.
        const proj = getProject(cfg.db, projectId)
        if (proj) {
          updateChildState(cfg.db, projectId, {
            status: proj.healthFailures >= policy.minFailures ? 'failing' : proj.status,
            boundPort: port,
            childPid: live.get(projectId)?.pid ?? null,
            instanceId,
            lastSeenAt: new Date().toISOString(),
          })
        }
      }
    } catch (err) {
      recordHealthFailure(cfg.db, projectId, (err as Error).message)
    }
  }

  /**
   * Charge the restart BUDGET (`maxRestartsPerWindow` → suspend).
   *
   * Charged when a recovery attempt actually started a child, or ran the full
   * blue/green fallback — which spawns a real green even when verification then
   * fails, so a both-paths-failed attempt costs a slot too; otherwise a project
   * that fails both paths every cycle would loop full-cost recovery forever and
   * never reach `suspend` and its slower retry backoff. The only uncharged
   * outcome is a same-port refusal, and that now always falls through to the
   * charged fallback — see `restartChild` / `recoverOnFreshPort`.
   */
  function recordRestart(projectId: string): void {
    const t = now()
    const history = restartHistory.get(projectId) ?? []
    restartHistory.set(
      projectId,
      [...history, t].filter((x) => t - x < policy.windowMs),
    )
  }

  /** Automatic recovery preserves the URL pinned by existing CLI sessions. */
  async function restartChild(projectId: string): Promise<void> {
    // The COOLDOWN is charged for the attempt — it paces retries, and a
    // refused attempt still costs a `taskkill` and a stop-grace wait, so
    // retrying it every tick would make a loaded machine worse. The BUDGET is
    // charged separately, by `recordRestart`, and only on an actual spawn.
    lastRestart.set(projectId, now())

    const child = live.get(projectId)
    const proj = getProject(cfg.db, projectId)
    if (!proj) return
    const port = child?.port ?? proj.boundPort ?? proj.desiredPort
    if (port === null) {
      await spawnChild(projectId, proj.projectRoot)
      recordRestart(projectId)
      return
    }
    const instanceId = randomUUID()
    const spec = buildChildSpawnSpec({
      brokerEntry: cfg.brokerEntry,
      projectRoot: proj.projectRoot,
      projectId,
      dbPath: join(cfg.projectDbDir, projectId, 'data.db'),
      scnsHome: join(cfg.projectDbDir, projectId, 'home'),
      port,
      instanceId,
      autonomyLevel: proj.autonomyLevel,
      autoApproveThreshold: proj.autoApproveThreshold,
      selfIssueRepo: proj.selfIssueRepo,
    })
    const ownedChildAlive = (): boolean => child !== undefined && !childHasExited(child)
    const result = await createPlatformRestarter({
      platform: process.platform,
      strategy: 'relaunch',
      runCommand: runRestartCommand,
      // Registry child_pid is advisory; only terminate our own tracked child —
      // which, for an adopted one, is a pid it reported about itself.
      readLivePid: () => (ownedChildAlive() ? (child?.pid ?? null) : null),
      stopPid: (pid) =>
        runRestartCommand(buildStopCommand(process.platform, pid), { timeoutMs: 15_000 }),
      isAlive: (pid) => child?.pid === pid && ownedChildAlive(),
      isPortInUse: async () => takenPortsFor(projectId).has(port) || (await portInUse(port)),
      spawnSpec: { command: process.execPath, ...spec },
      spawnBroker: () => {
        const proc = launchChild(projectId, proj.projectRoot, port, instanceId)
        claimChild(projectId, proc, port, instanceId)
        return proc.pid ?? null
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    })()
    if (result.spawnedPid === null) {
      await recoverOnFreshPort(projectId, port, result)
      return
    }
    recordRestart(projectId)
    log.info({ projectId, port, ...result }, 'meta-supervisor: same-port child recovery requested')
  }

  /**
   * Second chance when same-port recovery refused to spawn.
   *
   * The relaunch path must kill the old child before it can rebind the pinned
   * port, so it refuses whenever the stop does not demonstrably succeed —
   * spawning onto a port a live broker still holds is worse than not spawning.
   * That refusal is correct in isolation and catastrophic as a dead end: on a
   * loaded machine `taskkill` times out, the stop looks failed, and after three
   * refusals the child is suspended having never been restarted at all.
   *
   * Blue/green has no such constraint — green takes a FRESH port, so nothing
   * has to die first, and the registry repoint is what moves routing. The cost
   * is the thing same-port recovery exists to protect: a session holding the
   * old URL has to re-resolve (the extension's one-shot
   * `re-resolve-after-failure`). A changed port beats a dead project.
   *
   * Worst case this adds the swap's own bounded budget — green health 30s,
   * drain overlap 15s, blue stop-grace 5s — to a tick. Ticks are serial, so
   * that delays other projects' probes; it is bounded, and only reached on the
   * path whose alternative is suspension.
   */
  async function recoverOnFreshPort(
    projectId: string,
    port: number,
    refusal: RestartOutcome,
  ): Promise<void> {
    log.warn(
      { projectId, port, ...refusal },
      'meta-supervisor: same-port recovery refused — falling back to blue/green on a fresh port',
    )
    const swap = await swapChild(projectId, {
      // Blue already failed `minFailures` consecutive health probes and refused
      // a stop; it is not usefully serving. Keep the best-effort drain POST but
      // skip the overlap polling that protects in-flight requests on a HEALTHY
      // blue — ticks are serial, so on this path it only delays every other
      // project's probes.
      maxOverlapMs: 0,
    })
    // The attempt is charged whichever way it ends: the fallback spawns a real
    // green even when verification then fails, and an uncharged failure would
    // retry this full-cost path every cooldown forever instead of reaching
    // `suspend` and its slower failed-retry backoff.
    recordRestart(projectId)
    if (swap.outcome === 'swapped' || swap.outcome === 'no-blue') {
      if (swap.outcome === 'swapped' && !swap.blueStopped) {
        log.error(
          { projectId, bluePort: port, greenPort: swap.greenPort, phases: swap.phases },
          'meta-supervisor: old child survived SIGTERM+SIGKILL after the swap — it shares the ' +
            "project's SQLite DB with green (split-brain) and squats the pinned port until it dies",
        )
      }
      log.info(
        {
          projectId,
          bluePort: port,
          greenPort: swap.greenPort,
          outcome: swap.outcome,
          blueStopped: swap.blueStopped,
        },
        'meta-supervisor: child recovered on a fresh port after a refused same-port restart',
      )
      return
    }
    recordHealthFailure(
      cfg.db,
      projectId,
      `${refusal.detail} | blue/green fallback: ${swap.outcome}`,
    )
    log.error(
      { projectId, port, refusal: refusal.detail, outcome: swap.outcome, phases: swap.phases },
      'meta-supervisor: child recovery failed on both the pinned port and a fresh one',
    )
  }

  async function suspendChild(projectId: string, reason: string): Promise<void> {
    log.warn(
      { projectId, reason },
      'meta-supervisor: suspending child — automatic retry after the failed-retry backoff ' +
        '(`scns meta reset` retries now)',
    )
    // Best-effort, NOT verified — deliberately unlike the reap below.
    //
    // The two are asymmetric because they assert different things. A reap is
    // OPTIONAL (nothing is wrong; we merely want the memory back), so when its
    // stop cannot be verified the honest answer is to do nothing at all. A
    // suspension is a HEALTH VERDICT reached by exhausting the restart budget:
    // the project is already failing, and refusing to record the verdict would
    // leave the row `failing`, which `planForProject` re-decides as `suspend`
    // on every single tick — up to 20s of serial stop escalation each, forever.
    // Recording it is the lesser harm.
    //
    // It IS still a harm, and it is now RECOVERABLE rather than terminal: the
    // row keeps the surviving child's identity, so the next retry can probe
    // the occupant of its anchor and ADOPT it (see `spawnChild`) instead of
    // refusing forever. If the survivor cannot be identified — it is wedged
    // and no longer answers, or it is a stranger — the refusal stands and is
    // recorded on the row for an operator.
    await stopChildDeliberately(projectId, { status: 'failed' }, reason, {
      requireVerifiedStop: false,
    })
  }

  /**
   * Park a child nobody is using.
   *
   * `stopped` is the only status that stays down, which is exactly what this
   * needs — `registered` respawns immediately and `failed` respawns after the
   * retry backoff, so both would make the reap a no-op. What makes `stopped`
   * safe to use here (it is otherwise terminal operator intent) is
   * `stopped_reason = 'idle'`: `/api/meta/resolve` recognises it, answers the
   * RETRYABLE `child-idle`, and wakes the row on demand. An idle-reaped project
   * therefore costs a session a cold start, never a `global:fallback` latch.
   */
  async function stopIdleChild(projectId: string, reason: string): Promise<void> {
    lastReapAttempt.set(projectId, now())
    log.info({ projectId, reason }, 'meta-supervisor: reaping idle child (wakes on demand)')
    await stopChildDeliberately(projectId, { status: 'stopped', stoppedReason: 'idle' }, reason, {
      requireVerifiedStop: true,
    })
  }

  /**
   * The one way to take a child down on purpose.
   *
   * With `requireVerifiedStop`, the stop is PROVED before anything is written.
   * An earlier revision wrote the row before killing, to close the window in
   * which the registry still claimed a killed process was `running`. That
   * window is real but trivial; the window it opened instead was not. When the
   * kill did not land — an orphan with no live handle, or a SIGTERM that does
   * not take, both observed on this machine — the row asserted a stop that had
   * not happened, the port stayed occupied, and `spawnChild` then refused every
   * respawn forever. A project in that state can never resolve, so every
   * session in it latches `global:fallback` and silently refuses writes for its
   * whole life.
   *
   * So a reap we cannot verify is reported and ABANDONED, leaving the row
   * `running` and the ordinary health machinery in charge of a child that is,
   * after all, still running.
   */
  async function stopChildDeliberately(
    projectId: string,
    state: Pick<ProjectChildState, 'status' | 'stoppedReason'>,
    reason: string,
    opts: { readonly requireVerifiedStop: boolean },
  ): Promise<boolean> {
    const boundPort = live.get(projectId)?.port ?? getProject(cfg.db, projectId)?.boundPort ?? null
    const outcome = await stopChildVerified(projectId, boundPort)
    if (!outcome.stopped && opts.requireVerifiedStop) {
      log.error(
        { projectId, reason, detail: outcome.detail, boundPort },
        'meta-supervisor: deliberate stop REFUSED — leaving the row untouched so the child ' +
          'stays managed and its port stays claimed by the project that owns it',
      )
      return false
    }
    if (!outcome.stopped) {
      log.warn(
        { projectId, reason, detail: outcome.detail },
        'meta-supervisor: stop could not be verified, but the state is a health verdict and ' +
          'is recorded anyway — PRESERVING the runtime identity of the surviving process',
      )
      // Keep `bound_port`, `child_pid` and `instance_id`. They describe a
      // process that demonstrably still exists, so erasing them is simply
      // false — and it is the erasure, not the `failed` status, that used to
      // strand the project: with no stored `instance_id` the next spawn had
      // nothing to verify the port's occupant against, so it could only
      // refuse, forever. Preserved identity lets `spawnChild` recognise the
      // survivor and ADOPT it instead.
      const surviving = live.get(projectId)
      const row = getProject(cfg.db, projectId)
      try {
        updateChildState(cfg.db, projectId, {
          ...state,
          boundPort: surviving?.port ?? row?.boundPort ?? null,
          childPid: surviving?.pid ?? row?.childPid ?? null,
          instanceId: surviving?.instanceId ?? row?.instanceId ?? null,
          lastSeenAt: new Date().toISOString(),
        })
      } catch {
        /* removed concurrently */
      }
      return true
    }
    try {
      updateChildState(cfg.db, projectId, {
        ...state,
        boundPort: null,
        childPid: null,
        instanceId: null,
        lastSeenAt: new Date().toISOString(),
      })
    } catch {
      /* removed concurrently — the child is already down either way */
    }
    return true
  }

  /**
   * #61 option C — true blue/green for a child broker.
   *
   * Child ports are registry-assigned, so unlike the global broker this needs
   * no gap at all: green comes up on a fresh port, is verified by identity, and
   * takes over with one registry write while blue is still serving. See
   * `child-blue-green.ts` for the ordering rules and the overlap budget.
   */
  async function swapChild(
    projectId: string,
    swapConfig?: Partial<ChildSwapConfig>,
  ): Promise<ChildSwapResult> {
    const proj = getProject(cfg.db, projectId)
    let greenProc: ChildProcess | null = null

    return swapChildBroker({
      projectId,
      readProject: () =>
        proj === null
          ? null
          : {
              projectId,
              boundPort: live.get(projectId)?.port ?? proj.boundPort,
              // Registry child_pid is advisory (pid reuse can point it at an
              // unrelated process) — the swap must only ever stop a child this
              // supervisor owns. With no tracked child it degrades to 'no-blue':
              // green starts and the registry repoints, nothing is killed.
              childPid: live.get(projectId)?.pid ?? null,
              instanceId: live.get(projectId)?.instanceId ?? proj.instanceId,
              takenPorts: takenPortsFor(projectId),
            },
      allocateGreenPort: (excluded) => pickPort(projectId, excluded),
      newInstanceId: () => randomUUID(),
      spawnGreen: async ({ port, instanceId }) => {
        if (proj === null) return null
        try {
          greenProc = launchChild(projectId, proj.projectRoot, port, instanceId)
        } catch (err) {
          log.error({ err, projectId, port }, 'meta-supervisor: green spawn failed')
          return null
        }
        return greenProc.pid ?? null
      },
      probeChild: (port, instanceId) => probe(port, instanceId).then((r) => r.ok),
      repoint: ({ boundPort, childPid, instanceId }) => {
        // Claim the live slot BEFORE the registry write, so blue's imminent
        // exit handler sees a different pid and leaves green's row alone.
        if (greenProc !== null) {
          live.set(projectId, { proc: greenProc, pid: childPid, port: boundPort, instanceId })
          // Green is a brand-new process with a brand-new demand clock; blue's
          // last reading must not reap it on the next tick.
          lastRequestAgeMs.delete(projectId)
          lastReapAttempt.delete(projectId)
          greenProc.on('exit', (code, signal) => {
            // Same pid-keyed guard as the primary handler. The swap itself
            // never marks green (blue's stop is covered by the pid check
            // below), but a later reap or suspend of THIS child must not be
            // overwritten with `failing` just because it came up via a swap.
            const deliberate = childPid !== undefined && intentionalStops.delete(childPid)
            log.info(
              { projectId, pid: childPid, code, signal, deliberate },
              'meta-supervisor: child exited',
            )
            if (live.get(projectId)?.pid !== childPid) return
            live.delete(projectId)
            if (deliberate) return
            try {
              updateChildState(cfg.db, projectId, {
                status: 'failing',
                boundPort: null,
                childPid: null,
                instanceId: null,
                lastSeenAt: new Date().toISOString(),
              })
            } catch {
              /* project may have been removed */
            }
          })
        }
        updateChildState(cfg.db, projectId, {
          status: 'running',
          boundPort,
          childPid,
          instanceId,
          lastSeenAt: new Date().toISOString(),
        })
        resetHealthFailures(cfg.db, projectId)
      },
      drainBlue: async (port) => {
        await fetch(`http://127.0.0.1:${port}/api/admin/drain`, {
          method: 'POST',
          headers: adminHeaders(),
          signal: AbortSignal.timeout(5_000),
        })
      },
      readActiveRequests: async (port) => {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/api/admin/health`, {
            headers: adminHeaders(),
            signal: AbortSignal.timeout(5_000),
          })
          if (!res.ok) return null
          const body = (await res.json()) as Record<string, unknown>
          const n = body['activeRequestCount']
          return typeof n === 'number' && Number.isFinite(n) ? n : null
        } catch {
          return null
        }
      },
      stopChild: async (pid) => {
        try {
          process.kill(pid, 'SIGTERM')
        } catch {
          /* already gone */
        }
      },
      // Escalation when SIGTERM + grace leaves the process alive. SIGKILL is
      // TerminateProcess on win32 and uncatchable on POSIX — the leaked child
      // would otherwise keep the project's SQLite DB open and squat its port.
      forceStopChild: async (pid) => {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          /* already gone */
        }
      },
      isAlive: (pid) => {
        try {
          process.kill(pid, 0)
          return true
        } catch (err) {
          return (err as NodeJS.ErrnoException).code === 'EPERM'
        }
      },
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now,
      ...(swapConfig ? { config: swapConfig } : {}),
    })
  }

  async function tickOnce(): Promise<void> {
    // An adopted child has no exit event; this is its equivalent.
    pruneDeadAdopted()
    const plan = planTick(cfg.db, {
      nowMs: now(),
      policy,
      restartHistoryByProject: restartHistory,
      lastRestartByProject: lastRestart,
      idleMsByProject: lastRequestAgeMs,
      lastReapAttemptByProject: lastReapAttempt,
    })
    for (const action of plan.actions) {
      try {
        switch (action.kind) {
          case 'spawn':
            if (!live.has(action.projectId)) {
              // A planned spawn is a fresh start — first spawn, operator
              // `meta reset`, or a failed-retry. The previous incarnation's
              // in-memory restart charges must not carry over (a reset project
              // inheriting a spent budget re-suspends on its first failure
              // streak having been given zero new restarts). Stamp the attempt
              // BEFORE spawning so a spawn that throws (anchored port still
              // occupied by a zombie) re-arms the failed-retry backoff instead
              // of being re-planned — port-probed and error-logged — every tick.
              restartHistory.delete(action.projectId)
              lastRestart.set(action.projectId, now())
              await spawnChild(action.projectId, action.projectRoot)
            }
            break
          case 'probe':
            await probeChild(action.projectId, action.boundPort, action.instanceId)
            break
          case 'restart':
            await restartChild(action.projectId)
            break
          case 'suspend':
            await suspendChild(action.projectId, action.reason)
            break
          case 'stop-idle':
            await stopIdleChild(action.projectId, action.reason)
            break
        }
      } catch (err) {
        log.error({ err, action }, 'meta-supervisor: tick action failed')
      }
    }
  }

  function scheduleNext(): void {
    if (stopped) return
    timer = setTimeout(() => {
      tickOnce()
        .catch((err) => log.error({ err }, 'meta-supervisor: tick failed'))
        .finally(scheduleNext)
    }, intervalMs)
  }

  return {
    start(): void {
      log.info({ intervalMs, brokerEntry: cfg.brokerEntry }, 'meta-supervisor: starting')
      scheduleNext()
    },
    async stop(): Promise<void> {
      stopped = true
      if (timer) clearTimeout(timer)
      log.info({ children: live.size }, 'meta-supervisor: stopping')

      // Shutdown stops children in PARALLEL and does not route through
      // `stopChildVerified`, deliberately. That path escalates with a 5s grace
      // per step plus a 5s port-release wait — up to 20s PER CHILD, serially.
      // Across the 16 children on this machine that is a five-minute
      // shutdown, inside a signal handler with a bounded window. Signal
      // everything, drain once, escalate once.
      // Snapshot BEFORE signalling. A child that exits during the drain is
      // removed from `live` by its own exit handler, so iterating `live`
      // afterwards would skip exactly the children that shut down cleanly and
      // leave their rows stuck at whatever the last tick wrote.
      const shuttingDown = [...live.entries()]

      for (const [projectId, child] of shuttingDown) {
        log.info({ projectId, pid: child.pid }, 'meta-supervisor: SIGTERM child')
        // Mark BEFORE the kill, same contract as every other deliberate stop.
        // Without this, a clean supervisor shutdown wrote `failing` for every
        // child as it exited during the drain window below — a false health
        // verdict that spent restart budget and, worse, left routing claiming a
        // child was unhealthy when it had simply been asked to leave.
        // Adopted children have no exit handler, so they need no flag.
        if (child.proc !== null) intentionalStops.add(child.pid)
        try {
          signalChild(child, 'SIGTERM')
        } catch (err) {
          log.warn({ err, projectId }, 'meta-supervisor: SIGTERM failed')
        }
      }

      // Brief drain window.
      await sleep(1000)
      for (const [projectId, child] of shuttingDown) {
        if (!childHasExited(child)) {
          log.warn({ projectId, pid: child.pid }, 'meta-supervisor: SIGKILL child after grace')
          if (child.proc !== null) intentionalStops.add(child.pid)
          try {
            signalChild(child, 'SIGKILL')
          } catch (err) {
            log.warn({ err, projectId }, 'meta-supervisor: SIGKILL failed')
          }
        }
      }
      // Let a landed SIGKILL be observable before we decide what to record.
      await sleep(STOP_POLL_MS * 2)

      // Rows are written LAST, once the outcome per child is known.
      //
      // `registered` either way: it asserts intent ("this project should be
      // running") rather than a health verdict, it is retryable in the
      // extension, and the next supervisor spawns it on its first tick.
      //
      // What differs is the IDENTITY, and that difference is the whole fix.
      // This used to null `instance_id` unconditionally — the identical
      // erasure that `stopChildDeliberately` was changed to stop doing. With
      // `desired_port` still pinned (updateChildState never touches it) and no
      // stored identity, a child that survived its SIGTERM left a project that
      // was permanently unspawnable AND permanently unadoptable: `spawnChild`
      // found the anchor occupied, had nothing to verify the occupant against,
      // and could only refuse — forever. Preserving the survivor's identity is
      // what lets the next supervisor recognise it and adopt it.
      for (const [projectId, child] of shuttingDown) {
        const survived = !childHasExited(child)
        if (survived) {
          log.warn(
            { projectId, pid: child.pid, port: child.port },
            'meta-supervisor: child outlived shutdown — recording its identity so the next ' +
              'supervisor can adopt it rather than refuse its anchor forever',
          )
        }
        try {
          updateChildState(cfg.db, projectId, {
            status: 'registered',
            boundPort: survived ? child.port : null,
            childPid: survived ? child.pid : null,
            instanceId: survived ? child.instanceId : null,
            lastSeenAt: new Date().toISOString(),
          })
        } catch {
          /* project may have been removed */
        }
      }
      live.clear()
      lastRequestAgeMs.clear()
    },
    tickOnce,
    swapChild,
    livePids(): ReadonlyMap<string, number> {
      const out = new Map<string, number>()
      for (const [id, c] of live) {
        // Filter non-positive pids, restoring the guard the old
        // `if (c.proc.pid)` form provided. `claimChild` falls back to -1 when
        // a spawned proc somehow has no pid, and a sentinel must not escape
        // through a public accessor.
        if (c.pid > 0) out.set(id, c.pid)
      }
      return out
    },
  }
}

export async function defaultHttpProbe(port: number, instanceId: string): Promise<boolean> {
  return (await defaultChildProbe(port, instanceId)).ok
}

/**
 * The real identity-checked health probe, returning everything one call can
 * learn. `defaultHttpProbe` is the boolean shim over it, kept because callers
 * and tests already depend on that signature.
 *
 * One HTTP call, not two: the demand signal rides along in the payload the
 * supervisor was already fetching every tick, so idle reaping costs no extra
 * traffic against a live child.
 */
export async function defaultChildProbe(
  port: number,
  instanceId: string,
): Promise<ChildProbeResult> {
  const miss: ChildProbeResult = { ok: false, lastRequestAgeMs: null, pid: null }
  try {
    // The child inherits this supervisor's env, so its auth middleware is
    // keyed on the SAME BROKER_TOKEN we read here (broker/server.ts). The
    // auth exemption covers `/health*` and `/api/hooks/*` only — `/api/health`
    // is NOT exempt, so a tokenless probe 401s and the child would be killed
    // and respawned forever. Tokenless setups send no header, as before.
    const token = process.env.BROKER_TOKEN?.trim()
    // `x-scns-meta-probe` tells the child this is supervision traffic, so it
    // does NOT count as demand (broker/request-activity.ts). Without that, the
    // 5-second probe cadence would hold every child permanently "busy" and
    // idle reaping would never fire once.
    const headers: Record<string, string> = { 'x-scns-meta-probe': '1' }
    if (token) headers['Authorization'] = `Bearer ${token}`
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers,
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) return miss
    const body = (await res.json()) as Record<string, unknown>
    // Identity verification: child must echo back its SCNS_INSTANCE_ID
    // in the health payload. Without this, a stale process / port-squatter
    // could falsely pass a green check.
    const echoed = typeof body['instance_id'] === 'string' ? (body['instance_id'] as string) : null
    if (echoed !== instanceId) return miss
    const ageSeconds = body['last_request_age_seconds']
    const lastRequestAgeMs =
      typeof ageSeconds === 'number' && Number.isFinite(ageSeconds) && ageSeconds >= 0
        ? ageSeconds * 1000
        : null
    const reported = body['pid']
    const pid =
      typeof reported === 'number' && Number.isInteger(reported) && reported > 0 ? reported : null
    return { ok: true, lastRequestAgeMs, pid }
  } catch {
    return miss
  }
}
