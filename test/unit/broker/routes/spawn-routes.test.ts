import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import http from 'node:http'
import { openDatabase, closeDatabase } from '../../../../src/broker/storage/db.js'
import { createEventLog } from '../../../../src/broker/services/event-log.js'
import { createBrokerServer, type BrokerServer } from '../../../../src/broker/server.js'
import type { AgentSpawner, SpawnResult } from '../../../../src/broker/services/agent-spawner.js'
import type Database from 'better-sqlite3'
import { createTeam } from '../../../../src/broker/services/team-orchestration.js'

function request(
  server: Server,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined
    const req = http.request(
      {
        hostname: 'localhost',
        port: (server.address() as { port: number }).port,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
          ...headers,
        },
      },
      (res) => {
        let responseBody = ''
        res.on('data', (chunk: Buffer) => {
          responseBody += chunk.toString()
        })
        res.on('end', () => {
          let parsed: unknown
          try {
            parsed = JSON.parse(responseBody)
          } catch {
            parsed = responseBody
          }
          resolve({ status: res.statusCode!, body: parsed })
        })
      },
    )
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

function makeSpawnResult(overrides?: Partial<SpawnResult>): SpawnResult {
  return {
    sessionId: 'team1234-worker-1234567890',
    teamId: 'team-abc',
    name: 'worker',
    role: 'dev',
    platform: 'darwin',
    launchMethod: 'detached',
    pid: 12345,
    tmuxSession: null,
    tmuxWindow: null,
    ...overrides,
  }
}

