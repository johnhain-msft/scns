/**
 * Issue #61, option A — session-start reconciliation.
 *
 * The SCNS extension already resolves a broker at every Copilot session start.
 * That made it the obvious place to notice the stack is DEAD, because the
 * startup banner reports the *resolved route*, not a liveness probe: a session
 * with a dead broker looked healthy, silently fell back to `global:fallback`,
 * and had its memory writes refused.
 *
 * Reconciliation is the long-tail half of the fix. The external watchdog
 * (option B) covers a crash during a logged-in session; this covers the host
 * that has not seen a logon in days, because a Copilot session is the only
 * unprivileged, high-frequency trigger left.
 *
 * The decision is kept pure and lives here once. The generated extension is a
 * standalone `.mjs` that cannot import from `src/`, so the runtime copy is
 * EMITTED from this module by `reconcileRuntimeJs()` and cross-checked against
 * `decideReconcile` over the full input space in the unit test.
 */

/** How long a peer session's start-lock is trusted before it is treated as stale. */
export const DEFAULT_RECONCILE_LOCK_TTL_MS = 60_000
/** How long to wait for a started stack to answer /api/health before giving up. */
export const DEFAULT_RECONCILE_READY_TIMEOUT_MS = 20_000
/** Poll interval while waiting for readiness. */
export const DEFAULT_RECONCILE_POLL_MS = 500
/** Health probe timeout. Short: a session start must not stall on a wedged broker. */
export const DEFAULT_RECONCILE_PROBE_TIMEOUT_MS = 2_000

export type ReconcileAction = 'none' | 'start' | 'wait'

export interface ReconcileState {
  /** True when the global broker answered a health probe with any HTTP status. */
  readonly healthy: boolean
  /** Reconciliation enabled for this install (baked in, env-overridable). */
  readonly enabled: boolean
  /** SCNS_BROKER_URL is pinned — a supervisor owns this broker, hands off. */
  readonly teamMode: boolean
  /** A start command was baked in at install time. */
  readonly startCommandConfigured: boolean
  /** Age of a peer session's start-lock in ms, or null when no lock is held. */
  readonly lockAgeMs: number | null
}

export interface ReconcileDecision {
  readonly action: ReconcileAction
  readonly reason: string
}

/**
 * Decide what a starting session should do about the global broker.
 *
 * Order matters and is load-bearing:
 *   healthy      — a live broker is never touched, whatever else is true.
 *   disabled     — operator opt-out beats everything that could spawn.
 *   team mode    — SCNS_BROKER_URL means a supervisor already owns a broker.
 *   no command   — nothing to start; say so rather than failing obscurely.
 *   peer lock    — another session is mid-start; wait rather than race it.
 */
export function decideReconcile(
  state: ReconcileState,
  lockTtlMs: number = DEFAULT_RECONCILE_LOCK_TTL_MS,
): ReconcileDecision {
  if (state.healthy) return { action: 'none', reason: 'healthy' }
  if (!state.enabled) return { action: 'none', reason: 'disabled' }
  if (state.teamMode) return { action: 'none', reason: 'team-mode' }
  if (!state.startCommandConfigured) return { action: 'none', reason: 'no-start-command' }
  if (state.lockAgeMs !== null && state.lockAgeMs < lockTtlMs) {
    return { action: 'wait', reason: 'peer-starting' }
  }
  return { action: 'start', reason: 'broker-down' }
}

/**
 * The same decision as standalone JavaScript, for embedding in the generated
 * extension. A unit test evaluates this and compares it with `decideReconcile`
 * across every combination of inputs, so a change to one that is not mirrored
 * in the other fails immediately.
 */
export function reconcileRuntimeJs(): string {
  return `function decideReconcile(state, lockTtlMs) {
  if (lockTtlMs === undefined) lockTtlMs = ${DEFAULT_RECONCILE_LOCK_TTL_MS};
  if (state.healthy) return { action: "none", reason: "healthy" };
  if (!state.enabled) return { action: "none", reason: "disabled" };
  if (state.teamMode) return { action: "none", reason: "team-mode" };
  if (!state.startCommandConfigured) return { action: "none", reason: "no-start-command" };
  if (state.lockAgeMs !== null && state.lockAgeMs < lockTtlMs) {
    return { action: "wait", reason: "peer-starting" };
  }
  return { action: "start", reason: "broker-down" };
}`
}
