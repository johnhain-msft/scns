/**
 * Tests for POST /api/tasks/:id/spawn — task-driven agent spawn endpoint.
 *
 * Builds a role-aware prompt from the stored task, spawns via AgentSpawner,
 * and persists task.owner / task.status. Tie goes to the existing owner:
 * 409 if task.owner is already set (no force flag).
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
import { createTeam } from '../../../../src/broker/services/team-orchestration.js'
import { archiveTeam } from '../../../../src/broker/storage/repositories/team-repository.js'
import {
  createTask,
  findTaskById,
  updateTask,
} from '../../../../src/broker/storage/repositories/task-repository.js'
import { logger } from '../../../../src/shared/logger.js'
import { createStubSpawner } from '../../../helpers/stub-agent-spawner.js'
import type Database from 'better-sqlite3'

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

describe('POST /api/tasks/:id/spawn', () => {
  let db: Database.Database
  let server: Server
  let stub: ReturnType<typeof createStubSpawner>
  let rateMonitor: { getRecommendation: ReturnType<typeof vi.fn> }

  function rebuild(opts: { withSpawner?: boolean } = {}): void {
    const eventLog = createEventLog(db)
    const app = express()
    app.use(express.json())
    const deps: RouteDeps = {
      db,
      eventLog,
      rateMonitor: rateMonitor as unknown as RouteDeps['rateMonitor'],
    }
    if (opts.withSpawner !== false) {
      deps.agentSpawner = stub
    }
    registerRoutes(app, deps)
    app.use(createErrorHandler(logger))
    server = createServer(app)
  }

  beforeEach(async () => {
    db = openDatabase(':memory:')
    stub = createStubSpawner()
    rateMonitor = {
      getRecommendation: vi.fn().mockReturnValue(RateRecommendation.Normal),
    }
    rebuild()
    await new Promise<void>((resolve) => server.listen(0, resolve))
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    closeDatabase(db)
  })

  it('returns 404 when the task does not exist', async () => {
    const res = await request(server, 'POST', '/api/tasks/9999/spawn', {
      role: 'scns-manager',
    })
    expect(res.status).toBe(404)
  })

  it('returns 410 when the task team is archived', async () => {
    const team = createTeam(db, 'archived-team')
    const task = createTask(db, { team_id: team.id, subject: 'doomed' })
    archiveTeam(db, team.id)

    const res = await request(server, 'POST', `/api/tasks/${task.id}/spawn`, {
      role: 'scns-manager',
    })
    expect(res.status).toBe(410)
    expect(stub.spawnCalls).toHaveLength(0)
  })

  it('returns 400 when role is unsupported', async () => {
    const team = createTeam(db, 'role-team')
    const task = createTask(db, { team_id: team.id, subject: 'role check' })

    const res = await request(server, 'POST', `/api/tasks/${task.id}/spawn`, {
      role: 'overlord',
    })
    expect(res.status).toBe(400)
    expect(stub.spawnCalls).toHaveLength(0)
  })

  it('returns 409 when task already has an owner (tie goes to existing)', async () => {
    const team = createTeam(db, 'owned-team')
    const task = createTask(db, { team_id: team.id, subject: 'owned' })
    updateTask(db, task.id, { owner: 'session-existing-owner' })

    const res = await request(server, 'POST', `/api/tasks/${task.id}/spawn`, {
      role: 'scns-manager',
    })
    expect(res.status).toBe(409)
    const body = res.body as Record<string, unknown>
    expect(body.current_owner).toBe('session-existing-owner')
    expect(stub.spawnCalls).toHaveLength(0)
  })

  it('returns 503 when agent spawner is unavailable', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rebuild({ withSpawner: false })
    await new Promise<void>((resolve) => server.listen(0, resolve))

    const team = createTeam(db, 'no-spawner-team')
    const task = createTask(db, { team_id: team.id, subject: 'no spawner' })

    const res = await request(server, 'POST', `/api/tasks/${task.id}/spawn`, {
      role: 'scns-manager',
    })
    expect(res.status).toBe(503)
  })

  it('returns 429 when rate monitor recommends pause', async () => {
    rateMonitor.getRecommendation.mockReturnValue(RateRecommendation.Pause)
    const team = createTeam(db, 'rate-team')
    const task = createTask(db, { team_id: team.id, subject: 'rate-limited' })

    const res = await request(server, 'POST', `/api/tasks/${task.id}/spawn`, {
      role: 'scns-manager',
    })
    expect(res.status).toBe(429)
    expect(stub.spawnCalls).toHaveLength(0)
  })

  it('accepts scns-researcher as a task-spawnable role (Track 1 / 1C)', async () => {
    const team = createTeam(db, 'research-team')
    const task = createTask(db, {
      team_id: team.id,
      subject: 'Verify heartbeat-poller runtime claim',
      description: 'Investigate whether zombie cleanup runs live or via scheduler.',
    })

    const res = await request(server, 'POST', `/api/tasks/${task.id}/spawn`, {
      role: 'scns-researcher',
      launch_method: 'detached',
    })

    expect(res.status).toBe(201)
    expect(stub.spawnCalls).toHaveLength(1)
    expect(stub.spawnCalls[0].role).toBe('scns-researcher')
    // Investigate-only, evidence-first framing lands in the spawn prompt.
    expect(stub.spawnCalls[0].prompt).toMatch(/Your Role: RESEARCHER/)
    expect(stub.spawnCalls[0].prompt).toContain('live-confirmed')
  })

  it('happy path: 201, calls spawner, updates owner + status', async () => {
    const team = createTeam(db, 'happy-team')
    const task = createTask(db, {
      team_id: team.id,
      subject: 'Fix team-reaper bug',
      description: 'Reaper archives live ACP teams.',
    })

    const res = await request(server, 'POST', `/api/tasks/${task.id}/spawn`, {
      role: 'scns-manager',
      launch_method: 'detached',
      working_dir: '/tmp/happy',
    })

    expect(res.status).toBe(201)
    const body = res.body as Record<string, unknown>
    expect(body.task_id).toBe(task.id)
    expect(body.team_id).toBe(team.id)
    expect(body.role).toBe('scns-manager')
    expect(typeof body.session_id).toBe('string')

    expect(stub.spawnCalls).toHaveLength(1)
    const call = stub.spawnCalls[0]
    expect(call.team_id).toBe(team.id)
    expect(call.role).toBe('scns-manager')
    expect(call.working_dir).toBe('/tmp/happy')
    expect(call.launch_method).toBe('detached')
    expect(call.prompt).toContain('Fix team-reaper bug')
    expect(call.prompt).toContain('Reaper archives live ACP teams.')

    const refreshed = findTaskById(db, task.id)!
    expect(refreshed.owner).toBe(body.session_id)
    expect(refreshed.status).toBe('in_progress')
  })

  it('defaults to launch_method=acp when not specified', async () => {
    const team = createTeam(db, 'acp-team')
    const task = createTask(db, { team_id: team.id, subject: 'acp default' })

    const res = await request(server, 'POST', `/api/tasks/${task.id}/spawn`, {
      role: 'scns-dev',
    })
    expect(res.status).toBe(201)
    expect(stub.spawnCalls[0].launch_method).toBe('acp')
  })

  it('passes extra_context into the prompt', async () => {
    const team = createTeam(db, 'ctx-team')
    const task = createTask(db, { team_id: team.id, subject: 'with ctx' })

    const res = await request(server, 'POST', `/api/tasks/${task.id}/spawn`, {
      role: 'scns-dev',
      extra_context: 'Watch out for scheduler-repository.ts',
    })
    expect(res.status).toBe(201)
    expect(stub.spawnCalls[0].prompt).toContain('Watch out for scheduler-repository.ts')
  })
})
