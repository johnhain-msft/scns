import type Database from 'better-sqlite3'
import type { EventLog } from './event-log.js'
import type { Message } from '../types.js'
import {
  countMessagesByTeamMembers,
  findMessagesByTeamMembers,
  archiveMessages,
} from '../storage/repositories/message-repository.js'
import { setState, getState } from '../storage/repositories/state-repository.js'
import { findAllTeams } from '../storage/repositories/team-repository.js'

export interface CompactionResult {
  readonly team_id: string
  readonly messages_archived: number
  readonly digest_key: string
  readonly skipped: boolean
}

export interface CompactionOptions {
  readonly threshold?: number
  readonly retainRecent?: number
  readonly cooldownMs?: number
}

const DEFAULT_THRESHOLD = 100
const DEFAULT_RETAIN_RECENT = 20
const DEFAULT_COOLDOWN_MS = 300_000 // 5 minutes

function getDigestKey(teamId: string): string {
  return `team:${teamId}:message_digest`
}

function getLastCompactedKey(teamId: string): string {
  return `team:${teamId}:last_compacted_at`
}

export function getTeamMessageCount(
  db: Database.Database,
  teamId: string,
): number {
  return countMessagesByTeamMembers(db, teamId)
}

export function createDigest(messages: ReadonlyArray<Message>): string {
  if (messages.length === 0) {
    return `[Message Digest] 0 messages archived.`
  }

  const lines = messages.map((msg) => {
    const truncated = msg.content.length > 100
      ? `${msg.content.slice(0, 100)}...`
      : msg.content
    return `[${msg.created_at ?? 'unknown'}] ${msg.sender_id}: ${truncated}`
  })

  return [
    `[Message Digest] ${messages.length} messages archived.`,
    '',
    ...lines,
  ].join('\n')
}

function isCooldownActive(
  db: Database.Database,
  teamId: string,
  cooldownMs: number,
): boolean {
  const entry = getState(db, getLastCompactedKey(teamId))
  if (!entry) return false

  const lastCompactedAt = parseInt(entry.value, 10)
  if (isNaN(lastCompactedAt)) return false

  return (Date.now() - lastCompactedAt) < cooldownMs
}

function recordCompactionTime(
  db: Database.Database,
  teamId: string,
): void {
  setState(db, {
    key: getLastCompactedKey(teamId),
    value: String(Date.now()),
    story_id: null,
    session_id: null,
  })
}

export function compactTeamMessages(
  db: Database.Database,
  eventLog: EventLog,
  teamId: string,
  options?: CompactionOptions,
): CompactionResult {
  const threshold = options?.threshold ?? DEFAULT_THRESHOLD
  const retainRecent = options?.retainRecent ?? DEFAULT_RETAIN_RECENT
  const cooldownMs = options?.cooldownMs ?? DEFAULT_COOLDOWN_MS
  const digestKey = getDigestKey(teamId)

  // Circuit breaker: check cooldown
  if (isCooldownActive(db, teamId, cooldownMs)) {
    return { team_id: teamId, messages_archived: 0, digest_key: digestKey, skipped: true }
  }

  // Check message count
  const count = countMessagesByTeamMembers(db, teamId)
  if (count <= threshold) {
    return { team_id: teamId, messages_archived: 0, digest_key: digestKey, skipped: true }
  }

  // Fetch all team messages ordered by created_at ASC
  const allMessages = findMessagesByTeamMembers(db, teamId)

  // Determine which to archive (all except the most recent `retainRecent`)
  const archiveCount = Math.max(0, allMessages.length - retainRecent)
  if (archiveCount === 0) {
    return { team_id: teamId, messages_archived: 0, digest_key: digestKey, skipped: true }
  }

  const toArchive = allMessages.slice(0, archiveCount)
  const toArchiveIds = toArchive.map((m) => m.id)

  // Create digest from archived messages
  const digest = createDigest(toArchive)

  // Wrap critical state mutations in a transaction for atomicity
  const archived = db.transaction(() => {
    // Store digest in shared_state
    setState(db, {
      key: digestKey,
      value: digest,
      story_id: null,
      session_id: null,
    })

    // Archive messages (move to history + delete originals)
    const archivedCount = archiveMessages(db, toArchiveIds)

    // Record compaction time for circuit breaker
    recordCompactionTime(db, teamId)

    return archivedCount
  })()

  // Log event (outside transaction — non-critical)
  eventLog.messagesCompacted(null, {
    team_id: teamId,
    messages_archived: archived,
    digest_key: digestKey,
    retained: retainRecent,
  })

  return {
    team_id: teamId,
    messages_archived: archived,
    digest_key: digestKey,
    skipped: false,
  }
}

export function compactAllTeams(
  db: Database.Database,
  eventLog: EventLog,
  options?: CompactionOptions,
): ReadonlyArray<CompactionResult> {
  const teams = findAllTeams(db, 'active')
  const results: CompactionResult[] = []

  for (const team of teams) {
    const result = compactTeamMessages(db, eventLog, team.id, options)
    results.push(result)
  }

  return results
}
