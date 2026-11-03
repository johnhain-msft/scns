/**
 * P7 — Supervisor tick planner (pure).
 *
 * Pure function over the registry state. Returns a list of actions the
 * I/O-doing caller (meta-supervisor.ts) should execute this tick:
 *
 *   - spawn   — project is `registered` and has no live child
 *   - probe   — project is `starting` or `running` (HTTP health check;
 *               a successful probe on a `starting` child promotes it to `running`)
 *   - restart — failing child crossed the restart-policy threshold
 *   - suspend — failing child exceeded max-restarts/window (retried after the
 *               failed-retry backoff; `meta reset` retries immediately)
 *   - stop-idle — healthy child that nothing has talked to for the idle
 *               timeout; stopped and parked as `stopped`/`idle` until a
 *               session asks for it again
 *
 * Keeping this pure makes the orchestrator trivially testable. Side effects
 * (process.fork, HTTP requests, signal handling) live entirely in
 * meta-supervisor.ts.
 */
import type Database from 'better-sqlite3'
import { listProjects, type ProjectRow } from './registry.js'
import { shouldRestart, type RestartDecisionInput } from './restart-policy.js'

export type TickAction =
  | { readonly kind: 'spawn'; readonly projectId: string; readonly projectRoot: string }
  | {
      readonly kind: 'probe'
      readonly projectId: string
      readonly boundPort: number
      readonly instanceId: string
    }
  | { readonly kind: 'restart'; readonly projectId: string; readonly reason: string }
  | { readonly kind: 'suspend'; readonly projectId: string; readonly reason: string }
  | {
      readonly kind: 'stop-idle'
      readonly projectId: string
      readonly reason: string
      /** How long the child had gone without a request, per the last probe. */
      readonly idleMs: number
    }

export interface TickPlan {
  readonly actions: ReadonlyArray<TickAction>
}

export interface TickPolicy {
  readonly minFailures: number
  readonly cooldownMs: number
  readonly maxRestartsPerWindow: number
  readonly windowMs: number
  /**
   * How long a suspended (`failed`) child waits before the supervisor tries to
   * spawn it again. See `planForProject`. Optional so existing policy literals
   * keep compiling; defaults to {@link DEFAULT_FAILED_RETRY_BACKOFF_MS}.
   */
  readonly failedRetryBackoffMs?: number
  /**
   * How long a healthy child may go without serving a single non-monitoring
   * request before the supervisor stops it. Optional so existing policy
   * literals keep compiling; defaults to {@link DEFAULT_IDLE_TIMEOUT_MS}.
   * Set to 0 to disable idle reaping entirely.
   */
  readonly idleTimeoutMs?: number
  /**
   * How long after a REFUSED reap before another is attempted for the same
   * project. Defaults to {@link DEFAULT_REAP_COOLDOWN_MS}.
   */
  readonly reapCooldownMs?: number
}

/**
 * Default backoff before a suspended child is retried.
 *
 * Long enough that a genuinely broken project cannot spawn-crash-loop (the
 * restart budget is 3 per 10 minutes, so this is a slower cadence than the
 * budget itself), short enough that a child suspended by a transient machine
 * stall is back within minutes rather than waiting for an operator.
 */
export const DEFAULT_FAILED_RETRY_BACKOFF_MS = 300_000

/**
 * Default idle timeout before a child broker is reaped — 4 hours.
 *
 * Measured motivation: 16 child brokers on one machine, 12 of them serving
 * directories with no live Copilot session, holding ~1.47 GB of private bytes
 * and ~500s of CPU each over 30 hours. Nothing ever stopped them, because
 * nothing could: once spawned, a child ran forever.
 *
 * 4h is deliberately far longer than any plausible pause inside a working
 * session (lunch, a long build, a meeting) so reaping cannot interrupt someone
 * mid-task, and far shorter than the overnight-to-multi-day window in which
 * the abandoned children actually accumulate. The cost of being wrong is
 * bounded in any case: the first request to the project wakes the broker
 * again (`wakeIdleProject`), it does not refuse the session.
 */
export const DEFAULT_IDLE_TIMEOUT_MS = 14_400_000

/**
 * How long to wait before retrying a reap that was REFUSED.
 *
 * A refusal means the stop could not be verified (see `stopChildVerified`),
 * which on this machine is caused by load — a SIGTERM that does not take, a
 * `taskkill` that times out. Retrying every 5s would spend seconds of serial
 * tick time per attempt and make the load that caused the refusal worse. The
 * child is healthy and merely unwanted, so there is no urgency: try again in
 * ten minutes.
 */
export const DEFAULT_REAP_COOLDOWN_MS = 600_000

/**
 * When a suspended child last had its state written — which, for a `failed`
 * row, is the moment `suspendChild` suspended it. Nothing probes or restarts a
 * `failed` project, so no later write can move this forward.
 *
 * Returns null when it cannot be read: a row with no `last_seen_at` was put
 * into `failed` by something other than the supervisor (an operator, a
 * migration), and the caller treats that as "retry now".
 */
