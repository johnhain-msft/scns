/**
 * Self-heal — decides when the broker should restart itself in response to
 * sustained critical health-watchdog failures, then lets launchd's
 * `KeepAlive=true` relaunch a fresh process.
 *
 * The health watchdog detects (RSS bloat, db stalls, event-loop lag) but never
 * remediated — memory bloated all day until the 6 AM cron restart. This module
 * is the remediation half: the watchdog's `onUnhealthy` callback calls
 * `decideSelfHeal`, and on a `restart` verdict the broker drains gracefully and
 * `process.exit(1)`s.
 *
 * Crash-loop safety is layered:
 *   1. consecutive-failure threshold (`minFailures`) — only restart after the
 *      watchdog has been critically unhealthy for several ticks in a row.
 *   2. persisted cooldown (`broker:self_heal_last_restart_at`) — survives the
 *      restart, so a freshly-relaunched-but-still-bloated process cannot
 *      immediately restart again.
 *   3. bounded escalation (`broker:self_heal_restart_history`) — after
 *      `maxRestarts` restarts inside `escalationWindowMs`, the kill-switch is
 *      tripped and self-heal disables itself for manual intervention.
 *   4. kill-switch (`broker:self_heal_disabled` shared_state flag, plus the
 *      `SCNS_BROKER_SELF_HEAL=0` env override checked at the wiring site).
 *
 * All shared_state reads are wrapped defensively: if the db is the unhealthy
 * subsystem and reads throw, `decideSelfHeal` returns a non-restart verdict
 * rather than restarting blind (anti-loop policy).
 */

import type Database from 'better-sqlite3'
import { logger } from '../../shared/logger.js'

const log = logger.child({ module: 'self-heal' })

export const SELF_HEAL_DISABLED_KEY = 'broker:self_heal_disabled'
export const SELF_HEAL_LAST_RESTART_KEY = 'broker:self_heal_last_restart_at'
export const SELF_HEAL_RESTART_HISTORY_KEY = 'broker:self_heal_restart_history'
export const SELF_HEAL_EXIT_REASON_KEY = 'broker:last_exit_reason'

/** Consecutive watchdog failures required before a self-heal restart. */
export const DEFAULT_SELF_HEAL_MIN_FAILURES = 5
/** Minimum wall-clock gap between two self-heal restarts (persisted). */
export const DEFAULT_SELF_HEAL_COOLDOWN_MS = 10 * 60_000
/** Max self-heal restarts allowed inside the escalation window. */
export const DEFAULT_SELF_HEAL_MAX_RESTARTS = 3
/** Window over which restarts are counted for escalation. */
export const DEFAULT_SELF_HEAL_ESCALATION_WINDOW_MS = 60 * 60_000

export type SelfHealReason =
  | 'disabled'
  | 'below-threshold'
  | 'cooldown'
  | 'escalation-tripped'
  | 'restart'

export interface SelfHealDecisionInput {
  readonly consecutiveFailures: number
  readonly minFailures?: number
  readonly cooldownMs?: number
  readonly maxRestarts?: number
  readonly escalationWindowMs?: number
  readonly now?: number
}

export interface SelfHealDecision {
  readonly shouldRestart: boolean
  readonly reason: SelfHealReason
  readonly detail?: string
}

function readState(db: Database.Database, key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM shared_state WHERE key = ?')
    .get(key) as { value: string } | undefined
  return row?.value
}

function writeState(db: Database.Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO shared_state (key, value, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  ).run(key, value)
}

/** Whether the persisted self-heal kill-switch is set. Defaults to false on db error. */
export function isSelfHealDisabled(db: Database.Database): boolean {
  try {
    return readState(db, SELF_HEAL_DISABLED_KEY) === '1'
  } catch {
    return false
  }
}

/** Set or clear the persisted self-heal kill-switch. */
export function setSelfHealDisabled(db: Database.Database, disabled: boolean): void {
  if (disabled) {
    writeState(db, SELF_HEAL_DISABLED_KEY, '1')
  } else {
    db.prepare('DELETE FROM shared_state WHERE key = ?').run(SELF_HEAL_DISABLED_KEY)
  }
}

/** Recent restart timestamps inside the escalation window (best-effort, defaults to []). */
function readRestartHistory(db: Database.Database, now: number, windowMs: number): number[] {
  try {
    const raw = readState(db, SELF_HEAL_RESTART_HISTORY_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (n): n is number => typeof n === 'number' && Number.isFinite(n) && now - n < windowMs,
    )
  } catch {
    return []
  }
}

