import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import http from 'node:http'
import { openDatabase, closeDatabase } from '../../../../src/broker/storage/db.js'
import { createEventLog } from '../../../../src/broker/services/event-log.js'
import { createBrokerServer, type BrokerServer } from '../../../../src/broker/server.js'
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

describe('Task CRUD routes', () => {
  let db: Database.Database
  let broker: BrokerServer
  let server: Server
  let teamId: string

  beforeEach(async () => {
    db = openDatabase(':memory:')
    const eventLog = createEventLog(db)
    broker = createBrokerServer(db, eventLog)
    server = createServer(broker.app)
    await new Promise<void>((resolve) => server.listen(0, resolve))

    // Create a team for task tests
    const teamRes = await request(server, 'POST', '/api/teams', {
      name: 'task-test-team',
    })
    teamId = (teamRes.body as Record<string, string>).id
  })

  afterEach(async () => {
    await broker.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    closeDatabase(db)
  })

  it('POST /api/tasks creates a task', async () => {
    const res = await request(server, 'POST', '/api/tasks', {
      team_id: teamId,
      subject: 'Implement feature X',
    })
    expect(res.status).toBe(201)
    const body = res.body as Record<string, unknown>
    expect(body.id).toBeDefined()
    expect(body.team_id).toBe(teamId)
    expect(body.subject).toBe('Implement feature X')
    expect(body.status).toBe('pending')
  })

  it('POST /api/tasks with description and active_form', async () => {
    const res = await request(server, 'POST', '/api/tasks', {
      team_id: teamId,
      subject: 'Task with extras',
      description: 'A detailed description',
      active_form: 'bug-report',
    })
    expect(res.status).toBe(201)
    const body = res.body as Record<string, unknown>
    expect(body.description).toBe('A detailed description')
    expect(body.active_form).toBe('bug-report')
  })

  it('POST /api/tasks returns 400 for missing subject', async () => {
    const res = await request(server, 'POST', '/api/tasks', {
      team_id: teamId,
    })
    expect(res.status).toBe(400)
  })

  it('POST /api/tasks returns 400 for missing team_id', async () => {
    const res = await request(server, 'POST', '/api/tasks', {
      subject: 'No team',
    })
    expect(res.status).toBe(400)
  })

  it('POST /api/tasks returns 404 for unknown team_id', async () => {
    const res = await request(server, 'POST', '/api/tasks', {
      team_id: 'non-existent-team',
      subject: 'Orphan task',
    })
    expect(res.status).toBe(404)
  })

  it('GET /api/tasks returns tasks for a team', async () => {
    await request(server, 'POST', '/api/tasks', {
      team_id: teamId,
      subject: 'Task A',
    })
    await request(server, 'POST', '/api/tasks', {
      team_id: teamId,
      subject: 'Task B',
    })

    const res = await request(server, 'GET', `/api/tasks?team_id=${teamId}`)
    expect(res.status).toBe(200)
    const body = res.body as { tasks: Array<Record<string, unknown>> }
    expect(body.tasks).toBeInstanceOf(Array)
    expect(body.tasks.length).toBe(2)
  })

  it('GET /api/tasks filters by status', async () => {
    const createRes = await request(server, 'POST', '/api/tasks', {
      team_id: teamId,
      subject: 'Active task',
    })
    const taskId = (createRes.body as Record<string, unknown>).id

    await request(server, 'PATCH', `/api/tasks/${taskId}`, {
      status: 'in_progress',
    })

    await request(server, 'POST', '/api/tasks', {
      team_id: teamId,
      subject: 'Pending task',
    })

    const res = await request(server, 'GET', `/api/tasks?team_id=${teamId}&status=in_progress`)
    expect(res.status).toBe(200)
    const body = res.body as { tasks: Array<Record<string, unknown>> }
    expect(body.tasks.length).toBe(1)
    expect(body.tasks[0]!.subject).toBe('Active task')
  })

  it('GET /api/tasks returns 400 without team_id', async () => {
    const res = await request(server, 'GET', '/api/tasks')
    expect(res.status).toBe(400)
  })

  it('GET /api/tasks/:id returns task with deps', async () => {
    const createRes = await request(server, 'POST', '/api/tasks', {
      team_id: teamId,
      subject: 'Single task',
    })
    const taskId = (createRes.body as Record<string, unknown>).id

    const res = await request(server, 'GET', `/api/tasks/${taskId}`)
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown>
    expect(body.id).toBe(taskId)
    expect(body.subject).toBe('Single task')
    expect(body.blocked_by).toBeInstanceOf(Array)
    expect(body.blocks).toBeInstanceOf(Array)
  })

  it('GET /api/tasks/:id returns 404 for non-existent task', async () => {
    const res = await request(server, 'GET', '/api/tasks/99999')
    expect(res.status).toBe(404)
  })

  it('PATCH /api/tasks/:id updates non-completion fields', async () => {
    const createRes = await request(server, 'POST', '/api/tasks', {
      team_id: teamId,
      subject: 'Updatable task',
    })
    const taskId = (createRes.body as Record<string, unknown>).id

    const res = await request(server, 'PATCH', `/api/tasks/${taskId}`, {
      status: 'in_progress',
      owner: 'agent-1',
      subject: 'Updated subject',
    })
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown>
    expect(body.status).toBe('in_progress')
    expect(body.owner).toBe('agent-1')
    expect(body.subject).toBe('Updated subject')
  })

  it('PATCH /api/tasks/:id with status=completed is gated (409 without diff/handoff)', async () => {
    // Phase 13.12.24 — completion-gate behaviour is exercised in detail in
    // task-completion-gate.test.ts. This case just confirms the gate is
    // wired to the route by default.
    const createRes = await request(server, 'POST', '/api/tasks', {
      team_id: teamId,
      subject: 'Cannot self-complete',
    })
    const taskId = (createRes.body as Record<string, unknown>).id

    const res = await request(server, 'PATCH', `/api/tasks/${taskId}`, {
      status: 'completed',
      owner: 'agent-1',
    })
    expect(res.status).toBe(409)
  })

  it('PATCH /api/tasks/:id returns 404 for non-existent task', async () => {
    const res = await request(server, 'PATCH', '/api/tasks/99999', {
      status: 'completed',
    })
    expect(res.status).toBe(404)
  })

  it('DELETE /api/tasks/:id deletes task', async () => {
    const createRes = await request(server, 'POST', '/api/tasks', {
      team_id: teamId,
      subject: 'Deletable task',
    })
    const taskId = (createRes.body as Record<string, unknown>).id

    const res = await request(server, 'DELETE', `/api/tasks/${taskId}`)
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown>
    expect(body.deleted).toBe(true)

    // Verify it's gone
    const getRes = await request(server, 'GET', `/api/tasks/${taskId}`)
    expect(getRes.status).toBe(404)
  })

  it('DELETE /api/tasks/:id returns 404 for non-existent task', async () => {
    const res = await request(server, 'DELETE', '/api/tasks/99999')
    expect(res.status).toBe(404)
  })
})

