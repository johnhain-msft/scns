/**
 * Session broker server assembly.
 *
 * Creates and configures the Express 5 application with all middleware,
 * MCP endpoint, health router, and REST routes.
 */

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import express from 'express'
import type { Request, Response } from 'express'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import Database from 'better-sqlite3'
import type { EventLog } from './services/event-log.js'
import { createHealthRouter } from './health.js'
import { createProgressiveHealthRouter, type ProgressiveHealthDeps } from './progressive-health.js'
import {
  createFootprintRouter,
  computeFootprint,
  type FootprintTarget,
  type FootprintReport,
} from '../retention/footprint.js'
import { logger } from '../shared/logger.js'
import { getEmbeddingStatus } from '../memory/embeddings.js'
import { createErrorHandler } from './middleware/error-handler.js'
import { SSEManager } from './sse-manager.js'
import type { EventDispatcher } from './event-dispatcher.js'
import {
  createGlobalLimiter,
  createSessionWriteLimiter,
  createActiveRequestCounter,
} from './middleware/rate-limiter.js'
import { createAuthMiddleware } from './middleware/auth.js'
import { createSanitizeMiddleware } from './middleware/sanitize.js'
import { shutdownMiddleware, type ShutdownManager } from './shutdown.js'
import { registerTools } from './tools/register-tools.js'
import { registerRoutes } from './routes/index.js'
import { resolveProjectForPath } from '../meta-broker/registry.js'
import { resolveScnsHome } from '../shared/scns-home.js'
import { isAbsolutePath } from '../shared/paths.js'
import { registerDashboardRoutes } from './routes/dashboard-routes.js'
import { registerAdminRoutes } from './routes/admin-routes.js'
import { createRestartManager, type RestartManagerDeps } from './restart-manager.js'
import { applyOtelSchema } from '../otel/db.js'
import { createRuntimeMetrics } from './services/runtime-metrics.js'
import type { Decision } from '../brain/state-types.js'

/**
 * Minimal brain-agent interface used by the wake endpoint. Decoupled from the
 * full BrainAgent return type so the server doesn't pull in the whole brain
 * factory and so tests can inject a tiny stub.
 */
export interface BrainStatusSnapshot {
  readonly state: 'idle' | 'running' | 'deciding' | 'acting' | 'starting'
  readonly lastTickAt: string | null
  readonly ticksToday: number
  readonly currentDecisionId: number | null
  /** Pending suggestions — legacy alias of {@link pendingSuggestions} (dashboard reads it). */
  readonly queueDepth: number
  /** R3: the REAL brain task queue depth. */
  readonly taskQueueDepth: number
  /** Honest name for what {@link queueDepth} has always counted. */
  readonly pendingSuggestions: number
  readonly autonomy: number
  readonly isWoken: boolean
}

export interface BrainAgentHandle {
  wake(): Promise<Decision>
  isWakeInProgress(): boolean
  /** Phase 13.12.14: introspection for `GET /api/brain/status`. */
  getStatusSnapshot?(): BrainStatusSnapshot
}

const __healthDirname = dirname(fileURLToPath(import.meta.url))
const PACKAGE_VERSION: string = (() => {
  try {
    const raw = readFileSync(join(__healthDirname, '../../package.json'), 'utf-8')
    return (JSON.parse(raw) as { version: string }).version
  } catch {
    return '0.0.0'
  }
})()

const startedAt = Date.now()

function defaultFootprintTargets(): readonly FootprintTarget[] {
  const home = homedir()
  return [
    { label: 'telemetry-log', path: join(home, '.scns', 'telemetry', 'copilot-otel.jsonl') },
    { label: 'session-state', path: join(home, '.copilot', 'session-state') },
    { label: 'broker-db', path: join(home, '.session-broker', 'data.db') },
  ]
}

interface ActiveTransport {
  readonly transport: StreamableHTTPServerTransport
  readonly server: McpServer
}

