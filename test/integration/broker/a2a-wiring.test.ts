/**
 * A2A wiring integration tests — verifies TeamOrchestrator is properly
 * wired into the broker and accessible via HTTP routes.
 *
 * Tests real HTTP requests against an Express server with real SQLite.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { openDatabase, closeDatabase } from '../../../src/broker/storage/db.js'
import { createEventLog } from '../../../src/broker/services/event-log.js'
import { createEventDispatcher } from '../../../src/broker/event-dispatcher.js'
import { createBrokerServer, type BrokerServer } from '../../../src/broker/server.js'
import { createTeamOrchestrator } from '../../../src/broker/a2a/team-orchestrator.js'
import { createRateMonitor } from '../../../src/rate-limit/rate-monitor.js'
import type Database from 'better-sqlite3'

// ── Helpers ────────────────────────────────────────────────────

interface TestResponse {
  status: number
  body: unknown
}

let db: Database.Database
let broker: BrokerServer
let server: Server
let baseUrl: string

async function req(method: string, path: string, body?: unknown): Promise<TestResponse> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, body: json }
}

// ── Setup / Teardown ───────────────────────────────────────────

beforeEach(() => {
  db = openDatabase(':memory:')
  const dispatcher = createEventDispatcher()
  const eventLog = createEventLog(db, dispatcher)
  const rateMonitor = createRateMonitor()
  const orchestrator = createTeamOrchestrator({ rateMonitor })

  broker = createBrokerServer(db, eventLog, undefined, dispatcher, {
    authToken: null,
    orchestrator,
  })

  server = createServer(broker.app)
  server.listen(0)
  const addr = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterEach(async () => {
  await broker.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  closeDatabase(db)
})

// ═══════════════════════════════════════════════════════════════
// 1. JSON-RPC A2A endpoint
// ═══════════════════════════════════════════════════════════════

describe('POST /api/a2a — JSON-RPC dispatch', () => {
  it('dispatches tasks/submit and returns JSON-RPC response', async () => {
    const { status, body } = await req('POST', '/api/a2a', {
      jsonrpc: '2.0',
      method: 'tasks/submit',
      params: { submittedBy: 'test-agent', description: 'Test task' },
      id: 1,
    })

    expect(status).toBe(200)
    const resp = body as { jsonrpc: string; result: { id: string; status: string }; id: number }
    expect(resp.jsonrpc).toBe('2.0')
    expect(resp.id).toBe(1)
    expect(resp.result).toHaveProperty('id')
    expect(resp.result.status).toBe('submitted')
  })

  it('returns method-not-found for unknown methods', async () => {
    const { status, body } = await req('POST', '/api/a2a', {
      jsonrpc: '2.0',
      method: 'nonexistent/method',
      params: {},
      id: 2,
    })

    expect(status).toBe(200)
    const resp = body as { jsonrpc: string; error: { code: number; message: string }; id: number }
    expect(resp.error.code).toBe(-32601) // MethodNotFound
  })

  it('returns invalid-request for non-JSON-RPC payload', async () => {
    const { status, body } = await req('POST', '/api/a2a', {
      not: 'a jsonrpc message',
    })

    expect(status).toBe(200)
    const resp = body as { jsonrpc: string; error: { code: number } }
    expect(resp.error.code).toBe(-32600) // InvalidRequest
  })

  it('dispatches teams/create with template', async () => {
    const { status, body } = await req('POST', '/api/a2a', {
      jsonrpc: '2.0',
      method: 'teams/create',
      params: { templateName: 'research', teamId: 'test-team-1' },
      id: 3,
    })

    expect(status).toBe(200)
    const resp = body as { jsonrpc: string; result: { teamId: string }; id: number }
    expect(resp.jsonrpc).toBe('2.0')
    expect(resp.result.teamId).toBe('test-team-1')
  })

  it('dispatches teams/status for existing team', async () => {
    // Create team first
    await req('POST', '/api/a2a', {
      jsonrpc: '2.0',
      method: 'teams/create',
      params: { templateName: 'research', teamId: 'status-team' },
      id: 10,
    })

    // Get status
    const { status, body } = await req('POST', '/api/a2a', {
      jsonrpc: '2.0',
      method: 'teams/status',
      params: { teamId: 'status-team' },
      id: 11,
    })

    expect(status).toBe(200)
    const resp = body as { result: { teamId: string; overallStatus: string } }
    expect(resp.result.teamId).toBe('status-team')
    expect(resp.result.overallStatus).toBe('running')
  })

  it('dispatches agents/list returning empty initially', async () => {
    const { body } = await req('POST', '/api/a2a', {
      jsonrpc: '2.0',
      method: 'agents/list',
      params: {},
      id: 20,
    })

    const resp = body as { result: unknown[] }
    expect(resp.result).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════
// 2. Team task REST endpoints
// ═══════════════════════════════════════════════════════════════

describe('Team task REST convenience endpoints', () => {
  it('POST /api/a2a/teams/:id/tasks submits task to orchestrator', async () => {
    // Create A2A team first
    await req('POST', '/api/a2a', {
      jsonrpc: '2.0',
      method: 'teams/create',
      params: { templateName: 'research', teamId: 'rest-team' },
      id: 30,
    })

    const { status, body } = await req('POST', '/api/a2a/teams/rest-team/tasks', {
      subject: 'Implement feature X',
      description: 'Build the feature using TDD',
    })

    expect(status).toBe(201)
    const resp = body as { id: string; status: string; description: string }
    expect(resp).toHaveProperty('id')
    expect(resp.status).toBe('submitted')
    expect(resp.description).toBe('Build the feature using TDD')
  })

  it('GET /api/a2a/teams/:id/tasks lists tasks from orchestrator', async () => {
    // Create team and submit task
    await req('POST', '/api/a2a', {
      jsonrpc: '2.0',
      method: 'teams/create',
      params: { templateName: 'research', teamId: 'list-team' },
      id: 40,
    })
    await req('POST', '/api/a2a/teams/list-team/tasks', {
      subject: 'Task 1',
      description: 'First task',
    })
    await req('POST', '/api/a2a/teams/list-team/tasks', {
      subject: 'Task 2',
      description: 'Second task',
    })

    const { status, body } = await req('GET', '/api/a2a/teams/list-team/tasks')

    expect(status).toBe(200)
    const resp = body as { tasks: unknown[] }
    expect(resp.tasks.length).toBeGreaterThanOrEqual(2)
  })

  it('GET /api/a2a/teams/:id/status returns orchestration state', async () => {
    // Create team
    await req('POST', '/api/a2a', {
      jsonrpc: '2.0',
      method: 'teams/create',
      params: { templateName: 'research', teamId: 'state-team' },
      id: 50,
    })

    const { status, body } = await req('GET', '/api/a2a/teams/state-team/status')

    expect(status).toBe(200)
    const resp = body as { teamId: string; overallStatus: string; phases: unknown[] }
    expect(resp.teamId).toBe('state-team')
    expect(resp.overallStatus).toBe('running')
    expect(resp.phases).toBeInstanceOf(Array)
  })

  it('returns 404 for non-existent A2A team status', async () => {
    const { status } = await req('GET', '/api/a2a/teams/nonexistent/status')
    expect(status).toBe(404)
  })
})

// ═══════════════════════════════════════════════════════════════
// 3. Orchestrator status endpoint
// ═══════════════════════════════════════════════════════════════

describe('GET /api/a2a/status', () => {
  it('returns orchestrator status', async () => {
    const { status, body } = await req('GET', '/api/a2a/status')

    expect(status).toBe(200)
    const resp = body as {
      registeredAgents: number
      activeTasks: number
      activeTeams: number
      scalerStatus: unknown
      respawnStats: unknown
    }
    expect(resp.registeredAgents).toBe(0)
    expect(resp.activeTasks).toBe(0)
    expect(resp.activeTeams).toBe(0)
    expect(resp.scalerStatus).toBeDefined()
    expect(resp.respawnStats).toBeDefined()
  })
})
