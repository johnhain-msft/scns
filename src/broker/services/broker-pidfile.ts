/**
 * Issue #61 — broker pidfile.
 *
 * launchd owns the broker process on macOS, so the supervisor never needed to
 * ask "which pid is the broker?". The external watchdog does: to restart a
 * *hung* broker on a platform with no service manager it must stop the old
 * process before spawning a new one, and Node has no portable way to map a
 * listening port back to a pid.
 *
 * So the broker records itself. The file is best-effort bookkeeping, never a
 * lock: every failure path degrades to "no pid known", which the restarter
 * treats as "nothing to stop".
 *
 * Caveat, deliberately not papered over: a pid can be recycled by the OS after
 * an abrupt death. `startedAt` and `execPath` are recorded so a caller can add
 * corroboration, and `readLiveBrokerPid` refuses to hand back the caller's own
 * pid, but this is a developer-tool heuristic and not a guarantee.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, type PathLike } from 'node:fs'
import { dirname, join } from 'node:path'

export interface BrokerPidRecord {
  readonly pid: number
  readonly port: number
  /** Epoch ms — lets a caller reject a pid that predates the record. */
  readonly startedAt: number
  /** Interpreter that ran the broker, for corroboration and diagnostics. */
  readonly execPath: string
}

/** `<scnsHome>/.scns/run/<name>.pid` — one place for every runtime pidfile. */
export function runPidfilePath(scnsHome: string, name: string): string {
  return join(scnsHome, '.scns', 'run', `${name}.pid`)
}

/** `<scnsHome>/.scns/run/broker-<port>.pid` — per-port so child brokers never collide. */
export function brokerPidfilePath(scnsHome: string, port: number): string {
  return runPidfilePath(scnsHome, `broker-${port}`)
}

/**
 * `<scnsHome>/.scns/run/watchdog-<port>.pid`.
 *
 * The supervision root must be a singleton: two watchdogs polling the same
 * broker would both decide to restart it, and the second restart would land on
 * a broker the first one just started. Per-port because a watchdog supervises
 * exactly one broker.
 */
export function watchdogPidfilePath(scnsHome: string, port: number): string {
  return runPidfilePath(scnsHome, `watchdog-${port}`)
}

/** Write the record, creating parents. Never throws — bookkeeping must not break startup. */
export function writeBrokerPidfile(path: string, record: BrokerPidRecord): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(record), 'utf-8')
  } catch {
    /* best-effort: a restarter simply won't find a pid to stop */
  }
}

/** Read the record. Returns null for missing, unreadable, malformed or pid-less content. */
export function readBrokerPidfile(path: string): BrokerPidRecord | null {
  let raw: string
  try {
    if (!existsSync(path)) return null
    raw = readFileSync(path, 'utf-8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const r = parsed as Partial<BrokerPidRecord>
  if (typeof r.pid !== 'number' || !Number.isInteger(r.pid) || r.pid <= 0) return null
  return {
    pid: r.pid,
    port: typeof r.port === 'number' ? r.port : 0,
    startedAt: typeof r.startedAt === 'number' ? r.startedAt : 0,
    execPath: typeof r.execPath === 'string' ? r.execPath : '',
  }
}

/** Delete the pidfile. Idempotent and non-throwing. */
export function removeBrokerPidfile(path: string): void {
  try {
    rmSync(path as PathLike, { force: true })
  } catch {
    /* ignore */
  }
}

export type KillProbe = (pid: number, signal: number | NodeJS.Signals) => void

/**
 * Liveness probe via signal 0. EPERM means the process EXISTS but belongs to
 * another user — treating that as "dead" would let a restarter spawn a second
 * broker onto a still-bound port.
 */
export function isProcessAlive(pid: number, kill: KillProbe = process.kill): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * The pid of a broker that is actually running, or null.
 *
 * Self-cleaning: a pidfile whose process is gone is removed, so a crashed
 * broker leaves no trap for the next restart. Refuses to return `selfPid` —
 * the watchdog must never be handed its own pid to kill.
 */
export function readLiveBrokerPid(
  path: string,
  kill: KillProbe = process.kill,
  selfPid: number = process.pid,
): number | null {
  const record = readBrokerPidfile(path)
  if (record === null) return null
  if (record.pid === selfPid) return null
  if (!isProcessAlive(record.pid, kill)) {
    removeBrokerPidfile(path)
    return null
  }
  return record.pid
}
