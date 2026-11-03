/**
 * Dashboard REST API routes for the session broker.
 *
 * Provides endpoints for scheduler management, OTel observability,
 * dream daemon, suggestions, observers, memory, and SSE streaming.
 * Optional deps degrade gracefully when not wired.
 */

import type { Request, Response } from 'express'
import type express from 'express'
import { resolve, sep } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import type Database from 'better-sqlite3'
import type { EventLog } from '../services/event-log.js'
import { NotFoundError } from '../errors.js'
import {
  UpdateScheduledTaskSchema,
  OtelTracesQuerySchema,
  OtelTimeseriesQuerySchema,
  ExtensionContextSchema,
  MemoryStoreSchema,
  CreateNegativeMemorySchema,
  HeuristicNegativeMemorySchema,
  NegativeMemoryQuerySchema,
  NegativeMemorySearchSchema,
} from '../schemas.js'
import { SuggestionInputSchema, SuggestionSchema } from '../../suggest/types.js'
import { randomUUID } from 'node:crypto'
import { ZodError } from 'zod'
import {
  selectInjectableNegativeRules,
  NEGATIVE_MEMORY_SCAN_LIMIT,
  NEGATIVE_RULE_RELEVANCE_FLOOR,
  type ClassifiableNegativeMemory,
} from '../../memory/negative-memory-applicator.js'
import {
  injectionRelevanceEnabled,
  makePromptRelevanceScorer,
} from '../../memory/injection-relevance.js'
import {
  findAllTasks,
  findTaskById,
  updateTask,
  recordTaskRun,
  getTaskRunHistory,
} from '../storage/repositories/scheduler-repository.js'
import {
  findTraces,
  findSpansByTraceId,
  getMetricsSummary,
  getMetricsTimeseries,
} from '../../otel/otel-repository.js'
import { assembleTraceTree } from '../../otel/trace-assembler.js'
import { loadOtelConfig } from '../../otel/config.js'
import { getState } from '../storage/repositories/state-repository.js'
import { findAllSessions } from '../storage/repositories/session-repository.js'
import { findAllTeams, findTeamMembers } from '../storage/repositories/team-repository.js'
import { getEventsSinceFiltered } from '../storage/repositories/event-repository.js'
import { findAllMessages } from '../storage/repositories/message-repository.js'
import { findRecentScalingDecisions } from '../storage/repositories/scaling-outcomes-repository.js'
import { logger } from '../../shared/logger.js'

/** Extract Express 5 path param (handles string | string[] union). */
const param = (req: Request, name: string): string => {
  const val = req.params[name]
  return Array.isArray(val) ? val[0]! : (val ?? '')
}

/**
 * Parse an orchestrator `?since=` query param. Accepts:
 *   - `all` → returns undefined (no filter)
 *   - `1h`, `24h`, `7d`, or any `<N>h` / `<N>d` / `<N>m` → computed ISO-8601 timestamp
 *   - any ISO-8601 string parseable by Date → returned as ISO-8601
 *   - missing / empty / invalid → default 24h window
 * Returns an ISO-8601 timestamp string, or `undefined` when no filter should apply.
 */
function parseSinceParam(raw: unknown): string | undefined {
  const val = Array.isArray(raw) ? raw[0] : raw
  const str = typeof val === 'string' ? val.trim() : ''
  if (str === 'all') return undefined
  if (str === '') return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const relMatch = /^(\d+)([mhd])$/.exec(str)
  if (relMatch) {
    const n = parseInt(relMatch[1]!, 10)
    const unit = relMatch[2]!
    const ms = unit === 'm' ? n * 60_000 : unit === 'h' ? n * 3_600_000 : n * 86_400_000
    return new Date(Date.now() - ms).toISOString()
  }
  const parsed = Date.parse(str)
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString()
  // Unrecognized value → fall back to 24h default rather than leaking unbounded data.
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
}

/** Statuses that count as "in-flight" on the orchestrator dashboard card. */
const IN_FLIGHT_SUGGESTION_STATUSES: readonly string[] = ['pending', 'approved', 'in-progress']

/** Collect in-flight suggestions (sorted newest-first by updatedAt/createdAt, capped at 20). */
function listInFlightSuggestions(
  store: DashboardRouteDeps['suggestionStore'],
): ReadonlyArray<Record<string, unknown>> {
  if (!store) return []
  const all: Array<Record<string, unknown>> = []
  for (const status of IN_FLIGHT_SUGGESTION_STATUSES) {
    const rows = store.listByStatus(status) as ReadonlyArray<Record<string, unknown>>
    all.push(...rows)
  }
  return all
    .sort((a, b) => {
      const ca = String(a['updatedAt'] ?? a['createdAt'] ?? '')
      const cb = String(b['updatedAt'] ?? b['createdAt'] ?? '')
      return cb.localeCompare(ca)
    })
    .slice(0, 20)
}

/**
 * Filter out diagnostic/synthetic message traffic so the dashboard's Recent
 * Messages panel reflects real agent activity.
 *
 * Excludes any row whose sender_id OR receiver_id matches:
 *   - `^test-...`        (automated probes)
 *   - `^manual-test-...` (operator smoke tests)
 *   - exact `broadcast`  (system-wide diagnostic pings)
 */
const DIAGNOSTIC_ID_PATTERN = /^(?:test-|manual-test-|broadcast$)/

function isDiagnosticMessage(m: { sender_id: string | null; receiver_id: string | null }): boolean {
  const sender = m.sender_id ?? ''
  const receiver = m.receiver_id ?? ''
  return DIAGNOSTIC_ID_PATTERN.test(sender) || DIAGNOSTIC_ID_PATTERN.test(receiver)
}

function listRecentRealMessages(
  db: Database.Database,
  limit: number,
  since: string | undefined,
): ReturnType<typeof findAllMessages> {
  // Over-fetch to absorb filtered diagnostic rows, then trim.
  const overfetch = Math.min(500, Math.max(limit * 3, limit + 50))
  const rows = findAllMessages(db, since ? { limit: overfetch, since } : { limit: overfetch })
  const real = rows.filter((m) => !isDiagnosticMessage(m))
  return real.slice(0, limit)
}

