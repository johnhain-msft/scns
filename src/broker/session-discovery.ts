/**
 * Session Discovery Poller — finds running Copilot CLI processes and keeps
 * their broker sessions alive.
 *
 * This solves two problems:
 *   1. Sessions started before the SCNS extension was installed never register
 *   2. Sessions doing long tasks (5+ min) get zombie-reaped because no hooks fire
 *
 * On each tick:
 *   1. Lists processes (`ps` on POSIX, a Win32_Process query on Windows)
 *   2. Extracts session IDs from `--resume <uuid>` args
 *   3. On the global broker, creates unknown sessions (purpose: 'discovered').
 *      Project children only refresh sessions already registered in that project.
 *   4. Updates heartbeat for all discovered sessions (keeps them alive)
 *   5. Marks sessions as completed when their process disappears
 *
 * Note the scope limit on BOTH platforms: only a session launched with
 * `--resume <uuid>` carries its id in argv, so a freshly-started session is
 * never discoverable this way.
 */

import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import type Database from 'better-sqlite3'
import type { EventLog } from './services/event-log.js'
import {
  createSession,
  findSessionById,
  updateHeartbeat,
  updateSessionStatus,
  unarchiveSession,
} from './storage/repositories/session-repository.js'
import { logger } from '../shared/logger.js'
import { isPathInside } from './path-containment.js'

const execAsync = promisify(exec)

const UUID_REGEX = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
const DEFAULT_INTERVAL_MS = 15_000
const PS_TIMEOUT_MS = 5_000

// ── Types ────────────────────────────────────────────────────

export interface DiscoveredProcess {
  readonly pid: number
  readonly sessionId: string
}

export interface SessionDiscoveryOptions {
  readonly intervalMs?: number
  readonly psTimeoutMs?: number
  /** Override for testing — inject fake ps output */
  readonly psProvider?: () => Promise<string>
  /** Skip the initial tick on start (for testing) */
  readonly skipInitialTick?: boolean
  /** A child broker must not auto-register globally visible processes. */
  readonly projectRoot?: string
}

export interface SessionDiscovery {
  stop(): void
  /** Run a single discovery tick (for testing) */
  tick(): Promise<DiscoveryResult>
}

export interface DiscoveryResult {
  readonly discovered: number
  readonly refreshed: number
  readonly completed: number
  readonly processes: ReadonlyArray<DiscoveredProcess>
}

// ── Process discovery ────────────────────────────────────────

/**
 * Parse `ps` output and extract Copilot CLI session IDs.
 * Looks for processes matching `/copilot --resume <uuid>` or `/copilot --resume=<uuid>`.
 */
export function parseCopilotProcesses(psOutput: string): ReadonlyArray<DiscoveredProcess> {
  const results: DiscoveredProcess[] = []
  const seen = new Set<string>()

  for (const line of psOutput.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue

    // Match: copilot --resume <uuid> OR copilot --resume=<uuid>
    if (!trimmed.includes('copilot') || !trimmed.includes('--resume')) continue

    // Extract PID (first number on the line)
    const pidMatch = trimmed.match(/^\s*(\d+)\s/)
    if (!pidMatch?.[1]) continue
    const pid = parseInt(pidMatch[1], 10)

    // Extract session ID (UUID after --resume)
    const resumeMatch = trimmed.match(/--resume[= ]([0-9a-f-]{36})/i)
    if (!resumeMatch?.[1]) continue
    const sessionId = resumeMatch[1]

    if (!UUID_REGEX.test(sessionId)) continue
    if (seen.has(sessionId)) continue

    seen.add(sessionId)
    results.push({ pid, sessionId })
  }

  return results
}

/**
 * Build the command that lists candidate Copilot processes as `<pid> <args>`.
 *
 * `ps` does not exist on Windows, so the poller shelled out every 15s, failed,
 * and silently discovered nothing — see session-discovery-win32.test.ts for the
 * evidence. On win32 we query `Win32_Process` through PowerShell instead, which
 * is the only built-in way to read another process's full command line.
 *
 * The emitted win32 script deliberately contains NO double quotes: `exec` wraps
 * it in double quotes for cmd.exe, and an inner quote would terminate that
 * wrapper. Hence string concatenation and `-like` with single quotes.
 */
