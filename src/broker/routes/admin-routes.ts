/**
 * Admin routes — broker lifecycle management endpoints.
 *
 * Used by the daily restart orchestrator (scripts/broker-restart.sh) to:
 * 1. Prepare for restart (dream consolidation + housekeeping)
 * 2. Enter drain mode (reject new work, keep health alive)
 * 3. Report extended health status
 */

import type { Express, Request, Response, NextFunction } from 'express'
import type { RestartManager } from '../restart-manager.js'
import type { ShutdownManager } from '../shutdown.js'
import type { AgentSpawner } from '../services/agent-spawner.js'
import type Database from 'better-sqlite3'
import {
  snapshotActiveAgents,
  recoverAgents,
  type RecoverySnapshot,
} from '../services/session-recovery.js'
import { logger } from '../../shared/logger.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AdminRouteDeps {
  readonly restartManager: RestartManager
  readonly shutdownManager: ShutdownManager
  readonly agentSpawner?: AgentSpawner
  readonly db?: Database.Database
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

const log = logger.child({ module: 'admin-routes' })

export function registerAdminRoutes(app: Express, deps: AdminRouteDeps): void {
  /**
   * POST /api/admin/prepare-restart
   * Triggers dream consolidation + housekeeping before a restart.
   * Returns results (does not initiate shutdown).
   */
  app.post('/api/admin/prepare-restart', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      log.info('Admin: prepare-restart triggered')
      const result = await deps.restartManager.prepareForRestart()
      log.info({ success: result.success, durationMs: result.durationMs }, 'Admin: prepare-restart complete')
      res.json(result)
    } catch (error) {
      next(error)
    }
  })

  /**
   * POST /api/admin/drain
   * Enters drain mode — shutdown middleware returns 503 for non-health endpoints.
   */
  app.post('/api/admin/drain', (_req: Request, res: Response, next: NextFunction) => {
    try {
      deps.restartManager.enterDrainMode()
      deps.shutdownManager.startDrain()
      log.info('Admin: drain mode activated')
      res.json({ success: true, draining: true })
    } catch (error) {
      next(error)
    }
  })

  /**
   * GET /api/admin/health
   * Extended health check including drain status, uptime, and dep availability.
   * Always accessible (exempt from drain/shutdown middleware).
   */
  app.get('/api/admin/health', (_req: Request, res: Response, next: NextFunction) => {
    try {
      const health = deps.restartManager.getHealth()
      res.json(health)
    } catch (error) {
      next(error)
    }
  })

  /**
   * POST /api/admin/snapshot-agents
   * Captures active agent state for recovery after restart.
   * Called by broker-restart.sh after drain, before SIGTERM.
   * Returns snapshot count; acts as a restart gate.
   */
  app.post('/api/admin/snapshot-agents', (_req: Request, res: Response, next: NextFunction) => {
    try {
      if (!deps.agentSpawner || !deps.db) {
        res.status(503).json({ error: 'Agent spawner or DB not available', count: 0 })
        return
      }

      const activeAgents = deps.agentSpawner.getActiveAgents()
      const agents = Array.from(activeAgents.values()).map((a) => ({
        sessionId: a.sessionId,
        teamId: a.teamId,
        name: a.name,
        role: a.role,
        launchMethod: a.launchMethod as 'acp' | 'tmux' | 'detached',
        workingDir: '/tmp', // spawner doesn't track workingDir per-agent; use session DB
      }))

      // Enrich workingDir from session DB
      const getWorkingDir = deps.db.prepare('SELECT working_dir FROM sessions WHERE id = ?')
      const enriched = agents.map((a) => {
        const session = getWorkingDir.get(a.sessionId) as { working_dir: string } | undefined
        return { ...a, workingDir: session?.working_dir ?? a.workingDir }
      })

      const snapshots = snapshotActiveAgents(deps.db, enriched)
      log.info({ count: snapshots.length }, 'Admin: agents snapshotted for recovery')
      res.json({ success: true, count: snapshots.length })
    } catch (error) {
      next(error)
    }
  })

  /**
   * POST /api/admin/rollback
   * Programmatic rollback trigger. Invokes the configured rollback handler
   * (typically spawns broker-restart.sh with --rollback).
   * Body: { reason?: string } (optional human-readable context).
   */
  app.post('/api/admin/rollback', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined
      log.warn({ reason }, 'Admin: rollback endpoint invoked')
      const result = await deps.restartManager.requestRollback(reason)
      if (!result.success && !result.triggered) {
        res.status(503).json({
          success: false,
          triggered: false,
          error: result.error ?? 'Rollback handler not available',
        })
        return
      }
      if (!result.success) {
        res.status(500).json({
          success: false,
          triggered: true,
          error: result.error ?? 'Rollback handler failed',
        })
        return
      }
      res.json({ success: true, triggered: true })
    } catch (error) {
      next(error)
    }
  })

  // ─── Recovery inspection/retry ────────────────────────────────────────────
  //
  // These endpoints expose the existing recovery_snapshots table via REST so
  // operators can inspect pending/failed recoveries and retry specific ones.

  /**
   * GET /api/admin/recovery/snapshots
   * Lists recovery snapshots with optional ?status=pending|recovered|failed|expired filter.
   */
  app.get('/api/admin/recovery/snapshots', (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!deps.db) {
        res.status(503).json({ error: 'DB not available', snapshots: [] })
        return
      }
      const statusFilter = typeof req.query['status'] === 'string' ? req.query['status'] : null
      const allowed = new Set(['pending', 'recovered', 'failed', 'expired'])
      let rows: readonly RecoverySnapshot[]
      if (statusFilter && allowed.has(statusFilter)) {
        rows = deps.db
          .prepare('SELECT * FROM recovery_snapshots WHERE status = ? ORDER BY id DESC')
          .all(statusFilter) as RecoverySnapshot[]
      } else {
        rows = deps.db
          .prepare('SELECT * FROM recovery_snapshots ORDER BY id DESC')
          .all() as RecoverySnapshot[]
      }
      res.json({ snapshots: rows })
    } catch (error) {
      next(error)
    }
  })

  /**
   * GET /api/admin/recovery/status
   * Returns aggregate counts: { total, pending, recovered, failed, expired }.
   */
  app.get('/api/admin/recovery/status', (_req: Request, res: Response, next: NextFunction) => {
    try {
      if (!deps.db) {
        res.status(503).json({ error: 'DB not available' })
        return
      }
      const rows = deps.db
        .prepare('SELECT status, COUNT(*) AS count FROM recovery_snapshots GROUP BY status')
        .all() as Array<{ status: string; count: number }>
      const summary = { total: 0, pending: 0, recovered: 0, failed: 0, expired: 0 }
      for (const row of rows) {
        summary.total += row.count
        if (row.status in summary) {
          ;(summary as Record<string, number>)[row.status] = row.count
        }
      }
      res.json(summary)
    } catch (error) {
      next(error)
    }
  })

  /**
   * POST /api/admin/recovery/retry/:sessionId
   * Retries recovery for a failed/pending snapshot (identified by its original session_id).
   * Re-attempts spawning and, on success, marks the snapshot as recovered.
   */
  app.post(
    '/api/admin/recovery/retry/:sessionId',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!deps.db) {
          res.status(503).json({ error: 'DB not available' })
          return
        }
        if (!deps.agentSpawner) {
          res.status(503).json({ error: 'Agent spawner not available' })
          return
        }
        const rawSessionId = req.params['sessionId']
        const sessionId = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId
        if (!sessionId) {
          res.status(400).json({ error: 'sessionId required' })
          return
        }

        // Find the most recent retriable snapshot (failed or pending) for this session.
        const snapshot = deps.db
          .prepare(
            `SELECT * FROM recovery_snapshots
             WHERE session_id = ? AND status IN ('failed', 'pending')
             ORDER BY id DESC LIMIT 1`,
          )
          .get(sessionId) as RecoverySnapshot | undefined

        if (!snapshot) {
          res.status(404).json({ error: 'No retriable snapshot for session', sessionId })
          return
        }

        // Reset the snapshot to pending so recoverAgents can process it.
        deps.db
          .prepare(
            "UPDATE recovery_snapshots SET status = 'pending', recovered_at = NULL WHERE id = ?",
          )
          .run(snapshot.id)

        const spawner = deps.agentSpawner
        const [result] = await recoverAgents(
          deps.db,
          (input) => spawner.spawn(input),
          [{ ...snapshot, status: 'pending' }],
        )
        if (!result) {
          res.status(500).json({ error: 'Recovery produced no result' })
          return
        }
        if (result.success) {
          log.info(
            { originalSessionId: sessionId, newSessionId: result.newSessionId },
            'Admin: recovery retry succeeded',
          )
          res.json({
            success: true,
            originalSessionId: result.originalSessionId,
            newSessionId: result.newSessionId,
          })
          return
        }
        log.warn(
          { originalSessionId: sessionId, error: result.error },
          'Admin: recovery retry failed',
        )
        res.status(500).json({
          success: false,
          originalSessionId: result.originalSessionId,
          error: result.error ?? 'Recovery failed',
        })
      } catch (error) {
        next(error)
      }
    },
  )
}
