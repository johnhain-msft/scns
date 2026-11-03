/**
 * E2E: Session recovery — snapshot and recovery lifecycle via real HTTP.
 *
 * Tests:
 * 1. POST /api/admin/snapshot-agents captures active agent state
 * 2. Snapshots persist to DB and survive session cleanup
 * 3. Recovery endpoint returns correct state
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type Database from 'better-sqlite3'
import { openDatabase, closeDatabase } from '../../src/broker/storage/db.js'
import { createEventLog } from '../../src/broker/services/event-log.js'
import { createEventDispatcher } from '../../src/broker/event-dispatcher.js'
import { createBrokerServer, type BrokerServer } from '../../src/broker/server.js'
import { ShutdownManager } from '../../src/broker/shutdown.js'
import { loadPendingSnapshots } from '../../src/broker/services/session-recovery.js'

describe('Session Recovery E2E', () => {
  let db: Database.Database
  let broker: BrokerServer
  let server: Server
  let baseUrl: string
  let shutdownManager: ShutdownManager
  let mockActiveAgents: Map<string, any>

  beforeAll(async () => {
    db = openDatabase(':memory:')
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(db, dispatcher)
    shutdownManager = new ShutdownManager()

    mockActiveAgents = new Map()
    const mockSpawner = {
      spawn: vi.fn(),
      getActiveAgents: () => mockActiveAgents,
      cleanup: vi.fn(),
      shutdownAll: vi.fn(),
      sendMessage: vi.fn(),
    }

    broker = createBrokerServer(db, eventLog, shutdownManager, dispatcher, {
      authToken: null,
      agentSpawner: mockSpawner as any,
    })

    server = createServer(broker.app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterAll(async () => {
    await broker.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    closeDatabase(db)
  })

  it('snapshot-agents returns 0 when no agents are active', async () => {
    const res = await fetch(`${baseUrl}/api/admin/snapshot-agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.success).toBe(true)
    expect(body.count).toBe(0)
  })

  it('snapshot captures agents from spawner', async () => {
    // Register a session in DB first
    db.prepare(
      "INSERT INTO sessions (id, purpose, working_dir, status) VALUES (?, ?, ?, 'active')",
    ).run('agent-r1', 'dev agent for recovery test', '/project/recovery')

    // Register a team
    db.prepare("INSERT INTO teams (id, name, status) VALUES (?, ?, 'active')").run(
      'recovery-team',
      'Recovery Test Team',
    )
    db.prepare(
      "INSERT INTO team_members (team_id, session_id, name, role, agent_type) VALUES (?, ?, ?, ?, ?)",
    ).run('recovery-team', 'agent-r1', 'recovery-dev', 'dev', 'teammate')

    // Add to mock spawner's active agents
    mockActiveAgents.set('agent-r1', {
      sessionId: 'agent-r1',
      teamId: 'recovery-team',
      name: 'recovery-dev',
      role: 'dev',
      launchMethod: 'acp',
    })

    // Snapshot
    const snapRes = await fetch(`${baseUrl}/api/admin/snapshot-agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    expect(snapRes.status).toBe(200)
    const snapBody = (await snapRes.json()) as Record<string, unknown>
    expect(snapBody.success).toBe(true)
    expect(snapBody.count).toBe(1)

    // Verify in DB
    const pending = loadPendingSnapshots(db)
    const snap = pending.find((s) => s.session_id === 'agent-r1')
    expect(snap).toBeDefined()
    expect(snap!.name).toBe('recovery-dev')
    expect(snap!.working_dir).toBe('/project/recovery')

    // Cleanup
    mockActiveAgents.clear()
  })

  it('recovery_snapshots table persists data correctly', () => {
    // Directly insert a snapshot to verify the table works
    db.prepare(
      `INSERT INTO recovery_snapshots
         (session_id, team_id, name, role, working_dir, launch_method, purpose,
          pending_tasks, recent_messages, recovery_prompt, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'snap-test-1',
      'team-snap',
      'snap-worker',
      'dev',
      '/project',
      'acp',
      'test purpose',
      JSON.stringify([{ subject: 'Fix bug', status: 'in_progress' }]),
      JSON.stringify([{ sender_id: 'mgr', content: 'Priority fix' }]),
      'You are resuming work on fixing a critical bug.',
      'pending',
    )

    const snapshots = loadPendingSnapshots(db)
    const snap = snapshots.find((s) => s.session_id === 'snap-test-1')
    expect(snap).toBeDefined()
    expect(snap!.name).toBe('snap-worker')
    expect(snap!.role).toBe('dev')
    expect(snap!.purpose).toBe('test purpose')
    expect(snap!.recovery_prompt).toContain('resuming work')

    // Parse JSON fields
    const tasks = JSON.parse(snap!.pending_tasks ?? '[]')
    expect(tasks).toHaveLength(1)
    expect(tasks[0].subject).toBe('Fix bug')
  })

  it('snapshots survive session cleanup', () => {
    // Insert a snapshot
    db.prepare(
      `INSERT INTO recovery_snapshots
         (session_id, team_id, name, role, working_dir, launch_method, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('snap-survive-1', 'team-x', 'worker', 'dev', '/p', 'acp', 'pending')

    // Delete all sessions (simulates startup cleanup)
    db.prepare('DELETE FROM sessions').run()
    db.prepare('DELETE FROM team_members').run()

    // Snapshots still there
    const pending = loadPendingSnapshots(db)
    const found = pending.find((s) => s.session_id === 'snap-survive-1')
    expect(found).toBeDefined()
  })

  // ── Recovery REST endpoints (Phase 12.6) ─────────────────────────────

  it('GET /api/admin/recovery/snapshots returns all snapshots', async () => {
    const res = await fetch(`${baseUrl}/api/admin/recovery/snapshots`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { snapshots: Array<{ session_id: string; status: string }> }
    expect(Array.isArray(body.snapshots)).toBe(true)
    // We inserted snap-test-1 and snap-survive-1 above; and snapshot from agent-r1
    const ids = body.snapshots.map((s) => s.session_id)
    expect(ids).toContain('snap-test-1')
    expect(ids).toContain('snap-survive-1')
  })

  it('GET /api/admin/recovery/snapshots?status=pending filters by status', async () => {
    const res = await fetch(`${baseUrl}/api/admin/recovery/snapshots?status=pending`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { snapshots: Array<{ status: string }> }
    expect(body.snapshots.every((s) => s.status === 'pending')).toBe(true)
  })

  it('GET /api/admin/recovery/status returns aggregate counts', async () => {
    const res = await fetch(`${baseUrl}/api/admin/recovery/status`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      total: number
      pending: number
      recovered: number
      failed: number
      expired: number
    }
    expect(typeof body.total).toBe('number')
    expect(typeof body.pending).toBe('number')
    expect(typeof body.recovered).toBe('number')
    expect(typeof body.failed).toBe('number')
    expect(typeof body.expired).toBe('number')
    expect(body.total).toBeGreaterThanOrEqual(2)
    expect(body.pending + body.recovered + body.failed + body.expired).toBe(body.total)
  })

  it('POST /api/admin/recovery/retry/:sessionId returns 404 for unknown session', async () => {
    const res = await fetch(`${baseUrl}/api/admin/recovery/retry/nonexistent-session`, {
      method: 'POST',
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('retriable')
  })

  it('POST /api/admin/recovery/retry/:sessionId retries a failed snapshot', async () => {
    // Insert a failed snapshot + team
    db.prepare("INSERT INTO teams (id, name, status) VALUES ('retry-team', 'rt', 'active')")
      .run()
    db.prepare(
      `INSERT INTO recovery_snapshots
         (session_id, team_id, name, role, working_dir, launch_method, status)
       VALUES ('retry-me', 'retry-team', 'ret-worker', 'dev', '/p', 'detached', 'failed')`,
    ).run()

    // Default mock spawn returns undefined → recoverAgents catches that and
    // marks the snapshot failed. Regardless of outcome, the endpoint should
    // echo back the originalSessionId.
    const res = await fetch(`${baseUrl}/api/admin/recovery/retry/retry-me`, {
      method: 'POST',
    })
    expect([200, 500]).toContain(res.status)
    const body = (await res.json()) as { originalSessionId?: string }
    expect(body.originalSessionId).toBe('retry-me')
  })
})