/**
 * Decide whether the broker should self-heal (restart) given the current
 * consecutive-failure count. Pure decisioning over shared_state — no process
 * side effects except tripping the kill-switch on escalation. Returns a
 * non-restart verdict on any db read error (anti-loop policy).
 */
export function decideSelfHeal(
  db: Database.Database,
  input: SelfHealDecisionInput,
): SelfHealDecision {
  const now = input.now ?? Date.now()
  const minFailures = input.minFailures ?? DEFAULT_SELF_HEAL_MIN_FAILURES
  const cooldownMs = input.cooldownMs ?? DEFAULT_SELF_HEAL_COOLDOWN_MS
  const maxRestarts = input.maxRestarts ?? DEFAULT_SELF_HEAL_MAX_RESTARTS
  const windowMs = input.escalationWindowMs ?? DEFAULT_SELF_HEAL_ESCALATION_WINDOW_MS

  if (isSelfHealDisabled(db)) {
    return { shouldRestart: false, reason: 'disabled' }
  }

  if (input.consecutiveFailures < minFailures) {
    return {
      shouldRestart: false,
      reason: 'below-threshold',
      detail: `${input.consecutiveFailures} < ${minFailures}`,
    }
  }

  // Persisted cooldown — survives the restart, so a relaunched-but-still-bloated
  // process cannot restart again until the cooldown has elapsed.
  let lastRestart: number | null
  try {
    const raw = readState(db, SELF_HEAL_LAST_RESTART_KEY)
    lastRestart = raw !== undefined ? Number(raw) : null
  } catch {
    // Can't read cooldown state — don't restart blind.
    return { shouldRestart: false, reason: 'cooldown', detail: 'cooldown state unreadable' }
  }
  if (lastRestart !== null && Number.isFinite(lastRestart) && now - lastRestart < cooldownMs) {
    return {
      shouldRestart: false,
      reason: 'cooldown',
      detail: `${now - lastRestart}ms since last restart < ${cooldownMs}ms`,
    }
  }

  // Bounded escalation — too many restarts inside the window means restarting
  // isn't fixing the problem. Trip the kill-switch and require manual help.
  const history = readRestartHistory(db, now, windowMs)
  if (history.length >= maxRestarts) {
    try {
      setSelfHealDisabled(db, true)
    } catch {
      /* best effort — escalation log still fires */
    }
    log.error(
      { restarts: history.length, maxRestarts, windowMs },
      'Self-heal escalation: too many restarts in window — disabling self-heal (set broker:self_heal_disabled). Manual intervention required.',
    )
    return {
      shouldRestart: false,
      reason: 'escalation-tripped',
      detail: `${history.length} restarts within ${windowMs}ms`,
    }
  }

  return { shouldRestart: true, reason: 'restart' }
}

/**
 * Persist self-heal restart bookkeeping immediately before draining: the
 * cooldown timestamp, the escalation history, and the exit reason (so the
 * relaunched process can make recovery conservative). Best-effort — a db
 * failure here is logged but does not abort the restart.
 */
export function recordSelfHealRestart(
  db: Database.Database,
  exitReason = 'self_heal',
  now: number = Date.now(),
  windowMs: number = DEFAULT_SELF_HEAL_ESCALATION_WINDOW_MS,
): void {
  try {
    writeState(db, SELF_HEAL_LAST_RESTART_KEY, String(now))
    const history = readRestartHistory(db, now, windowMs)
    history.push(now)
    writeState(db, SELF_HEAL_RESTART_HISTORY_KEY, JSON.stringify(history))
    writeState(db, SELF_HEAL_EXIT_REASON_KEY, exitReason)
  } catch (err) {
    log.warn({ err }, 'Failed to persist self-heal restart bookkeeping (continuing with restart)')
  }
}

/**
 * Read and clear the last exit reason. Used on startup so recovery can avoid
 * rehydrating the agents that may have caused a memory-pressure self-heal.
 * One-shot: the key is deleted on read.
 */
export function consumeLastExitReason(db: Database.Database): string | null {
  try {
    const raw = readState(db, SELF_HEAL_EXIT_REASON_KEY)
    db.prepare('DELETE FROM shared_state WHERE key = ?').run(SELF_HEAL_EXIT_REASON_KEY)
    return raw ?? null
  } catch {
    return null
  }
}
