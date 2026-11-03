/**
 * Issue #61 (option C) — cross-platform blue/green broker restart.
 *
 * The restart sequence existed only as `scripts/broker-restart.sh`: bash, plus
 * `launchctl`, plus `python3` for JSON. That made the daily maintenance restart
 * — and `POST /api/admin/rollback`, which spawns the same script — macOS-only.
 * On Windows the rollback handler shelled out to `bash` and failed silently.
 *
 * This is that sequence as a decision core with injected effects. Every phase
 * except one is portable HTTP + process work; the exception is phase 5, the
 * actual swap, which is delegated to `createPlatformRestarter` so each platform
 * uses its native mechanism (`launchctl kickstart -k`, `systemctl --user
 * restart`, or userland stop-then-spawn).
 *
 * Two properties carry the safety, and both are pinned by tests:
 *
 *   1. **The canary is a gate, not a smoke test.** It runs on a throwaway port
 *      with an isolated data dir, and if it will not come up the restart aborts
 *      *before* blue is drained. Validating the binary after killing production
 *      would be theatre.
 *
 *   2. **Verification is authoritative, and failure rolls back.** Phase 1 and
 *      phase 4.5 failures are warnings — a broker that could not dream still
 *      deserves a restart. Phase 7 is the gate, and its three outcomes are kept
 *      distinct: served (0), rolled back and degraded (3), and nobody is
 *      serving (2). Collapsing the last two is how an outage gets slept through.
 *
 * On a platform with no socket-preserving restart the swap opens a short gap
 * where the port is unbound. That is a deliberate trade, not an oversight: the
 * alternative — spawning green while blue still holds the port — produces a
 * crash-looping second broker, which is strictly worse than a few seconds of
 * connection-refused. `gapMs` reports the real width of that window so the
 * trade is measured rather than assumed.
 */

import type { RestartOutcome } from './platform-restart.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BlueGreenPhase =
  | 'prepare'
  | 'canary-start'
  | 'canary-health'
  | 'drain'
  | 'snapshot'
  | 'restart'
  | 'verify'
  | 'rollback'

export type BlueGreenOutcome =
  /** Green is serving. */
  | 'success'
  /** The canary never came up; blue was never touched. */
  | 'canary-failed'
  /** Green failed verification and blue was restored — degraded but serving. */
  | 'rolled-back'
  /** Green failed verification and the rollback did not restore blue. */
  | 'failed'

/** Byte-compatible with `scripts/broker-restart.sh`, which cron still reads. */
export const EXIT_CODES: Readonly<Record<BlueGreenOutcome, 0 | 1 | 2 | 3>> = {
  success: 0,
  'canary-failed': 1,
  failed: 2,
  'rolled-back': 3,
}

export interface PhaseRecord {
  readonly phase: BlueGreenPhase
  readonly ok: boolean
  readonly detail: string
  readonly durationMs: number
}

export interface BlueGreenResult {
  readonly outcome: BlueGreenOutcome
  readonly exitCode: 0 | 1 | 2 | 3
  readonly phases: readonly PhaseRecord[]
  readonly restart: RestartOutcome | null
  /**
   * Milliseconds between the start of the swap and a verified-healthy broker —
   * the window during which the port may be unbound. Null when the swap was
   * never reached.
   */
  readonly gapMs: number | null
}

/** A throwaway broker started for validation only. */
export interface CanaryHandle {
  readonly pid: number | null
  stop(): Promise<void>
  /** Best-effort log text, so a failed canary is diagnosable from the result. */
  readLog?(): string
}

export interface BlueGreenConfig {
  /** Bound on both the canary health wait and the green verification wait. */
  readonly healthTimeoutMs: number
  /** Bound on waiting for in-flight requests to finish. */
  readonly drainTimeoutMs: number
  /** Poll interval for every wait loop. */
  readonly pollMs: number
}

export const DEFAULT_BLUE_GREEN_CONFIG: BlueGreenConfig = {
  healthTimeoutMs: 30_000,
  drainTimeoutMs: 30_000,
  pollMs: 1_000,
}

