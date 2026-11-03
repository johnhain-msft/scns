#!/usr/bin/env node

import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'

export interface CliArgs {
  readonly command: 'serve' | 'init' | 'apply'
  readonly port: number
  readonly dbPath: string
  readonly target?: Target
  readonly authToken?: string
  readonly manifestFile?: string
}

const DEFAULT_PORT = 3456
const DEFAULT_DB_PATH = join(homedir(), '.session-broker', 'data.db')

const VALID_TARGETS = ['claude', 'copilot', 'vscode', 'all'] as const
type Target = (typeof VALID_TARGETS)[number]

function isValidTarget(value: string): value is Target {
  return (VALID_TARGETS as ReadonlyArray<string>).includes(value)
}

export function parseArgs(argv: ReadonlyArray<string>): CliArgs {
  const hasInit = argv.includes('init')
  const hasApply = argv.includes('apply')
  const command = hasInit ? 'init' as const : hasApply ? 'apply' as const : 'serve' as const

  let port = DEFAULT_PORT
  let dbPath = DEFAULT_DB_PATH
  let target: Target | undefined = hasInit ? 'all' : undefined
  let authToken: string | undefined
  let manifestFile: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = argv[i + 1]

    if (arg === '--port' && next !== undefined) {
      const parsed = Number(next)
      if (Number.isFinite(parsed) && parsed > 0) {
        port = parsed
      }
      i++
    } else if (arg === '--db' && next !== undefined) {
      dbPath = next
      i++
    } else if (arg === '--target' && next !== undefined) {
      if (isValidTarget(next)) {
        target = next
      }
      i++
    } else if (arg === '--auth-token' && next !== undefined) {
      authToken = next
      i++
    } else if ((arg === '-f' || arg === '--file') && next !== undefined) {
      manifestFile = next
      i++
    }
  }

  return Object.freeze({
    command,
    port,
    dbPath,
    ...(target !== undefined ? { target } : {}),
    ...(authToken !== undefined ? { authToken } : {}),
    ...(manifestFile !== undefined ? { manifestFile } : {}),
  })
}

export function generateInitConfig(
  client: string,
  port: number,
  authToken?: string,
): string {
  const headers = authToken !== undefined
    ? { Authorization: `Bearer ${authToken}` }
    : undefined

  switch (client) {
    case 'claude':
      return JSON.stringify({
        mcpServers: {
          'session-broker': {
            type: 'http',
            url: `http://localhost:${port}/mcp`,
            ...(headers !== undefined ? { headers } : {}),
          },
        },
      }, null, 2)

    case 'copilot':
      return JSON.stringify({
        mcpServers: {
          'session-broker': {
            type: 'http',
            url: `http://localhost:${port}/mcp`,
            tools: ['*'],
            ...(headers !== undefined ? { headers } : {}),
          },
        },
      }, null, 2)

    case 'vscode':
      return JSON.stringify({
        servers: {
          'session-broker': {
            type: 'http',
            url: `http://localhost:${port}/mcp`,
            ...(headers !== undefined ? { headers } : {}),
          },
        },
      }, null, 2)

    default:
      return ''
  }
}

export interface WriteInitOptions {
  readonly target: string
  readonly port: number
  readonly authToken?: string
  readonly outputDir: string
}

interface ConfigTarget {
  readonly client: string
  readonly relativePath: string
}

const CONFIG_TARGETS: ReadonlyArray<ConfigTarget> = [
  { client: 'claude', relativePath: '.mcp.json' },
  { client: 'copilot', relativePath: join('.copilot', 'mcp-config.json') },
  { client: 'vscode', relativePath: join('.vscode', 'mcp.json') },
]

