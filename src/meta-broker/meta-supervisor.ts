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
} from './registry.js'
import { allocatePort } from './port-allocator.js'
import { swapChildBroker, type ChildSwapConfig, type ChildSwapResult } from './child-blue-green.js'
import { planTick, type TickPolicy } from './supervisor-tick.js'

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
}

const DEFAULT_INTERVAL_MS = 5_000

/** Grace before a suspended child that ignored SIGTERM is SIGKILLed. */
const SUSPEND_KILL_GRACE_MS = 5_000

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
  readonly proc: ChildProcess
  readonly port: number
  readonly instanceId: string
}

export function createMetaSupervisor(cfg: MetaSupervisorConfig): MetaSupervisor {
  applyMetaSchema(cfg.db)
  const intervalMs = cfg.intervalMs ?? DEFAULT_INTERVAL_MS
  const policy = cfg.policy ?? DEFAULT_POLICY
  const now = cfg.now ?? ((): number => Date.now())
  const probe = cfg.httpProbe ?? defaultHttpProbe
  const live = new Map<string, LiveChild>()
  const restartHistory = new Map<string, number[]>()
  const lastRestart = new Map<string, number>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  async function spawnChild(projectId: string, projectRoot: string): Promise<void> {
    const project = getProject(cfg.db, projectId)
    const anchored = project ? stickyDesiredPort(project) : undefined
    if (
      anchored !== undefined &&
      (takenPortsFor(projectId).has(anchored) || (await isPortInUse(anchored)))
    ) {
      throw new Error(
        `Project ${projectId} port ${anchored} is occupied; refusing to change its address`,
      )
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
    live.set(projectId, { proc, port, instanceId })
    proc.on('exit', (code, signal) => {
      log.info({ projectId, pid: proc.pid, code, signal }, 'meta-supervisor: child exited')
      // A swap deliberately replaces the live entry before stopping blue; blue's
      // exit must not then clear green's registry row.
      if (live.get(projectId)?.proc.pid !== proc.pid) return
      live.delete(projectId)
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
      isPortInUse,
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
      const ok = await probe(port, instanceId)
      if (ok) {
        resetHealthFailures(cfg.db, projectId)
        // A port that passed identity verification is known-good: pin it so a
        // restart reclaims it instead of re-dealing the pool under live
        // sessions. `bound_port` alone is cleared on exit and cannot persist.
        persistDesiredPort(cfg.db, projectId, port)
        updateChildState(cfg.db, projectId, {
          status: 'running',
          boundPort: port,
          childPid: live.get(projectId)?.proc.pid ?? null,
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
            childPid: live.get(projectId)?.proc.pid ?? null,
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
    const ownedChildAlive = (): boolean =>
      child !== undefined && child.proc.exitCode === null && child.proc.signalCode === null
    const result = await createPlatformRestarter({
      platform: process.platform,
      strategy: 'relaunch',
      runCommand: runRestartCommand,
      // Registry child_pid is advisory; only terminate our own tracked child.
      readLivePid: () => (ownedChildAlive() ? (child?.proc.pid ?? null) : null),
      stopPid: (pid) =>
        runRestartCommand(buildStopCommand(process.platform, pid), { timeoutMs: 15_000 }),
      isAlive: (pid) => child?.proc.pid === pid && ownedChildAlive(),
      isPortInUse: async () => takenPortsFor(projectId).has(port) || (await isPortInUse(port)),
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

  function suspendChild(projectId: string, reason: string): void {
    const child = live.get(projectId)
    if (child) {
      const proc = child.proc
      proc.kill('SIGTERM')
      // Escalate if it survives the grace. A suspended child that keeps running
      // holds the project's data.db open and squats the desired_port anchor, so
      // every failed-retry spawn refuses on port occupancy until it dies.
      // Fire-and-forget (and unref'd): suspension itself must not block the
      // serial tick loop.
      setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) {
          log.warn(
            { projectId, pid: proc.pid },
            'meta-supervisor: suspended child survived SIGTERM — escalating to SIGKILL',
          )
          try {
            proc.kill('SIGKILL')
          } catch {
            /* already gone */
          }
        }
      }, SUSPEND_KILL_GRACE_MS).unref?.()
      live.delete(projectId)
    }
    log.warn(
      { projectId, reason },
      'meta-supervisor: suspending child — automatic retry after the failed-retry backoff ' +
        '(`scns meta reset` retries now)',
    )
    try {
      updateChildState(cfg.db, projectId, {
        status: 'failed',
        boundPort: null,
        childPid: null,
        instanceId: null,
        lastSeenAt: new Date().toISOString(),
      })
    } catch {
      /* removed concurrently */
    }
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
              childPid: live.get(projectId)?.proc.pid ?? null,
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
      probeChild: (port, instanceId) => probe(port, instanceId),
      repoint: ({ boundPort, childPid, instanceId }) => {
        // Claim the live slot BEFORE the registry write, so blue's imminent
        // exit handler sees a different pid and leaves green's row alone.
        if (greenProc !== null) {
          live.set(projectId, { proc: greenProc, port: boundPort, instanceId })
          greenProc.on('exit', (code, signal) => {
            log.info({ projectId, pid: childPid, code, signal }, 'meta-supervisor: child exited')
            if (live.get(projectId)?.proc.pid !== childPid) return
            live.delete(projectId)
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
    const plan = planTick(cfg.db, {
      nowMs: now(),
      policy,
      restartHistoryByProject: restartHistory,
      lastRestartByProject: lastRestart,
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
            suspendChild(action.projectId, action.reason)
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
      for (const [projectId, child] of live) {
        log.info({ projectId, pid: child.proc.pid }, 'meta-supervisor: SIGTERM child')
        child.proc.kill('SIGTERM')
      }
      // Brief drain window.
      await new Promise((r) => setTimeout(r, 1000))
      for (const [projectId, child] of live) {
        // `proc.killed` only records that a signal was SENT — it is set by the
        // SIGTERM above and says nothing about whether the process exited, so
        // gating on it made this escalation dead code and leaked any
        // SIGTERM-resistant child on every supervisor shutdown. Exit state is
        // the real check.
        if (child.proc.exitCode === null && child.proc.signalCode === null) {
          log.warn({ projectId, pid: child.proc.pid }, 'meta-supervisor: SIGKILL child after grace')
          child.proc.kill('SIGKILL')
        }
      }
      live.clear()
    },
    tickOnce,
    swapChild,
    livePids(): ReadonlyMap<string, number> {
      const out = new Map<string, number>()
      for (const [id, c] of live) {
        if (c.proc.pid) out.set(id, c.proc.pid)
      }
      return out
    },
  }
}

export async function defaultHttpProbe(port: number, instanceId: string): Promise<boolean> {
  try {
    // The child inherits this supervisor's env, so its auth middleware is
    // keyed on the SAME BROKER_TOKEN we read here (broker/server.ts). The
    // auth exemption covers `/health*` and `/api/hooks/*` only — `/api/health`
    // is NOT exempt, so a tokenless probe 401s and the child would be killed
    // and respawned forever. Tokenless setups send no header, as before.
    const token = process.env.BROKER_TOKEN?.trim()
    const headers: Record<string, string> = { 'x-scns-meta-probe': '1' }
    if (token) headers['Authorization'] = `Bearer ${token}`
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers,
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) return false
    const body = (await res.json()) as Record<string, unknown>
    // Identity verification: child must echo back its SCNS_INSTANCE_ID
    // in the health payload. Without this, a stale process / port-squatter
    // could falsely pass a green check.
    const echoed = typeof body['instance_id'] === 'string' ? (body['instance_id'] as string) : null
    return echoed === instanceId
  } catch {
    return false
  }
}
