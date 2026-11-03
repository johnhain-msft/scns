import { loadConfig, ensureDbDirectory } from './config.js'
import { openDatabase, closeDatabase } from './storage/db.js'
import { createEventLog } from './services/event-log.js'
import { createBrokerServer } from './server.js'
import type { ToolProfile } from './tool-profiles.js'
import { startHeartbeatPoller } from './heartbeat-poller.js'
import { cleanupStaleSessionsOnStartup } from './startup-cleanup.js'
import { createRespawnController } from './services/respawn-controller.js'
import { handleSpawnAgent } from './tools/spawn-agent.js'
import { createAgentSpawner } from './services/agent-spawner.js'
import { logger } from './logger.js'
import { ShutdownManager } from './shutdown.js'
import { createEventDispatcher } from './event-dispatcher.js'

const config = loadConfig()
ensureDbDirectory(config.dbPath)
const db = openDatabase(config.dbPath)
const dispatcher = createEventDispatcher()
const eventLog = createEventLog(db, dispatcher)

const cleaned = cleanupStaleSessionsOnStartup(db, eventLog)
if (cleaned.sessions > 0 || cleaned.teams > 0 || cleaned.tasks > 0) {
  logger.info(
    { sessions: cleaned.sessions, teams: cleaned.teams, tasks: cleaned.tasks },
    'Startup cleanup completed',
  )
}

eventLog.brokerStarted({ port: config.port })

const shutdownManager = new ShutdownManager()
const defaultProfile = (process.env.BROKER_DEFAULT_PROFILE ?? 'bootstrap') as ToolProfile
const broker = createBrokerServer(db, eventLog, shutdownManager, dispatcher, { defaultProfile })
const spawner = createAgentSpawner(db, eventLog)

const respawnController = createRespawnController(
  db,
  eventLog,
  {
    autoRespawn: config.autoRespawn,
    maxRetries: config.maxRespawnRetries,
    backoffBaseMs: config.respawnBackoffBaseMs,
  },
  (input) => handleSpawnAgent(db, eventLog, input, spawner),
)

const heartbeatPoller = startHeartbeatPoller(db, eventLog, {
  intervalMs: 30_000,
  graceSeconds: config.zombieGraceMs / 1000,
  respawnController,
})

const httpServer = broker.app.listen(config.port, () => {
  logger.info({ port: config.port }, 'Session broker listening')
})

httpServer.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    logger.error(
      { port: config.port, code: err.code },
      'Port is already in use. Find the process with `ss -tlnp | grep <port>` and kill it, or use a different port with BROKER_PORT=<port>',
    )
  } else {
    logger.error({ err }, 'Failed to start broker')
  }
  heartbeatPoller.stop()
  closeDatabase(db)
  process.exit(1)
})

// Register cleanup functions in order:
// 1. Event log (record shutdown), 2. Spawner (kill child agents),
// 3. MCP transports (close before HTTP), 4. Heartbeat poller,
// 5. HTTP server, 6. Database, 7. Log flush
shutdownManager.register('event-log', async () => {
  eventLog.brokerStopped({ reason: 'shutdown' })
})

shutdownManager.register('agent-spawner', async () => {
  spawner.shutdownAll()
})

shutdownManager.register('mcp-transports', async () => {
  await broker.close()
})

shutdownManager.register('heartbeat-poller', async () => {
  heartbeatPoller.stop()
})

shutdownManager.register('http-server', async () => {
  await new Promise<void>((resolve, reject) => {
    httpServer.close((err) => {
      if (err) { reject(err) } else { resolve() }
    })
  })
})

shutdownManager.register('database', async () => {
  closeDatabase(db)
})

shutdownManager.register('log-flush', async () => {
  logger.flush()
})

process.on('SIGINT', () => { void shutdownManager.shutdown().then(() => { process.exit(0) }) })
process.on('SIGTERM', () => { void shutdownManager.shutdown().then(() => { process.exit(0) }) })
