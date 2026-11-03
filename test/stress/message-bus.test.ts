/**
 * Phase 13.6 stress: 2 teams × 3 agents × 100 messages over real HTTP.
 * Verifies no drops, no reorder within each team's seq sequence, and
 * that cross-team routed messages show up in the target team's feed.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as pathJoin } from 'node:path'
import type Database from 'better-sqlite3'
import { openDatabase, closeDatabase } from '../../src/broker/storage/db.js'
import { createEventLog } from '../../src/broker/services/event-log.js'
import { createEventDispatcher } from '../../src/broker/event-dispatcher.js'
import { createBrokerServer, type BrokerServer } from '../../src/broker/server.js'

describe('team message bus stress — 2 teams × 3 agents × 100 msgs', () => {
  let tmpDir: string
  let db: Database.Database
  let broker: BrokerServer
  let server: Server
  let baseUrl: string

  beforeAll(async () => {
    tmpDir = mkdtempSync(pathJoin(tmpdir(), 'scns-msgbus-stress-'))
    db = openDatabase(pathJoin(tmpDir, 'broker.db'))
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(db, dispatcher)
    broker = createBrokerServer(db, eventLog, undefined, dispatcher, {
      authToken: null,
      rateLimits: {
        globalMax: 100_000,
        sessionWriteMax: 100_000,
      },
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
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('200 messages across 2 teams — zero drops, strict monotonic per-team seq', async () => {
    async function register(id: string): Promise<void> {
      const r = await fetch(`${baseUrl}/api/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, purpose: 'stress' }),
      })
      expect(r.status).toBe(200)
    }

    async function mkTeam(name: string): Promise<string> {
      const r = await fetch(`${baseUrl}/api/teams`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      expect(r.status).toBe(201)
      return ((await r.json()) as { id: string }).id
    }

    async function addMember(teamId: string, sid: string, role: string): Promise<void> {
      const r = await fetch(`${baseUrl}/api/teams/${teamId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sid, name: sid, role }),
      })
      expect(r.status).toBe(201)
    }

    const agents = {
      a1: 'stress-a-1',
      a2: 'stress-a-2',
      a3: 'stress-a-3',
      b1: 'stress-b-1',
      b2: 'stress-b-2',
      b3: 'stress-b-3',
    }
    for (const id of Object.values(agents)) await register(id)

    const teamA = await mkTeam('stress-alpha')
    const teamB = await mkTeam('stress-beta')
    await addMember(teamA, agents.a1, 'lead')
    await addMember(teamA, agents.a2, 'dev')
    await addMember(teamA, agents.a3, 'qa')
    await addMember(teamB, agents.b1, 'lead')
    await addMember(teamB, agents.b2, 'dev')
    await addMember(teamB, agents.b3, 'qa')

    const N = 100 // per team
    const teamAAgents = [agents.a1, agents.a2, agents.a3]
    const teamBAgents = [agents.b1, agents.b2, agents.b3]

    const sendTo = async (teamId: string, sender: string, idx: number, extra: Record<string, unknown> = {}) => {
      const r = await fetch(`${baseUrl}/api/teams/${teamId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sender_id: sender, content: `${sender}-${idx}`, ...extra }),
      })
      expect(r.status).toBe(201)
      return (await r.json()) as { seq: number; id: string; team_id: string }
    }

    // Parallel-ish bursts within a team. Each agent fires N/3 messages.
    const jobsA: Promise<unknown>[] = []
    const jobsB: Promise<unknown>[] = []
    for (let i = 0; i < N; i++) {
      jobsA.push(sendTo(teamA, teamAAgents[i % 3]!, i))
      jobsB.push(sendTo(teamB, teamBAgents[i % 3]!, i))
    }
    // A few cross-team messages sprinkled in.
    for (let i = 0; i < 10; i++) {
      jobsA.push(sendTo(teamA, agents.a1, 1000 + i, { to_team: teamB, to_role: 'lead' }))
    }

    await Promise.all([...jobsA, ...jobsB])

    // Drain team A via cursor — verify strict ordering and zero gaps.
    const drain = async (teamId: string): Promise<number[]> => {
      const all: number[] = []
      let cursor = 0
      for (;;) {
        const r = await fetch(`${baseUrl}/api/teams/${teamId}/messages/since/${cursor}?limit=50`)
        expect(r.status).toBe(200)
        const body = (await r.json()) as { messages: Array<{ seq: number }>; cursor: number; head: number }
        if (body.messages.length === 0) break
        for (const m of body.messages) all.push(m.seq)
        cursor = body.cursor
        if (cursor >= body.head) break
      }
      return all
    }

    const seqsA = await drain(teamA)
    const seqsB = await drain(teamB)

    // Team A owns 100 native + 10 cross-from-A-not-counted (those are in team B)
    expect(seqsA).toHaveLength(N)
    expect(seqsB).toHaveLength(N + 10)

    for (let i = 0; i < seqsA.length; i++) expect(seqsA[i]).toBe(i + 1)
    for (let i = 0; i < seqsB.length; i++) expect(seqsB[i]).toBe(i + 1)
  })
})
