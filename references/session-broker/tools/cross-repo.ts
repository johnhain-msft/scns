import crypto from 'node:crypto'
import type Database from 'better-sqlite3'
import type { EventLog } from '../services/event-log.js'
import { findSessionById, findByRepoContext } from '../storage/repositories/session-repository.js'
import { createMessage } from '../storage/repositories/message-repository.js'
import { type ToolResult, textResult, errorResult } from './helpers.js'
import { logger } from '../logger.js'

interface FindAgentsByRepoInput {
  readonly repo_context: string
}

export function handleFindAgentsByRepo(
  db: Database.Database,
  input: FindAgentsByRepoInput,
): ToolResult {
  const agents = findByRepoContext(db, input.repo_context)
  return textResult({
    repo_context: input.repo_context,
    agents: agents.map((a) => ({
      id: a.id,
      purpose: a.purpose,
      working_dir: a.working_dir,
      status: a.status,
      repo_context: a.repo_context,
    })),
  })
}

interface BroadcastToRepoInput {
  readonly sender_id: string
  readonly repo_context: string
  readonly content: string
}

export function handleBroadcastToRepo(
  db: Database.Database,
  eventLog: EventLog,
  input: BroadcastToRepoInput,
): ToolResult {
  const sender = findSessionById(db, input.sender_id)
  if (!sender) {
    return errorResult(`sender_id '${input.sender_id}' not found in sessions. Register the session first.`)
  }

  const agents = findByRepoContext(db, input.repo_context)
  const recipients = agents.filter((a) => a.id !== input.sender_id)

  const sentMessages: string[] = []
  for (const recipient of recipients) {
    const id = crypto.randomUUID()
    createMessage(db, {
      id,
      sender_id: input.sender_id,
      receiver_id: recipient.id,
      content: input.content,
      story_id: null,
      reply_to: null,
    })
    sentMessages.push(recipient.id)
  }

  logger.info(
    {
      sender_id: input.sender_id,
      repo_context: input.repo_context,
      recipients_count: sentMessages.length,
    },
    'Cross-repo broadcast sent',
  )

  eventLog.repoBroadcastSent(input.sender_id, {
    repo_context: input.repo_context,
    recipients: sentMessages,
    content_length: input.content.length,
  })

  return textResult({
    repo_context: input.repo_context,
    messages_sent: sentMessages.length,
    recipients: sentMessages,
  })
}