export interface BrokerServer {
  readonly app: express.Express
  readonly transports: Map<string, ActiveTransport>
  setDashboardDeps(
    deps: Partial<
      Omit<import('./routes/dashboard-routes.js').DashboardRouteDeps, 'db' | 'eventLog'>
    >,
  ): void
  setProgressiveHealthDeps(deps: {
    getEmbeddingBackfillState?: () => import('./progressive-health.js').EmbeddingBackfillSnapshot
    getBrainStatus?: () => 'starting' | 'ready'
    getOtelStatus?: () => import('./progressive-health.js').OtelHealthSnapshot
  }): void
  setRestartManagerDeps(deps: Partial<RestartManagerDeps>): void
  setBrainAgent(agent: BrainAgentHandle | null): void
  /** Phase 13.12.17 — late-bind credential vault deps. */
  setSecretDeps(
    deps: Partial<{
      secretStore: import('../secrets/secret-store.js').SecretStore
      internalToken: string
    }>,
  ): void
  close(): Promise<void>
}

export interface BrokerServerOptions {
  readonly authToken?: string | null
  /**
   * W5 routing — path of the GLOBAL meta-broker registry
   * (`~/.scns/meta-broker.db`) consulted by `GET /api/meta/resolve` to map a
   * cwd to its child broker. Overridable for tests; missing file ⇒ the route
   * answers `no-meta-registry` (never throws).
   */
  readonly metaRegistryDbPath?: string
  /**
   * T056 [US5] — the immutable safety kernel; when present the outward MCP tools
   * (ask_human / consult_source) register, every call routed through its check chokepoint.
   */
  readonly safetyKernel?: import('./services/safety-kernel/safety-kernel.js').SafetyKernel
  /**
   * Multi-project foundation (P3): the project id this broker manages. When
   * set, new teams/sessions created via REST are stamped with it so the
   * project-scoped autospawner picks them up. See project-identity.ts.
   */
  readonly projectId?: string
  /**
   * Project root of a per-project child broker. When set, `/api/register`
   * refuses sessions whose working directory belongs to another project —
   * the guard against a session pinned to a reassigned child port.
   */
  readonly projectRoot?: string
  readonly rateLimits?: {
    readonly globalMax?: number
    readonly globalWindowMs?: number
    readonly sessionWriteMax?: number
    readonly sessionWriteWindowMs?: number
  }
  readonly memorySearch?: {
    search(query: string, topK: number): Promise<unknown>
    /** MAGMA live briefing (Stage-4): returns the synthesized memory context to inject. Optional so a
     *  legacy adapter (search-only) still works — the context route falls back to search()+plain join.
     *  N1: `opts.sessionId` scopes the re-ask credit assignment; the returned experienceId is threaded back. */
    briefing?(query: string, topK: number, opts?: { sessionId?: string }): Promise<unknown>
  }
  readonly memoryStore?: {
    store(key: string, value: string): Promise<{ stored: boolean; key: string }>
  }
  readonly memoryStats?: {
    getStats(): unknown
  }
  readonly suggestionStore?: {
    listByStatus(status: string): ReadonlyArray<unknown>
    approve(id: string): unknown
    reject(id: string): unknown
    save?(suggestion: import('../suggest/types.js').Suggestion): void
    retry?(id: string): unknown
    remove?(id: string): boolean
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
  readonly dreamDaemon?: {
    getStatus(): unknown
    triggerRun(force: boolean): Promise<unknown>
  }
  readonly handleSessionEvent?: (event: {
    readonly event: string
    readonly sessionId?: string
    readonly tool?: string
    readonly timestamp: string
    readonly metadata?: Record<string, unknown>
    readonly model?: string
    readonly toolArgs?: string
    readonly toolResult?: string
    readonly mcpServer?: string
    readonly skillName?: string
    readonly exitCode?: number
    readonly errorMessage?: string
    readonly traceId?: string
    readonly tokenUsage?: {
      readonly input?: number
      readonly output?: number
    }
  }) => { readonly id: string } | null
  readonly agentSpawner?: import('./services/agent-spawner.js').AgentSpawner
  readonly rotationController?: import('../context/rotation-controller.js').RotationController
  readonly compactionDetector?: import('../context/compaction-detector.js').CompactionDetector
  readonly costTracker?: import('../shared/cost-tracker.js').CostTracker
  readonly sentimentAnalyzer?: (text: string) => {
    readonly isNegative: boolean
    readonly overallScore: number
    readonly signals: ReadonlyArray<{ type: string; score: number; triggers: readonly string[] }>
    readonly dontRule?: string
    readonly subject?: string
    readonly recommendedTarget?: string
  }
  readonly negativeMemoryStore?: {
    storeFromHeuristic(input: {
      originalText: string
      dontRule: string
      category: string
      recommendedTarget: string
      confidence: number
      sessionId?: string
    }): { id: string }
  }
  readonly onSessionCompleted?: () => void
  readonly orchestrator?: import('./a2a/team-orchestrator.js').TeamOrchestrator
  readonly rateMonitor?: ReturnType<
    typeof import('../rate-limit/rate-monitor.js').createRateMonitor
  >
  /**
   * Phase 13.12.24 — completion gate. Returns true when `git -C <cwd>
   * diff --cached` would show staged changes. Defaults to a real-process
   * implementation; tests inject a deterministic stub.
   */
  readonly gitDiffChecker?: (cwd: string) => boolean
  /**
   * Phase 13.12.17 — credential vault.
   * When provided, the broker exposes `POST /api/secrets/:key/fetch`
   * guarded by the `X-SCNS-Internal-Token` header.
   */
  readonly secretStore?: import('../secrets/secret-store.js').SecretStore
  /**
   * Phase 13.12.17 — internal token required for secret fetches.
   * Generated once per broker lifetime; not exposed via dashboard.
   */
  readonly internalToken?: string
  /**
   * Max time (ms) a request to a late-bound dashboard route will wait for
   * `setDashboardDeps()` to be called before falling through to its degraded
   * response. Default: 5000. Set to 0 to disable the gate entirely.
   */
  readonly dashboardReadinessTimeoutMs?: number
  /**
   * Progressive readiness providers for `/api/health` (Phase 13.9.4).
   * Each is optional — falls back to 'idle'/'starting' when not provided.
   */
  readonly progressiveHealth?: {
    getEmbeddingBackfillState?: () => import('./progressive-health.js').EmbeddingBackfillSnapshot
    getBrainStatus?: () => 'starting' | 'ready'
    getOtelStatus?: () => import('./progressive-health.js').OtelHealthSnapshot
  }
  /**
   * On-disk footprint reporter for `/api/footprint`. Targets default to
   * the well-known SCNS paths (telemetry log, ~/.copilot/session-state,
   * ~/.session-broker/data.db) when not supplied. `getLastRotationAt`
   * lets the rotation daemon surface its most recent rotation timestamp.
   */
  readonly footprint?: {
    targets?: readonly FootprintTarget[]
    getLastRotationAt?: () => string | null
    compute?: () => Promise<FootprintReport>
  }
}

export function createBrokerServer(
  db: Database.Database,
  eventLog: EventLog,
  shutdownManager?: ShutdownManager,
  dispatcher?: EventDispatcher,
  options?: BrokerServerOptions,
): BrokerServer {
  const sseManager = new SSEManager()
  const app = express()

  // 1. JSON parsing (64KB body limit) + input sanitization
  app.use(express.json({ limit: '64kb' }))
  app.use(createSanitizeMiddleware())

  // 1a. Active-request counter (powers /api/admin/health drain polling).
  //     Must be added before drain/shutdown middleware so in-flight writes
  //     are reflected in the count while draining.
  const activeRequestCounter = createActiveRequestCounter()
  app.use(activeRequestCounter.middleware)

  // 2. CORS
  app.use((_req: Request, res: Response, next: express.NextFunction) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, mcp-session-id, Accept, Authorization',
    )
    if (_req.method === 'OPTIONS') {
      res.status(204).end()
      return
    }
    next()
  })

  // 3. Auth
  const authToken =
    options?.authToken !== undefined ? options.authToken : (process.env.BROKER_TOKEN ?? null)
  app.use(createAuthMiddleware(authToken ?? null))

  // 4. Rate limiter (global IP-based) + per-session write limiter
  app.use(
    createGlobalLimiter({
      max: options?.rateLimits?.globalMax,
      windowMs: options?.rateLimits?.globalWindowMs,
    }),
  )
  app.use(
    createSessionWriteLimiter({
      windowMs: options?.rateLimits?.sessionWriteWindowMs ?? 60_000,
      max: options?.rateLimits?.sessionWriteMax ?? 10,
    }),
  )

  // 5. Shutdown middleware
  if (shutdownManager) {
    app.use(shutdownMiddleware(shutdownManager))
  }

  const transports = new Map<string, ActiveTransport>()

  // 6. Agent Card well-known endpoint
  app.get('/.well-known/agent.json', (_req: Request, res: Response) => {
    if (options?.orchestrator) {
      res.json(options.orchestrator.getWellKnownJson())
    } else {
      res.json({ agents: [] })
    }
  })

  // 7. MCP endpoint — ensure Accept header compatibility
  app.use('/mcp', (req: Request, _res: Response, next: express.NextFunction) => {
    const accept = req.headers.accept || ''
    const needsJson = !accept.includes('application/json')
    const needsSse = !accept.includes('text/event-stream')

    if (needsJson || needsSse) {
      const fixed = 'application/json, text/event-stream'
      req.headers.accept = fixed

      const raw = req.rawHeaders
      let patched = false
      for (let i = 0; i < raw.length; i += 2) {
        if (raw[i]!.toLowerCase() === 'accept') {
          raw[i + 1] = fixed
          patched = true
          break
        }
      }
      if (!patched) {
        raw.push('Accept', fixed)
      }
    }
    next()
  })

  app.post('/mcp', async (req: Request, res: Response, next) => {
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined

      if (sessionId && transports.has(sessionId)) {
        const active = transports.get(sessionId)!
        await active.transport.handleRequest(req, res, req.body)
        return
      }

      if (!sessionId && isInitializeRequest(req.body)) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports.set(id, { transport, server: mcpServer })
          },
          onsessionclosed: (id) => {
            transports.delete(id)
          },
        })

        const mcpServer = new McpServer({
          name: 'session-broker',
          version: PACKAGE_VERSION,
        })

        registerTools(mcpServer, db, eventLog, options?.projectId, options?.safetyKernel)
        await mcpServer.connect(transport)
        await transport.handleRequest(req, res, req.body)
        return
      }

      res
        .status(400)
        .json({ error: 'Invalid request: missing session ID or not an initialize request' })
    } catch (error) {
      next(error)
    }
  })

  app.get('/mcp', async (req: Request, res: Response, next) => {
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined
      if (sessionId && transports.has(sessionId)) {
        const active = transports.get(sessionId)!
        await active.transport.handleRequest(req, res)
        return
      }
      res.status(400).json({ error: 'Invalid or missing session ID' })
    } catch (error) {
      next(error)
    }
  })

  app.delete('/mcp', async (req: Request, res: Response, next) => {
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined
      if (sessionId && transports.has(sessionId)) {
        const active = transports.get(sessionId)!
        await active.transport.handleRequest(req, res)
        return
      }
      res.status(400).json({ error: 'Invalid or missing session ID' })
    } catch (error) {
      next(error)
    }
  })

  // 8. Health
  app.use(
    '/health',
    createHealthRouter({
      db,
      version: PACKAGE_VERSION,
      startedAt,
      isEmbeddingAvailable: () => getEmbeddingStatus() === 'ready',
    }),
  )

  // 8b. Progressive readiness — `/api/health` (Phase 13.9.4).
  // Mutable deps so cli.ts can late-bind the backfill runner + brain state
  // after they're constructed (post-listen).
  const progressiveHealthDeps: ProgressiveHealthDeps = {
    db,
    startedAt,
    getEmbeddingBackfillState: options?.progressiveHealth?.getEmbeddingBackfillState,
    getBrainStatus: options?.progressiveHealth?.getBrainStatus,
    getOtelStatus: options?.progressiveHealth?.getOtelStatus,
  }
  app.use('/api/health', createProgressiveHealthRouter(progressiveHealthDeps))

  // 8b-2. Disk footprint reporter — `/api/footprint`.
  // Surfaces current sizes for the telemetry log, session-state folders,
  // and broker DB plus the last rotation timestamp so operators can see
  // whether retention is keeping the on-disk footprint in check.
  const footprintTargets: readonly FootprintTarget[] =
    options?.footprint?.targets ?? defaultFootprintTargets()
  const getLastRotationAt = options?.footprint?.getLastRotationAt ?? (() => null)
  const footprintProvider =
    options?.footprint?.compute ??
    (async () =>
      computeFootprint({
        targets: footprintTargets,
        lastRotationAt: getLastRotationAt(),
      }))
  app.use('/api/footprint', createFootprintRouter(footprintProvider))

  // 8c. Runtime metrics — powers the auto-restart soak harness + stress test.
  // Returns RSS, heap, event-loop lag percentiles, and spawner stats. Resets
  // the event-loop histogram after each serve so p99/max are per-request-
  // window, not lifetime-cumulative (useful when the soak harness polls
  // every 5 s and needs to see recent lag spikes).
  const runtimeMetrics = createRuntimeMetrics({ spawner: options?.agentSpawner })
  app.get('/api/metrics/runtime', (_req: Request, res: Response) => {
    const snap = runtimeMetrics.snapshot()
    runtimeMetrics.reset()
    res.json(snap)
  })
  if (shutdownManager) {
    shutdownManager.register('runtime-metrics', async () => runtimeMetrics.stop())
  }

  // 9. REST routes
  registerRoutes(app, {
    db,
    eventLog,
    projectId: options?.projectId,
    projectRoot: options?.projectRoot,
    sseManager,
    dispatcher,
    shutdownFn: shutdownManager ? () => shutdownManager.shutdown() : undefined,
    handleSessionEvent: options?.handleSessionEvent,
    agentSpawner: options?.agentSpawner,
    orchestrator: options?.orchestrator,
    rateMonitor: options?.rateMonitor,
    rotationController: options?.rotationController,
    compactionDetector: options?.compactionDetector,
    costTracker: options?.costTracker,
    sentimentAnalyzer: options?.sentimentAnalyzer,
    negativeMemoryStore: options?.negativeMemoryStore,
    onSessionCompleted: options?.onSessionCompleted,
    gitDiffChecker: options?.gitDiffChecker,
  })

  // 10. Dashboard routes — deps object is mutable so setDashboardDeps() can late-bind.
  //     Late-bound deps (memorySearch, suggestionStore, observationManager, dreamDaemon,
  //     memory*, negativeMemoryStore, etc.) are typically wired by the CLI AFTER
  //     broker startup completes. Between `listen` and `setDashboardDeps`, there is
  //     a brief window where dashboard routes would return degraded ({available:false})
  //     responses. `whenReady` lets those routes wait (with timeout) until deps arrive.
  try {
    applyOtelSchema(db)
  } catch (err) {
    logger.warn({ err }, 'OTel schema migration failed — OTel routes may not work')
  }
  let markReady: () => void = () => {}
  const whenReady = new Promise<void>((resolve) => {
    markReady = resolve
  })
  const readinessTimeoutMs = options?.dashboardReadinessTimeoutMs ?? 5000
  const gateReadiness = readinessTimeoutMs > 0
  const dashboardDeps: import('./routes/dashboard-routes.js').DashboardRouteDeps = {
    db,
    eventLog,
    memorySearch: options?.memorySearch,
    memoryStore: options?.memoryStore,
    memoryStats: options?.memoryStats,
    suggestionStore: options?.suggestionStore,
    observationManager: options?.observationManager,
    dreamDaemon: options?.dreamDaemon,
    whenReady: gateReadiness ? whenReady : undefined,
    readinessTimeoutMs,
  }
  // If the caller never calls setDashboardDeps (e.g., minimal test harness),
  // treat the initially-provided deps as the final set after a short delay.
  // This avoids requests hanging until the 5-second route-level timeout.
  // Tests that wire deps via setDashboardDeps will flip ready immediately.
  let ready = false
  registerDashboardRoutes(app, dashboardDeps)

  // 11. Admin routes (restart lifecycle management)
  // Use mutable deps object so late-binding works (same pattern as dashboardDeps)
  const adminRestartDeps: RestartManagerDeps = {
    getActiveRequestCount: () => activeRequestCounter.count(),
  }
  const restartManager = createRestartManager(adminRestartDeps)
  if (shutdownManager) {
    registerAdminRoutes(app, {
      restartManager,
      shutdownManager,
      agentSpawner: options?.agentSpawner,
      db,
    })
  }

  // 11b. Brain wake endpoint — late-bound via setBrainAgent()
  const brainAgentRef: { current: BrainAgentHandle | null } = { current: null }
  app.post('/api/brain/wake', async (_req: Request, res: Response) => {
    const agent = brainAgentRef.current
    if (!agent) {
      res.status(503).json({ error: 'brain agent not available', available: false })
      return
    }
    if (agent.isWakeInProgress()) {
      res.status(202).json({ status: 'already-running' })
      return
    }
    try {
      const decision = await agent.wake()
      res.status(200).json({ status: 'woken', decision })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error({ err }, 'Brain wake endpoint failed')
      res.status(500).json({ error: `brain wake failed: ${message}` })
    }
  })

  // 11c. Brain status introspection — Phase 13.12.14
  app.get('/api/brain/status', (_req: Request, res: Response) => {
    const agent = brainAgentRef.current
    if (!agent || !agent.getStatusSnapshot) {
      res.status(503).json({ error: 'brain agent not available', available: false })
      return
    }
    try {
      const snap = agent.getStatusSnapshot()
      res.status(200).json(snap)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error({ err }, 'Brain status endpoint failed')
      res.status(500).json({ error: `brain status failed: ${message}` })
    }
  })

  // 11c-bis. W5 routing — resolve which child broker owns a filesystem path.
  // Consulted by the Copilot extension at startup so feedback typed in project
  // X lands on X's child broker. Reads the GLOBAL meta registry read-only;
  // every failure mode is an explicit `resolved:false` reason, never a 500.
  const metaRegistryDbPath =
    options?.metaRegistryDbPath ?? join(resolveScnsHome(), '.scns', 'meta-broker.db')
  app.get('/api/meta/resolve', (req: Request, res: Response) => {
    const path = typeof req.query['path'] === 'string' ? req.query['path'] : ''
    // Host-platform absolute check: `/...` on posix, `C:\...`/UNC on win32.
    // The old `startsWith('/')` rejected every Windows path → silent fallback
    // to the global broker, the exact cross-repo pollution v1 must prevent.
    if (!isAbsolutePath(path)) {
      res.status(400).json({ error: 'path query param must be an absolute path' })
      return
    }
    if (!existsSync(metaRegistryDbPath)) {
      res.status(200).json({ resolved: false, reason: 'no-meta-registry' })
      return
    }
    let metaDb: InstanceType<typeof Database> | null = null
    try {
      metaDb = new Database(metaRegistryDbPath, { readonly: true, fileMustExist: true })
      const project = resolveProjectForPath(metaDb, path)
      if (!project) {
        res.status(200).json({ resolved: false, reason: 'no-project-for-path' })
        return
      }
      if (project.status !== 'running' || project.boundPort === null) {
        res.status(200).json({
          resolved: false,
          reason: `child-${project.status}`,
          projectId: project.projectId,
          status: project.status,
        })
        return
      }
      res.status(200).json({
        resolved: true,
        projectId: project.projectId,
        projectRoot: project.projectRoot,
        boundPort: project.boundPort,
        status: project.status,
        brokerUrl: `http://127.0.0.1:${project.boundPort}`,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn({ err, metaRegistryDbPath }, 'meta-resolve failed')
      res.status(200).json({ resolved: false, reason: `registry-error: ${message}` })
    } finally {
      metaDb?.close()
    }
  })

  // 11d. Secret vault fetch — Phase 13.12.17.
  // Guarded by X-SCNS-Internal-Token header (64-hex token generated at
  // broker startup, injected only into spawned-agent env, never dashboard).
  // Dashboards and external callers WITHOUT the token → 401.
  const secretDeps: {
    store: import('../secrets/secret-store.js').SecretStore | null
    token: string | null
  } = {
    store: options?.secretStore ?? null,
    token: options?.internalToken ?? null,
  }
  app.post('/api/secrets/:key/fetch', (req: Request, res: Response) => {
    if (!secretDeps.store || !secretDeps.token) {
      res.status(503).json({ error: 'secret vault not available', available: false })
      return
    }
    const provided = req.header('X-SCNS-Internal-Token')
    if (!provided || provided !== secretDeps.token) {
      res.status(401).json({ error: 'unauthorized' })
      return
    }
    const rawKey = req.params['key']
    const key =
      typeof rawKey === 'string' ? decodeURIComponent(rawKey) : Array.isArray(rawKey) ? '' : ''
    try {
      const value = secretDeps.store.get(key)
      if (value === null) {
        res.status(404).json({ error: `secret not found: ${key}` })
        return
      }
      res.status(200).json({ key, value })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // Log only the key + error shape, never values.
      logger.warn({ key, err: message }, 'Secret fetch failed')
      res.status(400).json({ error: message })
    }
  })

  // 12. Catch-all 404 for unknown API routes
  app.all('/api/{*path}', (_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found' })
  })

  // 12. Error handler (must be last)
  app.use(createErrorHandler(logger))

  return {
    app,
    transports,
    setDashboardDeps(deps) {
      Object.assign(dashboardDeps, deps)
      if (!ready) {
        ready = true
        markReady()
      }
    },
    setProgressiveHealthDeps(deps) {
      if (deps.getEmbeddingBackfillState !== undefined) {
        progressiveHealthDeps.getEmbeddingBackfillState = deps.getEmbeddingBackfillState
      }
      if (deps.getBrainStatus !== undefined) {
        progressiveHealthDeps.getBrainStatus = deps.getBrainStatus
      }
      if (deps.getOtelStatus !== undefined) {
        progressiveHealthDeps.getOtelStatus = deps.getOtelStatus
      }
    },
    setRestartManagerDeps(deps: Partial<RestartManagerDeps>) {
      Object.assign(adminRestartDeps, deps)
    },
    setBrainAgent(agent: BrainAgentHandle | null) {
      brainAgentRef.current = agent
    },
    setSecretDeps(deps) {
      if (deps.secretStore !== undefined) secretDeps.store = deps.secretStore
      if (deps.internalToken !== undefined) secretDeps.token = deps.internalToken
    },
    async close() {
      sseManager.closeAll()
      sseManager.stop()
      const closePromises = Array.from(transports.values()).map(({ server }) => server.close())
      await Promise.allSettled(closePromises)
      transports.clear()
    },
  }
}
