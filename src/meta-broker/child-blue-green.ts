/**
 * Issue #61 (option C) — child-broker blue/green by port swap.
 *
 * The global broker cannot do true blue/green: its port is fixed, so the old
 * process has to release it before the new one can bind, and the swap opens a
 * short window where nothing is listening. Child brokers have no such
 * constraint — the meta registry hands out their ports (`port-allocator.ts`),
 * and the registry itself is the routing table that `/api/meta/resolve` reads.
 *
 * So the swap is a registry write:
 *
 *   1. allocate a port green can have to itself
 *   2. start green there, with a FRESH instance id
 *   3. verify green answers `/api/health` AND echoes that instance id
 *   4. repoint the registry — the instant routing changes, and the first
 *      instant at which anything could have been affected
 *   5. drain blue, then stop it
 *
 * Nothing is ever refused: blue is still serving for every step before (4), and
 * sessions that already hold blue's URL keep using it until it drains. The one
 * session-level seam that matters is the extension's one-shot
 * `re-resolve-after-failure` (see `copilot-extension/extension-template.ts`),
 * which re-reads the registry after a transport failure — that is what catches
 * a session whose in-flight request outlives blue.
 *
 * ── The overlap, stated honestly ──
 *
 * Between (2) and (5) two brokers hold the same SQLite file open. That is safe
 * for poller-driven background work, which takes a row lock in
 * `background_tasks` (`broker/services/background-task-gate.ts`). It is NOT
 * claimed across processes by the cron task scheduler
 * (`broker/services/task-scheduler.ts`), which runs an immediate tick on start
 * and re-evaluates due crons every 60s. Two live brokers can therefore run the
 * same due task twice.
 *
 * The mitigation is a hard bound, not a hope: `maxOverlapMs` (default 15s) caps
 * how long blue may take to drain before it is stopped anyway — comfortably
 * inside one scheduler interval. It is deliberately not configurable upward
 * from the CLI. The alternative fix, cross-process claim in the scheduler, is a
 * larger change than this issue, and is worth filing separately.
 */

import { logger } from '../shared/logger.js'

const log = logger.child({ module: 'child-blue-green' })

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChildSwapPhase =
  | 'allocate'
  | 'spawn-green'
  | 'green-health'
  | 'repoint'
  | 'drain-blue'
  | 'stop-blue'

export type ChildSwapOutcome =
  /** Green verified, registry repointed, blue drained and stopped. */
  | 'swapped'
  /** Green never came up; it was stopped and blue was never touched. */
  | 'green-failed'
  /** Nothing was running: green was started and registered. */
  | 'no-blue'
  /** The project is not in the registry. */
  | 'not-registered'

export interface ChildSwapPhaseRecord {
  readonly phase: ChildSwapPhase
  readonly ok: boolean
  readonly detail: string
  readonly durationMs: number
}

export interface ChildSwapResult {
  readonly outcome: ChildSwapOutcome
  readonly projectId: string
  readonly bluePort: number | null
  readonly greenPort: number | null
  readonly greenPid: number | null
  readonly greenInstanceId: string | null
  readonly blueStopped: boolean
  /** How long blue and green were both live. Null when there was no blue. */
  readonly overlapMs: number | null
  readonly phases: readonly ChildSwapPhaseRecord[]
}

/** What the swap needs to know about the project, read once up front. */
export interface ProjectSnapshot {
  readonly projectId: string
  readonly boundPort: number | null
  readonly childPid: number | null
  readonly instanceId: string | null
  /** Ports held by OTHER projects, so green does not land on one. */
  readonly takenPorts: ReadonlySet<number>
}

export interface ChildSwapConfig {
  /** Bound on waiting for green to answer its identity-checked health probe. */
  readonly healthTimeoutMs: number
  /** Hard cap on blue and green coexisting. See the module note. */
  readonly maxOverlapMs: number
  /** Bound on waiting for a stopped blue to actually exit. */
  readonly stopGraceMs: number
  readonly pollMs: number
}

export const DEFAULT_CHILD_SWAP_CONFIG: ChildSwapConfig = {
  healthTimeoutMs: 30_000,
  maxOverlapMs: 15_000,
  stopGraceMs: 5_000,
  pollMs: 500,
}

