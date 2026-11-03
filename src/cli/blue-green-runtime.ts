/**
 * Issue #61 (option C) — real deps for the cross-platform blue/green restart.
 *
 * `broker/services/blue-green.ts` holds the sequence and its decisions with no
 * effects at all. This module is everything that touches the world: HTTP to the
 * admin endpoints, the canary process, and the platform-native swap and
 * rollback. Splitting them this way is what makes "the canary is a gate" and
 * "a failed verify rolls back" testable without starting a broker.
 *
 * One behaviour here is a fix rather than a port. `scripts/broker-restart.sh`
 * isolated its canary with `SCNS_DATA_DIR`, which nothing under `src/` reads —
 * `shared/scns-home.ts` keys off `SCNS_HOME`. So the shell canary booted a full
 * broker against the LIVE `~/.scns` vault and experience corpus, with only its
 * SQLite file redirected by `BROKER_DB_PATH`. The canary here sets both, which
 * is the same rule the repo's probe-safety guidance states: `SCNS_HOME` alone
 * does not scope the broker DB, and `BROKER_DB_PATH` alone does not scope the
 * memory tree.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  runBlueGreenRestart,
  type BlueGreenDeps,
  type BlueGreenResult,
  type CanaryHandle,
} from '../broker/services/blue-green.js'
import {
  createPlatformRestarter,
  createPlatformRollback,
  selectRestartStrategy,
  buildBrokerSpawn,
  type CommandSpec,
  type PlatformRestarterDeps,
  type SpawnSpec,
} from '../broker/services/platform-restart.js'
import {
  brokerPidfilePath,
  isProcessAlive,
  readLiveBrokerPid,
} from '../broker/services/broker-pidfile.js'
import { ConfigurationError } from '../shared/errors.js'
import { buildStopCommand } from './watchdog-runtime.js'

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export function resolveCanaryPort(mainPort: number, override?: number): number {
  const port = override ?? mainPort + 1
  if (port === mainPort) {
    throw new ConfigurationError(
      `blue-green: the canary cannot use the same port as the broker it validates (${mainPort})`,
    )
  }
  return port
}

// ---------------------------------------------------------------------------
// Canary
// ---------------------------------------------------------------------------

export interface CanarySpawnInput {
  readonly execPath: string
  readonly brokerEntry: string
  readonly port: number
  /** Isolated `SCNS_HOME` — relocates the whole `~/.scns` tree. */
  readonly dataDir: string
  /** Isolated broker DB. `SCNS_HOME` does NOT cover this. */
  readonly dbPath: string
}