export interface BlueGreenDeps {
  readonly mainPort: number
  readonly canaryPort: number
  /** Phase 1 — dream + housekeeping on blue. Non-blocking. */
  readonly prepare: () => Promise<{ ok: boolean; detail: string }>
  /** Phase 2 — start an isolated canary. Null when it could not be spawned. */
  readonly startCanary: (port: number) => Promise<CanaryHandle | null>
  /** True iff `GET /health/ready` on that port answered 2xx. Must not throw. */
  readonly probeReady: (port: number) => Promise<boolean>
  /** Phase 4 — tell blue to reject new work. */
  readonly drain: () => Promise<void>
  /** In-flight request count on blue; null when it cannot be read. */
  readonly readActiveRequests: () => Promise<number | null>
  /** Phase 4.5 — capture agents for post-restart recovery. Non-blocking. */
  readonly snapshotAgents: () => Promise<{ ok: boolean; count: number }>
  /** Phase 5 — the platform-native swap. */
  readonly restart: () => Promise<RestartOutcome>
  /** Bring blue back after a failed verification. */
  readonly rollback: () => Promise<RestartOutcome>
  readonly sleep: (ms: number) => Promise<void>
  readonly now?: () => number
  readonly log?: (line: string) => void
  readonly config?: Partial<BlueGreenConfig>
  /**
   * Skip phases 2–3. For a rollback-only invocation, where the binary has
   * already been proven by the run that is now being undone.
   */
  readonly skipCanary?: boolean
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Did the restart actually put a broker back?
 *
 * For `launchctl` / `systemctl` the service manager owns the process and never
 * hands back a pid, so a returned command is the strongest signal available.
 * For `relaunch` we ARE the supervisor, so a null `spawnedPid` is unambiguous:
 * nothing was started — usually because the old process refused to die and the
 * restarter correctly declined to spawn a second broker onto a bound port.
 */
export function restartStartedSomething(outcome: RestartOutcome): boolean {
  if (outcome.strategy !== 'relaunch') return true
  return outcome.spawnedPid !== null
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export async function runBlueGreenRestart(deps: BlueGreenDeps): Promise<BlueGreenResult> {
  const cfg: BlueGreenConfig = { ...DEFAULT_BLUE_GREEN_CONFIG, ...(deps.config ?? {}) }
  const now = deps.now ?? ((): number => Date.now())
  const log = deps.log ?? ((): void => {})
  const phases: PhaseRecord[] = []

  const record = async <T>(
    phase: BlueGreenPhase,
    fn: () => Promise<{ ok: boolean; detail: string; value?: T }>,
    startedAt?: number,
  ): Promise<{ ok: boolean; detail: string; value?: T }> => {
    const start = startedAt ?? now()
    let outcome: { ok: boolean; detail: string; value?: T }
    try {
      outcome = await fn()
    } catch (err) {
      outcome = { ok: false, detail: errText(err) }
    }
    phases.push({
      phase,
      ok: outcome.ok,
      detail: outcome.detail,
      durationMs: now() - start,
    })
    log(`${phase}: ${outcome.ok ? 'ok' : 'FAILED'} — ${outcome.detail}`)
    return outcome
  }

  /**
   * Poll readiness until the deadline. Never throws.
   *
   * Returns the elapsed time as well as the verdict, because the caller records
   * the phase AFTER the wait finishes — without this the wait, which is the
   * only slow part, would be reported as 0ms.
   */
  const waitForReady = async (
    port: number,
    timeoutMs: number,
  ): Promise<{ ready: boolean; startedAt: number }> => {
    const startedAt = now()
    const deadline = startedAt + timeoutMs
    for (;;) {
      let ready = false
      try {
        ready = await deps.probeReady(port)
      } catch {
        ready = false
      }
      if (ready) return { ready: true, startedAt }
      if (now() >= deadline) return { ready: false, startedAt }
      await deps.sleep(cfg.pollMs)
    }
  }

  const finish = (
    outcome: BlueGreenOutcome,
    restart: RestartOutcome | null,
    gapMs: number | null,
  ): BlueGreenResult => ({
    outcome,
    exitCode: EXIT_CODES[outcome],
    phases,
    restart,
    gapMs,
  })

  // ── Phase 1: pre-restart preparation (non-blocking) ──────────────────────
  // Phase 7 is the authoritative gate. A broker that could not consolidate its
  // memory still deserves the restart that might fix it.
  await record('prepare', async () => deps.prepare())

  // ── Phases 2–3: canary on a throwaway port (the gate) ────────────────────
  if (!deps.skipCanary) {
    const started = await record<CanaryHandle>('canary-start', async () => {
      const handle = await deps.startCanary(deps.canaryPort)
      if (handle === null) {
        return { ok: false, detail: `could not start a canary on port ${deps.canaryPort}` }
      }
      return {
        ok: true,
        detail: `canary pid ${handle.pid ?? 'unknown'} on ${deps.canaryPort}`,
        value: handle,
      }
    })

    if (!started.ok) {
      return finish('canary-failed', null, null)
    }

    const healthWait = await waitForReady(deps.canaryPort, cfg.healthTimeoutMs)
    const healthy = healthWait.ready

    // Stop the canary the moment it has answered the question, in both
    // directions — it must not still hold a port (or a DB) while the real
    // restart runs, and a failed one must not be left behind.
    const canary = started.value ?? null
    let canaryLog = ''
    if (canary !== null) {
      if (!healthy && typeof canary.readLog === 'function') {
        try {
          canaryLog = canary.readLog() ?? ''
        } catch {
          canaryLog = ''
        }
      }
      try {
        await canary.stop()
      } catch (err) {
        log(`canary stop failed: ${errText(err)}`)
      }
    }

    await record(
      'canary-health',
      async () =>
        healthy
          ? { ok: true, detail: `canary healthy on ${deps.canaryPort}` }
          : {
              ok: false,
              detail:
                `canary did not become ready within ${cfg.healthTimeoutMs}ms` +
                (canaryLog ? ` — canary log: ${canaryLog}` : ''),
            },
      healthWait.startedAt,
    )

    if (!healthy) {
      // Blue is untouched and still serving. That is the whole reason the
      // canary runs first.
      return finish('canary-failed', null, null)
    }
  }

  // ── Phase 4: drain blue ──────────────────────────────────────────────────
  await record('drain', async () => {
    try {
      await deps.drain()
    } catch (err) {
      // A broker that will not accept a drain request is exactly the broker we
      // are about to restart. Note it and carry on.
      log(`drain request failed: ${errText(err)}`)
    }
    const deadline = now() + cfg.drainTimeoutMs
    let active: number | null = null
    for (;;) {
      try {
        active = await deps.readActiveRequests()
      } catch {
        active = null
      }
      // Unreadable is treated as drained: blocking for the full timeout on a
      // broker that cannot answer buys nothing and delays the restart.
      if (active === null || active <= 0) {
        return { ok: true, detail: active === null ? 'active count unreadable' : 'active=0' }
      }
      if (now() >= deadline) {
        return {
          ok: false,
          detail: `drain timed out after ${cfg.drainTimeoutMs}ms with ${active} active request(s) — proceeding`,
        }
      }
      await deps.sleep(cfg.pollMs)
    }
  })

  // ── Phase 4.5: snapshot agents (non-blocking) ────────────────────────────
  await record('snapshot', async () => {
    const res = await deps.snapshotAgents()
    return res.ok
      ? { ok: true, detail: `${res.count} agent(s) snapshotted` }
      : { ok: false, detail: 'agent snapshot failed — agents will not be recovered' }
  })

  // ── Phase 5: the swap ────────────────────────────────────────────────────
  const gapStart = now()
  let restartOutcome: RestartOutcome | null = null
  await record('restart', async () => {
    restartOutcome = await deps.restart()
    return restartStartedSomething(restartOutcome)
      ? { ok: true, detail: restartOutcome.detail }
      : { ok: false, detail: restartOutcome.detail }
  })

  // ── Phase 7: verify, and roll back on failure ────────────────────────────
  const verifyWait = await waitForReady(deps.mainPort, cfg.healthTimeoutMs)
  const verified = verifyWait.ready
  const gapMs = now() - gapStart
  await record(
    'verify',
    async () =>
      verified
        ? { ok: true, detail: `broker ready on ${deps.mainPort} after ${gapMs}ms` }
        : {
            ok: false,
            detail: `broker not ready on ${deps.mainPort} within ${cfg.healthTimeoutMs}ms`,
          },
    verifyWait.startedAt,
  )

  if (verified) {
    return finish('success', restartOutcome, gapMs)
  }

  const rolledBack = await record('rollback', async () => {
    await deps.rollback()
    const healthy = await waitForReady(deps.mainPort, cfg.healthTimeoutMs)
    return healthy.ready
      ? { ok: true, detail: 'blue restored and serving' }
      : { ok: false, detail: `blue did not return within ${cfg.healthTimeoutMs}ms` }
  })

  return finish(rolledBack.ok ? 'rolled-back' : 'failed', restartOutcome, gapMs)
}
