/**
 * Gap 3 — external health-watchdog.
 *
 * The in-process health-watchdog (`health-watchdog.ts`) runs on the
 * broker's own event loop, so a BLOCKED loop cannot run its own
 * `setInterval` to self-heal — a wedged broker stays dead until the
 * daily cron. This module is the core of a SEPARATE process (run via
 * `scns watchdog run`, installed as its own launchd job) that
 * HTTP-polls `/api/health` and restarts the broker after N consecutive
 * UNRESPONSIVE probes (event-loop hang), gated by a startup grace
 * period and a cooldown.
 *
 * "Unresponsive" (request timed out / connection refused — no HTTP
 * status came back) is deliberately distinct from "responsive but
 * unhealthy" (ANY HTTP status, including 503): a responsive broker's
 * event loop is alive, so the in-process self-heal can handle it. The
 * external watchdog exists only for the case the in-process one cannot
 * catch — the hung loop.
 */

import { logger } from '../../shared/logger.js'

export const DEFAULT_MAX_CONSECUTIVE_TIMEOUTS = 3
export const DEFAULT_WATCHDOG_COOLDOWN_MS = 5 * 60_000
export const DEFAULT_WATCHDOG_STARTUP_GRACE_MS = 60_000
export const DEFAULT_WATCHDOG_INTERVAL_MS = 15_000
export const DEFAULT_WATCHDOG_PROBE_TIMEOUT_MS = 5_000

export type ProbeOutcome = 'responsive' | 'unresponsive'

export interface ProbeResult {
  readonly ok: boolean
  /** HTTP status code if a response came back at all (incl. 5xx). */
  readonly status?: number
  /** True when the request exceeded the probe timeout. */
  readonly timedOut?: boolean
  /** Network/transport error string (e.g. ECONNREFUSED) when no response. */
  readonly error?: string
  /** Underlying fetch transport code; Error.message alone is usually "fetch failed". */
  readonly errorCode?: string
}

/**
 * A probe is "responsive" iff an HTTP status came back — the event loop
 * served the request, even if the status is unhealthy (503). No status
 * (timeout / connection error) means the loop did not respond:
 * "unresponsive".
 */
export function classifyProbe(r: ProbeResult): ProbeOutcome {
  return typeof r.status === 'number' ? 'responsive' : 'unresponsive'
}

export interface WatchdogConfig {
  readonly maxConsecutiveTimeouts: number
  readonly cooldownMs: number
  readonly startupGraceMs: number
}

export interface WatchdogDecisionState {
  readonly consecutiveTimeouts: number
  readonly now: number
  readonly startedAt: number
  readonly lastRestartAt: number | null
  readonly killSwitch: boolean
}

export interface WatchdogDecision {
  readonly action: 'none' | 'restart'
  readonly reason: string
}

/**
 * Pure decision core. Restart only when, in order: not kill-switched,
 * past the startup grace, at/above the consecutive-timeout threshold,
 * and outside the cooldown of the last restart.
 */
export function decideWatchdogAction(
  s: WatchdogDecisionState,
  cfg: WatchdogConfig,
): WatchdogDecision {
  if (s.killSwitch) return { action: 'none', reason: 'kill-switch' }
  if (s.now - s.startedAt < cfg.startupGraceMs) {
    return { action: 'none', reason: 'startup-grace' }
  }
  if (s.consecutiveTimeouts < cfg.maxConsecutiveTimeouts) {
    return { action: 'none', reason: 'below-threshold' }
  }
  if (s.lastRestartAt != null && s.now - s.lastRestartAt < cfg.cooldownMs) {
    return { action: 'none', reason: 'cooldown' }
  }
  return { action: 'restart', reason: `unresponsive x${s.consecutiveTimeouts}` }
}

export interface ExternalWatchdogDeps {
  /** Distinguish the HTTP broker from the pidfile-only meta-broker watcher. */
  readonly target?: string
  /** Perform one health probe (HTTP GET /api/health with a timeout). */
  readonly probe: () => Promise<ProbeResult>
  /** Restart the broker (e.g. `launchctl kickstart -k`). */
  readonly restart: () => void | Promise<void>
  /** Read the persisted last-restart timestamp (file-based — broker may be down). */
  readonly loadLastRestartAt: () => number | null
  /** Persist a restart timestamp for the cooldown. */
  readonly saveLastRestartAt: (t: number) => void
  /** Operator kill-switch (e.g. presence of a file / env). */
  readonly isKillSwitched: () => boolean
  readonly now?: () => number
  readonly startedAt?: number
  readonly config?: Partial<WatchdogConfig>
  readonly intervalMs?: number
}

