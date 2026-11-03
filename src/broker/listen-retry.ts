/**
 * Port binding with EADDRINUSE retry logic.
 * Extracts the listen-with-retry concern from startup for testability.
 */

import type { Server } from 'node:http'
import { execFile } from 'node:child_process'
import { logger } from '../shared/logger.js'

const log = logger.child({ module: 'listen-retry' })

export interface ListenRetryOptions {
  readonly maxRetries?: number
  readonly baseDelayMs?: number
  readonly killStale?: boolean
}

const DEFAULTS: Required<ListenRetryOptions> = {
  maxRetries: 3,
  baseDelayMs: 2000,
  killStale: true,
}

/** Find the PID holding a port via lsof (macOS/Linux). Returns null if not found. */
export async function findPortHolder(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    execFile('lsof', ['-ti', `:${port}`], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err || !stdout.trim()) {
        resolve(null)
        return
      }
      const pid = parseInt(stdout.trim().split('\n')[0]!, 10)
      resolve(Number.isNaN(pid) ? null : pid)
    })
  })
}

/** Check if a PID is a SCNS broker process. */
async function isScnsBroker(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      'ps',
      ['-p', String(pid), '-o', 'args='],
      { timeout: 5000, windowsHide: true },
      (err, stdout) => {
        if (err || !stdout) {
          resolve(false)
          return
        }
        resolve(stdout.includes('scns') || stdout.includes('cli.js'))
      },
    )
  })
}

/** Attempt to kill a stale SCNS broker on the port. Returns true if killed. */
export async function killStaleProcess(port: number): Promise<boolean> {
  const pid = await findPortHolder(port)
  if (pid === null) return false

  // Only kill if it's our own broker
  const isOurs = await isScnsBroker(pid)
  if (!isOurs) {
    log.warn({ pid, port }, 'Port held by non-SCNS process — will not kill')
    return false
  }

  log.info({ pid, port }, 'Killing stale SCNS broker process')
  try {
    process.kill(pid, 'SIGTERM')
    // Wait a moment for the process to exit
    await new Promise((r) => setTimeout(r, 1000))
    return true
  } catch {
    return false
  }
}

/**
 * Listen on a port with exponential backoff retry on EADDRINUSE.
 * Returns the bound server, or throws after all retries exhausted.
 */
export async function listenWithRetry(
  listenFn: (port: number) => Server,
  port: number,
  options?: ListenRetryOptions,
): Promise<Server> {
  const { maxRetries, baseDelayMs, killStale } = { ...DEFAULTS, ...options }

  let lastError: Error | null = null

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const server = await new Promise<Server>((resolve, reject) => {
        const srv = listenFn(port)
        srv.on('error', (err: NodeJS.ErrnoException) => {
          // Close the failed server to free resources
          srv.close()
          reject(err)
        })
        srv.on('listening', () => resolve(srv))
      })
      return server
    } catch (err) {
      lastError = err as Error
      const errnoErr = err as NodeJS.ErrnoException

      // Only retry on EADDRINUSE
      if (errnoErr.code !== 'EADDRINUSE') {
        throw err
      }

      if (attempt === maxRetries) {
        break
      }

      const delay = baseDelayMs * Math.pow(2, attempt)
      log.warn(
        { port, attempt: attempt + 1, maxRetries, delayMs: delay },
        'EADDRINUSE — retrying after delay',
      )

      if (killStale) {
        await killStaleProcess(port)
      }

      await new Promise((r) => setTimeout(r, delay))
    }
  }

  throw lastError!
}

// ── launchd socket activation (Phase 1: zero-downtime restart) ───────────
//
// When the broker is started by launchd with a `Sockets` key, the launchd
// shim (native/scns-socket-launch) hands the already-bound listening socket to
// node as an inherited fd via the SCNS_LISTEN_FD env var. Listening on that fd
// (instead of binding the port ourselves) means launchd keeps the socket open
// across a `launchctl kickstart -k` process swap, so the kernel queues incoming
// connections during the restart → zero dropped connections.

/**
 * Parse a launchd-provided listen fd from an env value. Returns null when
 * absent/invalid so the caller falls back to port binding. fds 0/1/2 are stdio,
 * so a real inherited socket is always >= 3.
 */
export function parseListenFd(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null
  const fd = Number.parseInt(raw.trim(), 10)
  if (!Number.isInteger(fd) || fd < 3) return null
  return fd
}

/**
 * Listen on an already-bound (launchd-provided) socket fd. Unlike the port
 * path there is NO EADDRINUSE retry: launchd owns the socket, so binding cannot
 * race another process. Rejects if the server emits an error before listening.
 */
export function listenOnFd(
  listenFn: (handle: { fd: number }) => Server,
  fd: number,
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const srv = listenFn({ fd })
    srv.on('error', (err: NodeJS.ErrnoException) => {
      srv.close()
      reject(err)
    })
    srv.on('listening', () => resolve(srv))
  })
}