export async function writeInitConfigs(
  options: WriteInitOptions,
): Promise<ReadonlyArray<string>> {
  const targets = options.target === 'all'
    ? CONFIG_TARGETS
    : CONFIG_TARGETS.filter((t) => t.client === options.target)

  const writtenPaths: string[] = []

  for (const configTarget of targets) {
    const filePath = join(options.outputDir, configTarget.relativePath)
    const content = generateInitConfig(
      configTarget.client,
      options.port,
      options.authToken,
    )

    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, content + '\n', 'utf-8')
    writtenPaths.push(filePath)
  }

  return writtenPaths
}

const HELP_TEXT = `
session-broker - AI agent orchestration broker

Usage:
  session-broker [options]          Start the broker server
  session-broker init [options]     Generate MCP client config files
  session-broker apply -f <file>    Apply a team manifest (YAML)

Server options:
  --port <number>     Port to listen on (default: 3456)
  --db <path>         SQLite database path (default: ~/.session-broker/data.db)

Init options:
  --target <target>   Config target: claude, copilot, vscode, all (default: all)
  --port <number>     Port for generated URLs (default: 3456)
  --auth-token <tok>  Include Authorization header in generated configs

Apply options:
  -f, --file <path>   Path to team manifest YAML file
  --db <path>         SQLite database path (default: ~/.session-broker/data.db)

Examples:
  session-broker                          Start on default port 3456
  session-broker --port 4000              Start on port 4000
  session-broker init                     Generate configs for all clients
  session-broker init --target claude     Generate only .mcp.json
  session-broker init --auth-token abc    Generate configs with auth header
  session-broker apply -f team.yaml       Apply a team manifest
`.trim()