describe('Release intent route', () => {
  let db: Database.Database
  let broker: BrokerServer
  let server: Server

  beforeEach(async () => {
    db = openDatabase(':memory:')
    const eventLog = createEventLog(db)
    broker = createBrokerServer(db, eventLog)
    server = createServer(broker.app)
    await new Promise<void>((resolve) => server.listen(0, resolve))
  })

  afterEach(async () => {
    await broker.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    closeDatabase(db)
  })

  it('POST /api/release_intent releases a declared intent', async () => {
    // Register session first
    await request(server, 'POST', '/api/register', {
      id: 'release-sess',
      purpose: 'release intent test',
    })

    // Declare intent
    await request(server, 'POST', '/api/declare_intent', {
      session_id: 'release-sess',
      file: 'src/main.ts',
    })

    // Release it
    const res = await request(server, 'POST', '/api/release_intent', {
      session_id: 'release-sess',
      file: 'src/main.ts',
    })
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown>
    expect(body.released).toBe(true)
  })

  it('POST /api/release_intent returns released:false for non-existent intent', async () => {
    const res = await request(server, 'POST', '/api/release_intent', {
      session_id: 'no-such-session',
      file: 'no-such-file.ts',
    })
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown>
    expect(body.released).toBe(false)
  })

  it('POST /api/release_intent returns 400 for missing fields', async () => {
    const res = await request(server, 'POST', '/api/release_intent', {})
    expect(res.status).toBe(400)
  })
})
