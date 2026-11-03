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

function computeEmbeddingStatus(
  deps: ProgressiveHealthDeps,
): ComponentStatus {
  if (!deps.getEmbeddingBackfillState) {
    return { status: 'idle', progress: null }
  }
  const snap = deps.getEmbeddingBackfillState()
  return {
    status: snap.status,
    progress:
      snap.status === 'backfilling' || snap.status === 'ready'
        ? snap.progress
        : null,
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
  if (embeddings.status === 'backfilling' || brain.status === 'starting' || embeddings.status === 'failed') {
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

  return {
    status,
    uptime_seconds: Math.max(0, Math.floor(uptimeMs / 1000)),
    components: { embeddings, brain, db, otel },
    ...(instanceId ? { instance_id: instanceId } : {}),
    ...(projectId ? { project_id: projectId } : {}),
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