async function runCli(): Promise<void> {
  const rawArgs = process.argv.slice(2)

  if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
    process.stdout.write(HELP_TEXT + '\n')
    process.exit(0)
  }

  const args = parseArgs(rawArgs)

  if (args.command === 'init') {
    const target = args.target ?? 'all'

    const writtenFiles = await writeInitConfigs({
      target,
      port: args.port,
      authToken: args.authToken,
      outputDir: process.cwd(),
    })

    for (const filePath of writtenFiles) {
      process.stdout.write(`Created ${filePath}\n`)
    }
    process.exit(0)
  }

  if (args.command === 'apply') {
    if (!args.manifestFile) {
      process.stderr.write('ERROR: apply requires -f <file> argument\n')
      process.exit(1)
    }

    const { readFile } = await import('node:fs/promises')
    const { loadConfig, ensureDbDirectory } = await import('./config.js')
    const { openDatabase, closeDatabase } = await import('./storage/db.js')
    const { createEventLog } = await import('./services/event-log.js')
    const { parseManifest } = await import('./manifest/parser.js')
    const { reconcileManifest } = await import('./manifest/reconcile.js')

    let yamlContent: string
    try {
      yamlContent = await readFile(args.manifestFile, 'utf-8')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      process.stderr.write(`ERROR: Cannot read manifest file: ${message}\n`)
      process.exit(1)
    }

    const parsed = parseManifest(yamlContent)
    if (!parsed.ok) {
      process.stderr.write(`Manifest validation failed:\n${parsed.errors.join('\n')}\n`)
      process.exit(1)
    }

    if (args.dbPath !== DEFAULT_DB_PATH) {
      process.env.BROKER_DB_PATH = args.dbPath
    }

    const config = loadConfig()
    ensureDbDirectory(config.dbPath)
    const db = openDatabase(config.dbPath)
    const eventLog = createEventLog(db)

    try {
      const result = await reconcileManifest(db, eventLog, parsed.manifest)
      process.stdout.write(`Team '${result.team_name}' (${result.team_id}):\n`)
      process.stdout.write(`  Created: ${result.created}\n`)
      for (const role of result.roles) {
        process.stdout.write(`  Role '${role.role}': ${role.current} existing, ${role.spawned} spawned (desired: ${role.desired})\n`)
        for (const err of role.errors) {
          process.stderr.write(`    Error: ${err}\n`)
        }
      }
      process.stdout.write(`  Tasks: ${result.tasks.created} created, ${result.tasks.existed} existed, ${result.tasks.dependencies_set} deps set\n`)
      if (result.respawnPolicy) {
        process.stdout.write(`  Respawn policy: applied\n`)
      }
      if (result.scalingPolicy) {
        process.stdout.write(`  Scaling policy: applied\n`)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      process.stderr.write(`ERROR: Failed to apply manifest: ${message}\n`)
      closeDatabase(db)
      process.exit(1)
    }

    closeDatabase(db)
    process.exit(0)
  }

  // Serve mode — dynamically import heavy dependencies so that
  // parseArgs/generateInitConfig can be tested without loading the full server
  const [
    { loadConfig, ensureDbDirectory },
    { openDatabase, closeDatabase },
    { createEventLog },
    { createBrokerServer },
    { startHeartbeatPoller },
    { cleanupStaleSessionsOnStartup },
    { createRespawnController },
    { handleSpawnAgent },
    { createAgentSpawner },
  ] = await Promise.all([
    import('./config.js'),
    import('./storage/db.js'),
    import('./services/event-log.js'),
    import('./server.js'),
    import('./heartbeat-poller.js'),
    import('./startup-cleanup.js'),
    import('./services/respawn-controller.js'),
    import('./tools/spawn-agent.js'),
    import('./services/agent-spawner.js'),
  ])

  // Set env vars before loading config so loadConfig picks them up
  if (args.port !== DEFAULT_PORT) {
    process.env.BROKER_PORT = String(args.port)
  }
  if (args.dbPath !== DEFAULT_DB_PATH) {
    process.env.BROKER_DB_PATH = args.dbPath
  }

  const config = loadConfig()
  ensureDbDirectory(config.dbPath)
  const db = openDatabase(config.dbPath)
  const eventLog = createEventLog(db)

  const cleaned = cleanupStaleSessionsOnStartup(db, eventLog)
  if (cleaned.sessions > 0 || cleaned.teams > 0 || cleaned.tasks > 0) {
    process.stdout.write(
      `Startup cleanup: ${cleaned.sessions} sessions, ${cleaned.teams} teams, ${cleaned.tasks} tasks\n`
    )
  }

  eventLog.brokerStarted({ port: config.port })

  const defaultProfile = (process.env.BROKER_DEFAULT_PROFILE ?? 'bootstrap') as import('./tool-profiles.js').ToolProfile
  const broker = createBrokerServer(db, eventLog, undefined, undefined, { defaultProfile })
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
    process.stdout.write(`Session broker listening on port ${config.port}\n`)
  })

  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      process.stderr.write(
        `ERROR: Port ${config.port} is already in use.\n` +
        `Another process is occupying this port. To fix:\n` +
        `  1. Find it:  ss -tlnp | grep ${config.port}\n` +
        `  2. Kill it:  kill <PID>\n` +
        `  3. Or use a different port:  BROKER_PORT=${config.port + 1} npm run dev\n`
      )
    } else {
      process.stderr.write(`ERROR: Failed to start broker: ${err.message}\n`)
    }
    heartbeatPoller.stop()
    closeDatabase(db)
    process.exit(1)
  })

  async function shutdown(signal: string): Promise<void> {
    process.stdout.write(`\nReceived ${signal}. Shutting down...\n`)
    eventLog.brokerStopped({ reason: signal })

    spawner.shutdownAll()
    heartbeatPoller.stop()
    httpServer.close()
    await broker.close()
    closeDatabase(db)

    process.exit(0)
  }

  process.on('SIGINT', () => { void shutdown('SIGINT') })
  process.on('SIGTERM', () => { void shutdown('SIGTERM') })
}

// Only run when executed directly (not when imported for testing)
const isDirectExecution = process.argv[1]?.endsWith('cli.js') || process.argv[1]?.endsWith('cli.ts')
if (isDirectExecution) {
  void runCli()
}
