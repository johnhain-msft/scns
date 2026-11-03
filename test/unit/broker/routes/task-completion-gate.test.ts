/**
 * Phase 13.12.24 — task completion gate.
 *
 * PATCH /api/tasks/:id with status='completed' must reject (409) unless one
 * of the following holds for the task's owner:
 *   - non-empty `git diff --cached` in the owner's working_dir, OR
 *   - a session handoff for the owner whose latest quality check passed.
 *
 * status='failed' (the explicit abandon path) is always allowed regardless
 * of diff state.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import http from 'node:http'
import { openDatabase, closeDatabase } from '../../../../src/broker/storage/db.js'
import { createEventLog } from '../../../../src/broker/services/event-log.js'
import { createBrokerServer, type BrokerServer } from '../../../../src/broker/server.js'
import {
  createHandoff,
  createQualityCheck,
} from '../../../../src/broker/storage/repositories/quality-repository.js'
import { createSession } from '../../../../src/broker/storage/repositories/session-repository.js'
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
        let body = ''
        res.on('data', (c: Buffer) => {
          body += c.toString()
        })
        res.on('end', () => {
          let parsed: unknown
          try {
            parsed = JSON.parse(body)
          } catch {
            parsed = body
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

interface Harness {
  readonly db: Database.Database
  readonly broker: BrokerServer
  readonly server: Server
  readonly teamId: string
  /** Sets the diff checker's verdict for any cwd. */
  setHasDiff(value: boolean): void
}

async function makeHarness(): Promise<Harness> {
  const db = openDatabase(':memory:')
  const eventLog = createEventLog(db)
  let hasDiff = false
  const broker = createBrokerServer(db, eventLog, undefined, undefined, {
    gitDiffChecker: (_cwd: string) => hasDiff,
  })
  const server = createServer(broker.app)
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const teamRes = await request(server, 'POST', '/api/teams', {
    name: 'gate-team',
  })
  const teamId = (teamRes.body as { id: string }).id
  return {
    db,
    broker,
    server,
    teamId,
    setHasDiff: (v) => {
      hasDiff = v
    },
  }
}

async function makeTask(h: Harness, owner?: string): Promise<number> {
  const res = await request(h.server, 'POST', '/api/tasks', {
    team_id: h.teamId,
    subject: 'do the thing',
  })
  const id = (res.body as { id: number }).id
  if (owner !== undefined) {
    // Set owner directly via DB to keep the test focused on the completion
    // gate (PATCH /api/tasks/:id with `owner` only is allowed).
    h.db.prepare(`UPDATE tasks SET owner=?, status='in_progress' WHERE id=?`).run(owner, id)
  }
  return id
}

function registerOwnerSession(db: Database.Database, sessionId: string, workingDir: string): void {
  createSession(db, {
    id: sessionId,
    purpose: 'gate test',
    working_dir: workingDir,
    worktree: null,
  })
}

describe('PATCH /api/tasks/:id completion gate', () => {
  let h: Harness

  beforeEach(async () => {
    h = await makeHarness()
  })

  afterEach(async () => {
    await h.broker.close()
    await new Promise<void>((resolve) => h.server.close(() => resolve()))
    closeDatabase(h.db)
  })

  it('rejects status=completed when there is no staged diff and no passing handoff', async () => {
    const ownerId = 'sess-owner-1'
    registerOwnerSession(h.db, ownerId, '/tmp/no-diff')
    const taskId = await makeTask(h, ownerId)
    h.setHasDiff(false)

    const res = await request(h.server, 'PATCH', `/api/tasks/${taskId}`, {
      status: 'completed',
    })
    expect(res.status).toBe(409)
    const body = res.body as { error?: string }
    expect(body.error).toMatch(/staged diff|handoff|completion/i)
  })

  it('allows status=completed when the owner has a non-empty staged diff', async () => {
    const ownerId = 'sess-owner-2'
    registerOwnerSession(h.db, ownerId, '/tmp/with-diff')
    const taskId = await makeTask(h, ownerId)
    h.setHasDiff(true)

    const res = await request(h.server, 'PATCH', `/api/tasks/${taskId}`, {
      status: 'completed',
    })
    expect(res.status).toBe(200)
    expect((res.body as { status: string }).status).toBe('completed')
  })

  it('allows status=completed when there is a passing QA handoff for the owner', async () => {
    const ownerId = 'sess-owner-3'
    registerOwnerSession(h.db, ownerId, '/tmp/handoff')
    const taskId = await makeTask(h, ownerId)
    h.setHasDiff(false)

    createHandoff(h.db, {
      session_id: ownerId,
      progress: 'work complete',
      files_modified: ['src/x.ts'],
    })
    createQualityCheck(h.db, {
      session_id: ownerId,
      output: 'all green',
      passed: true,
      score: 1,
      findings: [],
    })

    const res = await request(h.server, 'PATCH', `/api/tasks/${taskId}`, {
      status: 'completed',
    })
    expect(res.status).toBe(200)
    expect((res.body as { status: string }).status).toBe('completed')
  })

  it('rejects status=completed when handoff exists but quality check did not pass', async () => {
    const ownerId = 'sess-owner-4'
    registerOwnerSession(h.db, ownerId, '/tmp/failing-qc')
    const taskId = await makeTask(h, ownerId)
    h.setHasDiff(false)

    createHandoff(h.db, {
      session_id: ownerId,
      progress: 'work complete',
    })
    createQualityCheck(h.db, {
      session_id: ownerId,
      output: 'lint fail',
      passed: false,
      score: 0,
      findings: ['lint'],
    })

    const res = await request(h.server, 'PATCH', `/api/tasks/${taskId}`, {
      status: 'completed',
    })
    expect(res.status).toBe(409)
  })

  it('rejects status=completed when task has no owner (cannot evaluate gate)', async () => {
    const taskId = await makeTask(h)
    h.setHasDiff(true)

    const res = await request(h.server, 'PATCH', `/api/tasks/${taskId}`, {
      status: 'completed',
    })
    expect(res.status).toBe(409)
  })

  it('allows status=failed regardless of diff state (abandon path)', async () => {
    const ownerId = 'sess-owner-5'
    registerOwnerSession(h.db, ownerId, '/tmp/abandon')
    const taskId = await makeTask(h, ownerId)
    h.setHasDiff(false)

    const res = await request(h.server, 'PATCH', `/api/tasks/${taskId}`, {
      status: 'failed',
    })
    expect(res.status).toBe(200)
    expect((res.body as { status: string }).status).toBe('failed')
  })

  it('allows non-completion patches (status=in_progress, owner change)', async () => {
    const taskId = await makeTask(h)

    const res = await request(h.server, 'PATCH', `/api/tasks/${taskId}`, {
      status: 'in_progress',
      owner: 'agent-1',
    })
    expect(res.status).toBe(200)
  })
})
