/**
 * P7 — Restart policy / suppression for misbehaving child brokers.
 *
 * Adopted from src/broker/services/self-heal.ts pattern. Pure function;
 * caller owns the side effects (actually restarting / suspending the child).
 *
 * Decision tree:
 *   1. consecutiveFailures < minFailures      → no restart (transient blip)
 *   2. now - lastRestartAt < cooldownMs       → no restart (still cooling down)
 *   3. recent restarts ≥ maxRestartsPerWindow → SUSPEND (crash loop — retried
 *                                                after the failed-retry backoff,
 *                                                or immediately via `meta reset`)
 *   4. otherwise                              → RESTART
 *
 * Window-based escalation means a child that misbehaved a long time ago
 * can still be restarted today — we don't banish forever.
 */

export interface RestartDecisionInput {
  /** Consecutive health probe failures since last success. */
  readonly consecutiveFailures: number
  /** Min failures before we even consider restarting. Default 3. */
  readonly minFailures: number
  /** Min ms between successive restarts of the SAME child. */
  readonly cooldownMs: number
  /** Cap on restarts within `windowMs`. Past that, suspend. */
  readonly maxRestartsPerWindow: number
  /** Sliding window length for `maxRestartsPerWindow`. */
  readonly windowMs: number
  /** Epoch-ms of every prior restart for this child. */
  readonly restartHistoryMs: ReadonlyArray<number>
  /** Epoch-ms of the most recent restart (or null if none yet). */
  readonly lastRestartAtMs: number | null
  readonly nowMs: number
}

export interface RestartDecision {
  readonly restart: boolean
  /** True when policy says give up and require manual intervention. */
  readonly suspend?: boolean
  readonly reason: string
}

export function shouldRestart(input: RestartDecisionInput): RestartDecision {
  if (input.consecutiveFailures < input.minFailures) {
    return {
      restart: false,
      reason: `failures ${input.consecutiveFailures} below threshold ${input.minFailures}`,
    }
  }

  const recentRestarts = input.restartHistoryMs.filter((t) => input.nowMs - t < input.windowMs)
  if (recentRestarts.length >= input.maxRestartsPerWindow) {
    return {
      restart: false,
      suspend: true,
      reason: `max ${input.maxRestartsPerWindow} restarts/window reached — suspended (auto-retried after backoff; \`meta reset\` retries now)`,
    }
  }

  if (input.lastRestartAtMs !== null && input.nowMs - input.lastRestartAtMs < input.cooldownMs) {
    return {
      restart: false,
      reason: `cooldown — ${Math.round((input.cooldownMs - (input.nowMs - input.lastRestartAtMs)) / 1000)}s remaining`,
    }
  }

  return { restart: true, reason: 'restart conditions met' }
}
