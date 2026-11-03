/**
 * E2E: Session messaging pipeline — direct messages, broadcast, teams, mark-read.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type Database from 'better-sqlite3'
import { openDatabase, closeDatabase } from '../../src/broker/storage/db.js'
import { createEventLog } from '../../src/broker/services/event-log.js'
import { createEventDispatcher } from '../../src/broker/event-dispatcher.js'
import { createBrokerServer, type BrokerServer } from '../../src/broker/server.js'

interface Message {
  id: string
  sender_id: string
  receiver_id: string | null
  content: string
  read_at: string | null
}

describe('Session Messaging E2E', () => {
  let db: Database.Database
  let broker: BrokerServer
  let server: Server
  let baseUrl: string

  beforeAll(async () => {
    db = openDatabase(':memory:')
    const dispatcher = createEventDispatcher()
    const eventLog = createEventLog(db, dispatcher)
    broker = createBrokerServer(db, eventLog, undefined, dispatcher, { authToken: null })
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

  async function registerAgent(id: string): Promise<void> {
    const res = await fetch(`${baseUrl}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, purpose: 'messaging test' }),
    })
    expect(res.status).toBe(200)
  }

  async function sendMessage(
    senderId: string,
    receiverId: string | null,
    content: string,
  ): Promise<Message> {
    const body: Record<string, unknown> = { sender_id: senderId, content }
    if (receiverId !== null) {
      body.receiver_id = receiverId
    }
    const res = await fetch(`${baseUrl}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(res.status).toBe(201)
    return res.json() as Promise<Message>
  }

  async function getMessages(receiverId: string, unreadOnly = false): Promise<Message[]> {
    const qs = unreadOnly ? '?unread_only=true' : ''
    const res = await fetch(`${baseUrl}/api/messages/${receiverId}${qs}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { messages: Message[] }
    return body.messages
  }

  it('direct message from A to B', async () => {
    await registerAgent('msg-agent-a')
    await registerAgent('msg-agent-b')

    // Send message A → B
    const sent = await sendMessage('msg-agent-a', 'msg-agent-b', 'Hello from A')
    expect(sent.sender_id).toBe('msg-agent-a')
    expect(sent.receiver_id).toBe('msg-agent-b')
    expect(sent.content).toBe('Hello from A')

    // B polls messages
    const msgs = await getMessages('msg-agent-b')
    expect(msgs.some((m) => m.content === 'Hello from A')).toBe(true)

    // A should not see B's messages
    const aMsgs = await getMessages('msg-agent-a')
    expect(aMsgs.some((m) => m.content === 'Hello from A')).toBe(false)
  })

  it('mark message as read', async () => {
    const sent = await sendMessage('msg-agent-a', 'msg-agent-b', 'Read me')

    // Initially unread
    const unread = await getMessages('msg-agent-b', true)
    expect(unread.some((m) => m.id === sent.id)).toBe(true)

    // Mark read
    const markRes = await fetch(`${baseUrl}/api/messages/mark-read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message_ids: [sent.id] }),
    })
    expect(markRes.status).toBe(200)

    // Should not appear in unread-only query
    const afterMark = await getMessages('msg-agent-b', true)
    expect(afterMark.some((m) => m.id === sent.id)).toBe(false)
  })

  it('broadcast message (null receiver) visible to all receivers', async () => {
    // msg-agent-a and msg-agent-b already registered
    const broadcast = await sendMessage('msg-agent-a', null, 'Broadcast to all')
    expect(broadcast.receiver_id).toBeNull()

    // Both agents should see the broadcast
    const bMsgs = await getMessages('msg-agent-b')
    expect(bMsgs.some((m) => m.content === 'Broadcast to all')).toBe(true)

    const aMsgs = await getMessages('msg-agent-a')
    expect(aMsgs.some((m) => m.content === 'Broadcast to all')).toBe(true)
  })

  it('team creation and member management', async () => {
    // Register additional agents
    await registerAgent('msg-team-lead')
    await registerAgent('msg-team-worker')

    // Create a team
    const teamRes = await fetch(`${baseUrl}/api/teams`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test Squad', description: 'E2E team test' }),
    })
    expect(teamRes.status).toBe(201)
    const team = (await teamRes.json()) as { id: string; name: string }
    expect(team.name).toBe('Test Squad')

    // Add members
    const joinRes1 = await fetch(`${baseUrl}/api/teams/${team.id}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: 'msg-team-lead',
        name: 'Lead',
        role: 'lead',
      }),
    })
    expect(joinRes1.status).toBe(201)

    const joinRes2 = await fetch(`${baseUrl}/api/teams/${team.id}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: 'msg-team-worker',
        name: 'Worker',
        role: 'dev',
      }),
    })
    expect(joinRes2.status).toBe(201)

    // Get team with members
    const getTeam = await fetch(`${baseUrl}/api/teams/${team.id}`)
    expect(getTeam.status).toBe(200)
    const teamData = (await getTeam.json()) as {
      id: string
      members: Array<{ session_id: string }>
    }
    expect(teamData.members).toHaveLength(2)

    // Remove a member
    const removeRes = await fetch(`${baseUrl}/api/teams/${team.id}/members/msg-team-worker`, {
      method: 'DELETE',
    })
    expect(removeRes.status).toBe(200)

    // Verify removal
    const getTeam2 = await fetch(`${baseUrl}/api/teams/${team.id}`)
    const teamData2 = (await getTeam2.json()) as {
      members: Array<{ session_id: string }>
    }
    expect(teamData2.members).toHaveLength(1)
    expect(teamData2.members[0]!.session_id).toBe('msg-team-lead')
  })

  it('message reply thread', async () => {
    // Send original message
    const original = await sendMessage('msg-agent-a', 'msg-agent-b', 'Original')

    // Reply to it
    const replyRes = await fetch(`${baseUrl}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender_id: 'msg-agent-b',
        receiver_id: 'msg-agent-a',
        content: 'Reply to original',
        reply_to: original.id,
      }),
    })
    expect(replyRes.status).toBe(201)
    const reply = (await replyRes.json()) as Message & { reply_to: string }
    expect(reply.reply_to).toBe(original.id)
  })

  it('shared state CRUD operations', async () => {
    // Set state
    const setRes = await fetch(`${baseUrl}/api/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'test-key', value: 'test-value' }),
    })
    expect(setRes.status).toBe(200)

    // Get state
    const getRes = await fetch(`${baseUrl}/api/state/test-key`)
    expect(getRes.status).toBe(200)
    const state = (await getRes.json()) as { key: string; value: string }
    expect(state.key).toBe('test-key')
    expect(state.value).toBe('test-value')

    // Delete state
    const delRes = await fetch(`${baseUrl}/api/state/test-key`, {
      method: 'DELETE',
    })
    expect(delRes.status).toBe(200)

    // Verify deleted
    const getRes2 = await fetch(`${baseUrl}/api/state/test-key`)
    expect(getRes2.status).toBe(404)
  })

  it('intent declaration and conflict detection', async () => {
    // Two sessions declare intent on same file
    const intent1 = await fetch(`${baseUrl}/api/declare_intent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: 'msg-agent-a',
        file: 'src/shared/config.ts',
        operation: 'edit',
      }),
    })
    expect(intent1.status).toBe(200)

    const intent2 = await fetch(`${baseUrl}/api/declare_intent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: 'msg-agent-b',
        file: 'src/shared/config.ts',
        operation: 'edit',
      }),
    })
    expect(intent2.status).toBe(200)
    const conflict = (await intent2.json()) as {
      conflict: boolean
      conflicting_sessions: Array<{ session_id: string }>
    }
    expect(conflict.conflict).toBe(true)
    expect(conflict.conflicting_sessions.some((s) => s.session_id === 'msg-agent-a')).toBe(true)

    // Verify via conflicts endpoint
    const conflictsRes = await fetch(`${baseUrl}/api/conflicts`)
    expect(conflictsRes.status).toBe(200)
    const { conflicts } = (await conflictsRes.json()) as {
      conflicts: Array<{ file_path: string }>
    }
    expect(conflicts.some((c) => c.file_path === 'src/shared/config.ts')).toBe(true)
  })
})