describe('Spawn routes — POST /api/spawn', () => {
  let db: Database.Database
  let broker: BrokerServer
  let server: Server
  let mockSpawner: AgentSpawner

  beforeEach(async () => {
    db = openDatabase(':memory:')
    const eventLog = createEventLog(db)
    mockSpawner = {
      spawn: vi.fn<AgentSpawner['spawn']>().mockResolvedValue(makeSpawnResult()),
      getActiveAgents: vi.fn().mockReturnValue(new Map()),
      cleanup: vi.fn(),
      shutdownAll: vi.fn(),
    }
    broker = createBrokerServer(db, eventLog, undefined, undefined, {
      agentSpawner: mockSpawner,
    })
    server = createServer(broker.app)
    await new Promise<void>((resolve) => server.listen(0, resolve))
  })

  afterEach(async () => {
    await broker.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    closeDatabase(db)
  })

  it('returns 201 with valid input and spawned result', async () => {
    // Seed a team so validation passes
    const team = createTeam(db, 'test-team')
    const teamId = team.id

    const spawnResult = makeSpawnResult({ teamId })
    ;(mockSpawner.spawn as ReturnType<typeof vi.fn>).mockResolvedValue(spawnResult)

    const res = await request(server, 'POST', '/api/spawn', {
      team_id: teamId,
      name: 'my-worker',
    })

    expect(res.status).toBe(201)
    const body = res.body as Record<string, unknown>
    expect(body.sessionId).toBe(spawnResult.sessionId)
    expect(body.teamId).toBe(teamId)
    expect(body.name).toBe('worker')
    expect(body.launchMethod).toBe('detached')

    // Verify spawn was called with correct args
    expect(mockSpawner.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        team_id: teamId,
        name: 'my-worker',
      }),
    )
  })

  it('passes optional fields through to spawner', async () => {
    const team = createTeam(db, 'opt-team')
    const teamId = team.id

    await request(server, 'POST', '/api/spawn', {
      team_id: teamId,
      name: 'builder',
      role: 'architect',
      working_dir: '/some/dir',
      prompt: 'Build a service',
      agent: 'teammate',
      permissions: 'all',
    })

    expect(mockSpawner.spawn).toHaveBeenCalledWith({
      team_id: teamId,
      name: 'builder',
      role: 'architect',
      working_dir: '/some/dir',
      prompt: 'Build a service',
      agent: 'teammate',
      permissions: 'all',
    })
  })

  it('returns 503 when agentSpawner is not available', async () => {
    // Create broker WITHOUT agentSpawner
    await broker.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    closeDatabase(db)

    db = openDatabase(':memory:')
    const eventLog = createEventLog(db)
    broker = createBrokerServer(db, eventLog, undefined, undefined, {
      // No agentSpawner
    })
    server = createServer(broker.app)
    await new Promise<void>((resolve) => server.listen(0, resolve))

    const res = await request(server, 'POST', '/api/spawn', {
      team_id: 'team-1',
      name: 'worker',
    })

    expect(res.status).toBe(503)
    const body = res.body as Record<string, unknown>
    expect(body.error).toContain('not available')
  })

  it('returns 400 for missing required field (team_id)', async () => {
    const res = await request(server, 'POST', '/api/spawn', {
      name: 'worker',
    })

    expect(res.status).toBe(400)
  })

  it('returns 400 for missing required field (name)', async () => {
    const res = await request(server, 'POST', '/api/spawn', {
      team_id: 'team-1',
    })

    expect(res.status).toBe(400)
  })

  it('returns 400 for empty name', async () => {
    const res = await request(server, 'POST', '/api/spawn', {
      team_id: 'team-1',
      name: '',
    })

    expect(res.status).toBe(400)
  })

  it('returns 400 for invalid name with path characters', async () => {
    const res = await request(server, 'POST', '/api/spawn', {
      team_id: 'team-1',
      name: '../etc/passwd',
    })

    expect(res.status).toBe(400)
  })

  it('returns 400 for invalid permissions value', async () => {
    const res = await request(server, 'POST', '/api/spawn', {
      team_id: 'team-1',
      name: 'worker',
      permissions: 'superuser',
    })

    expect(res.status).toBe(400)
  })

  it('returns 404 when team_id does not exist', async () => {
    const res = await request(server, 'POST', '/api/spawn', {
      team_id: 'nonexistent-team',
      name: 'worker',
    })

    expect(res.status).toBe(404)
    const body = res.body as { success: boolean; error: { message: string } }
    expect(body.error.message).toContain('Team')
  })

  it('returns 500 when spawn() throws', async () => {
    const team = createTeam(db, 'err-team')
    const teamId = team.id

    ;(mockSpawner.spawn as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('No compatible AI CLI found'),
    )

    const res = await request(server, 'POST', '/api/spawn', {
      team_id: teamId,
      name: 'worker',
    })

    expect(res.status).toBe(500)
  })

  it('returns 401 when auth token is set and not provided', async () => {
    await broker.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    closeDatabase(db)

    db = openDatabase(':memory:')
    const eventLog = createEventLog(db)
    broker = createBrokerServer(db, eventLog, undefined, undefined, {
      authToken: 'secret-token',
      agentSpawner: mockSpawner,
    })
    server = createServer(broker.app)
    await new Promise<void>((resolve) => server.listen(0, resolve))

    const res = await request(server, 'POST', '/api/spawn', {
      team_id: 'team-1',
      name: 'worker',
    })

    expect(res.status).toBe(401)
  })

  it('succeeds with auth token when provided', async () => {
    await broker.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    closeDatabase(db)

    db = openDatabase(':memory:')
    const eventLog = createEventLog(db)
    broker = createBrokerServer(db, eventLog, undefined, undefined, {
      authToken: 'secret-token',
      agentSpawner: mockSpawner,
    })
    server = createServer(broker.app)
    await new Promise<void>((resolve) => server.listen(0, resolve))

    // Seed a team
    const team = createTeam(db, 'auth-team')

    const res = await request(
      server,
      'POST',
      '/api/spawn',
      {
        team_id: team.id,
        name: 'worker',
      },
      { Authorization: `Bearer secret-token` },
    )

    expect(res.status).toBe(201)
  })
})
