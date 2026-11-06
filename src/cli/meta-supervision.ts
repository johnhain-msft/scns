/**
 * Issue #61 — supervising the meta-broker.
 *
 * macOS runs three KeepAlive launchd jobs: the broker, the meta-broker, and the
 * watchdog. Windows has exactly one Startup entry, and it starts the watchdog —
 * so whatever the watchdog does not supervise has nothing above it. The
 * meta-broker was in that category, and its failure mode is quiet and total:
 * when it dies every per-project child dies with it, and every session in every
 * registered repo silently latches `global:fallback`, writing to the shared
 * brain instead of its own project.
 *
 * It cannot be supervised the way the broker is. `meta-broker run` has NO HTTP
 * listener — it uses `node:net` only to test whether a port is free, and probes
 * its CHILDREN's `/api/health`. So liveness comes from a pidfile, shaped as a
 * `ProbeResult` so `createExternalWatchdog`'s tested decision core (grace,
 * threshold, cooldown, kill-switch) applies unchanged. A live process reads as
 * "responsive"; anything else reads as "unresponsive", exactly like a refused
 * connection.
 *
 * Supervision is conditional on purpose. The meta-broker is opt-in — `scns
 * start` does not launch it — so turning it on for someone who never registered
 * a project would start a feature they did not ask for. The condition is the
 * honest signal that it is in use: a registry that exists and has projects in
 * it. `--supervise-meta` / `--no-supervise-meta` override that in either
 * direction.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import DatabaseCtor from 'better-sqlite3'
import type Database from 'better-sqlite3'

import {
  isProcessAlive,
  readLiveBrokerPid,
  runPidfilePath,
} from '../broker/services/broker-pidfile.js'
import { GLOBAL_BROKER_ID } from '../meta-broker/registry.js'
import type { ProbeResult } from '../broker/services/external-watchdog.js'
import {
  DEFAULT_STOP_GRACE_MS,
  DEFAULT_STOP_POLL_MS,
  type RestartOutcome,
  type SpawnSpec,
} from '../broker/services/platform-restart.js'
import { SUPERVISED_ENV } from '../broker/services/supervision.js'

/**
 * `<scnsHome>/.scns/run/meta-broker.pid`.
 *
 * Not per-port, unlike the broker's: the meta-broker binds nothing of its own,
 * and exactly one per `SCNS_HOME` is correct. A port suffix would imply a
 * second instance is meaningful, which it is not — two supervisors on one
 * registry would each spawn children for the same project.
 */
export function metaBrokerPidfilePath(scnsHome: string): string {
  return runPidfilePath(scnsHome, 'meta-broker')
}

// ---------------------------------------------------------------------------
// Should we supervise it at all?
// ---------------------------------------------------------------------------

export interface MetaSupervisionInput {
  /** Does the meta registry DB exist on disk? */
  readonly metaDbExists: boolean
  /** How many projects are registered; null when the registry cannot be read. */
  readonly registeredProjects: number | null
  /** `--supervise-meta` / `--no-supervise-meta`. */
  readonly override?: boolean
}

export interface MetaSupervisionDecision {
  readonly supervise: boolean
  readonly reason: string
}

export type MetaSupervisionMode = 'auto' | 'on' | 'off'

/**
 * Map the CLI mode to the tri-state `override`.
 *
 * Deliberately NOT a commander `--no-` boolean pair: defining `--no-x` after
 * `--x` makes commander default the option to `true`, which would turn the
 * auto-detect into "always on" without anyone noticing.
 */
export function resolveSuperviseMetaOverride(mode: string | undefined): boolean | undefined {
  const normalised = (mode ?? 'auto').trim().toLowerCase()
  if (normalised === 'on' || normalised === 'true' || normalised === 'yes') return true
  if (normalised === 'off' || normalised === 'false' || normalised === 'no') return false
  return undefined
}

export function decideMetaSupervision(input: MetaSupervisionInput): MetaSupervisionDecision {
  if (input.override !== undefined) {
    return { supervise: input.override, reason: 'operator override' }
  }
  if (!input.metaDbExists) {
    return { supervise: false, reason: 'no meta registry — the meta-broker was never set up' }
  }
  if (input.registeredProjects === null) {
    return {
      supervise: false,
      reason: 'meta registry unreadable — supervising the broker only',
    }
  }
  if (input.registeredProjects === 0) {
    return { supervise: false, reason: 'meta registry has no registered projects' }
  }
  return {
    supervise: true,
    reason: `${input.registeredProjects} registered project(s)`,
  }
}

