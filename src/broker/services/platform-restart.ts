/**
 * Issue #61 — platform-aware broker restart.
 *
 * `external-watchdog.ts` was already a pure decision core with an injected
 * `restart` dep, but the single injection point in `src/cli.ts` hardcoded
 * `launchctl kickstart -k`. That made the one portable piece of the healing
 * machinery macOS-only in practice: on Windows the watchdog could correctly
 * decide "the broker is dead" and then run a command that does not exist.
 *
 * This module is that dep, per platform:
 *   darwin  → `launchctl kickstart -k gui/<uid>/<label>`   (byte-identical to before)
 *   linux   → `systemctl --user restart <service>`
 *   *       → relaunch: stop the recorded pid, wait for it to go, spawn a new broker
 *
 * The relaunch path is the interesting one, because it is a supervisor written
 * in userland. Two rules keep it from making things worse:
 *
 *   1. Stop before spawn, and only spawn once the old process is actually gone.
 *      Spawning onto a still-bound port produces a crash-looping second broker,
 *      which is a worse failure than the one being healed.
 *   2. Fail loudly at WIRING time, not at 3am. A relaunch strategy with no spawn
 *      spec throws when the restarter is constructed — while an operator is
 *      watching — rather than the first time the broker dies.
 *
 * The spawned child carries `SCNS_SUPERVISED=1`, which is what lets it arm
 * self-heal (see supervision.ts). The supervisor asserts the relaunch contract;
 * the broker never assumes it.
 */

import { ConfigurationError } from '../../shared/errors.js'
import { SUPERVISED_ENV } from './supervision.js'
import { spawnSync } from 'node:child_process'

export type RestartStrategy = 'launchctl' | 'systemctl' | 'relaunch'

export interface CommandSpec {
  readonly command: string
  readonly args: readonly string[]
}

export interface SpawnSpec extends CommandSpec {
  readonly env: Readonly<Record<string, string>>
}

export function buildStopCommand(platform: NodeJS.Platform, pid: number): CommandSpec {
  if (!Number.isInteger(pid) || pid <= 0) throw new ConfigurationError('A positive PID is required')
  return platform === 'win32'
    ? { command: 'taskkill', args: ['/PID', String(pid), '/T', '/F'] }
    : { command: 'kill', args: ['-9', String(pid)] }
}

export function runRestartCommand(spec: CommandSpec, opts: { timeoutMs: number }): void {
  const result = spawnSync(spec.command, [...spec.args], {
    stdio: ['ignore', 'ignore', 'pipe'],
    encoding: 'utf8',
    timeout: opts.timeoutMs,
    killSignal: 'SIGKILL',
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `${spec.command} failed (${result.status ?? result.signal}): ${result.stderr?.trim() ?? ''}`,
    )
  }
}

/** Default grace for a stopped broker to disappear before we refuse to spawn. */
export const DEFAULT_STOP_GRACE_MS = 10_000
/** Liveness poll interval while waiting out the stop grace. */
export const DEFAULT_STOP_POLL_MS = 250
/** Hard bound on a service-manager command so a wedged one cannot hang the watchdog. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000

export function selectRestartStrategy(platform: NodeJS.Platform): RestartStrategy {
  if (platform === 'darwin') return 'launchctl'
  if (platform === 'linux') return 'systemctl'
  return 'relaunch'
}

export function buildLaunchctlRestart(o: { uid: number; label: string }): CommandSpec {
  return { command: 'launchctl', args: ['kickstart', '-k', `gui/${o.uid}/${o.label}`] }
}

/**
 * `launchctl bootout gui/<uid> <plistPath>` — unload the job.
 *
 * Addresses the DOMAIN plus a plist path rather than `gui/<uid>/<label>`,
 * matching `scripts/broker-restart.sh`, so the same path works whether or not
 * the label is currently loaded.
 */
export function buildLaunchctlBootout(o: { uid: number; plistPath: string }): CommandSpec {
  return { command: 'launchctl', args: ['bootout', `gui/${o.uid}`, o.plistPath] }
}

/** `launchctl bootstrap gui/<uid> <plistPath>` — load the job from its plist. */
export function buildLaunchctlBootstrap(o: { uid: number; plistPath: string }): CommandSpec {
  return { command: 'launchctl', args: ['bootstrap', `gui/${o.uid}`, o.plistPath] }
}