function suspendedAtMs(proj: ProjectRow): number | null {
  if (proj.lastSeenAt === null) return null
  const parsed = Date.parse(proj.lastSeenAt)
  return Number.isNaN(parsed) ? null : parsed
}

export interface PlanTickInput {
  readonly nowMs: number
  readonly policy: TickPolicy
  readonly restartHistoryByProject: ReadonlyMap<string, ReadonlyArray<number>>
  readonly lastRestartByProject: ReadonlyMap<string, number>
  /**
   * Per project, how long the child had gone without serving a non-monitoring
   * request as of the supervisor's last SUCCESSFUL probe.
   *
   * A project absent from this map is a project whose idleness is UNKNOWN, and
   * unknown never reaps. That is the whole fail-safe: the supervisor can only
   * stop a child that affirmatively told it "nothing has asked me for anything
   * in N ms". A probe that failed, a child too old to report the field, a
   * project that has not been probed yet — all simply keep running.
   */
  readonly idleMsByProject?: ReadonlyMap<string, number>
  /**
   * When a reap was last attempted per project. Paces retries after a refused
   * stop — see {@link DEFAULT_REAP_COOLDOWN_MS}.
   */
  readonly lastReapAttemptByProject?: ReadonlyMap<string, number>
}

/**
 * How long this project has gone without demand, taking the EARLIEST evidence
 * of use from either source. Null when nothing is known.
 *
 * Two independent signals, because neither sees what the other does:
 *
 *  - `idleMsByProject` — the child's own last non-monitoring request. Precise,
 *    but blind to a session that has resolved and not yet spoken.
 *  - `last_resolved_at` — when `/api/meta/resolve` last handed this project's
 *    URL to a session. That resolve happens on the GLOBAL broker and never
 *    touches the child, so without it a session resolving at 3h59m would have
 *    its broker reaped out from under it seconds later, and its first write
 *    would be refused.
 *
 * Taking the minimum means ANY evidence of recent use protects the child.
 */
function effectiveIdleMs(proj: ProjectRow, input: PlanTickInput): number | null {
  const fromChild = input.idleMsByProject?.get(proj.projectId)
  // The child's own reading is REQUIRED. `last_resolved_at` may only SHORTEN
  // the idle age; it can never establish one. The absence of recent resolves
  // is not evidence that nobody is using the broker — a session that resolved
  // once and has been working hard ever since resolves no more.
  if (fromChild === undefined) return null
  const resolvedAt = proj.lastResolvedAt === null ? NaN : Date.parse(proj.lastResolvedAt)
  if (Number.isNaN(resolvedAt)) return fromChild
  return Math.min(fromChild, Math.max(0, input.nowMs - resolvedAt))
}

/** @returns the idle reap decision for a healthy, verified-running child. */
function planIdleReap(proj: ProjectRow, input: PlanTickInput): TickAction | null {
  // Only a child that is `running` AND clean. A child with health failures
  // belongs to the restart policy, which has already had its say above; racing
  // the reaper against a restart would make both decisions harder to reason
  // about for no benefit.
  if (proj.status !== 'running' || proj.healthFailures > 0) return null
  const timeoutMs = input.policy.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  if (timeoutMs <= 0) return null
  const idleMs = effectiveIdleMs(proj, input)
  if (idleMs === null || idleMs < timeoutMs) return null
  // A refused reap is paced, not abandoned. See DEFAULT_REAP_COOLDOWN_MS.
  const lastAttempt = input.lastReapAttemptByProject?.get(proj.projectId)
  const cooldownMs = input.policy.reapCooldownMs ?? DEFAULT_REAP_COOLDOWN_MS
  if (lastAttempt !== undefined && input.nowMs - lastAttempt < cooldownMs) return null
  return {
    kind: 'stop-idle',
    projectId: proj.projectId,
    idleMs,
    reason: `no non-monitoring request in ${Math.round(idleMs / 60_000)}m (idle timeout ${Math.round(timeoutMs / 60_000)}m)`,
  }
}