export interface ExternalWatchdog {
  /** Run a single probe + decision cycle. Returns the decision taken. */
  tick(): Promise<WatchdogDecision>
  start(): void
  stop(): void
}

export function createExternalWatchdog(deps: ExternalWatchdogDeps): ExternalWatchdog {
  const cfg: WatchdogConfig = {
    maxConsecutiveTimeouts:
      deps.config?.maxConsecutiveTimeouts ?? DEFAULT_MAX_CONSECUTIVE_TIMEOUTS,
    cooldownMs: deps.config?.cooldownMs ?? DEFAULT_WATCHDOG_COOLDOWN_MS,
    startupGraceMs: deps.config?.startupGraceMs ?? DEFAULT_WATCHDOG_STARTUP_GRACE_MS,
  }
  const now = deps.now ?? (() => Date.now())
  const startedAt = deps.startedAt ?? now()
  const intervalMs = deps.intervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS
  const log = logger.child({ module: 'external-watchdog', target: deps.target ?? 'broker' })

  let consecutiveTimeouts = 0
  let timer: ReturnType<typeof setInterval> | null = null
  let ticking = false

  async function tick(): Promise<WatchdogDecision> {
    // Re-entrancy guard: never overlap probes (a slow restart or a hung
    // probe must not stack onto the next interval).
    if (ticking) return { action: 'none', reason: 'tick-in-flight' }
    ticking = true
    try {
      let probe: ProbeResult
      try {
        probe = await deps.probe()
      } catch (err) {
        probe = { ok: false, error: err instanceof Error ? err.message : String(err) }
        log.warn({ err }, 'probe threw — treating as unresponsive')
      }
      const outcome = classifyProbe(probe)

      if (outcome === 'responsive') {
        consecutiveTimeouts = 0
        return { action: 'none', reason: 'responsive' }
      }

      consecutiveTimeouts += 1
      const decision = decideWatchdogAction(
        {
          consecutiveTimeouts,
          now: now(),
          startedAt,
          lastRestartAt: deps.loadLastRestartAt(),
          killSwitch: deps.isKillSwitched(),
        },
        cfg,
      )

      if (decision.action === 'restart') {
        log.warn(
          { consecutiveTimeouts, reason: decision.reason, probe },
          'external-watchdog: broker unresponsive — restarting',
        )
        deps.saveLastRestartAt(now())
        consecutiveTimeouts = 0
        try {
          await deps.restart()
        } catch (err) {
          log.error({ err }, 'external-watchdog: restart failed')
        }
      } else {
        log.info(
          { consecutiveTimeouts, reason: decision.reason, probe },
          'external-watchdog: unresponsive probe (no restart)',
        )
      }
      return decision
    } finally {
      ticking = false
    }
  }

  return {
    tick,
    start() {
      if (timer) return
      // NOT unref'd: this runs as a standalone daemon (`scns watchdog
      // run`), so the interval is what keeps the process alive. Use
      // stop() (wired to SIGINT/SIGTERM) for clean teardown.
      timer = setInterval(() => {
        void tick()
      }, intervalMs)
    },
    stop() {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    },
  }
}

/**
 * Probe `${baseUrl}/api/health` with a hard timeout. Any HTTP response
 * (even 5xx) is "responsive"; an AbortError/timeout or network error is
 * "unresponsive". Never throws.
 */
export async function httpHealthProbe(
  baseUrl: string,
  timeoutMs: number = DEFAULT_WATCHDOG_PROBE_TIMEOUT_MS,
): Promise<ProbeResult> {
  const log = logger.child({ module: 'external-watchdog' })
  const url = `${baseUrl}/api/health`
  const startedAt = Date.now()
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)
  let result: ProbeResult
  try {
    const res = await fetch(url, { signal: controller.signal })
    result = { ok: res.ok, status: res.status }
    // Responsiveness is established by the headers; release the unused body.
    await res.body?.cancel().catch((err: unknown) => {
      log.debug({ err }, 'HTTP probe body cancellation failed')
    })
  } catch (err) {
    if (controller.signal.aborted) {
      result = { ok: false, timedOut: true }
    } else {
      const cause = err instanceof Error ? err.cause : undefined
      const errorCode =
        typeof cause === 'object' && cause !== null && 'code' in cause
          ? cause.code
          : undefined
      result = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        ...(typeof errorCode === 'string' ? { errorCode } : {}),
      }
    }
  } finally {
    clearTimeout(t)
  }
  log.info({ url, durationMs: Date.now() - startedAt, probe: result }, 'external-watchdog: HTTP probe')
  return result
}
