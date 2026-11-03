/**
 * GAP-025: Rate limiting enforcement in /api/spawn endpoint.
 *
 * Verifies that the spawn route checks deps.rateMonitor and blocks
 * spawns (429) when the recommendation is Pause, ScaleDown, or YieldToUser,
 * while allowing spawns when Normal or SlowDown.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import http from 'node:http'
import express from 'express'
import { openDatabase, closeDatabase } from '../../../../src/broker/storage/db.js'
import { createEventLog } from '../../../../src/broker/services/event-log.js'
import { registerRoutes, type RouteDeps } from '../../../../src/broker/routes/index.js'
import { createErrorHandler } from '../../../../src/broker/middleware/error-handler.js'
import { RateRecommendation } from '../../../../src/rate-limit/rate-monitor.js'
import type { AgentSpawner, SpawnResult } from '../../../../src/broker/services/agent-spawner.js'
import type Database from 'better-sqlite3'
import { createTeam } from '../../../../src/broker/services/team-orchestration.js'
import { logger } from '../../../../src/shared/logger.js'

function request(
  server: Server,
  method: string,
  path: string,
  body?: unknown,
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

describe('Rate enforcement — POST /api/spawn', () => {
  let db: Database.Database
  let server: Server
  let mockSpawner: AgentSpawner
  let mockRateMonitor: { getRecommendation: ReturnType<typeof vi.fn> }

  beforeEach(async () => {
    db = openDatabase(':memory:')
    const eventLog = createEventLog(db)

    mockSpawner = {
      spawn: vi.fn<AgentSpawner['spawn']>().mockResolvedValue(makeSpawnResult()),
      getActiveAgents: vi.fn().mockReturnValue(new Map()),
      cleanup: vi.fn(),
      shutdownAll: vi.fn(),
    }

    mockRateMonitor = {
      getRecommendation: vi.fn().mockReturnValue(RateRecommendation.Normal),
    }

    const app = express()
    app.use(express.json())

    const deps: RouteDeps = {
      db,
      eventLog,
      agentSpawner: mockSpawner,
      rateMonitor: mockRateMonitor as unknown as RouteDeps['rateMonitor'],
    }
    registerRoutes(app, deps)
    app.use(createErrorHandler(logger))

    server = createServer(app)
    await new Promise<void>((resolve) => server.listen(0, resolve))
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    closeDatabase(db)
  })

  it('returns 429 when rate recommendation is pause', async () => {
    mockRateMonitor.getRecommendation.mockReturnValue(RateRecommendation.Pause)

    const res = await request(server, 'POST', '/api/spawn', {
      team_id: 'any-team',
      name: 'worker',
    })

    expect(res.status).toBe(429)
    const body = res.body as Record<string, unknown>
    expect(body.error).toContain('pause')
    expect(mockSpawner.spawn).not.toHaveBeenCalled()
  })

  it('returns 429 when rate recommendation is scale-down', async () => {
    mockRateMonitor.getRecommendation.mockReturnValue(RateRecommendation.ScaleDown)

    const res = await request(server, 'POST', '/api/spawn', {
      team_id: 'any-team',
      name: 'worker',
    })

    expect(res.status).toBe(429)
    const body = res.body as Record<string, unknown>
    expect(body.error).toContain('scale-down')
    expect(mockSpawner.spawn).not.toHaveBeenCalled()
  })

  it('returns 429 when rate recommendation is yield-to-user', async () => {
    mockRateMonitor.getRecommendation.mockReturnValue(RateRecommendation.YieldToUser)

    const res = await request(server, 'POST', '/api/spawn', {
      team_id: 'any-team',
      name: 'worker',
    })

    expect(res.status).toBe(429)
    const body = res.body as Record<string, unknown>
    expect(body.error).toContain('yield-to-user')
    expect(mockSpawner.spawn).not.toHaveBeenCalled()
  })

  it('allows spawn (201) when rate recommendation is normal', async () => {
    const team = createTeam(db, 'test-team')
    mockRateMonitor.getRecommendation.mockReturnValue(RateRecommendation.Normal)

    const spawnResult = makeSpawnResult({ teamId: team.id })
    ;(mockSpawner.spawn as ReturnType<typeof vi.fn>).mockResolvedValue(spawnResult)

    const res = await request(server, 'POST', '/api/spawn', {
      team_id: team.id,
      name: 'worker',
    })

    expect(res.status).toBe(201)
    expect(mockSpawner.spawn).toHaveBeenCalled()
  })

  it('allows spawn (201) when rate recommendation is slow-down', async () => {
    const team = createTeam(db, 'test-team')
    mockRateMonitor.getRecommendation.mockReturnValue(RateRecommendation.SlowDown)

    const spawnResult = makeSpawnResult({ teamId: team.id })
    ;(mockSpawner.spawn as ReturnType<typeof vi.fn>).mockResolvedValue(spawnResult)

    const res = await request(server, 'POST', '/api/spawn', {
      team_id: team.id,
      name: 'worker',
    })

    expect(res.status).toBe(201)
    expect(mockSpawner.spawn).toHaveBeenCalled()
  })

  it('allows spawn when no rateMonitor is provided', async () => {
    // Rebuild server without rateMonitor
    await new Promise<void>((resolve) => server.close(() => resolve()))
    closeDatabase(db)

    db = openDatabase(':memory:')
    const eventLog = createEventLog(db)
    const team = createTeam(db, 'no-rate-team')

    const spawnResult = makeSpawnResult({ teamId: team.id })
    const spawner: AgentSpawner = {
      spawn: vi.fn<AgentSpawner['spawn']>().mockResolvedValue(spawnResult),
      getActiveAgents: vi.fn().mockReturnValue(new Map()),
      cleanup: vi.fn(),
      shutdownAll: vi.fn(),
    }

    const app = express()
    app.use(express.json())
    registerRoutes(app, { db, eventLog, agentSpawner: spawner })
    app.use(createErrorHandler(logger))

    server = createServer(app)
    await new Promise<void>((resolve) => server.listen(0, resolve))

    const res = await request(server, 'POST', '/api/spawn', {
      team_id: team.id,
      name: 'worker',
    })

    expect(res.status).toBe(201)
    expect(spawner.spawn).toHaveBeenCalled()
  })
})
