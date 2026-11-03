import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { TestDb } from '../../../helpers/db-harness.js'
import { createBrokerTestDb } from '../../../helpers/broker-db-harness.js'
import { createEventLog, type EventLog } from '../../../../src/broker/services/event-log.js'
import { registerTools } from '../../../../src/broker/tools/register-tools.js'
import {
  createSession,
  findSessionById,
} from '../../../../src/broker/storage/repositories/session-repository.js'

// ── McpServer mock ──────────────────────────────────────────
// Capture handlers registered via server.tool() so we can invoke them directly.

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}>

interface CapturedTool {
  name: string
  description: string
  schema: Record<string, unknown>
  handler: ToolHandler
}

function createMockServer() {
  const tools = new Map<string, CapturedTool>()

  const server = {
    tool: vi.fn(
      (
        name: string,
        description: string,
        schema: Record<string, unknown>,
        handler: ToolHandler,
      ) => {
        tools.set(name, { name, description, schema, handler })
      },
    ),
  }

  return {
    server: server as unknown as import('@modelcontextprotocol/sdk/server/mcp.js').McpServer,
    tools,
  }
}

// ── Helpers ──────────────────────────────────────────────────

function parseResult(result: {
  content: Array<{ type: string; text: string }>
  isError?: boolean
}) {
  return JSON.parse(result.content[0]!.text)
}

function seedSession(db: import('better-sqlite3').Database, id: string, purpose = 'test') {
  return createSession(db, { id, purpose, working_dir: '/workspace', worktree: null })
}

// ── Tests ────────────────────────────────────────────────────