export function buildCanarySpawnSpec(input: CanarySpawnInput): SpawnSpec {
  return {
    command: input.execPath,
    args: [input.brokerEntry, 'start', '--port', String(input.port), '--autonomy', '0'],
    env: {
      SCNS_HOME: input.dataDir,
      BROKER_DB_PATH: input.dbPath,
      BROKER_PORT: String(input.port),
      SCNS_LOG_LEVEL: 'warn',
      // A validation broker must never take a port it finds occupied: the one
      // process most likely to hold it is the production broker this canary
      // exists to protect.
      BROKER_LISTEN_KILL_STALE: 'false',
      // Machine-wide observers would write real observations from a throwaway
      // process. The canary observes nothing.
      OBSERVE_ACTIVE_APP_ENABLED: 'false',
      OBSERVE_SESSION_STORE_ENABLED: 'false',
    },
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export function authHeaders(token: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token && token.trim() !== '') headers['Authorization'] = `Bearer ${token.trim()}`
  return headers
}

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>

export interface BlueGreenHttpOptions {
  readonly port: number
  readonly token?: string
  readonly fetchImpl?: FetchImpl
  readonly prepareTimeoutMs?: number
  readonly snapshotTimeoutMs?: number
  readonly probeTimeoutMs?: number
}

export interface BlueGreenHttp {
  prepare(): Promise<{ ok: boolean; detail: string }>
  drain(): Promise<void>
  readActiveRequests(): Promise<number | null>
  snapshotAgents(): Promise<{ ok: boolean; count: number }>
  probeReady(port: number): Promise<boolean>
}

const DEFAULT_PREPARE_TIMEOUT_MS = 120_000
const DEFAULT_SNAPSHOT_TIMEOUT_MS = 10_000
const DEFAULT_PROBE_TIMEOUT_MS = 5_000

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Names the failing sub-steps of a prepare result, so the log is diagnosable. */
function prepareDetail(body: Record<string, unknown>): string {
  const steps = body['steps']
  if (steps && typeof steps === 'object' && !Array.isArray(steps)) {
    const failed = Object.entries(steps as Record<string, unknown>)
      .filter(
        ([, v]) =>
          typeof v === 'object' && v !== null && (v as { success?: unknown }).success === false,
      )
      .map(([name]) => name)
    if (failed.length > 0) return failed.join(',')
  }
  if (typeof body['error'] === 'string') return body['error']
  return 'unknown'
}

export function createBlueGreenHttp(opts: BlueGreenHttpOptions): BlueGreenHttp {
  const fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init))
  const headers = authHeaders(opts.token)
  const base = `http://127.0.0.1:${opts.port}`

  const withTimeout = async <T>(
    ms: number,
    fn: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), ms)
    try {
      return await fn(controller.signal)
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    async prepare() {
      try {
        const res = await withTimeout(
          opts.prepareTimeoutMs ?? DEFAULT_PREPARE_TIMEOUT_MS,
          (signal) =>
            fetchImpl(`${base}/api/admin/prepare-restart`, { method: 'POST', headers, signal }),
        )
        const body = (await res.json()) as Record<string, unknown>
        return body['success'] === true
          ? { ok: true, detail: 'success=true' }
          : { ok: false, detail: prepareDetail(body) }
      } catch (err) {
        return { ok: false, detail: errText(err) }
      }
    },

    async drain() {
      await withTimeout(DEFAULT_SNAPSHOT_TIMEOUT_MS, (signal) =>
        fetchImpl(`${base}/api/admin/drain`, { method: 'POST', headers, signal }),
      )
    },

    async readActiveRequests() {
      try {
        const res = await withTimeout(DEFAULT_PROBE_TIMEOUT_MS, (signal) =>
          fetchImpl(`${base}/api/admin/health`, { headers, signal }),
        )
        if (!res.ok) return null
        const body = (await res.json()) as Record<string, unknown>
        const n = body['activeRequestCount']
        return typeof n === 'number' && Number.isFinite(n) ? n : null
      } catch {
        // null is "unknown", NOT "drained". The caller distinguishes them.
        return null
      }
    },

    async snapshotAgents() {
      try {
        const res = await withTimeout(
          opts.snapshotTimeoutMs ?? DEFAULT_SNAPSHOT_TIMEOUT_MS,
          (signal) =>
            fetchImpl(`${base}/api/admin/snapshot-agents`, { method: 'POST', headers, signal }),
        )
        if (!res.ok) return { ok: false, count: 0 }
        const body = (await res.json()) as Record<string, unknown>
        const count = typeof body['count'] === 'number' ? body['count'] : 0
        return { ok: true, count }
      } catch {
        return { ok: false, count: 0 }
      }
    },

    async probeReady(port: number) {
      try {
        const res = await withTimeout(opts.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS, (signal) =>
          fetchImpl(`http://127.0.0.1:${port}/health/ready`, { signal }),
        )
        return res.ok
      } catch {
        return false
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

export interface BlueGreenRuntimeOptions {
  readonly platform: NodeJS.Platform
  readonly port: number
  readonly canaryPort?: number
  readonly scnsHome: string
  readonly execPath?: string
  /** Entry script for the canary and, where there is no service manager, the relaunch. */
  readonly brokerEntry?: string
  /** darwin — the launchd job. */
  readonly brokerLabel?: string
  readonly uid?: number
  /** darwin — the plist a rollback bootstraps from. */
  readonly plistPath?: string
  /** linux — the systemd user unit. */
  readonly service?: string
  readonly autonomyLevel?: number
  readonly token?: string
  readonly skipCanary?: boolean
}

/** A spawned process, narrowed to what the canary handle needs. */
export interface SpawnedProcess {
  readonly pid: number | undefined
  kill(signal?: NodeJS.Signals | number): boolean
}

export interface BlueGreenSeams {
  readonly runCommand?: PlatformRestarterDeps['runCommand']
  readonly spawnBroker?: PlatformRestarterDeps['spawnBroker']
  readonly readLivePid?: PlatformRestarterDeps['readLivePid']
  readonly isAlive?: PlatformRestarterDeps['isAlive']
  readonly sleep?: PlatformRestarterDeps['sleep']
  readonly http?: BlueGreenHttp
  readonly fetchImpl?: FetchImpl
  /** Replace the whole canary step (tests that do not want a process at all). */
  readonly spawnCanary?: (port: number) => Promise<CanaryHandle | null>
  /** Replace only the process spawn, keeping the real temp-dir isolation. */
  readonly spawnProcess?: (spec: SpawnSpec) => SpawnedProcess
}

function defaultRunCommand(spec: CommandSpec, o: { timeoutMs: number }): void {
  const res = spawnSync(spec.command, [...spec.args], {
    stdio: 'ignore',
    timeout: o.timeoutMs,
    killSignal: 'SIGKILL',
    windowsHide: true,
  })
  if (res.error) throw res.error
}

function defaultSpawnProcess(spec: SpawnSpec, logPath: string): SpawnedProcess {
  let out: number | 'ignore' = 'ignore'
  try {
    out = openSync(logPath, 'a')
  } catch {
    /* the canary still runs; only its log is lost */
  }
  const child: ChildProcess = spawn(spec.command, [...spec.args], {
    env: { ...process.env, ...spec.env },
    stdio: ['ignore', out, out],
    windowsHide: true,
    detached: false,
  })
  return { pid: child.pid, kill: (signal) => child.kill(signal) }
}

function resolvePlatformDeps(
  opts: BlueGreenRuntimeOptions,
  seams: BlueGreenSeams,
): PlatformRestarterDeps {
  const strategy = selectRestartStrategy(opts.platform)
  const runCommand = seams.runCommand ?? defaultRunCommand
  const pidfilePath = brokerPidfilePath(opts.scnsHome, opts.port)

  const common = {
    platform: opts.platform,
    runCommand,
    spawnBroker:
      seams.spawnBroker ??
      ((spec: SpawnSpec) => {
        try {
          const child = spawn(spec.command, [...spec.args], {
            detached: true,
            stdio: 'ignore',
            env: { ...process.env, ...spec.env },
            windowsHide: true,
          })
          child.unref()
          return child.pid ?? null
        } catch {
          return null
        }
      }),
    readLivePid: seams.readLivePid ?? ((): number | null => readLiveBrokerPid(pidfilePath)),
    stopPid: (pid: number): void =>
      runCommand(buildStopCommand(opts.platform, pid), { timeoutMs: 15_000 }),
    isAlive: seams.isAlive ?? ((pid: number): boolean => isProcessAlive(pid)),
    sleep: seams.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))),
  }

  if (strategy === 'launchctl') {
    if (!opts.plistPath) {
      throw new ConfigurationError(
        'blue-green: a launchd rollback needs plistPath — `kickstart` cannot load a job ' +
          'that a failed restart left unloaded, which is exactly when a rollback runs',
      )
    }
    return {
      ...common,
      launchd: {
        uid: opts.uid ?? 0,
        label: opts.brokerLabel ?? 'com.scns.broker',
        plistPath: opts.plistPath,
      },
    }
  }

  if (strategy === 'systemctl') {
    return { ...common, systemd: { service: opts.service ?? 'scns' } }
  }

  if (!opts.brokerEntry) {
    throw new ConfigurationError(
      `blue-green: no broker entry script to relaunch on ${opts.platform}. ` +
        'Pass --broker-entry <path to dist/cli.js>.',
    )
  }
  return {
    ...common,
    spawnSpec: buildBrokerSpawn({
      execPath: opts.execPath ?? process.execPath,
      scriptPath: opts.brokerEntry,
      port: opts.port,
      ...(opts.autonomyLevel !== undefined ? { autonomyLevel: opts.autonomyLevel } : {}),
    }),
  }
}

