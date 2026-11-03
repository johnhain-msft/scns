/**
 * Child-broker demand signal — "when did a human-driven request last arrive?"
 *
 * The meta-supervisor reaps a child broker that nobody is using (see
 * `meta-broker/supervisor-tick.ts`). Choosing the signal for "nobody is using
 * this" is the whole safety argument for that feature, so it is worth being
 * explicit about why it is THIS and not something cheaper.
 *
 * ── Why not session counts ──
 *
 * The obvious candidate is `broker/project-registry.ts` `listProjects`, which
 * counts `sessions WHERE archived_at IS NULL`. It is unusable: a session row
 * that was never archived — a Copilot CLI killed with the window, a crash, a
 * machine reboot — pins its project as "busy" forever. The signal would be
 * falsifiable by a stale DB row, in the direction that never reaps, which is
 * precisely the bug being fixed.
 *
 * ── The signal ──
 *
 * Last arrival time of a non-monitoring HTTP request, held IN MEMORY in the
 * child process itself. It cannot be falsified by any DB row, because it is not
 * derived from the database at all; it moves only when a real request reaches
 * this process's event loop. It is reported to the supervisor through
 * `/api/health`, which the supervisor already polls for identity verification.
 *
 * Two consequences worth stating:
 *
 *  - It resets to process start on every spawn, so a freshly woken child gets a
 *    full idle window before it can be reaped again. Wake/reap cannot thrash.
 *  - The supervisor learns it only from a SUCCESSFUL probe. A child that cannot
 *    be reached reports nothing, and unknown idleness never reaps.
 *
 * ── Monitoring traffic must not count ──
 *
 * The supervisor probes every child every 5 seconds, and the watchdog polls
 * too. If that counted as demand, every child would look permanently busy and
 * the reaper would never fire once. Monitoring requests are therefore excluded
 * both by path and by the `x-scns-meta-probe` header the supervisor sends —
 * belt and braces, because getting this wrong silently disables the feature.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express'

/**
 * Header the meta-supervisor's identity probe sets (see
 * `meta-broker/meta-supervisor.ts` `defaultChildProbe`). Its presence marks a
 * request as supervision traffic no matter which path it hits.
 */
export const META_PROBE_HEADER = 'x-scns-meta-probe'

/**
 * Paths that are monitoring, not work. Matched as exact path or path prefix
 * (`/health` also covers `/health/live` and `/health/ready`).
 *
 *  - `/health*`          — liveness/readiness, hit by the watchdog
 *  - `/api/health`       — the supervisor's identity probe and the external
 *                          watchdog's poll
 *  - `/api/admin/health` — blue/green drain polling (`child-blue-green.ts`)
 */
const MONITORING_PATH_PREFIXES: readonly string[] = ['/health', '/api/health', '/api/admin/health']

function pathOf(url: string): string {
  const q = url.indexOf('?')
  const path = q === -1 ? url : url.slice(0, q)
  // Normalize a trailing slash so `/api/health/` matches `/api/health`.
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}

/**
 * True when a request is supervision/monitoring traffic and must NOT count as
 * demand. Exported for direct testing — the cost of a false "busy" here is the
 * whole feature silently doing nothing.
 */
export function isMonitoringRequest(
  url: string,
  headers: Readonly<Record<string, unknown>> = {},
): boolean {
  if (headers[META_PROBE_HEADER] !== undefined) return true
  const path = pathOf(url)
  return MONITORING_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
}

export interface RequestActivityTracker {
  /** Mount early, before the routes — it only stamps a timestamp. */
  readonly middleware: RequestHandler
  /**
   * Epoch ms of the last non-monitoring request, or of process start.
   * Not used by the broker itself — `idleMs` is what `/api/health` reports.
   * Kept as a test/diagnostic seam alongside {@link markRequest}.
   */
  lastRequestAt(): number
  /** Milliseconds since the last non-monitoring request. Never negative. */
  idleMs(nowMs?: number): number
  /** Test seam: record an arrival without an Express request. */
  markRequest(atMs?: number): void
}

export function createRequestActivityTracker(now: () => number = Date.now): RequestActivityTracker {
  // Seeded at construction, NOT at 0. A child that has never served anything is
  // idle for as long as it has been up — which is exactly the abandoned-broker
  // case the reaper exists for — while a child that has just been woken starts
  // its idle clock fresh instead of being reaped on its first tick.
  let lastAt = now()

  const middleware: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
    if (!isMonitoringRequest(req.originalUrl ?? req.url ?? '', req.headers)) {
      lastAt = now()
    }
    next()
  }

  return {
    middleware,
    lastRequestAt: () => lastAt,
    idleMs: (nowMs?: number) => Math.max(0, (nowMs ?? now()) - lastAt),
    markRequest: (atMs?: number) => {
      lastAt = atMs ?? now()
    },
  }
}