function planForProject(proj: ProjectRow, input: PlanTickInput): TickAction | null {
  switch (proj.status) {
    case 'registered':
      return { kind: 'spawn', projectId: proj.projectId, projectRoot: proj.projectRoot }

    case 'starting':
      // The child was spawned on a previous tick and has a bound port +
      // instance id, but nothing has probed it yet. Probe it so a successful
      // identity check promotes it to 'running'. Do NOT apply the restart/
      // suspend policy while starting — a child that is still booting (HTTP not
      // yet listening) fails early probes, and those must not trigger a restart.
      if (proj.boundPort !== null && proj.instanceId !== null) {
        return {
          kind: 'probe',
          projectId: proj.projectId,
          boundPort: proj.boundPort,
          instanceId: proj.instanceId,
        }
      }
      return null

    case 'running':
    case 'failing': {
      // First, the health-policy decision: if failing badly, decide restart/suspend.
      if (proj.healthFailures > 0) {
        const decision = shouldRestart(buildRestartInput(proj, input))
        if (decision.suspend) {
          return { kind: 'suspend', projectId: proj.projectId, reason: decision.reason }
        }
        if (decision.restart) {
          return { kind: 'restart', projectId: proj.projectId, reason: decision.reason }
        }
      }
      // Nothing is using this child — park it. Checked before the probe so a
      // reapable child is stopped this tick rather than probed first and
      // stopped on the next one.
      const idleReap = planIdleReap(proj, input)
      if (idleReap) return idleReap
      // Otherwise: probe health if we know where to probe.
      if (proj.boundPort !== null && proj.instanceId !== null) {
        return {
          kind: 'probe',
          projectId: proj.projectId,
          boundPort: proj.boundPort,
          instanceId: proj.instanceId,
        }
      }
      // Inconsistent state — the row says running/failing but there is nothing
      // to probe: the child exited (or was lost) before ever verifying. The
      // state itself is the failure evidence — a child that dies at boot never
      // records a probe failure (`claimChild` resets the counter on spawn), so
      // gate on the policy with the failure threshold treated as met. Routed as
      // a RESTART, not a plain spawn: the restart path charges the budget and
      // respects the cooldown, so a boot-crash loop suspends after
      // `maxRestartsPerWindow` instead of spawning a new process every tick
      // forever without ever costing a slot.
      const decision = shouldRestart({
        ...buildRestartInput(proj, input),
        consecutiveFailures: input.policy.minFailures,
      })
      if (decision.suspend) {
        return { kind: 'suspend', projectId: proj.projectId, reason: decision.reason }
      }
      if (decision.restart) {
        return {
          kind: 'restart',
          projectId: proj.projectId,
          reason: 'no bound port/instance to probe — child exited before verifying',
        }
      }
      return null
    }

    case 'failed': {
      // NOT terminal. `failed` is reached by exhausting the restart budget,
      // and that budget is spent by *machine* conditions as readily as by a
      // broken project — a stall that makes `taskkill` time out burns the same
      // slots as a crash loop. Latching forever meant a child that was never
      // actually unhealthy stayed dead until someone hand-edited the registry,
      // which is exactly the 2026-10-12 outage. Retry on a slow cadence
      // instead: a genuinely broken project just re-suspends, costing one
      // spawn per backoff; a transiently-stalled one heals itself.
      //
      // `stopped` below stays terminal — that one is deliberate operator
      // intent, not a health verdict.
      //
      // The backoff measures from the LATER of the suspension time and the last
      // in-memory attempt stamp. `last_seen_at` alone is not enough: a retry
      // whose spawn throws before any registry write (the anchored port is
      // still held by a zombie) leaves it frozen at the suspension, and the
      // planner would re-plan the spawn — port probe, throw, error log — every
      // tick instead of once per backoff.
      const suspendedAt = suspendedAtMs(proj)
      const lastAttempt = input.lastRestartByProject.get(proj.projectId) ?? null
      const since = Math.max(
        suspendedAt ?? Number.NEGATIVE_INFINITY,
        lastAttempt ?? Number.NEGATIVE_INFINITY,
      )
      const backoffMs = input.policy.failedRetryBackoffMs ?? DEFAULT_FAILED_RETRY_BACKOFF_MS
      if (Number.isFinite(since) && input.nowMs - since < backoffMs) return null
      return { kind: 'spawn', projectId: proj.projectId, projectRoot: proj.projectRoot }
    }

    case 'stopped':
      // Terminal — skip. True for BOTH kinds of stop, and deliberately so:
      //  - `stopped_reason = 'operator'` (or NULL) stays down until
      //    `meta-broker reset`.
      //  - `stopped_reason = 'idle'` stays down until DEMAND wakes it. The
      //    wake is `/api/meta/resolve` flipping the row to `registered`
      //    (`wakeIdleProject`), never a timer here — a reaped child that
      //    respawned on its own would make the whole feature pointless.
      return null
  }
}

function buildRestartInput(proj: ProjectRow, input: PlanTickInput): RestartDecisionInput {
  return {
    consecutiveFailures: proj.healthFailures,
    minFailures: input.policy.minFailures,
    cooldownMs: input.policy.cooldownMs,
    maxRestartsPerWindow: input.policy.maxRestartsPerWindow,
    windowMs: input.policy.windowMs,
    restartHistoryMs: input.restartHistoryByProject.get(proj.projectId) ?? [],
    lastRestartAtMs: input.lastRestartByProject.get(proj.projectId) ?? null,
    nowMs: input.nowMs,
  }
}

export function planTick(db: Database.Database, input: PlanTickInput): TickPlan {
  const projects = listProjects(db)
  const actions: TickAction[] = []
  for (const proj of projects) {
    const action = planForProject(proj, input)
    if (action) actions.push(action)
  }
  return { actions }
}
