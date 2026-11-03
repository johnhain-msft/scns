/**
 * Issue #61 — the self-heal trigger.
 *
 * Extracted verbatim from the body of `startBroker`, where the single most
 * dangerous line in the codebase — `process.exit(1)`, on the unwritten
 * assumption that launchd will relaunch us — had no test and no platform
 * check. On Windows that assumption is false, so the "heal" was a permanent
 * death: the observed 11h47m outage.
 *
 * The change in behaviour is the arming gate. `decideSelfHealArming` runs once
 * at construction; when there is no relaunch substrate the trigger never fires
 * and says so loudly at startup rather than at the moment of death. The health
 * watchdog keeps observing and logging either way — only the trigger is held.
 *
 * Everything downstream of arming (threshold, cooldown, escalation, kill-switch,
 * re-entrancy, drain-then-exit) is unchanged.
 */

import type Database from 'better-sqlite3'
import type { HealthCheck } from './health-watchdog.js'
import { decideSelfHeal, recordSelfHealRestart } from './self-heal.js'
import { decideSelfHealArming, type SelfHealArmingDecision } from './supervision.js'

export interface SelfHealTriggerLogger {
  info: (fields: Record<string, unknown>, msg: string) => void
  warn: (fields: Record<string, unknown>, msg: string) => void
  error: (fields: Record<string, unknown>, msg: string) => void
}

export interface SelfHealTriggerDeps {
  readonly db: Database.Database
  readonly platform: NodeJS.Platform
  readonly env: Readonly<Record<string, string | undefined>>
  /** Graceful shutdown of every subsystem. */
  readonly drain: () => Promise<void>
  /** Terminate the process so the supervisor can relaunch it. */
  readonly exit: (code: number) => void
  /** Stop the health watchdog so it cannot re-enter mid-drain. */
  readonly stopWatchdog: () => void
  readonly log: SelfHealTriggerLogger
  readonly minFailures?: number
  readonly cooldownMs?: number
}

export interface SelfHealTrigger {
  /** Whether self-heal may fire at all on this host. */
  readonly armed: boolean
  readonly arming: SelfHealArmingDecision
  /** Called by the health watchdog's `onUnhealthy`. */
  trigger(failures: number, checks: readonly HealthCheck[]): void
}

export function createSelfHealTrigger(deps: SelfHealTriggerDeps): SelfHealTrigger {
  const arming = decideSelfHealArming({ platform: deps.platform, env: deps.env })

  if (!arming.armed) {
    deps.log.warn(
      { reason: arming.reason, supervision: arming.supervision.kind },
      `Self-heal DISARMED: ${arming.detail}`,
    )
  } else if (arming.reason === 'env-forced') {
    deps.log.warn(
      { reason: arming.reason, supervision: arming.supervision.kind },
      `Self-heal armed by override: ${arming.detail}`,
    )
  }

  let selfHealInProgress = false

  const trigger = (failures: number, checks: readonly HealthCheck[]): void => {
    // Re-entrancy guard set synchronously before any await/db read so repeated
    // watchdog ticks during an in-flight drain cannot double-restart.
    if (selfHealInProgress) return
    if (!arming.armed) return

    let decision: ReturnType<typeof decideSelfHeal>
    try {
      decision = decideSelfHeal(deps.db, {
        consecutiveFailures: failures,
        ...(deps.minFailures !== undefined ? { minFailures: deps.minFailures } : {}),
        ...(deps.cooldownMs !== undefined ? { cooldownMs: deps.cooldownMs } : {}),
      })
    } catch (err) {
      // db is the unhealthy subsystem — don't restart blind.
      deps.log.error({ err }, 'Self-heal decision failed (db error) — skipping restart this tick')
      return
    }
    if (!decision.shouldRestart) {
      deps.log.warn(
        { reason: decision.reason, detail: decision.detail, failures },
        'Self-heal restart skipped',
      )
      return
    }

    selfHealInProgress = true
    const dominant =
      checks
        .filter((c) => !c.healthy)
        .map((c) => c.name)
        .join(',') || 'unknown'
    recordSelfHealRestart(deps.db, `self_heal:${dominant}`)
    deps.log.error(
      { failures, dominant, supervision: arming.supervision.kind },
      'Self-heal: draining broker and exiting(1) for supervisor relaunch',
    )
    try {
      deps.stopWatchdog()
    } catch {
      /* ignore */
    }
    deps
      .drain()
      .then(() => deps.exit(1))
      .catch((err: unknown) => {
        deps.log.error({ err }, 'Self-heal drain failed — forcing exit(1)')
        deps.exit(1)
      })
  }

  return { armed: arming.armed, arming, trigger }
}
