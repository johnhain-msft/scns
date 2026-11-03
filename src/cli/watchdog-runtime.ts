/**
 * Issue #61 — real deps for the external watchdog's restart action.
 *
 * `scns watchdog run` built its restart closure inline in `src/cli.ts`, which
 * is how it ended up hardcoded to `launchctl kickstart -k`. Pulling the
 * construction out here does two things: it lets the decision "what do we
 * actually run on this platform?" be tested, and it keeps the process-touching
 * parts (spawn, taskkill, log files) in one place with injectable seams.
 *
 * On Windows the watchdog IS the supervision root — there is no service
 * manager available to a non-admin account (Task Scheduler and `sc create`
 * both return access-denied on the affected host), so the watchdog owns the
 * stop-and-respawn itself.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'

import {
  brokerPidfilePath,
  readLiveBrokerPid,
  removeBrokerPidfile,
  writeBrokerPidfile,
  isProcessAlive,
} from '../broker/services/broker-pidfile.js'
import {
  buildBrokerSpawn,
  buildStopCommand,
  createPlatformRestarter,
  runRestartCommand,
  selectRestartStrategy,
  type PlatformRestarterDeps,
  type RestartOutcome,
  type RestartStrategy,
  type SpawnSpec,
} from '../broker/services/platform-restart.js'
export { buildStopCommand } from '../broker/services/platform-restart.js'
import { ConfigurationError } from '../shared/errors.js'
import { isPortInUse } from '../shared/ports.js'

export interface WatchdogRestartOptions {
  readonly platform: NodeJS.Platform
  readonly port: number
  readonly scnsHome: string
  /** darwin only — the launchd job to kickstart. */
  readonly brokerLabel?: string
  readonly uid?: number
  /** linux only — the systemd user unit to restart. */
  readonly service?: string
  /** relaunch only — interpreter and entry script for a fresh broker. */
  readonly execPath?: string
  readonly brokerEntry?: string
  readonly autonomyLevel?: number
}

export interface WatchdogRestartConfig {
  readonly strategy: RestartStrategy
  readonly pidfilePath: string
  readonly launchd?: { uid: number; label: string }
  readonly systemd?: { service: string }
  readonly spawnSpec?: SpawnSpec
}

export function resolveWatchdogRestartConfig(opts: WatchdogRestartOptions): WatchdogRestartConfig {
  const strategy = selectRestartStrategy(opts.platform)
  const pidfilePath = brokerPidfilePath(opts.scnsHome, opts.port)

  if (strategy === 'launchctl') {
    return {
      strategy,
      pidfilePath,
      launchd: { uid: opts.uid ?? 0, label: opts.brokerLabel ?? 'com.scns.broker' },
    }
  }
  if (strategy === 'systemctl') {
    return { strategy, pidfilePath, systemd: { service: opts.service ?? 'scns' } }
  }

  if (!opts.brokerEntry) {
    throw new ConfigurationError(
      `scns watchdog: no broker entry script to relaunch on ${opts.platform}. ` +
        'Pass --broker-entry <path to dist/cli.js> — a watchdog that cannot start ' +
        'the broker is worse than none, because it looks like supervision.',
    )
  }
  return {
    strategy,
    pidfilePath,
    spawnSpec: buildBrokerSpawn({
      execPath: opts.execPath ?? process.execPath,
      scriptPath: opts.brokerEntry,
      port: opts.port,
      ...(opts.autonomyLevel !== undefined ? { autonomyLevel: opts.autonomyLevel } : {}),
    }),
  }
}

/** Seams so the restart path can be exercised without touching real processes. */
export interface WatchdogRestartSeams {
  readonly runCommand?: PlatformRestarterDeps['runCommand']
  readonly spawnBroker?: PlatformRestarterDeps['spawnBroker']
  readonly readLivePid?: PlatformRestarterDeps['readLivePid']
  readonly isAlive?: PlatformRestarterDeps['isAlive']
  readonly isPortInUse?: PlatformRestarterDeps['isPortInUse']
  readonly sleep?: PlatformRestarterDeps['sleep']
}

/**
 * Spawn a detached broker whose stdio lands in the usual log files, so a
 * relaunch that immediately dies leaves evidence instead of a silent gap.
 * The child is unref'd: the watchdog supervises it, it does not own it, and a
 * watchdog restart must not take the broker down with it.
 */
function defaultSpawnBroker(scnsHome: string): (spec: SpawnSpec) => number | null {
  return (spec) => {
    const logDir = join(scnsHome, '.scns', 'logs')
    let out: number | 'ignore' = 'ignore'
    let err: number | 'ignore' = 'ignore'
    try {
      mkdirSync(logDir, { recursive: true })
      out = openSync(join(logDir, 'broker.log'), 'a')
      err = openSync(join(logDir, 'broker_error.log'), 'a')
    } catch {
      /* logging is best-effort; the relaunch still matters */
    }
    try {
      const child = spawn(spec.command, [...spec.args], {
        detached: true,
        stdio: ['ignore', out, err],
        env: { ...process.env, ...spec.env },
        windowsHide: true,
      })
      child.unref()
      return child.pid ?? null
    } catch {
      return null
    }
  }
}