describe('registerTools', () => {
  let testDb: TestDb
  let eventLog: EventLog
  let tools: Map<string, CapturedTool>

  beforeEach(() => {
    testDb = createBrokerTestDb()
    eventLog = createEventLog(testDb.db)
    const mock = createMockServer()
    tools = mock.tools
    registerTools(mock.server, testDb.db, eventLog)
  })

  afterEach(() => {
    testDb.close()
  })

  // ── Registration ────────────────────────────────────────────

  describe('tool registration', () => {
    it('registers all tools', () => {
      expect(tools.size).toBe(11)
    })

    it('registers expected tool names', () => {
      const names = [...tools.keys()]
      expect(names).toEqual(
        expect.arrayContaining([
          'register_session',
          'deregister_session',
          'send_message',
          'ack_message',
          'get_messages',
          'heartbeat',
          'create_team',
          'join_team',
          'list_sessions',
          'register_role',
          'list_roles',
        ]),
      )
    })

    it('each tool has a non-empty description', () => {
      for (const [, tool] of tools) {
        expect(tool.description).toBeTruthy()
      }
    })
  })

  // ── register_session ────────────────────────────────────────

  describe('register_session', () => {
    it('creates a session and returns it', async () => {
      const handler = tools.get('register_session')!.handler
      const result = await handler({
        id: 'sess-1',
        purpose: 'code review',
        working_dir: '/project',
      })

      expect(result.isError).toBeUndefined()
      const data = parseResult(result)
      expect(data.id).toBe('sess-1')
      expect(data.purpose).toBe('code review')
      expect(data.working_dir).toBe('/project')
      expect(data.status).toBe('active')
    })

    it('persists session to database', async () => {
      const handler = tools.get('register_session')!.handler
      await handler({ id: 'sess-db', purpose: 'test', working_dir: '/w' })

      const session = findSessionById(testDb.db, 'sess-db')
      expect(session).not.toBeNull()
      expect(session!.purpose).toBe('test')
    })

    it('defaults working_dir to process.cwd() when omitted', async () => {
      const handler = tools.get('register_session')!.handler
      const result = await handler({ id: 'sess-cwd', purpose: 'test' })

      const data = parseResult(result)
      expect(data.working_dir).toBe(process.cwd())
    })

    it('logs sessionRegistered event', async () => {
      const handler = tools.get('register_session')!.handler
      await handler({ id: 'sess-evt', purpose: 'review', working_dir: '/w' })

      const events = eventLog.forSession('sess-evt')
      expect(events.length).toBeGreaterThanOrEqual(1)
      expect(events.some((e) => e.event_type === 'session_registered')).toBe(true)
    })

    it('revives a known id instead of erroring (issue #70: durable identity)', async () => {
      const handler = tools.get('register_session')!.handler
      await handler({ id: 'dup', purpose: 'first', working_dir: '/w' })
      testDb.db
        .prepare("UPDATE sessions SET status = 'expired', archived_at = datetime('now') WHERE id = 'dup'")
        .run()

      const result = await handler({ id: 'dup', purpose: 'second', working_dir: '/w' })

      expect(result.isError).toBeUndefined()
      const data = parseResult(result)
      expect(data.revived).toBe(true)
      expect(data.status).toBe('active')
    })
  })

  // ── deregister_session ──────────────────────────────────────

  describe('deregister_session', () => {
    it('marks session as completed', async () => {
      seedSession(testDb.db, 'sess-dereg')
      const handler = tools.get('deregister_session')!.handler
      const result = await handler({ id: 'sess-dereg' })

      expect(result.isError).toBeUndefined()
      const data = parseResult(result)
      expect(data.success).toBe(true)
      expect(data.id).toBe('sess-dereg')
    })

    it('updates status to completed in database', async () => {
      seedSession(testDb.db, 'sess-complete')
      const handler = tools.get('deregister_session')!.handler
      await handler({ id: 'sess-complete' })

      const session = findSessionById(testDb.db, 'sess-complete')
      expect(session!.status).toBe('completed')
    })

    it('logs sessionDeregistered event', async () => {
      seedSession(testDb.db, 'sess-derevt')
      const handler = tools.get('deregister_session')!.handler
      await handler({ id: 'sess-derevt' })

      const events = eventLog.forSession('sess-derevt')
      expect(events.some((e) => e.event_type === 'session_deregistered')).toBe(true)
    })

    it('returns error for nonexistent session', async () => {
      const handler = tools.get('deregister_session')!.handler
      const result = await handler({ id: 'ghost' })

      expect(result.isError).toBe(true)
      const data = parseResult(result)
      expect(data.error).toContain('ghost')
      expect(data.error).toContain('not found')
    })
  })

  // ── send_message ────────────────────────────────────────────

  describe('send_message', () => {
    beforeEach(() => {
      seedSession(testDb.db, 'sender')
      seedSession(testDb.db, 'receiver')
    })

    it('creates a message and returns it', async () => {
      const handler = tools.get('send_message')!.handler
      const result = await handler({
        sender_id: 'sender',
        receiver_id: 'receiver',
        content: 'Hello!',
      })

      expect(result.isError).toBeUndefined()
      const data = parseResult(result)
      expect(data.sender_id).toBe('sender')
      expect(data.receiver_id).toBe('receiver')
      expect(data.content).toBe('Hello!')
      expect(data.id).toBeDefined()
    })

    it('supports broadcast (null receiver_id)', async () => {
      const handler = tools.get('send_message')!.handler
      const result = await handler({
        sender_id: 'sender',
        content: 'Broadcast!',
      })

      expect(result.isError).toBeUndefined()
      const data = parseResult(result)
      expect(data.receiver_id).toBeNull()
    })

    it('supports explicit null receiver_id', async () => {
      const handler = tools.get('send_message')!.handler
      const result = await handler({
        sender_id: 'sender',
        receiver_id: null,
        content: 'Broadcast explicit!',
      })

      expect(result.isError).toBeUndefined()
      const data = parseResult(result)
      expect(data.receiver_id).toBeNull()
    })

    it('logs messageSent event', async () => {
      const handler = tools.get('send_message')!.handler
      await handler({ sender_id: 'sender', receiver_id: 'receiver', content: 'hi' })

      const events = eventLog.forSession('sender')
      expect(events.some((e) => e.event_type === 'message_sent')).toBe(true)
    })

    it('message event payload includes message_id and receiver_id', async () => {
      const handler = tools.get('send_message')!.handler
      await handler({ sender_id: 'sender', receiver_id: 'receiver', content: 'hi' })

      const events = eventLog.forSession('sender')
      const msgEvent = events.find((e) => e.event_type === 'message_sent')!
      const payload = JSON.parse(msgEvent.payload)
      expect(payload.message_id).toBeDefined()
      expect(payload.receiver_id).toBe('receiver')
    })
  })

  // ── get_messages ────────────────────────────────────────────

  describe('get_messages', () => {
    beforeEach(() => {
      seedSession(testDb.db, 'alice')
      seedSession(testDb.db, 'bob')
    })

    it('returns messages for receiver', async () => {
      // Send a message from alice to bob
      const sendHandler = tools.get('send_message')!.handler
      await sendHandler({ sender_id: 'alice', receiver_id: 'bob', content: 'Hey Bob' })

      const handler = tools.get('get_messages')!.handler
      const result = await handler({ receiver_id: 'bob' })

      expect(result.isError).toBeUndefined()
      const data = parseResult(result)
      expect(data.messages).toHaveLength(1)
      expect(data.messages[0].content).toBe('Hey Bob')
    })

    it('returns empty array when no messages', async () => {
      const handler = tools.get('get_messages')!.handler
      const result = await handler({ receiver_id: 'bob' })

      const data = parseResult(result)
      expect(data.messages).toHaveLength(0)
    })

    it('includes broadcast messages (null receiver)', async () => {
      const sendHandler = tools.get('send_message')!.handler
      await sendHandler({ sender_id: 'alice', content: 'Broadcast!' })

      const handler = tools.get('get_messages')!.handler
      const result = await handler({ receiver_id: 'bob' })

      const data = parseResult(result)
      expect(data.messages.length).toBeGreaterThanOrEqual(1)
      expect(data.messages.some((m: { content: string }) => m.content === 'Broadcast!')).toBe(true)
    })

    it('supports unread_only filter', async () => {
      const sendHandler = tools.get('send_message')!.handler
      await sendHandler({ sender_id: 'alice', receiver_id: 'bob', content: 'msg1' })

      // Mark the message as read manually
      testDb.db
        .prepare("UPDATE messages SET read_at = datetime('now') WHERE content = 'msg1'")
        .run()

      // Send another unread message
      await sendHandler({ sender_id: 'alice', receiver_id: 'bob', content: 'msg2' })

      const handler = tools.get('get_messages')!.handler
      const result = await handler({ receiver_id: 'bob', unread_only: true })

      const data = parseResult(result)
      expect(data.messages).toHaveLength(1)
      expect(data.messages[0].content).toBe('msg2')
    })
  })

  // ── heartbeat ───────────────────────────────────────────────

  describe('heartbeat', () => {
    it('returns success for existing session', async () => {
      seedSession(testDb.db, 'sess-hb')
      const handler = tools.get('heartbeat')!.handler
      const result = await handler({ session_id: 'sess-hb' })

      expect(result.isError).toBeUndefined()
      const data = parseResult(result)
      expect(data.success).toBe(true)
      expect(data.session_id).toBe('sess-hb')
    })

    it('updates last_heartbeat in database', async () => {
      seedSession(testDb.db, 'sess-hbtime')
      // Backdate heartbeat
      testDb.db
        .prepare(
          "UPDATE sessions SET last_heartbeat = datetime('now', '-1 hour') WHERE id = 'sess-hbtime'",
        )
        .run()
      const before = findSessionById(testDb.db, 'sess-hbtime')!.last_heartbeat

      const handler = tools.get('heartbeat')!.handler
      await handler({ session_id: 'sess-hbtime' })

      const after = findSessionById(testDb.db, 'sess-hbtime')!.last_heartbeat
      expect(after).not.toBe(before)
    })

    it('logs heartbeatReceived event', async () => {
      seedSession(testDb.db, 'sess-hbevt')
      const handler = tools.get('heartbeat')!.handler
      await handler({ session_id: 'sess-hbevt' })

      const events = eventLog.forSession('sess-hbevt')
      expect(events.some((e) => e.event_type === 'heartbeat_received')).toBe(true)
    })

    it('returns error for nonexistent session', async () => {
      const handler = tools.get('heartbeat')!.handler
      const result = await handler({ session_id: 'no-such' })

      expect(result.isError).toBe(true)
      const data = parseResult(result)
      expect(data.error).toContain('no-such')
      expect(data.error).toContain('not found')
    })
  })

  // ── create_team ─────────────────────────────────────────────

  describe('create_team', () => {
    it('creates a team and returns it', async () => {
      const handler = tools.get('create_team')!.handler
      const result = await handler({ name: 'Alpha', description: 'The alpha team' })

      expect(result.isError).toBeUndefined()
      const data = parseResult(result)
      expect(data.name).toBe('Alpha')
      expect(data.description).toBe('The alpha team')
      expect(data.status).toBe('active')
      expect(data.id).toMatch(/^[0-9a-f]{8}-/)
    })

    it('creates team without description', async () => {
      const handler = tools.get('create_team')!.handler
      const result = await handler({ name: 'Minimal' })

      expect(result.isError).toBeUndefined()
      const data = parseResult(result)
      expect(data.name).toBe('Minimal')
    })

    it('logs teamCreated event', async () => {
      const handler = tools.get('create_team')!.handler
      await handler({ name: 'EvtTeam' })

      // teamCreated uses null sessionId
      const events = eventLog.since(0)
      expect(events.some((e) => e.event_type === 'team_created')).toBe(true)
    })

    it('returns error on duplicate team name', async () => {
      const handler = tools.get('create_team')!.handler
      await handler({ name: 'UniqueTeam' })
      const result = await handler({ name: 'UniqueTeam' })

      expect(result.isError).toBe(true)
      const data = parseResult(result)
      expect(data.error).toBeDefined()
    })
  })

  // ── join_team ───────────────────────────────────────────────

  describe('join_team', () => {
    let teamId: string

    beforeEach(async () => {
      seedSession(testDb.db, 'agent-1')
      const handler = tools.get('create_team')!.handler
      const result = await handler({ name: 'JoinTeam' })
      teamId = parseResult(result).id
    })

    it('joins a session to a team and returns the member', async () => {
      const handler = tools.get('join_team')!.handler
      const result = await handler({
        team_id: teamId,
        session_id: 'agent-1',
        name: 'Agent One',
      })

      expect(result.isError).toBeUndefined()
      const data = parseResult(result)
      expect(data.team_id).toBe(teamId)
      expect(data.session_id).toBe('agent-1')
      expect(data.name).toBe('Agent One')
      expect(data.role).toBe('general')
    })

    it('respects optional role parameter', async () => {
      const handler = tools.get('join_team')!.handler
      const result = await handler({
        team_id: teamId,
        session_id: 'agent-1',
        name: 'Lead',
        role: 'lead',
      })

      const data = parseResult(result)
      expect(data.role).toBe('lead')
    })

    it('logs teamMemberJoined event', async () => {
      const handler = tools.get('join_team')!.handler
      await handler({ team_id: teamId, session_id: 'agent-1', name: 'Agent One' })

      const events = eventLog.forSession('agent-1')
      expect(events.some((e) => e.event_type === 'team_member_joined')).toBe(true)
    })

    it('event payload includes team_id and name', async () => {
      const handler = tools.get('join_team')!.handler
      await handler({ team_id: teamId, session_id: 'agent-1', name: 'Agent One' })

      const events = eventLog.forSession('agent-1')
      const joinEvent = events.find((e) => e.event_type === 'team_member_joined')!
      const payload = JSON.parse(joinEvent.payload)
      expect(payload.team_id).toBe(teamId)
      expect(payload.name).toBe('Agent One')
    })

    it('returns error for nonexistent team', async () => {
      const handler = tools.get('join_team')!.handler
      const result = await handler({
        team_id: 'no-team',
        session_id: 'agent-1',
        name: 'Agent One',
      })

      expect(result.isError).toBe(true)
      const data = parseResult(result)
      expect(data.error).toBeDefined()
    })

    it('returns error for duplicate membership', async () => {
      const handler = tools.get('join_team')!.handler
      await handler({ team_id: teamId, session_id: 'agent-1', name: 'Agent One' })
      const result = await handler({ team_id: teamId, session_id: 'agent-1', name: 'Agent Dup' })

      expect(result.isError).toBe(true)
      const data = parseResult(result)
      expect(data.error).toBeDefined()
    })
  })

  // ── list_sessions ───────────────────────────────────────────

  describe('list_sessions', () => {
    it('returns empty list when no sessions exist', async () => {
      const handler = tools.get('list_sessions')!.handler
      const result = await handler({})

      expect(result.isError).toBeUndefined()
      const data = parseResult(result)
      expect(data.sessions).toHaveLength(0)
    })

    it('returns all active sessions', async () => {
      seedSession(testDb.db, 's1', 'purpose-1')
      seedSession(testDb.db, 's2', 'purpose-2')

      const handler = tools.get('list_sessions')!.handler
      const result = await handler({})

      const data = parseResult(result)
      expect(data.sessions).toHaveLength(2)
    })

    it('filters sessions by status', async () => {
      seedSession(testDb.db, 's-active', 'active session')
      seedSession(testDb.db, 's-paused', 'paused session')
      // Set one to paused (not archived)
      testDb.db.prepare("UPDATE sessions SET status = 'paused' WHERE id = 's-paused'").run()

      const handler = tools.get('list_sessions')!.handler
      const result = await handler({ status: 'paused' })

      const data = parseResult(result)
      expect(data.sessions).toHaveLength(1)
      expect(data.sessions[0].id).toBe('s-paused')
    })

    it('completed+archived sessions excluded by default (findAllSessions behavior)', async () => {
      seedSession(testDb.db, 's-live')
      seedSession(testDb.db, 's-completed')
      // Completing a session also sets archived_at, so findAllSessions excludes it
      testDb.db
        .prepare(
          "UPDATE sessions SET status = 'completed', archived_at = datetime('now') WHERE id = 's-completed'",
        )
        .run()

      const handler = tools.get('list_sessions')!.handler
      const result = await handler({ status: 'completed' })

      const data = parseResult(result)
      // findAllSessions filters out archived_at IS NOT NULL by default
      expect(data.sessions).toHaveLength(0)
    })

    it('returns all when no status filter provided', async () => {
      seedSession(testDb.db, 's-a')
      seedSession(testDb.db, 's-b')

      const handler = tools.get('list_sessions')!.handler
      const result = await handler({})

      const data = parseResult(result)
      expect(data.sessions).toHaveLength(2)
    })

    it('excludes archived sessions by default (no status filter)', async () => {
      seedSession(testDb.db, 's-live')
      seedSession(testDb.db, 's-archived')
      testDb.db
        .prepare("UPDATE sessions SET archived_at = datetime('now') WHERE id = 's-archived'")
        .run()

      const handler = tools.get('list_sessions')!.handler
      const result = await handler({})

      const data = parseResult(result)
      expect(data.sessions).toHaveLength(1)
      expect(data.sessions[0].id).toBe('s-live')
    })
  })

  // ── textResult / errorResult format ─────────────────────────

  describe('result format', () => {
    it('textResult has content array with type "text"', async () => {
      seedSession(testDb.db, 'fmt-sess')
      const handler = tools.get('heartbeat')!.handler
      const result = await handler({ session_id: 'fmt-sess' })

      expect(result.content).toHaveLength(1)
      expect(result.content[0]!.type).toBe('text')
      expect(() => JSON.parse(result.content[0]!.text)).not.toThrow()
    })

    it('errorResult has isError=true and content with error message', async () => {
      const handler = tools.get('deregister_session')!.handler
      const result = await handler({ id: 'nonexistent' })

      expect(result.isError).toBe(true)
      expect(result.content).toHaveLength(1)
      expect(result.content[0]!.type).toBe('text')
      const data = JSON.parse(result.content[0]!.text)
      expect(data.error).toBeDefined()
    })
  })
})