export interface ChildSwapDeps {
  readonly projectId: string
  readonly readProject: () => ProjectSnapshot | null
  readonly allocateGreenPort: (excluded: ReadonlySet<number>) => Promise<number>
  readonly newInstanceId: () => string
  /** Start a child on `port` with `instanceId`. Returns its pid, or null. */
  readonly spawnGreen: (o: { port: number; instanceId: string }) => Promise<number | null>
  /** Identity-checked health probe — must verify the echoed instance id. */
  readonly probeChild: (port: number, instanceId: string) => Promise<boolean>
  /** The atomic handover: one registry write. */
  readonly repoint: (s: { boundPort: number; childPid: number; instanceId: string }) => void
  readonly drainBlue: (port: number) => Promise<void>
  readonly readActiveRequests: (port: number) => Promise<number | null>
  readonly stopChild: (pid: number) => Promise<void>
  /**
   * Forceful termination (SIGKILL / TerminateProcess), used only after `stopChild` plus a full
   * grace window left the process alive. Optional: without it the swap reports the leak and moves
   * on, as before — but a leaked child holds the project's SQLite file and a pool port, and (for a
   * failed green) is in neither the live map nor the registry, so nothing else will ever stop it.
   */
  readonly forceStopChild?: (pid: number) => Promise<void>
  readonly isAlive: (pid: number) => boolean
  readonly sleep: (ms: number) => Promise<void>
  readonly now?: () => number
  readonly log?: (line: string) => void
  readonly config?: Partial<ChildSwapConfig>
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export async function swapChildBroker(deps: ChildSwapDeps): Promise<ChildSwapResult> {
  const cfg: ChildSwapConfig = { ...DEFAULT_CHILD_SWAP_CONFIG, ...(deps.config ?? {}) }
  const now = deps.now ?? ((): number => Date.now())
  const emit = deps.log ?? ((line: string): void => log.info({ projectId: deps.projectId }, line))
  const phases: ChildSwapPhaseRecord[] = []

  const record = async <T>(
    phase: ChildSwapPhase,
    fn: () => Promise<{ ok: boolean; detail: string; value?: T }>,
  ): Promise<{ ok: boolean; detail: string; value?: T }> => {
    const start = now()
    let out: { ok: boolean; detail: string; value?: T }
    try {
      out = await fn()
    } catch (err) {
      out = { ok: false, detail: errText(err) }
    }
    phases.push({ phase, ok: out.ok, detail: out.detail, durationMs: now() - start })
    emit(`${phase}: ${out.ok ? 'ok' : 'FAILED'} — ${out.detail}`)
    return out
  }

  /**
   * Stop a child and VERIFY it died: SIGTERM, wait up to the stop grace, then escalate to
   * `forceStopChild` (when wired) and wait the grace again. Returns whether the pid is gone.
   */
  const stopAndVerify = async (pid: number, label: string): Promise<boolean> => {
    try {
      await deps.stopChild(pid)
    } catch (err) {
      emit(`could not stop ${label} (pid ${pid}): ${errText(err)}`)
    }
    let deadline = now() + cfg.stopGraceMs
    while (deps.isAlive(pid) && now() < deadline) {
      await deps.sleep(cfg.pollMs)
    }
    if (!deps.isAlive(pid)) return true
    if (deps.forceStopChild) {
      emit(
        `${label} pid ${pid} survived SIGTERM + ${cfg.stopGraceMs}ms grace — escalating to SIGKILL`,
      )
      try {
        await deps.forceStopChild(pid)
      } catch (err) {
        emit(`could not force-stop ${label} (pid ${pid}): ${errText(err)}`)
      }
      deadline = now() + cfg.stopGraceMs
      while (deps.isAlive(pid) && now() < deadline) {
        await deps.sleep(cfg.pollMs)
      }
    }
    return !deps.isAlive(pid)
  }

  const project = deps.readProject()
  if (project === null) {
    return {
      outcome: 'not-registered',
      projectId: deps.projectId,
      bluePort: null,
      greenPort: null,
      greenPid: null,
      greenInstanceId: null,
      blueStopped: false,
      overlapMs: null,
      phases,
    }
  }

  // "Blue" means a child we can actually hand over FROM: a port to drain and a
  // pid to stop. A registered port with no pid is a stale row, not a process.
  const hasBlue = project.boundPort !== null && project.childPid !== null
  const bluePort = hasBlue ? project.boundPort : null
  const bluePid = hasBlue ? project.childPid : null

  const fail = (): ChildSwapResult => ({
    outcome: 'green-failed',
    projectId: deps.projectId,
    bluePort,
    greenPort: null,
    greenPid: null,
    greenInstanceId: null,
    blueStopped: false,
    overlapMs: null,
    phases,
  })

  // ── 1. Allocate a port green can have to itself ──────────────────────────
  const excluded = new Set(project.takenPorts)
  if (project.boundPort !== null) excluded.add(project.boundPort)

  const allocated = await record<number>('allocate', async () => {
    const port = await deps.allocateGreenPort(excluded)
    return { ok: true, detail: `green port ${port}`, value: port }
  })
  if (!allocated.ok || allocated.value === undefined) return fail()
  const greenPort = allocated.value

  // ── 2. Start green ───────────────────────────────────────────────────────
  const greenInstanceId = deps.newInstanceId()
  const greenStart = now()
  const spawned = await record<number>('spawn-green', async () => {
    const pid = await deps.spawnGreen({ port: greenPort, instanceId: greenInstanceId })
    return pid === null
      ? { ok: false, detail: `could not spawn a child on port ${greenPort}` }
      : { ok: true, detail: `green pid ${pid} on ${greenPort}`, value: pid }
  })
  if (!spawned.ok || spawned.value === undefined) return fail()
  const greenPid = spawned.value

  // ── 3. Verify green, by identity and not just by liveness ────────────────
  const deadline = now() + cfg.healthTimeoutMs
  let healthy = false
  for (;;) {
    try {
      healthy = await deps.probeChild(greenPort, greenInstanceId)
    } catch {
      healthy = false
    }
    if (healthy || now() >= deadline) break
    await deps.sleep(cfg.pollMs)
  }

  await record('green-health', async () =>
    healthy
      ? { ok: true, detail: `green healthy on ${greenPort} (instance ${greenInstanceId})` }
      : { ok: false, detail: `green did not verify within ${cfg.healthTimeoutMs}ms` },
  )

  if (!healthy) {
    // Blue is still registered and still serving. Clean green up — VERIFIED, because this green is
    // in neither the live map nor the registry: a green that shrugs off one SIGTERM would otherwise
    // keep the project's data.db and a pool port forever, invisible to stop() and to operators.
    const greenStopped = await stopAndVerify(greenPid, 'the failed green')
    if (!greenStopped) {
      emit(`failed green pid ${greenPid} is still alive — leaking a port and a DB handle`)
    }
    return fail()
  }

  // ── 4. The handover: one registry write ──────────────────────────────────
  const repointed = await record('repoint', async () => {
    deps.repoint({ boundPort: greenPort, childPid: greenPid, instanceId: greenInstanceId })
    return { ok: true, detail: `registry now routes ${deps.projectId} to ${greenPort}` }
  })
  if (!repointed.ok) {
    // Routing never moved, so blue is still the live child. Stop green rather
    // than leave two brokers running with only one of them reachable.
    await stopAndVerify(greenPid, 'green after a failed repoint')
    return fail()
  }

  if (!hasBlue || bluePort === null || bluePid === null) {
    return {
      outcome: 'no-blue',
      projectId: deps.projectId,
      bluePort,
      greenPort,
      greenPid,
      greenInstanceId,
      blueStopped: false,
      overlapMs: null,
      phases,
    }
  }

  // ── 5. Drain blue, bounded by the overlap budget ─────────────────────────
  await record('drain-blue', async () => {
    try {
      await deps.drainBlue(bluePort)
    } catch (err) {
      // Blue is on its way out either way; a refused drain only means some
      // in-flight requests will be cut short.
      emit(`drain request to blue failed: ${errText(err)}`)
    }
    const drainDeadline = greenStart + cfg.maxOverlapMs
    let active: number | null = null
    for (;;) {
      try {
        active = await deps.readActiveRequests(bluePort)
      } catch {
        active = null
      }
      if (active === null || active <= 0) {
        return { ok: true, detail: active === null ? 'active count unreadable' : 'active=0' }
      }
      if (now() >= drainDeadline) {
        return {
          ok: false,
          detail:
            `overlap budget of ${cfg.maxOverlapMs}ms reached with ${active} active request(s) ` +
            'on blue — stopping it anyway to keep the shared-DB window short',
        }
      }
      await deps.sleep(cfg.pollMs)
    }
  })

  // ── 6. Stop blue ─────────────────────────────────────────────────────────
  let blueStopped = true
  await record('stop-blue', async () => {
    const stopped = await stopAndVerify(bluePid, 'blue')
    if (!stopped) {
      blueStopped = false
      // Reported, not rolled back. Green is verified, registered and serving;
      // undoing that to tidy up a leaked process would take down the healthy
      // broker to fix the unhealthy one. A surviving blue is split-brain: it
      // shares green's SQLite DB (cron tasks run twice), keeps serving sessions
      // still pinned to its URL, and squats a port — hence the SIGKILL
      // escalation inside stopAndVerify before conceding here.
      return {
        ok: false,
        detail:
          `blue pid ${bluePid} still alive after SIGTERM` +
          `${deps.forceStopChild ? '+SIGKILL' : ''} and ${cfg.stopGraceMs}ms grace — ` +
          'green is serving, but blue is leaking a port and a DB handle',
      }
    }
    return { ok: true, detail: `blue pid ${bluePid} stopped` }
  })

  return {
    outcome: 'swapped',
    projectId: deps.projectId,
    bluePort,
    greenPort,
    greenPid,
    greenInstanceId,
    blueStopped,
    overlapMs: now() - greenStart,
    phases,
  }
}
