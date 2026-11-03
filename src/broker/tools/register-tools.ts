/**
 * Registers core MCP tools on the McpServer.
 * Each tool wraps a broker operation with Zod-validated input.
 */

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type Database from 'better-sqlite3'
import type { EventLog } from '../services/event-log.js'
import {
  createSession,
  findSessionById,
  findAllSessions,
  updateHeartbeat,
  updateSessionStatus,
  reviveSession,
} from '../storage/repositories/session-repository.js'
import {
  createMessageWithReplay,
  ClientMessageIdConflictError,
  findMessagesByReceiver,
  findMessageById,
  setMessageDisposition,
} from '../storage/repositories/message-repository.js'
import { createTeam, joinTeam } from '../services/team-orchestration.js'
import { registerRole, listRoles } from '../role-registry.js'
import { appendEvent } from '../storage/repositories/event-repository.js'
import type { SafetyKernel } from '../services/safety-kernel/safety-kernel.js'
import {
  createAskHumanHandler,
  createConsultSourceHandler,
  ASK_HUMAN_MAX_CHARS,
  CONSULT_REASON_MAX_CHARS,
} from '../services/outward/index.js'

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

function textResult(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] }
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true }
}

export function registerTools(
  server: McpServer,
  db: Database.Database,
  eventLog: EventLog,
  projectId?: string,
  safetyKernel?: SafetyKernel,
): void {
  // T056 [US5] (specs/001-learning-memory-loop) — the two OUTWARD actions, registered only when the
  // immutable safety kernel is wired (every call routes through its single check chokepoint and is
  // audited into the hash-chained kernel_audit; the allowlist ships EMPTY ⇒ deny-all egress/spend).
  if (safetyKernel) {
    const askHuman = createAskHumanHandler({
      kernel: safetyKernel,
      // The human channel: an append-only 'human.question' event the dashboard surfaces — internal
      // by construction (no egress, no spend).
      deliver: (question) => {
        const ev = appendEvent(db, {
          event_type: 'human.question',
          session_id: null,
          payload: JSON.stringify({ question, status: 'pending-human' }),
        })
        return `q-${ev.id}`
      },
    })
    const consultSource = createConsultSourceHandler({
      kernel: safetyKernel,
      fetchSource: async (url) => {
        const ctl = new AbortController()
        const timer = setTimeout(() => ctl.abort(), 10_000)
        try {
          const res = await fetch(url, { signal: ctl.signal })
          const body = (await res.text()).slice(0, 100_000)
          return { status: res.status, body }
        } finally {
          clearTimeout(timer)
        }
      },
    })
    server.tool(
      'ask_human',
      'Deliver a clarifying question to the human (no external contact, no spend; audited)',
      {
        question: z
          .string()
          .min(1)
          .max(ASK_HUMAN_MAX_CHARS)
          .describe('The clarifying question for the human'),
      },
      async (args) => {
        const res = askHuman.askHuman({ question: args.question })
        return res.allowed ? textResult(res) : errorResult(res.detail)
      },
    )
    server.tool(
      'consult_source',
      'Read an APPROVED-LIST source (deny-all by default; spend always refused; audited)',
      {
        url: z.string().url().describe('The source URL to consult'),
        reason: z
          .string()
          .min(1)
          .max(CONSULT_REASON_MAX_CHARS)
          .describe('Why this source is needed (recorded in the audit trail)'),
      },
      async (args) => {
        const res = await consultSource.consultSource({ url: args.url, reason: args.reason })
        return res.allowed ? textResult(res) : errorResult(res.detail)
      },
    )
  }
  server.tool(
    'register_session',
    'Register a new session with the broker',
    {
      id: z.string().describe('Unique session identifier'),
      purpose: z.string().describe('Purpose of the session'),
      working_dir: z.string().optional().describe('Working directory'),
    },
    async (args) => {
      try {
        // Issue #70: mirror POST /api/register — a known id revives instead
        // of failing on the primary key; interim mail stays in its inbox.
        const existing = findSessionById(db, args.id)
        if (existing) {
          const revived = reviveSession(db, args.id, ['expired', 'completed', 'zombie'])
          eventLog.sessionRegistered(args.id, {
            purpose: existing.purpose,
            working_dir: existing.working_dir,
            revived: true,
            previous_status: existing.status,
          })
          return textResult({ ...revived, revived: true })
        }
        const session = createSession(db, {
          id: args.id,
          purpose: args.purpose,
          working_dir: args.working_dir ?? process.cwd(),
          worktree: null,
          project_id: projectId ?? null,
        })
        eventLog.sessionRegistered(session.id, {
          purpose: session.purpose,
          working_dir: session.working_dir,
        })
        return textResult(session)
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Unknown error')
      }
    },
  )

  server.tool(
    'deregister_session',
    'Deregister a session from the broker',
    {
      id: z.string().describe('Session ID to deregister'),
    },
    async (args) => {
      try {
        const session = findSessionById(db, args.id)
        if (!session) {
          return errorResult(`Session '${args.id}' not found`)
        }
        updateSessionStatus(db, args.id, 'completed')
        eventLog.sessionDeregistered(args.id, { id: args.id })
        return textResult({ success: true, id: args.id })
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Unknown error')
      }
    },
  )

  server.tool(
    'send_message',
    'Send a message to another session',
    {
      sender_id: z.string().describe('Sender session ID'),
      receiver_id: z
        .string()
        .nullable()
        .optional()
        .describe('Receiver session ID (null for broadcast)'),
      content: z.string().describe('Message content'),
      client_message_id: z
        .string()
        .optional()
        .describe(
          'Stable client id for safe retries (issue #70): same id + same payload replays the original message; conflicting reuse is rejected',
        ),
    },
    async (args) => {
      try {
        // Issue #70: distinguishable participant errors instead of raw FK failures.
        if (!findSessionById(db, args.sender_id)) {
          return errorResult(
            `UNKNOWN_PARTICIPANT: sender '${args.sender_id}' is not registered — register_session first`,
          )
        }
        let receiverStatus: string | null = null
        if (args.receiver_id != null) {
          const receiver = findSessionById(db, args.receiver_id)
          if (!receiver) {
            return errorResult(
              `UNKNOWN_PARTICIPANT: receiver '${args.receiver_id}' is not registered — verify the id via list_sessions`,
            )
          }
          receiverStatus = receiver.status
        }
        const { message, replayed } = createMessageWithReplay(db, {
          id: randomUUID(),
          sender_id: args.sender_id,
          receiver_id: args.receiver_id ?? null,
          content: args.content,
          story_id: null,
          client_message_id: args.client_message_id ?? null,
        })
        if (!replayed) {
          eventLog.messageSent(args.sender_id, {
            message_id: message.id,
            receiver_id: args.receiver_id ?? null,
          })
        }
        return textResult({ ...message, replayed, receiver_status: receiverStatus })
      } catch (err) {
        if (err instanceof ClientMessageIdConflictError) {
          return errorResult(`CLIENT_MESSAGE_ID_CONFLICT: ${err.message}`)
        }
        if ((err as { code?: string })?.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
          return errorResult(
            'UNKNOWN_PARTICIPANT: a participant was deregistered while the send was in flight — re-check the ids and retry',
          )
        }
        return errorResult(err instanceof Error ? err.message : 'Unknown error')
      }
    },
  )

  server.tool(
    'ack_message',
    'Record an explicit disposition (accepted/rejected/deferred) for a received message — a send response alone is never an acknowledgement',
    {
      message_id: z.string().describe('Message ID to acknowledge'),
      disposition: z
        .enum(['accepted', 'rejected', 'deferred'])
        .describe('Explicit verdict on the message'),
      note: z.string().optional().describe('Optional rationale recorded with the disposition'),
    },
    async (args) => {
      try {
        const existing = findMessageById(db, args.message_id)
        if (!existing) {
          return errorResult(`Message '${args.message_id}' not found`)
        }
        // Directed mail only — a broadcast has many recipients and one row,
        // so a single ack would hide it from every other inbox.
        if (existing.receiver_id === null) {
          return errorResult(
            `BROADCAST_NOT_ACKABLE: message '${args.message_id}' is a broadcast — dispositions are per-recipient`,
          )
        }
        const message = setMessageDisposition(db, args.message_id, args.disposition, args.note)
        eventLog.messageDisposition(existing.receiver_id, {
          message_id: args.message_id,
          disposition: args.disposition,
        })
        return textResult({ success: true, message })
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Unknown error')
      }
    },
  )

  server.tool(
    'get_messages',
    'Get messages for a receiver session',
    {
      receiver_id: z.string().describe('Receiver session ID'),
      unread_only: z.boolean().optional().describe('Only return unread messages'),
    },
    async (args) => {
      try {
        const messages = findMessagesByReceiver(db, args.receiver_id, {
          unreadOnly: args.unread_only,
        })
        return textResult({ messages })
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Unknown error')
      }
    },
  )

  server.tool(
    'heartbeat',
    'Send a heartbeat for a session',
    {
      session_id: z.string().describe('Session ID'),
    },
    async (args) => {
      try {
        const session = findSessionById(db, args.session_id)
        if (!session) {
          return errorResult(`Session '${args.session_id}' not found`)
        }
        // Issue #70: a heartbeat proves liveness — undo lease expiry (but
        // never resurrect an explicitly completed session).
        const revived = session.status === 'expired'
        if (revived) {
          reviveSession(db, args.session_id)
        } else {
          updateHeartbeat(db, args.session_id)
        }
        eventLog.heartbeatReceived(args.session_id, revived ? { revived: true } : {})
        return textResult({
          success: true,
          session_id: args.session_id,
          ...(revived && { revived }),
        })
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Unknown error')
      }
    },
  )

  server.tool(
    'create_team',
    'Create a new team',
    {
      name: z.string().describe('Team name'),
      description: z.string().optional().describe('Team description'),
    },
    async (args) => {
      try {
        const team = createTeam(db, args.name, args.description, undefined, projectId)
        eventLog.teamCreated(null, { team_id: team.id, name: team.name })
        return textResult(team)
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Unknown error')
      }
    },
  )

  server.tool(
    'join_team',
    'Join a session to a team',
    {
      team_id: z.string().describe('Team ID'),
      session_id: z.string().describe('Session ID'),
      name: z.string().describe('Member display name'),
      role: z.string().optional().describe('Member role'),
    },
    async (args) => {
      try {
        const member = joinTeam(db, args.team_id, args.session_id, args.name, args.role)
        eventLog.teamMemberJoined(args.session_id, {
          team_id: args.team_id,
          name: args.name,
        })
        return textResult(member)
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Unknown error')
      }
    },
  )

  // P4 (de-hardcode roles): self-innovate. Lets an agent mint a brand-new agent
  // role at runtime (catalogue entry) without a code/schema change.
  server.tool(
    'register_role',
    'Register a new agent role at runtime (self-innovate). The role becomes usable on team members immediately.',
    {
      role: z.string().describe('Role identifier (e.g. "security-auditor")'),
      description: z.string().optional().describe('What this role does'),
      spawnable: z
        .boolean()
        .optional()
        .describe('Whether this role has a task-spawn prompt strategy (advisory metadata)'),
    },
    async (args) => {
      try {
        registerRole(db, {
          role: args.role,
          description: args.description ?? null,
          spawnable: args.spawnable === true,
        })
        const created = listRoles(db).find((r) => r.role === args.role.trim())
        return textResult(created ?? { role: args.role.trim() })
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Unknown error')
      }
    },
  )

  server.tool('list_roles', 'List all registered agent roles', {}, async () => {
    try {
      return textResult({ roles: listRoles(db) })
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : 'Unknown error')
    }
  })

  server.tool(
    'list_sessions',
    'List all active sessions',
    {
      status: z.string().optional().describe('Filter by status'),
    },
    async (args) => {
      try {
        const sessions = findAllSessions(db, args.status)
        return textResult({ sessions })
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Unknown error')
      }
    },
  )
}