export function buildSystemctlRestart(o: { service: string }): CommandSpec {
  return { command: 'systemctl', args: ['--user', 'restart', o.service] }
}

export function buildBrokerSpawn(o: {
  execPath: string
  scriptPath: string
  port: number
  autonomyLevel?: number
  env?: Readonly<Record<string, string>>
}): SpawnSpec {
  const args = [o.scriptPath, 'start', '--port', String(o.port)]
  if (o.autonomyLevel !== undefined) args.push('--autonomy', String(o.autonomyLevel))
  return {
    command: o.execPath,
    args,
    env: { ...(o.env ?? {}), [SUPERVISED_ENV]: '1' },
  }
}

export interface RestartOutcome {
  readonly strategy: RestartStrategy
  /** Pid we stopped, when the relaunch path found a live broker. */
  readonly stoppedPid: number | null
  /** Pid of the process we started, when the relaunch path spawned one. */
  readonly spawnedPid: number | null
  readonly detail: string
}

export interface PlatformRestarterDeps {
  readonly platform: NodeJS.Platform
  /** Override the platform mapping (tests, and operators with an odd setup). */
  readonly strategy?: RestartStrategy
  /** Run a service-manager command synchronously, bounded by `timeoutMs`. */
  readonly runCommand: (spec: CommandSpec, opts: { timeoutMs: number }) => void
  /** Spawn a detached broker. Returns its pid, or null when the spawn failed. */
  readonly spawnBroker: (spec: SpawnSpec) => number | null
  /** Pid of a broker known to be running, or null. */
  readonly readLivePid: () => number | null
  /** Forcefully stop a pid. May throw (access denied, already gone). */
  readonly stopPid: (pid: number) => void
  readonly isAlive: (pid: number) => boolean
  /** Optional listener guard when a missing pidfile cannot establish absence. */
  readonly isPortInUse?: () => Promise<boolean>
  readonly sleep: (ms: number) => Promise<void>
  /** Clock, injectable so the stop-grace deadline can be tested without wall time. */
  readonly now?: () => number
  readonly launchd?: { uid: number; label: string; plistPath?: string }
  readonly systemd?: { service: string }
  readonly spawnSpec?: SpawnSpec
  readonly stopGraceMs?: number
  readonly pollMs?: number
  readonly commandTimeoutMs?: number
}

/**
 * Build the restart dep for `createExternalWatchdog`. Validates its own
 * configuration eagerly so a misconfigured watchdog cannot start and then
 * discover, during an outage, that it has nothing to run.
 */