export function buildProcessListCommand(platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return 'ps -ww -eo pid,args'
  const script =
    'Get-CimInstance Win32_Process | ' +
    "Where-Object { $_.CommandLine -like '*copilot*' } | " +
    "ForEach-Object { ('' + $_.ProcessId + ' ' + $_.CommandLine) }"
  return `powershell -NoProfile -NonInteractive -Command "${script}"`
}

/**
 * Default process-list provider.
 *
 * `windowsHide` is mandatory. `exec` routes through `cmd.exe` on Windows, and
 * Windows 11 delegates console hosting to Windows Terminal by default, so
 * without it every tick opened a full terminal window on the user's desktop
 * (measured: one per 15s tick).
 */
async function defaultPsProvider(
  timeoutMs: number,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  try {
    const { stdout } = await execAsync(buildProcessListCommand(platform), {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    })
    return stdout
  } catch {
    return ''
  }
}

/**
 * Best-effort cwd lookup for a PID.
 *
 * `lsof` is macOS/Linux only and Windows exposes no comparable built-in, so on
 * win32 we skip the probe entirely rather than spawn a subprocess that can only
 * fail. Falls back to the broker's cwd.
 */
async function getCwdForPid(pid: number): Promise<string> {
  if (process.platform === 'win32') return process.cwd()
  try {
    const { stdout } = await execAsync(`lsof -p ${pid} -Fn 2>/dev/null | grep '^n/' | grep cwd`, {
      timeout: 2000,
      windowsHide: true,
    })
    const match = stdout.match(/^n(.+)$/m)
    if (match?.[1]) return match[1]
  } catch {
    // Fallback
  }
  return process.cwd()
}

// ── Discovery tick ───────────────────────────────────────────

const MISS_THRESHOLD = 3 // Require 3 consecutive misses before marking completed

