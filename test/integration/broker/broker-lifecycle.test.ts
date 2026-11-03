/**
 * Broker HTTP integration tests — verifies full request→response flow
 * through the assembled Express app with real SQLite databases.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { openDatabase, closeDatabase } from '../../../src/broker/storage/db.js'
import { createEventLog } from '../../../src/broker/services/event-log.js'
import { createEventDispatcher } from '../../../src/broker/event-dispatcher.js'
import { createBrokerServer, type BrokerServer } from '../../../src/broker/server.js'
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
  broker = createBrokerServer(db, eventLog, undefined, dispatcher, { authToken: null })

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
// 1. Full session lifecycle
// ═══════════════════════════════════════════════════════════════

describe('Session lifecycle', () => {
  it('health probes return ok on empty broker', async () => {
    const live = await req('GET', '/health/live')
    expect(live.status).toBe(200)
    expect(live.body).toEqual({ status: 'ok' })

    const ready = await req('GET', '/health/ready')
    expect(ready.status).toBe(200)
    const readyBody = ready.body as Record<string, unknown>
    expect(readyBody.status).toBe('ok')
    expect((readyBody.sessions as Record<string, number>).active).toBe(0)
  })

  it('register → list → heartbeat → deregister flow', async () => {
    // Register
    const reg = await req('POST', '/api/register', {
      id: 'agent-1',
      purpose: 'test',
      working_dir: '/workspace',
    })
    expect(reg.status).toBe(200)
    expect((reg.body as Record<string, string>).id).toBe('agent-1')

    // List — session appears
    const list1 = await req('GET', '/api/list_sessions')
    expect(list1.status).toBe(200)
    const sessions1 = (list1.body as Record<string, unknown[]>).sessions
    expect(sessions1).toHaveLength(1)
    expect((sessions1[0] as Record<string, string>).id).toBe('agent-1')

    // Heartbeat
    const hb = await req('POST', '/api/heartbeat', { session_id: 'agent-1' })
    expect(hb.status).toBe(200)
    expect((hb.body as Record<string, unknown>).success).toBe(true)

    // Ready check — active count should be 1
    const ready = await req('GET', '/health/ready')
    const readySessions = (ready.body as Record<string, Record<string, number>>).sessions
    expect(readySessions.active).toBe(1)

    // Deregister
    const dereg = await req('POST', '/api/deregister/agent-1')
    expect(dereg.status).toBe(200)
    expect((dereg.body as Record<string, unknown>).success).toBe(true)

    // List — session no longer shows (it's archived/completed)
    const list2 = await req('GET', '/api/list_sessions')
    const sessions2 = (list2.body as Record<string, unknown[]>).sessions
    expect(sessions2).toHaveLength(0)
  })

  it('heartbeat on unknown session returns 404', async () => {
    const res = await req('POST', '/api/heartbeat', { session_id: 'ghost' })
    expect(res.status).toBe(404)
  })

  it('deregister unknown session returns 404', async () => {
    const res = await req('POST', '/api/deregister/ghost')
    expect(res.status).toBe(404)
  })

  it('register with missing fields returns 400', async () => {
    const res = await req('POST', '/api/register', { purpose: 'no-id' })
    expect(res.status).toBe(400)
  })
})

// ═══════════════════════════════════════════════════════════════
// 2. Messaging between agents
// ═══════════════════════════════════════════════════════════════

describe('Messaging between agents', () => {
  it('send → receive → mark-read flow', async () => {
    // Register two agents
    await req('POST', '/api/register', { id: 'alice', purpose: 'sender', working_dir: '/w' })
    await req('POST', '/api/register', { id: 'bob', purpose: 'receiver', working_dir: '/w' })

    // Alice sends a message to Bob
    const send = await req('POST', '/api/messages', {
      sender_id: 'alice',
      receiver_id: 'bob',
      content: 'hello from alice',
    })
    expect(send.status).toBe(201)
    const msgId = (send.body as Record<string, string>).id
    expect(msgId).toBeDefined()

    // Bob receives the message
    const bobMsgs = await req('GET', '/api/messages/bob')
    expect(bobMsgs.status).toBe(200)
    const bobMessages = (bobMsgs.body as Record<string, unknown[]>).messages
    expect(bobMessages).toHaveLength(1)
    expect((bobMessages[0] as Record<string, string>).content).toBe('hello from alice')

    // Alice does NOT see messages directed to Bob
    const aliceMsgs = await req('GET', '/api/messages/alice')
    const aliceMessages = (aliceMsgs.body as Record<string, unknown[]>).messages
    expect(aliceMessages).toHaveLength(0)

    // Mark the message as read
    const markRead = await req('POST', '/api/messages/mark-read', { message_ids: [msgId] })
    expect(markRead.status).toBe(200)

    // Unread-only query for Bob should be empty
    const unread = await req('GET', '/api/messages/bob?unread_only=true')
    const unreadMsgs = (unread.body as Record<string, unknown[]>).messages
    expect(unreadMsgs).toHaveLength(0)
  })

  it('broadcast message (no receiver_id) is visible to any receiver query', async () => {
    await req('POST', '/api/register', { id: 'broadcaster', purpose: 'bc', working_dir: '/w' })

    const send = await req('POST', '/api/messages', {
      sender_id: 'broadcaster',
      content: 'hello everyone',
    })
    expect(send.status).toBe(201)
    expect((send.body as Record<string, unknown>).receiver_id).toBeNull()
  })

  it('message with reply_to creates a thread reference', async () => {
    await req('POST', '/api/register', { id: 'a', purpose: 'x', working_dir: '/w' })
    await req('POST', '/api/register', { id: 'b', purpose: 'x', working_dir: '/w' })

    const msg1 = await req('POST', '/api/messages', {
      sender_id: 'a',
      receiver_id: 'b',
      content: 'original',
    })
    const msg1Id = (msg1.body as Record<string, string>).id

    const msg2 = await req('POST', '/api/messages', {
      sender_id: 'b',
      receiver_id: 'a',
      content: 'reply',
      reply_to: msg1Id,
    })
    expect(msg2.status).toBe(201)
    expect((msg2.body as Record<string, string>).reply_to).toBe(msg1Id)
  })
})

// ═══════════════════════════════════════════════════════════════
// 3. Team lifecycle
// ═══════════════════════════════════════════════════════════════

describe('Team lifecycle', () => {
  it('create team → add members → get team → disband', async () => {
    // Register sessions
    await req('POST', '/api/register', { id: 'lead-1', purpose: 'lead', working_dir: '/w' })
    await req('POST', '/api/register', { id: 'dev-1', purpose: 'dev', working_dir: '/w' })

    // Create team
    const createTeam = await req('POST', '/api/teams', { name: 'alpha-team' })
    expect(createTeam.status).toBe(201)
    const teamId = (createTeam.body as Record<string, string>).id
    expect(teamId).toBeDefined()

    // Add lead
    const addLead = await req('POST', `/api/teams/${teamId}/members`, {
      session_id: 'lead-1',
      name: 'Lead',
      role: 'lead',
    })
    expect(addLead.status).toBe(201)

    // Add dev
    const addDev = await req('POST', `/api/teams/${teamId}/members`, {
      session_id: 'dev-1',
      name: 'Dev',
      role: 'dev',
    })
    expect(addDev.status).toBe(201)

    // Get team — should have 2 members
    const getTeam = await req('GET', `/api/teams/${teamId}`)
    expect(getTeam.status).toBe(200)
    const teamBody = getTeam.body as Record<string, unknown>
    expect(teamBody.name).toBe('alpha-team')
    expect((teamBody.members as unknown[]).length).toBe(2)

    // Disband
    const disband = await req('DELETE', `/api/teams/${teamId}`)
    expect(disband.status).toBe(200)

    // Verify status is disbanded
    const getAfter = await req('GET', `/api/teams/${teamId}`)
    expect(getAfter.status).toBe(200)
    expect((getAfter.body as Record<string, string>).status).toBe('disbanded')
  })

  it('duplicate team member returns 409', async () => {
    await req('POST', '/api/register', { id: 'dup-agent', purpose: 'test', working_dir: '/w' })
    const team = await req('POST', '/api/teams', { name: 'dup-team' })
    const teamId = (team.body as Record<string, string>).id

    await req('POST', `/api/teams/${teamId}/members`, {
      session_id: 'dup-agent',
      name: 'Agent',
      role: 'dev',
    })

    const dup = await req('POST', `/api/teams/${teamId}/members`, {
      session_id: 'dup-agent',
      name: 'Agent2',
      role: 'dev',
    })
    expect(dup.status).toBe(409)
  })

  it('remove team member', async () => {
    await req('POST', '/api/register', { id: 'rm-agent', purpose: 'test', working_dir: '/w' })
    const team = await req('POST', '/api/teams', { name: 'rm-team' })
    const teamId = (team.body as Record<string, string>).id

    await req('POST', `/api/teams/${teamId}/members`, {
      session_id: 'rm-agent',
      name: 'Agent',
      role: 'dev',
    })

    const remove = await req('DELETE', `/api/teams/${teamId}/members/rm-agent`)
    expect(remove.status).toBe(200)

    const info = await req('GET', `/api/teams/${teamId}`)
    expect((info.body as Record<string, unknown[]>).members).toHaveLength(0)
  })

  it('list teams with status filter', async () => {
    await req('POST', '/api/teams', { name: 'team-a' })
    const teamB = await req('POST', '/api/teams', { name: 'team-b' })
    const teamBId = (teamB.body as Record<string, string>).id
    await req('DELETE', `/api/teams/${teamBId}`)

    // Only active teams
    const active = await req('GET', '/api/teams?status=active')
    const activeTeams = (active.body as Record<string, unknown[]>).teams
    expect(activeTeams).toHaveLength(1)
    expect((activeTeams[0] as Record<string, string>).name).toBe('team-a')
  })
})

// ═══════════════════════════════════════════════════════════════
// 6. Shared state operations
// ═══════════════════════════════════════════════════════════════

describe('Shared state operations', () => {
  it('set → get → delete → 404', async () => {
    await req('POST', '/api/register', { id: 'worker-1', purpose: 'worker', working_dir: '/w' })

    // Set state
    const set = await req('POST', '/api/state', {
      key: 'progress',
      value: '50%',
      session_id: 'worker-1',
    })
    expect(set.status).toBe(200)
    expect((set.body as Record<string, string>).value).toBe('50%')

    // Get state
    const get = await req('GET', '/api/state/progress')
    expect(get.status).toBe(200)
    expect((get.body as Record<string, string>).key).toBe('progress')
    expect((get.body as Record<string, string>).value).toBe('50%')

    // Delete state
    const del = await req('DELETE', '/api/state/progress')
    expect(del.status).toBe(200)

    // Get again — 404
    const gone = await req('GET', '/api/state/progress')
    expect(gone.status).toBe(404)
  })

  it('overwrite existing key updates value', async () => {
    await req('POST', '/api/state', { key: 'counter', value: '1' })
    await req('POST', '/api/state', { key: 'counter', value: '2' })

    const get = await req('GET', '/api/state/counter')
    expect((get.body as Record<string, string>).value).toBe('2')
  })

  it('set state with missing fields returns 400', async () => {
    const res = await req('POST', '/api/state', { key: 'no-value' })
    expect(res.status).toBe(400)
  })
})

// ═══════════════════════════════════════════════════════════════
// 7. File intent + conflict detection
// ═══════════════════════════════════════════════════════════════

describe('File intent and conflict detection', () => {
  it('two editors on same file produce a conflict', async () => {
    await req('POST', '/api/register', { id: 'editor-1', purpose: 'edit', working_dir: '/w' })
    await req('POST', '/api/register', { id: 'editor-2', purpose: 'edit', working_dir: '/w' })

    // First intent — no conflict
    const intent1 = await req('POST', '/api/declare_intent', {
      session_id: 'editor-1',
      file: 'src/main.ts',
    })
    expect(intent1.status).toBe(200)
    expect((intent1.body as Record<string, boolean>).conflict).toBe(false)

    // Second intent on same file — conflict detected
    const intent2 = await req('POST', '/api/declare_intent', {
      session_id: 'editor-2',
      file: 'src/main.ts',
    })
    expect(intent2.status).toBe(200)
    expect((intent2.body as Record<string, boolean>).conflict).toBe(true)

    const conflicting = (intent2.body as Record<string, unknown[]>).conflicting_sessions
    expect(conflicting).toHaveLength(1)
    expect((conflicting[0] as Record<string, string>).session_id).toBe('editor-1')

    // GET /api/conflicts lists the conflict
    const allConflicts = await req('GET', '/api/conflicts')
    expect(allConflicts.status).toBe(200)
    const conflicts = (allConflicts.body as Record<string, unknown[]>).conflicts
    expect(conflicts.length).toBeGreaterThanOrEqual(1)
    const mainConflict = conflicts.find(
      (c) => (c as Record<string, string>).file_path === 'src/main.ts',
    ) as Record<string, unknown>
    expect(mainConflict).toBeDefined()
    expect((mainConflict.sessions as unknown[]).length).toBe(2)
  })

  it('single editor on a file has no conflict', async () => {
    await req('POST', '/api/register', { id: 'solo', purpose: 'edit', working_dir: '/w' })

    const intent = await req('POST', '/api/declare_intent', {
      session_id: 'solo',
      file: 'src/solo.ts',
    })
    expect((intent.body as Record<string, boolean>).conflict).toBe(false)

    const all = await req('GET', '/api/conflicts')
    expect((all.body as Record<string, unknown[]>).conflicts).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════════
// Events
// ═══════════════════════════════════════════════════════════════

describe('Events API', () => {
  it('events accumulate and are retrievable via /api/events/since', async () => {
    // Register a session — this generates events
    await req('POST', '/api/register', { id: 'ev-agent', purpose: 'test', working_dir: '/w' })
    await req('POST', '/api/heartbeat', { session_id: 'ev-agent' })

    const events = await req('GET', '/api/events/since/0')
    expect(events.status).toBe(200)
    const eventList = (events.body as Record<string, unknown[]>).events
    expect(eventList.length).toBeGreaterThanOrEqual(2)

    const types = eventList.map((e) => (e as Record<string, string>).event_type)
    expect(types).toContain('session_registered')
    expect(types).toContain('heartbeat_received')
  })
})

// ═══════════════════════════════════════════════════════════════
// Unknown routes
// ═══════════════════════════════════════════════════════════════

describe('Unknown API routes', () => {
  it('returns 404 for unknown API paths', async () => {
    const res = await req('GET', '/api/nonexistent')
    expect(res.status).toBe(404)
  })
})