export function createPlatformRestarter(
  deps: PlatformRestarterDeps,
): () => Promise<RestartOutcome> {
  const strategy = deps.strategy ?? selectRestartStrategy(deps.platform)
  const commandTimeoutMs = deps.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS

  if (strategy === 'launchctl' && !deps.launchd) {
    throw new ConfigurationError(
      'platform-restart: the launchctl strategy needs a launchd { uid, label }',
    )
  }
  if (strategy === 'systemctl' && !deps.systemd) {
    throw new ConfigurationError(
      'platform-restart: the systemctl strategy needs a systemd { service }',
    )
  }
  if (strategy === 'relaunch' && !deps.spawnSpec) {
    throw new ConfigurationError(
      'platform-restart: the relaunch strategy needs a spawnSpec — refusing to install a ' +
        'watchdog that cannot restart anything',
    )
  }

  if (strategy === 'launchctl') {
    const spec = buildLaunchctlRestart(deps.launchd!)
    return async () => {
      deps.runCommand(spec, { timeoutMs: commandTimeoutMs })
      return {
        strategy,
        stoppedPid: null,
        spawnedPid: null,
        detail: `${spec.command} ${spec.args.join(' ')}`,
      }
    }
  }

  if (strategy === 'systemctl') {
    const spec = buildSystemctlRestart(deps.systemd!)
    return async () => {
      deps.runCommand(spec, { timeoutMs: commandTimeoutMs })
      return {
        strategy,
        stoppedPid: null,
        spawnedPid: null,
        detail: `${spec.command} ${spec.args.join(' ')}`,
      }
    }
  }

  const spawnSpec = deps.spawnSpec!
  const stopGraceMs = deps.stopGraceMs ?? DEFAULT_STOP_GRACE_MS
  const pollMs = deps.pollMs ?? DEFAULT_STOP_POLL_MS
  const now = deps.now ?? (() => Date.now())

  return async () => {
    const notes: string[] = []
    const livePid = deps.readLivePid()
    let stoppedPid: number | null = null

    if (livePid !== null) {
      stoppedPid = livePid
      try {
        deps.stopPid(livePid)
        notes.push(`stopped pid ${livePid}`)
      } catch (err) {
        // Access denied / already reaped. Not fatal on its own: the liveness
        // wait below decides whether a spawn is safe. But it must be visible —
        // a silently-failed kill is how you get two brokers.
        notes.push(
          `stop pid ${livePid} failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }

      const deadline = now() + stopGraceMs
      while (deps.isAlive(livePid) && now() < deadline) {
        await deps.sleep(pollMs)
      }
      if (deps.isAlive(livePid)) {
        return {
          strategy,
          stoppedPid,
          spawnedPid: null,
          detail:
            `pid ${livePid} still alive after ${stopGraceMs}ms — did not exit; ` +
            `refusing to spawn a second broker onto the same port. ${notes.join('; ')}`,
        }
      }
    } else {
      notes.push('no live broker pid recorded')
    }

    if (deps.isPortInUse && (await deps.isPortInUse())) {
      return {
        strategy,
        stoppedPid,
        spawnedPid: null,
        detail: `broker port still occupied; refusing to spawn a second broker. ${notes.join('; ')}`,
      }
    }

    const spawnedPid = deps.spawnBroker(spawnSpec)
    notes.push(
      spawnedPid === null
        ? `spawn of ${spawnSpec.command} failed`
        : `spawned ${spawnSpec.command} as pid ${spawnedPid}`,
    )
    return { strategy, stoppedPid, spawnedPid, detail: notes.join('; ') }
  }
}

/**
 * Bring the PREVIOUS broker back after a failed green — the rollback half of
 * blue/green (#61 option C).
 *
 * On darwin this is deliberately not `kickstart -k`: that command fails when
 * the job is not loaded, and "not loaded" is precisely the state a failed
 * restart tends to leave behind. `broker-restart.sh rollback` boots the job out
 * and bootstraps it from its plist, with one retry, and so does this.
 *
 * Elsewhere a rollback and a restart are the same act — start the broker again
 * — so those paths share the restarter's logic, including its refusal to spawn
 * onto a still-bound port.
 */
export function createPlatformRollback(deps: PlatformRestarterDeps): () => Promise<RestartOutcome> {
  const strategy = deps.strategy ?? selectRestartStrategy(deps.platform)
  const commandTimeoutMs = deps.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS

  if (strategy !== 'launchctl') {
    return createPlatformRestarter(deps)
  }

  const plistPath = deps.launchd?.plistPath
  if (!plistPath) {
    throw new ConfigurationError(
      'platform-restart: the launchctl rollback needs launchd.plistPath — ' +
        '`kickstart` cannot load a job that a failed restart left unloaded',
    )
  }
  const uid = deps.launchd!.uid
  const bootout = buildLaunchctlBootout({ uid, plistPath })
  const bootstrap = buildLaunchctlBootstrap({ uid, plistPath })

  return async () => {
    const notes: string[] = []
    try {
      deps.runCommand(bootout, { timeoutMs: commandTimeoutMs })
      notes.push('booted out')
    } catch (err) {
      // Expected whenever the job is already unloaded. Idempotent by design.
      notes.push(`bootout skipped: ${err instanceof Error ? err.message : String(err)}`)
    }

    try {
      deps.runCommand(bootstrap, { timeoutMs: commandTimeoutMs })
      notes.push('bootstrap ok')
    } catch (first) {
      notes.push(`bootstrap failed: ${first instanceof Error ? first.message : String(first)}`)
      await deps.sleep(deps.pollMs ?? DEFAULT_STOP_POLL_MS)
      // One retry, then let it throw: a rollback that cannot load the job is an
      // exit-2 situation and must not be reported as a recovery.
      deps.runCommand(bootstrap, { timeoutMs: commandTimeoutMs })
      notes.push('bootstrap ok on retry')
    }

    return {
      strategy,
      stoppedPid: null,
      spawnedPid: null,
      detail: notes.join('; '),
    }
  }
}