export interface DashboardRouteDeps {
  readonly db: Database.Database
  readonly eventLog: EventLog
  /** WI-6 — execute a scheduled task's real handler (dashboard run-now). */
  readonly schedulerRunNow?: (taskId: string) => Promise<'ran' | 'no-task' | 'no-handler'>
  readonly dreamDaemon?: {
    getStatus(): unknown
    triggerRun(force: boolean): Promise<unknown>
  }
  readonly suggestionStore?: {
    listByStatus(status: string): ReadonlyArray<unknown>
    approve(id: string): unknown
    reject(id: string): unknown
    save?(suggestion: import('../../suggest/types.js').Suggestion): void
    /** Phase 13.12.9: manual retry → clears backoff; returns updated suggestion or null. */
    retry?(id: string): unknown
    /** Phase 13.12.9: explicit delete for any suggestion status; returns true if removed. */
    remove?(id: string): boolean
    /** Phase 13.12.16: re-promote needs-human → pending; returns updated suggestion or null. */
    repromote?(id: string): unknown
  }
  readonly observationManager?: {
    getStatus(): unknown
    toggleObserver(type: string, enabled: boolean): void
    getPlugins?(): ReadonlyArray<{
      readonly name: string
      readonly type: string
      readonly state: string
      readonly metadata: {
        readonly name: string
        readonly version: string
        readonly source: string
        readonly description?: string
      }
      readonly capabilities: readonly string[]
      healthCheck(): Promise<{
        readonly healthy: boolean
        readonly message: string
        readonly lastCheck: string
      }>
    }>
  }
  readonly memorySearch?: {
    search(query: string, topK: number): Promise<unknown>
    briefing?(
      query: string,
      topK: number,
      opts?: { sessionId?: string; cwd?: string },
    ): Promise<unknown>
  }
  readonly memoryStats?: {
    getStats(): unknown
  }
  readonly memoryFiles?: {
    listFiles(): ReadonlyArray<{
      path: string
      content: string
      mtimeMs: number
      sizeBytes: number
    }>
  }
  readonly memoryStore?: {
    store(key: string, value: string): Promise<{ stored: boolean; key: string }>
  }
  /**
   * #71 — explicit, project-bound memory deletion executed INSIDE the owning broker, so no second
   * process opens a writable connection against a live vault. `apply: false` previews.
   */
  readonly memoryDeletion?: {
    run(input: {
      readonly path: string
      readonly apply: boolean
      readonly hard: boolean
      readonly allowPinned: boolean
    }): unknown
  }
  readonly negativeMemoryStore?: {
    storeFromTool(input: {
      feedback: string
      context?: string
      category?: string
      target?: string
      severity?: string
      sessionId?: string
    }): {
      id: string
      dontRule: string
      category: string
      recommendedTarget: string
      /** W5.4 — authorship classified at the store boundary. */
      promptOrigin?: string
    }
    storeFromHeuristic(input: {
      originalText: string
      dontRule: string
      category: string
      recommendedTarget: string
      confidence: number
      sessionId?: string
    }): { id: string }
    list(options?: { target?: string; limit?: number }): ReadonlyArray<unknown>
    search(query: string, limit?: number): ReadonlyArray<unknown>
    count(): number
  }
  /**
   * W5.3 — called for HUMAN-origin negative feedback only, so a human-authored
   * critique also enters the self-issue task pipeline as a High task. Returns
   * the created task id, or null when the queue rejected it. Machine/heuristic
   * entries must never reach this.
   */
  readonly onHumanNegativeFeedback?: (mem: {
    readonly id: string
    readonly dontRule: string
    readonly category: string
    readonly recommendedTarget: string
  }) => string | null
  readonly memoryLessons?: {
    list(): ReadonlyArray<{
      id?: string
      name: string
      type: string
      description: string
      content: string
      source?: string
      createdAt?: string
    }>
    archiveEntry(
      entryId: string,
      reason: string,
      note?: string,
    ): { success: boolean; archivedId?: string }
  }
  readonly lessonStore?: {
    list(filter?: { cwd?: string; project?: string; agent?: string }): ReadonlyArray<{
      frontmatter: {
        id: string
        scope: 'global' | 'project' | 'agent'
        project?: string
        agent?: string
        tags: readonly string[]
        appliesTo: readonly string[]
        createdAt: string
      }
      body: string
      path: string
    }>
    groupByScope(lessons: ReadonlyArray<unknown>): Record<string, ReadonlyArray<unknown>>
  }
  readonly archiveStore?: {
    list(): ReadonlyArray<{
      id: string
      name: string
      type: string
      content: string
      source: string
      createdAt: string
      archivedAt: string
      archiveReason: string
      rejectionNote?: string
    }>
    search(query: string): ReadonlyArray<unknown>
    count(): number
  }
  readonly memoryTiers?: {
    getTierSummary(): {
      daily: { count: number; totalBytes: number }
      weekly: { count: number; totalBytes: number }
      monthly: { count: number; totalBytes: number }
      archive: { count: number; totalBytes: number }
      embeddingStatus: { ready: boolean; embeddedChunks: number; totalChunks: number }
    }
  }
  /**
   * Resolves when late-bound dashboard deps (suggestionStore, observationManager,
   * dreamDaemon, memory*, negativeMemoryStore, …) have been wired by the CLI via
   * `setDashboardDeps()`. Routes that depend on those deps await this promise
   * (with a short timeout) to avoid returning degraded responses during the
   * brief window between broker startup and dep wiring.
   */
  readonly whenReady?: Promise<void>
  /** Max ms to wait before releasing a gated request with degraded response. */
  readonly readinessTimeoutMs?: number
  /**
   * Phase 13.12.4: optional callback invoked after a successful
   * POST /api/suggestions persists the new suggestion. Used to wake the
   * brain so the new suggestion is promoted without waiting for the next
   * scheduled tick. Must be fire-and-forget: errors thrown from the
   * callback are logged and do not affect the 201 response.
   */
  readonly onSuggestionPosted?: () => void
}

/** Path prefixes whose handlers should wait for late-bound deps to be populated. */
const LATE_BOUND_PREFIXES: readonly string[] = [
  '/api/suggestions',
  '/api/observers',
  '/api/dream',
  '/api/memory',
  '/api/negative-memories',
  '/api/orchestrator',
]

/** Default max time (ms) a request will wait for late-bound deps. */
const DEFAULT_READINESS_TIMEOUT_MS = 5000

