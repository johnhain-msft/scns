import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import express from 'express'
import type { Request, Response } from 'express'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import type Database from 'better-sqlite3'
import type { EventLog } from './services/event-log.js'
import { createHealthRouter } from './health.js'
import { logger } from './logger.js'
import { createErrorHandler } from './middleware/error-handler.js'
import { SSEManager } from './sse-manager.js'
import type { EventDispatcher } from './event-dispatcher.js'
import { createGlobalLimiter } from './middleware/rate-limiter.js'
import { createAuthMiddleware } from './middleware/auth.js'
import { createAgentSpawner } from './services/agent-spawner.js'
import { startedAt } from './tools/broker-info.js'
import { shutdownMiddleware, type ShutdownManager } from './shutdown.js'
import { registerTools } from './tools/register-tools.js'
import { applyProfile } from './tool-filter.js'
import type { ToolProfile } from './tool-profiles.js'
import { registerRoutes } from './routes/index.js'

// Read version from package.json once at module load (not per-request)
const __healthDirname = dirname(fileURLToPath(import.meta.url))
const PACKAGE_VERSION: string = (() => {
  try {
    const raw = readFileSync(join(__healthDirname, '../../package.json'), 'utf-8')
    return (JSON.parse(raw) as { version: string }).version
  } catch {
    return '0.0.0'
  }
})()

interface ActiveTransport {
  readonly transport: StreamableHTTPServerTransport
  readonly server: McpServer
}

export interface BrokerServer {
  readonly app: express.Express
  readonly transports: Map<string, ActiveTransport>
  close(): Promise<void>
}


export interface BrokerServerOptions {
  /** Default tool profile for new MCP sessions. Defaults to 'bootstrap'. */
  readonly defaultProfile?: ToolProfile
}

export function createBrokerServer(db: Database.Database, eventLog: EventLog, shutdownManager?: ShutdownManager, dispatcher?: EventDispatcher, options?: BrokerServerOptions): BrokerServer {
  const defaultProfile = options?.defaultProfile ?? 'bootstrap'
  const spawner = createAgentSpawner(db, eventLog)
  const sseManager = new SSEManager()
  const app = express()
  app.use(express.json())

  // Global CORS middleware for dashboard and external clients
  app.use((_req: Request, res: Response, next: express.NextFunction) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id, Accept, Authorization')
    if (_req.method === 'OPTIONS') {
      res.status(204).end()
      return
    }
    next()
  })

  // Bearer token auth middleware (after CORS, before routes)
  app.use(createAuthMiddleware(process.env.BROKER_TOKEN ?? null))

  // Rate limiting — global limit applies to all routes (health & MCP exempt)
  app.use(createGlobalLimiter())

  // Shutdown middleware — reject new requests with 503 during graceful shutdown
  if (shutdownManager) {
    app.use(shutdownMiddleware(shutdownManager))
  }

  const transports = new Map<string, ActiveTransport>()

  // Ensure MCP clients send the Accept header the SDK requires.
  // Some clients (e.g. GitHub Copilot CLI) may omit text/event-stream.
  // NOTE: We must patch rawHeaders too because @hono/node-server reads
  // rawHeaders (not the parsed headers object) when converting to a
  // Web Standard Request for the MCP SDK transport.
  app.use('/mcp', (req: Request, _res: Response, next: express.NextFunction) => {
    const accept = req.headers.accept || ''
    const needsJson = !accept.includes('application/json')
    const needsSse = !accept.includes('text/event-stream')

    if (needsJson || needsSse) {
      // The SDK does a literal string check for both 'application/json' AND
      // 'text/event-stream'. Wildcards like */* don't satisfy it.
      const fixed = 'application/json, text/event-stream'

      // Patch the parsed headers object (used by Express itself)
      req.headers.accept = fixed

      // Patch rawHeaders array (used by @hono/node-server -> MCP SDK)
      const raw = req.rawHeaders
      let patched = false
      for (let i = 0; i < raw.length; i += 2) {
        if (raw[i].toLowerCase() === 'accept') {
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

  app.post('/mcp', async (req: Request, res: Response) => {
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
        version: '0.1.0',
      })

      const toolMap = registerTools(mcpServer, db, eventLog, spawner)
      applyProfile(toolMap, defaultProfile)
      await mcpServer.connect(transport)
      await transport.handleRequest(req, res, req.body)
      return
    }

    res.status(400).json({ error: 'Invalid request: missing session ID or not an initialize request' })
  })

  app.get('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined
    if (sessionId && transports.has(sessionId)) {
      const active = transports.get(sessionId)!
      await active.transport.handleRequest(req, res)
      return
    }
    res.status(400).json({ error: 'Invalid or missing session ID' })
  })

  app.delete('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined
    if (sessionId && transports.has(sessionId)) {
      const active = transports.get(sessionId)!
      await active.transport.handleRequest(req, res)
      return
    }
    res.status(400).json({ error: 'Invalid or missing session ID' })
  })

  // Health check endpoints (liveness, readiness, backward-compatible)
  app.use('/health', createHealthRouter({ db, version: PACKAGE_VERSION, startedAt }))


  // Register all REST API routes and SSE endpoints
  registerRoutes(app, { db, eventLog, sseManager, dispatcher })

  app.use(createErrorHandler(logger))

  return {
    app,
    transports,
    async close() {
      sseManager.closeAll()
      sseManager.stop()
      spawner.shutdownAll()
      const closePromises = Array.from(transports.values()).map(({ server }) => server.close())
      await Promise.all(closePromises)
      transports.clear()
    },
  }
}