/**
 * Count registered projects without letting a bad registry break the watchdog.
 *
 * Returns null for missing, unreadable or non-SQLite files. The watchdog's
 * first duty is the broker, and it must start even if the meta registry is
 * corrupt. Opened read-only: the watchdog observes the registry, it never
 * writes to it.
 */
export function countRegisteredProjects(metaDbPath: string): number | null {
  if (!existsSync(metaDbPath)) return null
  let db: Database.Database
  try {
    db = new DatabaseCtor(metaDbPath, { readonly: true, fileMustExist: true })
  } catch {
    return null
  }
  try {
    const table = db
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='projects'")
      .get() as { n: number } | undefined
    if (!table || table.n === 0) return 0
    // The reserved global row (#63) is target-graph configuration, not a
    // child — a registry holding only it has nothing to supervise.
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM projects WHERE project_id != ?')
      .get(GLOBAL_BROKER_ID) as { n: number }
    return count.n
  } catch {
    return null
  } finally {
    try {
      db.close()
    } catch {
      /* already closed */
    }
  }
}

// ---------------------------------------------------------------------------
// #63 — the registry's target graph, read the hardened way
// ---------------------------------------------------------------------------

/** One broker's declared repos, with the legacy alias already applied. */
export interface RegistryTargetRow {
  readonly projectId: string
  readonly projectRoot: string
  /** Where updates come from; fetch-only. Null for an ordinary project. */
  readonly upstreamRepo: string | null
  /** Effective write target: `write_target_repo`, else legacy `self_issue_repo`. */
  readonly writeTargetRepo: string | null
}

