/**
 * Progressive readiness endpoint — `/api/health`.
 *
 * Added in Phase 13.9.4. Reports per-component readiness so cold starts can
 * serve traffic in `degraded` state while the embedding backfill and brain
 * finish initializing, then flip to `ready` once all components are up.
 */

import { Router } from 'express'
import type { Request, Response } from 'express'
import type Database from 'better-sqlite3'

export interface EmbeddingBackfillSnapshot {
  readonly status: 'idle' | 'backfilling' | 'ready' | 'failed'
  readonly progress: { readonly done: number; readonly total: number }
  readonly errorMessage?: string | null
}

export interface OtelHealthSnapshot {
  readonly status: 'ready' | 'unconfigured' | 'error'
  readonly progress?: { readonly done: number; readonly total: number }
  readonly errorMessage?: string | null
}

export interface ProgressiveHealthDeps {
  readonly db: Database.Database
  readonly startedAt: number
  getEmbeddingBackfillState?: () => EmbeddingBackfillSnapshot
  getBrainStatus?: () => 'starting' | 'ready'
  getOtelStatus?: () => OtelHealthSnapshot
  /**
   * Idle reaping — ms since this broker last served a non-monitoring request
   * (see `broker/request-activity.ts`). Surfaced so the meta-supervisor can
   * decide, from the probe it already makes, whether anyone is still using
   * this child. Omitted on brokers that do not track it; the supervisor treats
   * an absent value as "idleness unknown" and never reaps on it.
   */
  getLastRequestAgeMs?: () => number
}

export type OverallStatus = 'ready' | 'degraded' | 'starting'

interface ComponentStatus {
  readonly status: string
  readonly progress?: { readonly done: number; readonly total: number } | null
  readonly errorMessage?: string | null
}

export interface ProgressiveHealthResponse {
  readonly status: OverallStatus
  readonly uptime_seconds: number
  readonly components: {
    readonly embeddings: ComponentStatus
    readonly brain: ComponentStatus
    readonly db: ComponentStatus
    readonly otel: ComponentStatus
  }
  /**
   * P7 — meta-broker identity verification. Echoed from `SCNS_INSTANCE_ID`
   * env on broker startup so the meta-supervisor's HTTP probe can confirm
   * it's talking to the child it spawned (not a port-squatter or a stale
   * process from a prior PID-reuse incident). Absent on stand-alone runs.
   */
  readonly instance_id?: string
  /** P7 — `BROKER_PROJECT_ID` echo (debugging convenience). */
  readonly project_id?: string
  /**
   * Idle reaping — seconds since this broker last served a non-monitoring
   * request. Absent when the broker does not track request activity, which the
   * meta-supervisor reads as "unknown" (and therefore never reaps).
   */
  readonly last_request_age_seconds?: number
  /**
   * Adoption — this process's OWN pid, self-reported.
   *
   * The meta-supervisor needs a pid to stop a child it did not spawn, and the
   * registry's `child_pid` is explicitly advisory ("never trust it for
   * identity" — see `meta-broker/registry.ts`): it was written by a previous
   * supervisor incarnation and the OS may have recycled it since. A pid
   * reported by the very process that just passed an identity-checked probe on
   * this port cannot be stale, because that process is demonstrably alive and
   * demonstrably the right one.
   */
  readonly pid?: number
}

const STARTING_WINDOW_MS = 500

function computeDbStatus(db: Database.Database): ComponentStatus {
  try {
    db.prepare('SELECT 1').get()
    return { status: 'ready' }
  } catch (err) {
    return {
      status: 'error',
      errorMessage: err instanceof Error ? err.message : String(err),
    }
  }
}

function computeEmbeddingStatus(deps: ProgressiveHealthDeps): ComponentStatus {
  if (!deps.getEmbeddingBackfillState) {
    return { status: 'idle', progress: null }
  }
  const snap = deps.getEmbeddingBackfillState()
  return {
    status: snap.status,
    progress: snap.status === 'backfilling' || snap.status === 'ready' ? snap.progress : null,
    errorMessage: snap.errorMessage ?? null,
  }
}

function computeBrainStatus(deps: ProgressiveHealthDeps): ComponentStatus {
  const status = deps.getBrainStatus?.() ?? 'starting'
  return { status }
}

function computeOtelStatus(deps: ProgressiveHealthDeps): ComponentStatus {
  if (!deps.getOtelStatus) {
    return { status: 'unconfigured', progress: null }
  }
  try {
    const snap = deps.getOtelStatus()
    return {
      status: snap.status,
      progress: snap.progress ?? null,
      errorMessage: snap.errorMessage ?? null,
    }
  } catch (err) {
    return {
      status: 'error',
      progress: null,
      errorMessage: err instanceof Error ? err.message : String(err),
    }
  }
}

export function computeOverallStatus(
  uptimeMs: number,
  embeddings: ComponentStatus,
  brain: ComponentStatus,
  db: ComponentStatus,
): OverallStatus {
  if (db.status !== 'ready') return 'degraded'
  if (uptimeMs < STARTING_WINDOW_MS) return 'starting'
  if (embeddings.status === 'ready' && brain.status === 'ready') return 'ready'
  if (
    embeddings.status === 'backfilling' ||
    brain.status === 'starting' ||
    embeddings.status === 'failed'
  ) {
    return 'degraded'
  }
  if (embeddings.status === 'idle') return 'ready'
  return 'degraded'
}

export function buildProgressiveHealth(
  deps: ProgressiveHealthDeps,
  now: number = Date.now(),
): ProgressiveHealthResponse {
  const uptimeMs = now - deps.startedAt
  const embeddings = computeEmbeddingStatus(deps)
  const brain = computeBrainStatus(deps)
  const db = computeDbStatus(deps.db)
  const otel = computeOtelStatus(deps)
  const status = computeOverallStatus(uptimeMs, embeddings, brain, db)

  const instanceId = process.env['SCNS_INSTANCE_ID']
  const projectId = process.env['BROKER_PROJECT_ID']
  const lastRequestAgeMs = deps.getLastRequestAgeMs?.()

  return {
    status,
    uptime_seconds: Math.max(0, Math.floor(uptimeMs / 1000)),
    components: { embeddings, brain, db, otel },
    pid: process.pid,
    ...(instanceId ? { instance_id: instanceId } : {}),
    ...(projectId ? { project_id: projectId } : {}),
    ...(typeof lastRequestAgeMs === 'number' && Number.isFinite(lastRequestAgeMs)
      ? { last_request_age_seconds: Math.max(0, Math.floor(lastRequestAgeMs / 1000)) }
      : {}),
  }
}

export function createProgressiveHealthRouter(deps: ProgressiveHealthDeps): Router {
  const router = Router()
  router.get('/', (_req: Request, res: Response) => {
    const body = buildProgressiveHealth(deps)
    const statusCode = body.components.db.status === 'ready' ? 200 : 503
    res.status(statusCode).json(body)
  })
  return router
}