export function createBlueGreenDeps(
  opts: BlueGreenRuntimeOptions,
  seams: BlueGreenSeams = {},
): BlueGreenDeps {
  const canaryPort = resolveCanaryPort(opts.port, opts.canaryPort)
  const platformDeps = resolvePlatformDeps(opts, seams)
  const http =
    seams.http ??
    createBlueGreenHttp({
      port: opts.port,
      ...(opts.token !== undefined ? { token: opts.token } : {}),
      ...(seams.fetchImpl ? { fetchImpl: seams.fetchImpl } : {}),
    })

  const startCanary =
    seams.spawnCanary ??
    (async (port: number): Promise<CanaryHandle | null> => {
      if (!opts.brokerEntry) {
        throw new ConfigurationError(
          'blue-green: the canary needs a broker entry script. Pass --broker-entry, or --skip-canary ' +
            'to restart without validating the binary first.',
        )
      }
      const dataDir = mkdtempSync(join(tmpdir(), 'scns-canary-'))
      const dbDir = mkdtempSync(join(tmpdir(), 'scns-canary-db-'))
      const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
      /**
       * Remove the isolated trees, with a bounded retry.
       *
       * On Windows the killed canary does not release its SQLite handles the
       * instant `kill` returns, so a single `rmSync` leaves the directory
       * behind — one leaked temp tree per restart, forever. Retrying briefly
       * clears it; giving up quietly after that is correct, because a leaked
       * temp dir must never fail a restart.
       */
      const cleanup = async (): Promise<void> => {
        for (let attempt = 0; attempt < 10; attempt++) {
          let remaining = false
          for (const dir of [dataDir, dbDir]) {
            try {
              rmSync(dir, { recursive: true, force: true })
            } catch {
              remaining = true
            }
          }
          if (!remaining) return
          await sleep(200)
        }
      }
      const logPath = join(dataDir, 'canary.log')
      const spec = buildCanarySpawnSpec({
        execPath: opts.execPath ?? process.execPath,
        brokerEntry: opts.brokerEntry,
        port,
        dataDir,
        dbPath: join(dbDir, 'canary.db'),
      })
      let child: SpawnedProcess
      try {
        child = seams.spawnProcess ? seams.spawnProcess(spec) : defaultSpawnProcess(spec, logPath)
      } catch {
        // Fail closed: a canary that cannot start is a canary that failed, and
        // the gate must abort the restart rather than skip validation.
        await cleanup()
        return null
      }
      return {
        pid: child.pid ?? null,
        readLog: (): string => {
          try {
            return readFileSync(logPath, 'utf-8').slice(-2000)
          } catch {
            return ''
          }
        },
        async stop(): Promise<void> {
          try {
            child.kill('SIGKILL')
          } catch {
            /* already gone */
          }
          await cleanup()
        },
      }
    })

  return {
    mainPort: opts.port,
    canaryPort,
    prepare: () => http.prepare(),
    startCanary,
    probeReady: (port) => http.probeReady(port),
    drain: () => http.drain(),
    readActiveRequests: () => http.readActiveRequests(),
    snapshotAgents: () => http.snapshotAgents(),
    restart: createPlatformRestarter(platformDeps),
    rollback: createPlatformRollback(platformDeps),
    sleep: platformDeps.sleep,
    ...(opts.skipCanary !== undefined ? { skipCanary: opts.skipCanary } : {}),
  }
}

/** Run the whole sequence with real deps. */
export async function runBlueGreen(
  opts: BlueGreenRuntimeOptions,
  seams: BlueGreenSeams = {},
  log?: (line: string) => void,
): Promise<BlueGreenResult> {
  const deps = createBlueGreenDeps(opts, seams)
  return runBlueGreenRestart({ ...deps, ...(log ? { log } : {}) })
}

export function formatBlueGreenReport(result: BlueGreenResult): string {
  const lines = result.phases.map(
    (p) => `  ${p.ok ? 'ok    ' : 'FAILED'} ${p.phase.padEnd(13)} ${p.detail} (${p.durationMs}ms)`,
  )
  lines.push(`  outcome: ${result.outcome} (exit ${result.exitCode})`)
  if (result.gapMs !== null) {
    lines.push(`  unbound-port window: ${result.gapMs}ms`)
  }
  return lines.join('\n')
}