function nonBlank(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/**
 * Every registry row's target graph — the reserved `global` row included —
 * without letting a bad registry break the caller (`scns doctor`, the
 * singleton's self-issue startup). Same contract as `countRegisteredProjects`:
 * null for missing/unreadable/non-SQLite, read-only, never throws. Tolerates
 * a pre-#63 registry where the new columns do not exist yet.
 */
export function readRegistryTargets(metaDbPath: string): ReadonlyArray<RegistryTargetRow> | null {
  if (!existsSync(metaDbPath)) return null
  let db: Database.Database
  try {
    db = new DatabaseCtor(metaDbPath, { readonly: true, fileMustExist: true })
  } catch {
    return null
  }
  try {
    const table = db
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='projects'")
      .get() as { n: number } | undefined
    if (!table || table.n === 0) return []
    const rows = db
      .prepare('SELECT * FROM projects ORDER BY created_at ASC, project_id ASC')
      .all() as Array<Record<string, unknown>>
    return rows.map((r) => ({
      projectId: String(r['project_id']),
      projectRoot: typeof r['project_root'] === 'string' ? r['project_root'] : '',
      upstreamRepo: nonBlank(r['upstream_repo']),
      writeTargetRepo: nonBlank(r['write_target_repo']) ?? nonBlank(r['self_issue_repo']),
    }))
  } catch {
    return null
  } finally {
    try {
      db.close()
    } catch {
      /* already closed */
    }
  }
}

/**
 * `scns meta-broker list` prints each broker's `upstream -> write target`
 * alongside its JSON. One line per broker, global first. Honest placeholders:
 * a project is its own upstream, and an unset write target is what makes a
 * writer refuse (#58).
 */
export function formatTargetGraph(rows: ReadonlyArray<RegistryTargetRow>): string[] {
  const global = rows.find((r) => r.projectId === GLOBAL_BROKER_ID)
  const lines: string[] = []
  if (global === undefined) {
    lines.push('global: (not configured — no reserved registry row; env SCNS_SELF_ISSUE_REPO only)')
  } else {
    lines.push(
      `global: ${global.upstreamRepo ?? '(no upstream)'} -> ${
        global.writeTargetRepo ?? '(write target unset — unattended writers refuse)'
      }`,
    )
  }
  for (const row of rows) {
    if (row.projectId === GLOBAL_BROKER_ID) continue
    lines.push(
      `${row.projectId}: ${row.upstreamRepo ?? '(project is its own upstream)'} -> ${
        row.writeTargetRepo ?? '(write target unset — self-issue ingest off)'
      }`,
    )
  }
  return lines
}

// ---------------------------------------------------------------------------
// Liveness as a ProbeResult
// ---------------------------------------------------------------------------

/**
 * Shape pidfile liveness like an HTTP probe so `createExternalWatchdog` needs
 * no new branch: a numeric `status` is what `classifyProbe` calls "responsive".
 */
export function pidfileLivenessProbe(
  path: string,
  kill: (pid: number, signal: number | NodeJS.Signals) => void = process.kill,
  selfPid: number = process.pid,
): () => Promise<ProbeResult> {
  return async () => {
    const pid = readLiveBrokerPid(path, kill, selfPid)
    if (pid === null) {
      return { ok: false, error: `no live meta-broker recorded at ${path}` }
    }
    return { ok: true, status: 200 }
  }
}

// ---------------------------------------------------------------------------
// Restart
// ---------------------------------------------------------------------------

export interface MetaBrokerSpawnInput {
  readonly execPath: string
  readonly scriptPath: string
  readonly metaDb: string
  readonly projectDbDir: string
}

export function buildMetaBrokerSpawn(input: MetaBrokerSpawnInput): SpawnSpec {
  return {
    command: input.execPath,
    args: [
      input.scriptPath,
      'meta-broker',
      'run',
      '--meta-db',
      input.metaDb,
      '--broker-entry',
      input.scriptPath,
      '--project-db-dir',
      input.projectDbDir,
    ],
    env: { [SUPERVISED_ENV]: '1' },
  }
}

export interface MetaBrokerRestartOptions extends MetaBrokerSpawnInput {
  readonly scnsHome: string
}

export interface MetaBrokerRestartSeams {
  readonly readLivePid?: () => number | null
  readonly stopPid?: (pid: number) => void
  readonly isAlive?: (pid: number) => boolean
  readonly spawnProcess?: (spec: SpawnSpec) => number | null
  readonly sleep?: (ms: number) => Promise<void>
  readonly now?: () => number
  readonly stopGraceMs?: number
  readonly pollMs?: number
}

/**
 * Stop-then-spawn, with the same refusal rule as the broker's relaunch path:
 * never start a second meta-broker while the first is alive. Two supervisors
 * sharing one registry would each spawn a child for the same project and then
 * fight over its port — strictly worse than the outage being healed.
 */
export function createMetaBrokerRestart(
  opts: MetaBrokerRestartOptions,
  seams: MetaBrokerRestartSeams = {},
): () => Promise<RestartOutcome> {
  const pidfile = metaBrokerPidfilePath(opts.scnsHome)
  const spec = buildMetaBrokerSpawn(opts)
  const readLivePid = seams.readLivePid ?? ((): number | null => readLiveBrokerPid(pidfile))
  const stopPid = seams.stopPid ?? defaultStopPid
  const isAlive = seams.isAlive ?? ((pid: number): boolean => isProcessAlive(pid))
  const spawnProcess = seams.spawnProcess ?? defaultSpawnMetaBroker(opts.scnsHome)
  const sleep =
    seams.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)))
  const now = seams.now ?? ((): number => Date.now())
  const stopGraceMs = seams.stopGraceMs ?? DEFAULT_STOP_GRACE_MS
  const pollMs = seams.pollMs ?? DEFAULT_STOP_POLL_MS

  return async () => {
    const notes: string[] = []
    const livePid = readLivePid()
    let stoppedPid: number | null = null

    if (livePid !== null) {
      stoppedPid = livePid
      try {
        stopPid(livePid)
        notes.push(`stopped meta-broker pid ${livePid}`)
      } catch (err) {
        notes.push(
          `stop pid ${livePid} failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
      const deadline = now() + stopGraceMs
      while (isAlive(livePid) && now() < deadline) {
        await sleep(pollMs)
      }
      if (isAlive(livePid)) {
        return {
          strategy: 'relaunch',
          stoppedPid,
          spawnedPid: null,
          detail:
            `meta-broker pid ${livePid} still alive after ${stopGraceMs}ms — ` +
            `refusing to spawn a second supervisor over the same registry. ${notes.join('; ')}`,
        }
      }
    } else {
      notes.push('no live meta-broker pid recorded')
    }

    const spawnedPid = spawnProcess(spec)
    notes.push(
      spawnedPid === null ? 'meta-broker spawn failed' : `spawned meta-broker as pid ${spawnedPid}`,
    )
    return { strategy: 'relaunch', stoppedPid, spawnedPid, detail: notes.join('; ') }
  }
}

function defaultStopPid(pid: number): void {
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    /* already gone */
  }
}

function defaultSpawnMetaBroker(scnsHome: string): (spec: SpawnSpec) => number | null {
  return (spec) => {
    const logDir = join(scnsHome, '.scns', 'logs')
    let out: number | 'ignore' = 'ignore'
    try {
      mkdirSync(logDir, { recursive: true })
      out = openSync(join(logDir, 'meta-broker.log'), 'a')
    } catch {
      /* logging is best-effort */
    }
    try {
      const child = spawn(spec.command, [...spec.args], {
        detached: true,
        stdio: ['ignore', out, out],
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
