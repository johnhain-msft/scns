/**
 * Phase 13.6 E2E: team message bus via real HTTP.
 * Covers monotonic seq, cursor resume, addressability, cross-team routing,
 * and restart recovery (reopening the SQLite file on a new server).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { openDatabase, closeDatabase } from '../../src/broker/storage/db.js'
import { createEventLog } from '../../src/broker/services/event-log.js'
import { createEventDispatcher } from '../../src/broker/event-dispatcher.js'
import { createBrokerServer, type BrokerServer } from '../../src/broker/server.js'

interface TeamMessage {
  id: string
  sender_id: string
  receiver_id: string | null
  content: string
  team_id: string | null
  seq: number | null
  to_role: string | null
  to_team: string | null
  created_at?: string
}

interface SinceResponse {
  messages: TeamMessage[]
  cursor: number
  head: number
}

describe('team message bus E2E (Phase 13.6)', () => {
  let tmpDir: string
  let dbPath: string
  let db: Database.Database
  let broker: BrokerServer
  let server: Server
  let baseUrl: string

  async function startBroker(): Promise<void> {
    db = openDatabase(dbPath)
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(db, dispatcher)
    broker = createBrokerServer(db, eventLog, undefined, dispatcher, { authToken: null })
    server = createServer(broker.app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${addr.port}`
  }

  async function stopBroker(): Promise<void> {
    await broker.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    closeDatabase(db)
  }

  async function register(id: string): Promise<void> {
    const res = await fetch(`${baseUrl}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, purpose: 'msgbus' }),
    })
    expect(res.status).toBe(200)
  }

  async function createTeam(name: string): Promise<string> {
    const res = await fetch(`${baseUrl}/api/teams`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { id: string }
    return body.id
  }

  async function joinTeam(teamId: string, sessionId: string, role: string): Promise<void> {
    const res = await fetch(`${baseUrl}/api/teams/${teamId}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, name: sessionId, role }),
    })
    expect(res.status).toBe(201)
  }

  async function post(
    teamId: string,
    body: Record<string, unknown>,
  ): Promise<TeamMessage> {
    const res = await fetch(`${baseUrl}/api/teams/${teamId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(res.status).toBe(201)
    return (await res.json()) as TeamMessage
  }

  async function since(
    teamId: string,
    cursor: number,
    query?: Record<string, string>,
  ): Promise<SinceResponse> {
    const qs = query ? '?' + new URLSearchParams(query).toString() : ''
    const res = await fetch(`${baseUrl}/api/teams/${teamId}/messages/since/${cursor}${qs}`)
    expect(res.status).toBe(200)
    return (await res.json()) as SinceResponse
  }

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'scns-msgbus-e2e-'))
    dbPath = join(tmpDir, 'broker.db')
    await startBroker()
  })

  afterAll(async () => {
    await stopBroker()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('monotonic ordering + cursor resume + role filter + cross-team + restart', async () => {
    // Setup two teams across real HTTP
    await register('a-lead')
    await register('a-dev')
    await register('b-lead')
    const teamA = await createTeam('alpha')
    const teamB = await createTeam('beta')
    await joinTeam(teamA, 'a-lead', 'lead')
    await joinTeam(teamA, 'a-dev', 'dev')
    await joinTeam(teamB, 'b-lead', 'lead')

    // --- Ordering ---
    const m1 = await post(teamA, { sender_id: 'a-lead', content: 'kickoff' })
    const m2 = await post(teamA, { sender_id: 'a-dev', content: 'ack', reply_to: m1.id })
    const m3 = await post(teamA, {
      sender_id: 'a-lead',
      content: 'please test',
      to_role: 'dev',
    })
    expect([m1.seq, m2.seq, m3.seq]).toEqual([1, 2, 3])
    expect(m1.team_id).toBe(teamA)
    expect(m3.to_role).toBe('dev')

    // --- Cursor resume (half, then resume) ---
    const first = await since(teamA, 0, { limit: '2' })
    expect(first.messages.map((x) => x.seq)).toEqual([1, 2])
    expect(first.cursor).toBe(2)
    expect(first.head).toBe(3)

    const next = await since(teamA, first.cursor)
    expect(next.messages.map((x) => x.seq)).toEqual([3])
    expect(next.cursor).toBe(3)

    const empty = await since(teamA, 3)
    expect(empty.messages).toHaveLength(0)
    expect(empty.cursor).toBe(3)
    expect(empty.head).toBe(3)

    // --- Role-based server-side filter ---
    const devOnly = await since(teamA, 0, { for_role: 'dev' })
    // m1 has no role and no receiver → broadcast (matched), m2 direct to no one (receiver_id null) → broadcast (matched),
    // m3 to_role=dev (matched)
    // Actually m1/m2 have receiver_id = null and to_role = null, so they count as broadcasts.
    expect(devOnly.messages.some((m) => m.seq === 3)).toBe(true)

    // --- Cross-team addressing: A posts to Team B's lead ---
    const cross = await post(teamA, {
      sender_id: 'a-lead',
      content: 'heads up Team B',
      to_team: teamB,
      to_role: 'lead',
    })
    expect(cross.team_id).toBe(teamB)
    expect(cross.seq).toBe(1) // Team B's own seq sequence
    expect(cross.to_team).toBe(teamB)

    const bView = await since(teamB, 0)
    expect(bView.messages).toHaveLength(1)
    expect(bView.messages[0]!.content).toBe('heads up Team B')

    // --- 400/404 paths ---
    const badCursor = await fetch(`${baseUrl}/api/teams/${teamA}/messages/since/-1`)
    expect(badCursor.status).toBe(400)

    const badTeam = await fetch(`${baseUrl}/api/teams/nope/messages/since/0`)
    expect(badTeam.status).toBe(404)

    const missingSender = await fetch(`${baseUrl}/api/teams/${teamA}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'no sender' }),
    })
    expect(missingSender.status).toBe(400)

    const unknownTarget = await fetch(`${baseUrl}/api/teams/${teamA}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sender_id: 'a-lead', content: 'hi', to_team: 'ghost' }),
    })
    expect(unknownTarget.status).toBe(404)

    // --- RESTART RECOVERY ---
    // Tear down the broker mid-conversation, then reopen same DB file and resume.
    await stopBroker()
    await startBroker()

    // Cursor that stopped at 3 on team A should see no new messages yet.
    const afterRestart = await since(teamA, 3)
    expect(afterRestart.messages).toHaveLength(0)

    // Post a new message after restart — seq must continue from 4, not reset to 1.
    const m4 = await post(teamA, {
      sender_id: 'a-dev',
      content: 'back online',
    })
    expect(m4.seq).toBe(4)

    const resumed = await since(teamA, 3)
    expect(resumed.messages.map((x) => x.seq)).toEqual([4])

    // Full history is intact across restart.
    const all = await since(teamA, 0)
    expect(all.messages.map((x) => x.seq)).toEqual([1, 2, 3, 4])
    expect(all.messages[0]!.content).toBe('kickoff')
  })
})
