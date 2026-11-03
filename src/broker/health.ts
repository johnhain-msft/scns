import { Router } from 'express'
import type { Request, Response } from 'express'
import type Database from 'better-sqlite3'
import { countSessionsByStatus } from './storage/repositories/session-repository.js'
import { countTeamsByStatus } from './storage/repositories/team-repository.js'
import { countTasksByStatus } from './storage/repositories/task-repository.js'

export interface HealthDependencies {
  readonly db: Database.Database
  readonly version: string
  readonly startedAt: number
  readonly isEmbeddingAvailable?: () => boolean
}

interface SessionCounts {
  readonly active: number
  readonly working: number
  readonly reporting: number
  readonly idle: number
  readonly paused: number
  readonly zombie: number
  readonly expired: number
  readonly total: number
}

interface TaskCounts {
  readonly pending: number
  readonly in_progress: number
}

interface ReadyResponse {
  readonly status: 'ok' | 'degraded'
  readonly version: string
  readonly uptime_seconds: number
  readonly memory_mb: number
  readonly dependencies: {
    readonly database: 'ok' | 'error'
    readonly embeddings: 'ok' | 'unavailable'
  }
  readonly sessions: SessionCounts
  readonly teams: number
  readonly tasks: TaskCounts
}

/**
 * Check embedding model availability via the injected dependency.
 * The broker server wires this to `getEmbeddingStatus() === 'ready'`
 * from the FastEmbed module (see server.ts). Falls back to false when
 * no checker is injected (e.g. in tests without embedding support).
 */
function isEmbeddingAvailable(deps: HealthDependencies): boolean {
  return deps.isEmbeddingAvailable?.() ?? false
}

function checkDatabase(db: Database.Database): 'ok' | 'error' {
  try {
    db.prepare('SELECT 1').get()
    return 'ok'
  } catch {
    return 'error'
  }
}

function getSessionCounts(db: Database.Database): SessionCounts {
  try {
    const active = countSessionsByStatus(db, 'active')
    const working = countSessionsByStatus(db, 'working')
    const reporting = countSessionsByStatus(db, 'reporting')
    const idle = countSessionsByStatus(db, 'idle')
    const paused = countSessionsByStatus(db, 'paused')
    const zombie = countSessionsByStatus(db, 'zombie')
    const expired = countSessionsByStatus(db, 'expired')
    return {
      active,
      working,
      reporting,
      idle,
      paused,
      zombie,
      expired,
      total: active + working + reporting + idle + paused + zombie + expired,
    }
  } catch {
    return {
      active: 0,
      working: 0,
      reporting: 0,
      idle: 0,
      paused: 0,
      zombie: 0,
      expired: 0,
      total: 0,
    }
  }
}

function getTaskCounts(db: Database.Database): TaskCounts {
  try {
    return {
      pending: countTasksByStatus(db, 'pending'),
      in_progress: countTasksByStatus(db, 'in_progress'),
    }
  } catch {
    return { pending: 0, in_progress: 0 }
  }
}

function getTeamCount(db: Database.Database): number {
  try {
    return countTeamsByStatus(db, 'active')
  } catch {
    return 0
  }
}

function buildReadyResponse(deps: HealthDependencies): { statusCode: number; body: ReadyResponse } {
  const dbStatus = checkDatabase(deps.db)
  const embeddingsStatus: 'ok' | 'unavailable' = isEmbeddingAvailable(deps) ? 'ok' : 'unavailable'
  const overallStatus: 'ok' | 'degraded' = dbStatus === 'ok' ? 'ok' : 'degraded'
  const statusCode = dbStatus === 'ok' ? 200 : 503

  const sessions = getSessionCounts(deps.db)
  const teams = getTeamCount(deps.db)
  const tasks = getTaskCounts(deps.db)

  return {
    statusCode,
    body: {
      status: overallStatus,
      version: deps.version,
      uptime_seconds: Math.floor((Date.now() - deps.startedAt) / 1000),
      memory_mb: Math.round((process.memoryUsage().rss / 1024 / 1024) * 100) / 100,
      dependencies: {
        database: dbStatus,
        embeddings: embeddingsStatus,
      },
      sessions,
      teams,
      tasks,
    },
  }
}

export function createHealthRouter(deps: HealthDependencies): Router {
  const router = Router()

  // Liveness probe — always 200 if process is alive
  router.get('/live', (_req: Request, res: Response) => {
    res.json({ status: 'ok' })
  })

  // Readiness probe — checks dependencies
  router.get('/ready', (_req: Request, res: Response) => {
    const { statusCode, body } = buildReadyResponse(deps)
    res.status(statusCode).json(body)
  })

  // Root handler — backward-compatible response with new enriched fields
  router.get('/', (_req: Request, res: Response) => {
    const { statusCode, body } = buildReadyResponse(deps)
    res.status(statusCode).json({
      ...body,
      active_teams: body.teams,
      pending_tasks: body.tasks.pending,
      in_progress_tasks: body.tasks.in_progress,
    })
  })

  return router
}
