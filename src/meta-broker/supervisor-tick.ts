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
      // Terminal until operator re-registers — skip.
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
