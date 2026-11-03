/**
 * E2E: ACP (Agent Client Protocol) integration.
 *
 * Tests the ACP client against the real `copilot --acp` process.
 * These tests require the `copilot` CLI to be installed and authenticated.
 * They will be skipped if `copilot` is not available.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { execSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type Database from 'better-sqlite3'
import { openDatabase, closeDatabase } from '../../src/broker/storage/db.js'
import { createEventLog } from '../../src/broker/services/event-log.js'
import { createEventDispatcher } from '../../src/broker/event-dispatcher.js'
import { createBrokerServer, type BrokerServer } from '../../src/broker/server.js'
import { createAcpClient, type AcpClient } from '../../src/broker/services/acp-client.js'

function isCopilotAvailable(): boolean {
  try {
    execSync('command -v copilot', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const hasCopilot = isCopilotAvailable()
const describeAcp = hasCopilot ? describe : describe.skip

describeAcp('ACP E2E', () => {
  let db: Database.Database
  let broker: BrokerServer
  let server: Server
  let baseUrl: string
  let acpClients: AcpClient[] = []

  beforeAll(async () => {
    db = openDatabase(':memory:')
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(db, dispatcher)
    broker = createBrokerServer(db, eventLog, undefined, dispatcher, { authToken: null })
    server = createServer(broker.app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterEach(async () => {
    for (const client of acpClients) {
      try {
        await client.close()
      } catch {
        // Best effort
      }
    }
    acpClients = []
  })

  afterAll(async () => {
    await broker.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    closeDatabase(db)
  })

  it('initializes ACP connection to copilot', async () => {
    const client = createAcpClient({ initTimeoutMs: 30_000 })
    acpClients.push(client)

    const result = await client.initialize()

    expect(result.protocolVersion).toBe(1)
    expect(result.agentInfo).toBeDefined()
    expect(client.state).toBe('ready')
    expect(client.pid).toBeTypeOf('number')
  }, 45_000)

  it('creates a session and sends a prompt', async () => {
    const client = createAcpClient({
      initTimeoutMs: 30_000,
      promptTimeoutMs: 120_000,
    })
    acpClients.push(client)

    await client.initialize()

    const sessionId = await client.createSession(process.cwd())
    expect(sessionId).toBeTruthy()
    expect(typeof sessionId).toBe('string')

    // Collect streaming chunks
    const chunks: string[] = []
    client.onUpdate((update) => {
      if (update.update.sessionUpdate === 'agent_message_chunk') {
        chunks.push(update.update.content.text)
      }
    })

    const result = await client.sendPrompt(sessionId, 'Reply with exactly the word "pong" and nothing else.')
    expect(result.stopReason).toBe('end_turn')
    expect(result.output).toBeTruthy()
    expect(result.output.length).toBeGreaterThan(0)
    expect(chunks.length).toBeGreaterThan(0)
    // The accumulated output should match the chunks
    expect(result.output).toBe(chunks.join(''))
  }, 180_000)

  it('closes cleanly', async () => {
    const client = createAcpClient({ initTimeoutMs: 30_000 })
    acpClients.push(client)

    await client.initialize()
    expect(client.state).toBe('ready')

    await client.close()
    expect(client.state).toBe('closed')
  }, 45_000)

  it('rejects prompt on closed client', async () => {
    const client = createAcpClient({ initTimeoutMs: 30_000 })
    acpClients.push(client)

    await client.initialize()
    const sessionId = await client.createSession(process.cwd())
    await client.close()

    await expect(client.sendPrompt(sessionId, 'hello')).rejects.toThrow()
  }, 45_000)

  it('spawns ACP agent via broker spawn API', async () => {
    // Create a team first
    const teamRes = await fetch(`${baseUrl}/api/teams`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'acp-test-team' }),
    })
    expect(teamRes.status).toBe(201)
    const team = (await teamRes.json()) as { id: string }

    // Spawn an ACP agent
    const spawnRes = await fetch(`${baseUrl}/api/spawn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: team.id,
        name: 'acp-test-agent',
        role: 'dev',
        prompt: 'Reply with exactly "ready" and nothing else.',
        launch_method: 'acp',
      }),
    })

    // This may fail if the broker doesn't have the spawner wired
    // In E2E with in-memory broker, spawner is not available
    if (spawnRes.status === 503) {
      // Expected — spawner requires real CLI setup
      const body = (await spawnRes.json()) as { error: string }
      expect(body.error).toContain('not available')
      return
    }

    expect(spawnRes.status).toBe(201)
    const result = (await spawnRes.json()) as { launchMethod: string; acpSessionId: string }
    expect(result.launchMethod).toBe('acp')
    expect(result.acpSessionId).toBeTruthy()
  }, 60_000)
})