/** Build the `restart` dep for `createExternalWatchdog`. */
export function createWatchdogRestart(
  opts: WatchdogRestartOptions,
  seams: WatchdogRestartSeams = {},
): () => Promise<RestartOutcome> {
  const cfg = resolveWatchdogRestartConfig(opts)
  const runCommand = seams.runCommand ?? runRestartCommand
  return createPlatformRestarter({
    platform: opts.platform,
    strategy: cfg.strategy,
    runCommand,
    spawnBroker: seams.spawnBroker ?? defaultSpawnBroker(opts.scnsHome),
    readLivePid: seams.readLivePid ?? (() => readLiveBrokerPid(cfg.pidfilePath)),
    stopPid: (pid) => runCommand(buildStopCommand(opts.platform, pid), { timeoutMs: 15_000 }),
    isAlive: seams.isAlive ?? ((pid) => isProcessAlive(pid)),
    isPortInUse: seams.isPortInUse ?? (() => isPortInUse(opts.port)),
    sleep: seams.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    ...(cfg.launchd ? { launchd: cfg.launchd } : {}),
    ...(cfg.systemd ? { systemd: cfg.systemd } : {}),
    ...(cfg.spawnSpec ? { spawnSpec: cfg.spawnSpec } : {}),
  })
}

/**
 * Best-effort location of the broker entry script for a relaunch: the script
 * that started this process, if it looks like the CLI. Returns null when it
 * cannot be established, so the caller fails with a useful message instead of
 * spawning something arbitrary.
 */
export function resolveBrokerEntry(argv: readonly string[] = process.argv): string | null {
  const candidate = argv[1]
  if (!candidate) return null
  if (!/cli\.(js|ts|mjs)$/.test(candidate)) return null
  return existsSync(candidate) ? candidate : null
}

export interface SingletonClaim {
  readonly acquired: boolean
  /** Pid of the live holder when the claim was refused. */
  readonly heldBy: number | null
  readonly path: string
  release(): void
}

/**
 * Claim single-instance ownership via a pidfile.
 *
 * The supervision root has to be a singleton: two watchdogs polling the same
 * broker would each decide to restart it, and the second restart would kill the
 * broker the first one just started. Session-start reconciliation spawns a
 * watchdog whenever the stack looks dead, so this guard is what makes that
 * spawn idempotent.
 *
 * Stale pidfiles self-clean (see `readLiveBrokerPid`), so a watchdog killed
 * with the window close button does not lock out its successor.
 */
export function claimSingleton(path: string, pid: number = process.pid): SingletonClaim {
  const holder = readLiveBrokerPid(path, process.kill, pid)
  if (holder !== null) {
    return { acquired: false, heldBy: holder, path, release: () => {} }
  }
  writeBrokerPidfile(path, {
    pid,
    port: 0,
    startedAt: Date.now(),
    execPath: process.execPath,
  })
  return {
    acquired: true,
    heldBy: null,
    path,
    release: () => removeBrokerPidfile(path),
  }
}

export interface EnsureBrokerUpResult {
  readonly started: boolean
  readonly reason: string
}

/**
 * Bring the broker up at watchdog start, without waiting out the startup grace.
 *
 * The grace exists to protect a broker that is still booting — it must not be
 * killed for being slow. That reasoning does not apply when no broker process
 * exists at all: waiting 60s plus three probe intervals to start something that
 * is definitively absent is 105 wasted seconds on every logon. So: start
 * immediately when the probe is unresponsive AND no broker pid is recorded;
 * otherwise defer to the normal watchdog loop, which has the grace.
 */
export async function ensureBrokerUp(
  opts: WatchdogRestartOptions,
  deps: {
    probe: () => Promise<{ status?: number }>
    restart: () => Promise<RestartOutcome>
    readLivePid?: () => number | null
  },
): Promise<EnsureBrokerUpResult> {
  const cfg = resolveWatchdogRestartConfig(opts)
  const result = await deps.probe()
  if (typeof result.status === 'number') {
    return { started: false, reason: 'broker-responsive' }
  }
  const readLivePid = deps.readLivePid ?? (() => readLiveBrokerPid(cfg.pidfilePath))
  const livePid = readLivePid()
  if (livePid !== null) {
    // A process exists but is not answering: it may be mid-boot. That is
    // precisely what the startup grace is for — hand it to the normal loop.
    return { started: false, reason: `broker-pid-${livePid}-present-deferring-to-grace` }
  }
  const outcome = await deps.restart()
  if (outcome.strategy === 'relaunch' && outcome.spawnedPid === null) {
    throw new Error(`Initial broker reconcile failed: ${outcome.detail}`)
  }
  return { started: true, reason: 'no-broker-running' }
}