async function discoveryTick(
  db: Database.Database,
  eventLog: EventLog,
  psProvider: () => Promise<string>,
  trackedSessions: Set<string>,
  missCounters: Map<string, number>,
  projectRoot: string | undefined,
): Promise<DiscoveryResult> {
  let psOutput: string
  try {
    psOutput = await psProvider()
  } catch (err) {
    logger.debug({ err }, 'Session discovery: ps failed, skipping tick')
    return { discovered: 0, refreshed: 0, completed: 0, processes: [] }
  }
  const processes = parseCopilotProcesses(psOutput)
  const currentIds = new Set(processes.map((p) => p.sessionId))

  let discovered = 0
  let refreshed = 0
  let completed = 0

  // Register new or update existing sessions
  for (const proc of processes) {
    const existing = findSessionById(db, proc.sessionId)

    // A --resume id does not establish project ownership, and on Windows
    // there is no process-cwd lookup. Registration belongs to guarded hooks.
    if (projectRoot && (!existing || !isPathInside(existing.working_dir ?? '', projectRoot))) {
      trackedSessions.delete(proc.sessionId)
      missCounters.delete(proc.sessionId)
      continue
    }

    if (!existing) {
      try {
        const workDir = await getCwdForPid(proc.pid)
        createSession(db, {
          id: proc.sessionId,
          purpose: 'discovered',
          working_dir: workDir,
          worktree: null,
        })
        eventLog.sessionRegistered(proc.sessionId, {
          source: 'discovery',
          pid: proc.pid,
        })
        discovered++
        trackedSessions.add(proc.sessionId)
        logger.info({ sessionId: proc.sessionId, pid: proc.pid }, 'Discovered new Copilot session')
      } catch (err) {
        // Session might have been created by a hook between our check and insert
        logger.debug({ err, sessionId: proc.sessionId }, 'Discovery: create failed (race ok)')
      }
    } else if (
      existing.status === 'zombie' ||
      existing.status === 'completed' ||
      existing.status === 'expired'
    ) {
      // Session was retired but the process is still running — resurrect it.
      // Issue #70: 'expired' is now the normal post-grace state, and a live
      // discovered process is proof of life; leaving it expired would strand
      // a running --resume session non-routable (and, with archived_at
      // cleared below, invisible to TTL GC forever).
      try {
        updateSessionStatus(db, proc.sessionId, 'active')
        updateHeartbeat(db, proc.sessionId)
        unarchiveSession(db, proc.sessionId)
        discovered++
        trackedSessions.add(proc.sessionId)
        logger.info(
          { sessionId: proc.sessionId, pid: proc.pid, oldStatus: existing.status },
          'Resurrected Copilot session',
        )
      } catch (err) {
        logger.debug({ err, sessionId: proc.sessionId }, 'Discovery: resurrect failed')
      }
    } else {
      // Session exists and is active — just refresh heartbeat
      try {
        updateHeartbeat(db, proc.sessionId)
        unarchiveSession(db, proc.sessionId)
        refreshed++
        trackedSessions.add(proc.sessionId)
      } catch (err) {
        logger.debug({ err, sessionId: proc.sessionId }, 'Discovery: heartbeat update failed')
      }
    }
  }

  // Mark sessions as completed only after multiple consecutive misses
  for (const sessionId of trackedSessions) {
    if (!currentIds.has(sessionId)) {
      const misses = (missCounters.get(sessionId) ?? 0) + 1
      missCounters.set(sessionId, misses)

      if (misses >= MISS_THRESHOLD) {
        const existing = findSessionById(db, sessionId)
        if (
          existing &&
          (!projectRoot || isPathInside(existing.working_dir ?? '', projectRoot)) &&
          existing.status !== 'completed' &&
          existing.status !== 'zombie'
        ) {
          try {
            updateSessionStatus(db, sessionId, 'completed')
            completed++
            logger.info({ sessionId, misses }, 'Copilot session process ended')
          } catch (err) {
            logger.debug({ err, sessionId }, 'Discovery: completion update failed')
          }
        }
        trackedSessions.delete(sessionId)
        missCounters.delete(sessionId)
      }
    } else {
      // Process is back — reset miss counter
      missCounters.delete(sessionId)
    }
  }

  return { discovered, refreshed, completed, processes }
}

// ── Public API ───────────────────────────────────────────────

export function startSessionDiscovery(
  db: Database.Database,
  eventLog: EventLog,
  options?: SessionDiscoveryOptions,
): SessionDiscovery {
  const intervalMs = options?.intervalMs ?? DEFAULT_INTERVAL_MS
  const psTimeoutMs = options?.psTimeoutMs ?? PS_TIMEOUT_MS
  const psProvider = options?.psProvider ?? (() => defaultPsProvider(psTimeoutMs))
  const projectRoot = options?.projectRoot ?? process.env['BROKER_PROJECT_ROOT']
  const trackedSessions = new Set<string>()
  const missCounters = new Map<string, number>()

  logger.info({ intervalMs }, 'Session discovery poller started')

  // Run immediately on start (unless testing)
  if (!options?.skipInitialTick) {
    discoveryTick(db, eventLog, psProvider, trackedSessions, missCounters, projectRoot).catch(
      (err) => {
        logger.warn({ err }, 'Initial session discovery tick failed')
      },
    )
  }

  const intervalId = setInterval(() => {
    discoveryTick(db, eventLog, psProvider, trackedSessions, missCounters, projectRoot).catch(
      (err) => {
        logger.warn({ err }, 'Session discovery tick failed')
      },
    )
  }, intervalMs)

  return {
    stop(): void {
      clearInterval(intervalId)
      logger.info('Session discovery poller stopped')
    },
    async tick(): Promise<DiscoveryResult> {
      return discoveryTick(db, eventLog, psProvider, trackedSessions, missCounters, projectRoot)
    },
  }
}