export function registerDashboardRoutes(app: express.Express, deps: DashboardRouteDeps): void {
  const { db, eventLog } = deps

  // Readiness gate: hold requests to late-bound routes until deps are wired
  // (or until READINESS_TIMEOUT_MS expires). This eliminates the startup race
  // where routes would otherwise return `{available: false}` / 503 between
  // `listen()` and `setDashboardDeps()`.
  if (deps.whenReady) {
    const readyPromise = deps.whenReady
    const timeoutMs = deps.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS
    let ready = false
    readyPromise.then(() => {
      ready = true
    })
    app.use((req: Request, _res: Response, next) => {
      if (ready) return next()
      if (!LATE_BOUND_PREFIXES.some((prefix) => req.path.startsWith(prefix))) return next()
      let called = false
      const done = () => {
        if (called) return
        called = true
        next()
      }
      const timer = setTimeout(done, timeoutMs)
      readyPromise.then(() => {
        clearTimeout(timer)
        done()
      })
    })
  }

  // ── Scheduler Routes ──────────────────────────────────────────

  app.get('/api/scheduler/tasks', (_req: Request, res: Response, next) => {
    try {
      const tasks = findAllTasks(db)
      res.json({ tasks })
    } catch (err) {
      next(err)
    }
  })

  app.patch('/api/scheduler/tasks/:id', (req: Request, res: Response, next) => {
    try {
      const id = param(req, 'id')
      const parsed = UpdateScheduledTaskSchema.safeParse(req.body)
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' })
        return
      }
      const updated = updateTask(db, id, {
        ...parsed.data,
        description: parsed.data.description ?? undefined,
      })
      if (!updated) {
        throw new NotFoundError('ScheduledTask', id)
      }
      res.json(updated)
    } catch (err) {
      next(err)
    }
  })

  app.post('/api/scheduler/tasks/:id/run', async (req: Request, res: Response, next) => {
    try {
      const id = param(req, 'id')
      const task = findTaskById(db, id)
      if (!task) {
        throw new NotFoundError('ScheduledTask', id)
      }
      // WI-6: actually EXECUTE the task's handler. The old body only recorded
      // a success row — a "run now" that lied. The legacy record-only path
      // remains for brokers wired without a scheduler (bare unit harnesses).
      if (deps.schedulerRunNow) {
        const outcome = await deps.schedulerRunNow(id)
        if (outcome === 'no-handler') {
          res.status(409).json({ success: false, error: `no handler registered for ${id}` })
          return
        }
        const updated = findTaskById(db, id)
        res.json({ success: true, executed: true, task: updated })
        return
      }
      const now = new Date().toISOString()
      recordTaskRun(db, id, 'success', now, now, 0)
      const updated = findTaskById(db, id)
      res.json({ success: true, task: updated })
    } catch (err) {
      next(err)
    }
  })

  app.get('/api/scheduler/history/:id', (req: Request, res: Response, next) => {
    try {
      const id = param(req, 'id')
      const task = findTaskById(db, id)
      if (!task) {
        throw new NotFoundError('ScheduledTask', id)
      }
      const limitStr = req.query['limit']
      const limit =
        typeof limitStr === 'string' ? Math.min(Math.max(parseInt(limitStr, 10) || 50, 1), 500) : 50
      const history = getTaskRunHistory(db, id, limit)
      res.json({ history })
    } catch (err) {
      next(err)
    }
  })

  // ── Dream Routes ──────────────────────────────────────────────

  app.get('/api/dream/status', (_req: Request, res: Response, next) => {
    try {
      if (deps.dreamDaemon) {
        res.json(deps.dreamDaemon.getStatus())
        return
      }
      res.json({ available: false, message: 'Dream daemon not initialized' })
    } catch (err) {
      next(err)
    }
  })

  app.post('/api/dream/trigger', async (req: Request, res: Response, next) => {
    try {
      if (!deps.dreamDaemon) {
        res.status(503).json({ error: 'Dream daemon not initialized' })
        return
      }
      const force = req.query['force'] === 'true'
      const result = await deps.dreamDaemon.triggerRun(force)
      res.json(result)
    } catch (err) {
      next(err)
    }
  })

  // ── Suggestion Routes ─────────────────────────────────────────

  app.get('/api/suggestions', (req: Request, res: Response, next) => {
    try {
      if (!deps.suggestionStore) {
        res.json({ available: false, suggestions: [] })
        return
      }
      const status = (req.query['status'] as string) || 'pending'
      const suggestions = deps.suggestionStore.listByStatus(status)
      res.json({ suggestions })
    } catch (err) {
      next(err)
    }
  })

  app.post('/api/suggestions/:id/approve', (req: Request, res: Response, next) => {
    try {
      if (!deps.suggestionStore) {
        res.status(503).json({ error: 'Suggestion store not initialized' })
        return
      }
      const id = param(req, 'id')
      const result = deps.suggestionStore.approve(id)
      res.json(result)
    } catch (err) {
      next(err)
    }
  })

  app.post('/api/suggestions/:id/reject', (req: Request, res: Response, next) => {
    try {
      if (!deps.suggestionStore) {
        res.status(503).json({ error: 'Suggestion store not initialized' })
        return
      }
      const id = param(req, 'id')
      const result = deps.suggestionStore.reject(id)
      res.json(result)
    } catch (err) {
      next(err)
    }
  })

  // Phase 13.12.9: manual retry — clears backoff + (if failed) puts back to
  // approved so the brain executes on the next wake.
  app.post('/api/suggestions/:id/retry', (req: Request, res: Response, next) => {
    try {
      if (!deps.suggestionStore || !deps.suggestionStore.retry) {
        res.status(503).json({ error: 'Suggestion store does not support retry' })
        return
      }
      const id = param(req, 'id')
      const result = deps.suggestionStore.retry(id)
      if (!result) {
        res.status(404).json({ error: `Suggestion ${id} not found` })
        return
      }
      res.json({ success: true, suggestion: result })
    } catch (err) {
      next(err)
    }
  })

  // Phase 13.12.9: explicit delete endpoint (previously 404).
  app.delete('/api/suggestions/:id', (req: Request, res: Response, next) => {
    try {
      if (!deps.suggestionStore || !deps.suggestionStore.remove) {
        res.status(503).json({ error: 'Suggestion store does not support delete' })
        return
      }
      const id = param(req, 'id')
      const removed = deps.suggestionStore.remove(id)
      if (!removed) {
        res.status(404).json({ error: `Suggestion ${id} not found` })
        return
      }
      res.json({ success: true, id })
    } catch (err) {
      next(err)
    }
  })

  // Phase 13.12.16: re-promote a `needs-human` suggestion back to `pending`
  // after the human has addressed the blocking concern.
  app.post('/api/suggestions/:id/repromote', (req: Request, res: Response, next) => {
    try {
      if (!deps.suggestionStore || !deps.suggestionStore.repromote) {
        res.status(503).json({ error: 'Suggestion store does not support repromote' })
        return
      }
      const id = param(req, 'id')
      const result = deps.suggestionStore.repromote(id)
      if (!result) {
        res.status(404).json({ error: `Suggestion ${id} not found or not in needs-human` })
        return
      }
      res.json({ success: true, suggestion: result })
    } catch (err) {
      next(err)
    }
  })

  // Phase 13.9.5 — validated JSON injection endpoint.
  // Body = SuggestionInputSchema (client-controllable fields only);
  // server fills id/status/timestamps/defaults and persists via
  // suggestionStore.save(). Produces canonical markdown file in pending/.
  app.post('/api/suggestions', (req: Request, res: Response, next) => {
    try {
      if (!deps.suggestionStore || !deps.suggestionStore.save) {
        res.status(503).json({ error: 'Suggestion store not initialized' })
        return
      }

      const parsed = SuggestionInputSchema.safeParse(req.body)
      if (!parsed.success) {
        res.status(400).json({
          error: 'Invalid suggestion payload',
          issues: parsed.error.issues,
        })
        return
      }

      const now = new Date().toISOString()
      const id = randomUUID()
      const input = parsed.data
      const suggestion = SuggestionSchema.parse({
        id,
        type: input.type,
        title: input.title,
        description: input.description,
        status: 'pending',
        confidence: input.confidence,
        evidence: input.evidence ?? [],
        tags: input.tags ?? [],
        createdAt: now,
        updatedAt: now,
        actionable: input.actionable ?? true,
        estimatedComplexity: input.estimatedComplexity ?? 'solo',
        ...(input.suggestedRoles ? { suggestedRoles: input.suggestedRoles } : {}),
        ...(input.implementationPlan ? { implementationPlan: input.implementationPlan } : {}),
      })

      try {
        deps.suggestionStore.save(suggestion)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        res.status(500).json({ error: `Failed to persist suggestion: ${message}` })
        return
      }

      // Phase 13.12.4: auto-wake the brain so this suggestion is promoted
      // immediately instead of waiting up to 5 minutes for the next tick.
      // Fire-and-forget; a thrown callback must not affect the 201 response.
      if (deps.onSuggestionPosted) {
        try {
          deps.onSuggestionPosted()
        } catch (err) {
          logger.warn({ err, id }, 'onSuggestionPosted callback threw (ignored)')
        }
      }

      res.status(201).json({
        id,
        path: `pending/${id}.md`,
        suggestion,
      })
    } catch (err) {
      if (err instanceof ZodError) {
        res.status(400).json({ error: 'Invalid suggestion payload', issues: err.issues })
        return
      }
      next(err)
    }
  })

  // ── Observer Routes ───────────────────────────────────────────

  app.get('/api/observers', async (_req: Request, res: Response, next) => {
    try {
      if (!deps.observationManager) {
        res.json({ available: false, observers: [] })
        return
      }
      const status = deps.observationManager.getStatus()

      if (deps.observationManager.getPlugins) {
        const plugins = deps.observationManager.getPlugins()
        const pluginData = await Promise.all(
          plugins.map(async (p) => {
            let health: { healthy: boolean; message: string; lastCheck: string }
            try {
              health = await p.healthCheck()
            } catch {
              health = {
                healthy: false,
                message: 'healthCheck threw',
                lastCheck: new Date().toISOString(),
              }
            }
            return {
              name: p.name,
              type: p.type,
              state: p.state,
              metadata: p.metadata,
              capabilities: [...p.capabilities],
              health,
            }
          }),
        )
        res.json({ ...(status as object), plugins: pluginData })
        return
      }

      res.json(status)
    } catch (err) {
      next(err)
    }
  })

  app.post('/api/observers/:type/toggle', (req: Request, res: Response, next) => {
    try {
      if (!deps.observationManager) {
        res.status(503).json({ error: 'Observation manager not initialized' })
        return
      }
      const type = param(req, 'type')
      const enabled = req.body?.enabled !== false
      deps.observationManager.toggleObserver(type, enabled)
      res.json({ type, enabled })
    } catch (err) {
      next(err)
    }
  })

  // ── Memory Routes ─────────────────────────────────────────────

  app.get('/api/memory/search', async (req: Request, res: Response, next) => {
    try {
      if (!deps.memorySearch) {
        res.json({ available: false, results: [] })
        return
      }
      const q = (req.query['q'] as string) || ''
      const topK = Math.min(Math.max(parseInt(req.query['top_k'] as string, 10) || 10, 1), 100)
      const out = await deps.memorySearch.search(q, topK)
      // T024 [US2]: the live adapter returns { results, experienceId } so the human verdict can bind
      // per-attempt; a legacy array-shaped adapter is wrapped unchanged.
      res.json(out !== null && typeof out === 'object' && 'results' in out ? out : { results: out })
    } catch (err) {
      next(err)
    }
  })

  app.get('/api/memory/stats', (_req: Request, res: Response, next) => {
    try {
      if (!deps.memoryStats) {
        res.json({ available: false })
        return
      }
      res.json(deps.memoryStats.getStats())
    } catch (err) {
      next(err)
    }
  })

  app.get('/api/memory/files', (_req: Request, res: Response, next) => {
    try {
      if (!deps.memoryFiles) {
        res.json({ available: false, files: [] })
        return
      }
      const files = deps.memoryFiles.listFiles().map((f) => ({
        path: f.path,
        sizeBytes: f.sizeBytes,
        modifiedAt: new Date(f.mtimeMs).toISOString(),
        preview: f.content.slice(0, 200),
      }))
      files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
      res.json({ files })
    } catch (err) {
      next(err)
    }
  })

  // ── Memory Store Route ─────────────────────────────────────────

  app.post('/api/memory/store', async (req: Request, res: Response, next) => {
    try {
      if (!deps.memoryStore) {
        res.status(503).json({ error: 'Memory store not initialized', stored: false })
        return
      }
      const parsed = MemoryStoreSchema.safeParse(req.body)
      if (!parsed.success) {
        res
          .status(400)
          .json({ error: parsed.error.issues[0]?.message ?? 'Invalid request', stored: false })
        return
      }
      // The vault indexes only *.md files, but callers (extension tools pass
      // the model-chosen key verbatim) send bare keys like "project-decision".
      // Without this, the fact lands in an extensionless file no search will
      // ever return — stored-but-invisible data loss.
      const key = parsed.data.key.endsWith('.md') ? parsed.data.key : `${parsed.data.key}.md`
      const result = await deps.memoryStore.store(key, parsed.data.value)
      res.json(result)
    } catch (err) {
      next(err)
    }
  })

  // ── Memory Deletion Route (#71) ────────────────────────────────
  //
  // The broker OWNS its project's vault, so explicit deletion executes HERE rather than in a
  // second process opening a concurrent writable connection against a live vault. Preview is the
  // default; `apply: true` is the destructive call and is reported per step.

  app.post('/api/memory/delete', (req: Request, res: Response, next) => {
    try {
      if (!deps.memoryDeletion) {
        res.status(503).json({ error: 'Memory deletion not initialized', applied: false })
        return
      }
      const body = (req.body ?? {}) as Record<string, unknown>
      const path = typeof body['path'] === 'string' ? body['path'].trim() : ''
      if (!path) {
        res.status(400).json({ error: 'path is required', applied: false })
        return
      }
      const result = deps.memoryDeletion.run({
        path,
        apply: body['apply'] === true,
        hard: body['hard'] === true,
        allowPinned: body['allow_pinned'] === true,
      })
      res.json(result)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // A path that escapes the vault root is a client error, not a server fault.
      if (/traversal/i.test(message)) {
        res.status(400).json({ error: message, applied: false })
        return
      }
      next(err)
    }
  })

  // ── Negative Memory Routes ─────────────────────────────────────

  app.get('/api/memory/negative', (req: Request, res: Response, next) => {
    try {
      if (!deps.negativeMemoryStore) {
        res.status(503).json({ error: 'Negative memory store not initialized', memories: [] })
        return
      }
      const parsed = NegativeMemoryQuerySchema.safeParse(req.query)
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid query' })
        return
      }
      const memories = deps.negativeMemoryStore.list({
        target: parsed.data.target,
        limit: parsed.data.limit,
      })
      res.json({ memories, count: deps.negativeMemoryStore.count() })
    } catch (err) {
      next(err)
    }
  })

  app.get('/api/memory/negative/search', (req: Request, res: Response, next) => {
    try {
      if (!deps.negativeMemoryStore) {
        res.status(503).json({ error: 'Negative memory store not initialized', results: [] })
        return
      }
      const parsed = NegativeMemorySearchSchema.safeParse(req.query)
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid query' })
        return
      }
      const results = deps.negativeMemoryStore.search(parsed.data.q, parsed.data.limit)
      res.json({ results })
    } catch (err) {
      next(err)
    }
  })

  app.post('/api/memory/negative', (req: Request, res: Response, next) => {
    try {
      if (!deps.negativeMemoryStore) {
        res.status(503).json({ error: 'Negative memory store not initialized' })
        return
      }
      const parsed = CreateNegativeMemorySchema.safeParse(req.body)
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' })
        return
      }
      const mem = deps.negativeMemoryStore.storeFromTool(parsed.data)
      eventLog.stateUpdated(parsed.data.sessionId ?? null, {
        action: 'negative_memory_stored',
        memoryId: mem.id,
        category: mem.category,
        target: mem.recommendedTarget,
      })
      // W5.3: human-authored critique also becomes a High brain task. Storage
      // must never fail because task creation did — feedback is the record.
      let taskId: string | null = null
      if (mem.promptOrigin === 'human' && deps.onHumanNegativeFeedback) {
        try {
          taskId = deps.onHumanNegativeFeedback(mem)
        } catch (err) {
          logger.warn({ err, memoryId: mem.id }, 'human-feedback task creation failed')
        }
      }
      res.json({ stored: true, ...mem, ...(taskId ? { taskId } : {}) })
    } catch (err) {
      next(err)
    }
  })

  app.post('/api/memory/negative/heuristic', (req: Request, res: Response, next) => {
    try {
      if (!deps.negativeMemoryStore) {
        res.status(503).json({ error: 'Negative memory store not initialized' })
        return
      }
      const parsed = HeuristicNegativeMemorySchema.safeParse(req.body)
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' })
        return
      }
      const mem = deps.negativeMemoryStore.storeFromHeuristic(parsed.data)
      res.json({ stored: true, id: mem.id })
    } catch (err) {
      next(err)
    }
  })

  // ── Memory Management Routes ──────────────────────────────────

  app.get('/api/memory/lessons', (_req: Request, res: Response, next) => {
    try {
      if (!deps.memoryLessons) {
        res.status(503).json({ error: 'Memory lessons not initialized', lessons: [] })
        return
      }
      const lessons = deps.memoryLessons.list()
      res.json({ lessons, count: lessons.length })
    } catch (err) {
      next(err)
    }
  })

  // Phase 13.12.11 — scoped lessons (YAML frontmatter) filtered by caller context
  app.get('/api/memory/scoped-lessons', (req: Request, res: Response, next) => {
    try {
      if (!deps.lessonStore) {
        res.json({ available: false, lessons: [], groups: {} })
        return
      }
      const filter: { cwd?: string; project?: string; agent?: string } = {}
      const cwd = req.query['cwd']
      const project = req.query['project']
      const agent = req.query['agent']
      if (typeof cwd === 'string' && cwd) filter.cwd = cwd
      if (typeof project === 'string' && project) filter.project = project
      if (typeof agent === 'string' && agent) filter.agent = agent
      const hasFilter = Object.keys(filter).length > 0
      const all = deps.lessonStore.list()
      const filtered = hasFilter ? deps.lessonStore.list(filter) : all
      const groups = deps.lessonStore.groupByScope(filtered)
      res.json({
        available: true,
        count: filtered.length,
        totalCount: all.length,
        lessons: filtered,
        groups,
      })
    } catch (err) {
      next(err)
    }
  })

  app.post('/api/memory/archive', (req: Request, res: Response, next) => {
    try {
      if (!deps.memoryLessons) {
        res.status(503).json({ error: 'Memory lessons not initialized' })
        return
      }
      const { entryId, reason, note } = req.body as {
        entryId?: string
        reason?: string
        note?: string
      }
      if (!entryId || !reason) {
        res.status(400).json({ error: 'entryId and reason are required' })
        return
      }
      const validReasons = [
        'user-rejected',
        'deprioritized',
        'superseded',
        'low-value',
        'old',
        'duplicate',
        'pruned',
      ]
      if (!validReasons.includes(reason)) {
        res
          .status(400)
          .json({ error: `Invalid reason. Must be one of: ${validReasons.join(', ')}` })
        return
      }
      const result = deps.memoryLessons.archiveEntry(entryId, reason, note)
      if (result.success) {
        res.json({ success: true, archivedId: result.archivedId })
      } else {
        res.status(404).json({ error: 'Entry not found' })
      }
    } catch (err) {
      next(err)
    }
  })

  app.get('/api/memory/archive', (_req: Request, res: Response, next) => {
    try {
      if (!deps.archiveStore) {
        res.status(503).json({ error: 'Archive store not initialized', entries: [] })
        return
      }
      const entries = deps.archiveStore.list()
      res.json({ entries, count: entries.length })
    } catch (err) {
      next(err)
    }
  })

  app.get('/api/memory/tiers', (_req: Request, res: Response, next) => {
    try {
      if (!deps.memoryTiers) {
        res.status(503).json({ error: 'Memory tiers not initialized' })
        return
      }
      res.json(deps.memoryTiers.getTierSummary())
    } catch (err) {
      next(err)
    }
  })

  // ── Extension API Routes ───────────────────────────────────────

  app.get('/api/extension/config', (_req: Request, res: Response, next) => {
    try {
      const stateEntry = getState(db, 'extension.config')
      if (stateEntry) {
        try {
          const config = JSON.parse(stateEntry.value)
          res.json({
            contextInjectionEnabled: config.contextInjectionEnabled ?? false,
            maxMemories: config.maxMemories ?? 5,
            maxSuggestions: config.maxSuggestions ?? 3,
          })
          return
        } catch {
          // Invalid JSON in state — return defaults
        }
      }
      res.json({
        contextInjectionEnabled: false,
        maxMemories: 5,
        maxSuggestions: 3,
      })
    } catch (err) {
      next(err)
    }
  })

  app.post('/api/extension/context', async (req: Request, res: Response, next) => {
    try {
      const parsed = ExtensionContextSchema.safeParse(req.body)
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' })
        return
      }

      const parts: string[] = []
      let memoriesUsed = 0
      let suggestionsUsed = 0
      let experienceId: number | undefined

      // Issue #75: the memory briefing below is already relevance-ranked against the prompt;
      // the suggestion and negative-rule blocks used to inject in store order regardless of
      // topic. Both now share ONE lexical scorer (zero embedding work on this hot path —
      // the briefing already spends that budget). SCNS_INJECTION_RELEVANCE=0 restores the
      // unfiltered store-order behavior for both blocks.
      const relevanceScore = injectionRelevanceEnabled()
        ? makePromptRelevanceScorer(parsed.data.prompt)
        : null

      // Search memory if available
      if (deps.memorySearch) {
        try {
          if (typeof deps.memorySearch.briefing === 'function') {
            // MAGMA live briefing — inject the Stage-4 synthesized context directly (already a formatted
            // "Relevant SCNS memories" block). Reverts to the plain join below via SCNS_LIVE_MEMORY_BRIEFING.
            // N1: thread the client session key so the experience row carries a session scope, and KEEP the
            // experienceId (it used to be dropped here) so a human outcome can bind to this exact retrieval.
            // GATE: also thread cwd — the robust fallback session key when sessionId is absent at the hook.
            const b = (await deps.memorySearch.briefing(parsed.data.prompt, 5, {
              ...(parsed.data.sessionId ? { sessionId: parsed.data.sessionId } : {}),
              ...(parsed.data.cwd ? { cwd: parsed.data.cwd } : {}),
              ...(parsed.data.clientTimeoutMs
                ? { clientTimeoutMs: parsed.data.clientTimeoutMs }
                : {}),
            })) as {
              text?: string
              chunkIds?: readonly number[]
              experienceId?: number
            }
            if (b?.text) {
              parts.push(b.text)
              memoriesUsed = b.chunkIds?.length ?? 0
            }
            if (typeof b?.experienceId === 'number') experienceId = b.experienceId
          } else {
            const results = (await deps.memorySearch.search(parsed.data.prompt, 5)) as {
              results?: readonly { content?: string }[]
            }
            if (results?.results?.length) {
              const memories = results.results
                .filter((r): r is { content: string } => !!r.content)
                .map((r) => r.content)
              if (memories.length > 0) {
                parts.push('Relevant SCNS memories:\n' + memories.join('\n'))
                memoriesUsed = memories.length
              }
            }
          }
        } catch {
          // Memory search failed, continue without
        }
      }

      // Get pending suggestions if available
      if (deps.suggestionStore) {
        try {
          const suggestions = deps.suggestionStore.listByStatus('pending') as readonly {
            title?: string
            description?: string
          }[]
          // Relevance mode injects NOTHING when no pending suggestion matches the prompt:
          // suggestions are nudges, not guardrails — an off-topic nudge is pure noise, and
          // the dashboard still lists everything pending. (Flip-back keeps the old first-3.)
          const summaries = relevanceScore
            ? suggestions
                .map((s, i) => ({ text: s.title ?? s.description ?? '', i }))
                .map((s) => ({ ...s, score: relevanceScore(s.text) }))
                .filter((s) => s.score > 0)
                .sort((a, b) => b.score - a.score || a.i - b.i)
                .slice(0, 3)
                .map((s) => s.text)
            : suggestions.slice(0, 3).map((s) => s.title ?? s.description ?? '')
          if (summaries.length > 0) {
            parts.push('Pending SCNS suggestions:\n' + summaries.join('\n'))
            suggestionsUsed = summaries.length
          }
        } catch {
          // Suggestion store failed, continue without
        }
      }

      // Get negative memories (things NOT to do). Fetch a WIDE page and let the shared critic
      // predicate decide what survives — the limit applies to eligible rules, not to raw rows, so
      // critic-suppressed noise can no longer consume the whole injection budget.
      if (deps.negativeMemoryStore) {
        try {
          const negMemories = deps.negativeMemoryStore.list({
            limit: NEGATIVE_MEMORY_SCAN_LIMIT,
          }) as readonly (ClassifiableNegativeMemory & { dontRule?: string; category?: string })[]
          const categoryOf = new Map<string, string | undefined>()
          for (const m of negMemories) if (m.dontRule) categoryOf.set(m.dontRule, m.category)

          // Relevance for rules runs AFTER the critic gate (quality first, topicality second)
          // and keeps a floor: pinned rules always inject, and universally-phrased guardrails
          // top up to NEGATIVE_RULE_RELEVANCE_FLOOR when the prompt matches fewer than that.
          const rules = selectInjectableNegativeRules(negMemories, {
            limit: 10,
            ...(relevanceScore
              ? { relevance: { score: relevanceScore, floor: NEGATIVE_RULE_RELEVANCE_FLOOR } }
              : {}),
          }).map((rule) => {
            const category = categoryOf.get(rule)
            return `- ${rule}${category ? ` [${category}]` : ''}`
          })
          if (rules.length > 0) {
            parts.push(
              'IMPORTANT — Things to AVOID (learned from past feedback):\n' + rules.join('\n'),
            )
          }
        } catch {
          // Negative memory store failed, continue without
        }
      }

      if (parts.length === 0) {
        res.json({
          additionalContext: null,
          memoriesUsed: 0,
          suggestionsUsed: 0,
          ...(experienceId !== undefined ? { experienceId } : {}),
        })
        return
      }

      res.json({
        additionalContext: parts.join('\n\n'),
        memoriesUsed,
        suggestionsUsed,
        ...(experienceId !== undefined ? { experienceId } : {}),
      })
    } catch (err) {
      next(err)
    }
  })

  // ── Sessions Alias ─────────────────────────────────────────────

  app.get('/api/sessions', (req: Request, res: Response, next) => {
    try {
      const status = req.query.status as string | undefined
      const includeArchived = req.query.include_archived === 'true'
      const sessions = findAllSessions(db, status, includeArchived)
      res.json({ sessions })
    } catch (error) {
      next(error)
    }
  })

  // ── OTel Routes ───────────────────────────────────────────────

  app.get('/api/otel/traces', (req: Request, res: Response, next) => {
    try {
      const parsed = OtelTracesQuerySchema.safeParse(req.query)
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid query' })
        return
      }
      const { limit, offset, start_after, start_before, name, status } = parsed.data
      const traces = findTraces(db, {
        limit,
        offset,
        startAfter: start_after,
        startBefore: start_before,
        name,
        status,
      })
      res.json({ traces })
    } catch (err) {
      next(err)
    }
  })

  app.get('/api/otel/traces/:traceId', (req: Request, res: Response, next) => {
    try {
      const traceId = param(req, 'traceId')
      const spans = findSpansByTraceId(db, traceId)
      if (spans.length === 0) {
        throw new NotFoundError('Trace', traceId)
      }
      const tree = assembleTraceTree(spans)
      res.json({ trace_id: traceId, spans, tree })
    } catch (err) {
      next(err)
    }
  })

  app.get('/api/otel/metrics/summary', (req: Request, res: Response, next) => {
    try {
      const since = req.query['since'] as string | undefined
      const summary = getMetricsSummary(db, since ? { since } : undefined)
      res.json(summary)
    } catch (err) {
      next(err)
    }
  })

  app.get('/api/otel/metrics/timeseries', (req: Request, res: Response, next) => {
    try {
      const parsed = OtelTimeseriesQuerySchema.safeParse(req.query)
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid query' })
        return
      }
      const { metric, since, interval } = parsed.data
      const buckets = getMetricsTimeseries(db, metric, { since, interval })
      res.json({ buckets })
    } catch (err) {
      next(err)
    }
  })

  app.get('/api/otel/config', (_req: Request, res: Response, next) => {
    try {
      const config = loadOtelConfig()
      res.json({ config })
    } catch (err) {
      next(err)
    }
  })

  app.patch('/api/otel/config', (req: Request, res: Response, next) => {
    try {
      const body = req.body as Record<string, unknown> | undefined
      if (!body || typeof body !== 'object') {
        res.status(400).json({ error: 'Request body required' })
        return
      }

      // Apply recognized fields to env vars (takes effect on next loadOtelConfig() call)
      if (typeof body['enabled'] === 'boolean') {
        process.env['OTEL_SCNS_ENABLED'] = body['enabled'] ? 'true' : 'false'
      }
      if (typeof body['filePath'] === 'string') {
        const filePath = body['filePath']
        // Security: validate path is under allowed directories (home dir,
        // the OS temp dir, or posix /tmp — the latter never matches on
        // win32, where the OS temp dir is the equivalent).
        const resolvedPath = resolve(filePath.replace(/^~(?=\/|$)/, homedir()))
        const home = homedir()
        const tmp = tmpdir()
        const underTmpDir = resolvedPath.startsWith(tmp.endsWith(sep) ? tmp : tmp + sep)
        if (!resolvedPath.startsWith(home) && !resolvedPath.startsWith('/tmp/') && !underTmpDir) {
          res.status(400).json({ error: 'filePath must be under home directory or the temp dir' })
          return
        }
        if (resolvedPath.includes('..')) {
          res.status(400).json({ error: 'filePath must not contain path traversal' })
          return
        }
        process.env['OTEL_SCNS_FILE_PATH'] = resolvedPath
      }
      if (typeof body['retentionDays'] === 'number' && body['retentionDays'] > 0) {
        process.env['OTEL_SCNS_RETENTION_DAYS'] = String(body['retentionDays'])
      }
      if (typeof body['pollIntervalMs'] === 'number' && body['pollIntervalMs'] > 0) {
        process.env['OTEL_SCNS_POLL_INTERVAL_MS'] = String(body['pollIntervalMs'])
      }

      const config = loadOtelConfig()
      res.json({
        config,
        note: 'Configuration updated. Some changes require restart to take effect.',
      })
    } catch (err) {
      next(err)
    }
  })

  // ── Orchestrator Overview (Phase 13.7) ───────────────────────
  // Single aggregated endpoint for the dashboard orchestrator page.
  // Returns teams + members, pending suggestions, recent quality-gate verdicts,
  // recent team completions, and recent cross-team messages in one call.
  //
  // Supports ?since=<ISO8601 | 1h | 24h | 7d | all> (default 24h) applied to
  // verdicts, completions, scalingDecisions, and messages.
  app.get('/api/orchestrator/overview', (req: Request, res: Response, next) => {
    try {
      const since = parseSinceParam(req.query['since'])

      // Teams with members + heartbeat joined from sessions
      const sessions = findAllSessions(db)
      const sessionById = new Map<string, (typeof sessions)[number]>()
      for (const s of sessions) sessionById.set(s.id, s)
      const teams = findAllTeams(db).map((team) => {
        const members = findTeamMembers(db, team.id).map((m) => {
          const sess = sessionById.get(m.session_id)
          return {
            session_id: m.session_id,
            name: m.name,
            role: m.role,
            agent_type: m.agent_type ?? null,
            status: m.status,
            joined_at: m.joined_at,
            last_heartbeat: sess?.last_heartbeat ?? null,
            session_status: sess?.status ?? null,
          }
        })
        return { ...team, members }
      })

      // Suggestions "in-flight" = pending | approved | in-progress only.
      // Terminal statuses (implemented, rejected, failed, needs-human,
      // blocked-autonomy) are excluded so the card reflects live work.
      const suggestions = listInFlightSuggestions(deps.suggestionStore)

      // Quality gate verdicts (last 20, newest first), filtered by since
      const verdicts = getEventsSinceFiltered(db, {
        afterId: 0,
        eventTypes: ['quality_gate_verdict'],
        limit: 20,
        newestFirst: true,
        ...(since ? { since } : {}),
      })

      // Team completions (last 20, newest first) — includes stagedDiff preview
      const completions = getEventsSinceFiltered(db, {
        afterId: 0,
        eventTypes: ['team_completed'],
        limit: 20,
        newestFirst: true,
        ...(since ? { since } : {}),
      })

      // Recent cross-team messages (last 20, filtered)
      const messages = listRecentRealMessages(db, 20, since)

      // Phase 13.12.13: recent scaling-policy decisions with joined outcome
      const scalingDecisions = findRecentScalingDecisions(db, 20, since).map((d) => ({
        ...d,
        roles: JSON.parse(d.roles_json) as string[],
      }))

      res.json({
        teams,
        suggestions,
        verdicts,
        completions,
        messages,
        scalingDecisions,
      })
    } catch (err) {
      next(err)
    }
  })

  // ── Orchestrator standalone endpoints (since-aware) ──────────
  // Default window: 24h. Pass ?since=all to disable the filter.
  // Accepted formats: ISO-8601 timestamp, or relative 1h|24h|7d|all.

  app.get('/api/orchestrator/suggestions-in-flight', (_req: Request, res: Response, next) => {
    try {
      const suggestions = listInFlightSuggestions(deps.suggestionStore)
      res.json({ suggestions })
    } catch (err) {
      next(err)
    }
  })

  app.get('/api/orchestrator/verdicts', (req: Request, res: Response, next) => {
    try {
      const since = parseSinceParam(req.query['since'])
      const verdicts = getEventsSinceFiltered(db, {
        afterId: 0,
        eventTypes: ['quality_gate_verdict'],
        limit: 50,
        newestFirst: true,
        ...(since ? { since } : {}),
      })
      res.json({ verdicts })
    } catch (err) {
      next(err)
    }
  })

  app.get('/api/orchestrator/completions', (req: Request, res: Response, next) => {
    try {
      const since = parseSinceParam(req.query['since'])
      const completions = getEventsSinceFiltered(db, {
        afterId: 0,
        eventTypes: ['team_completed'],
        limit: 50,
        newestFirst: true,
        ...(since ? { since } : {}),
      })
      res.json({ completions })
    } catch (err) {
      next(err)
    }
  })

  app.get('/api/orchestrator/scaling-decisions', (req: Request, res: Response, next) => {
    try {
      const since = parseSinceParam(req.query['since'])
      const limit = Math.min(
        100,
        Math.max(1, parseInt(String(req.query['limit'] ?? '50'), 10) || 50),
      )
      const decisions = findRecentScalingDecisions(db, limit, since).map((d) => ({
        ...d,
        roles: JSON.parse(d.roles_json) as string[],
      }))
      res.json({ decisions })
    } catch (err) {
      next(err)
    }
  })

  app.get('/api/orchestrator/recent-messages', (req: Request, res: Response, next) => {
    try {
      const since = parseSinceParam(req.query['since'])
      const limit = Math.min(
        200,
        Math.max(1, parseInt(String(req.query['limit'] ?? '50'), 10) || 50),
      )
      const messages = listRecentRealMessages(db, limit, since)
      res.json({ messages })
    } catch (err) {
      next(err)
    }
  })

  // Phase 13.12.13: standalone endpoint for scaling decisions
  app.get('/api/orchestrator/decisions', (req: Request, res: Response, next) => {
    try {
      const limit = Math.min(
        100,
        Math.max(1, parseInt(String(req.query['limit'] ?? '20'), 10) || 20),
      )
      const decisions = findRecentScalingDecisions(db, limit).map((d) => ({
        ...d,
        roles: JSON.parse(d.roles_json) as string[],
      }))
      res.json({ decisions })
    } catch (err) {
      next(err)
    }
  })

  // ── SSE Stream ────────────────────────────────────────────────

  app.get('/api/events/stream', (req: Request, res: Response) => {
    try {
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.flushHeaders()

      let lastId = parseInt(req.query['since'] as string, 10) || 0
      const interval = setInterval(() => {
        try {
          const events = eventLog.since(lastId)
          for (const event of events) {
            res.write(`id: ${event.id}\n`)
            res.write(`event: ${event.event_type}\n`)
            res.write(`data: ${JSON.stringify(event)}\n\n`)
            lastId = event.id
          }
        } catch {
          clearInterval(interval)
        }
      }, 1000)

      res.on('close', () => {
        clearInterval(interval)
      })
    } catch {
      // SSE setup failed — connection already closed, nothing to do
    }
  })
}
