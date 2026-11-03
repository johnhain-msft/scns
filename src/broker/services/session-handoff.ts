/**
 * Session handoff service — creates, retrieves, and manages handoff documents.
 * Handoff documents capture session progress for blue/green rotation.
 */

import type Database from 'better-sqlite3'
import {
  createHandoff,
  findLatestHandoff,
  findHandoffsBySession,
  claimHandoff,
  consumeHandoff,
  expireHandoffs,
} from '../storage/repositories/quality-repository.js'
import type { SessionHandoff } from '../types.js'

// ── Types ────────────────────────────────────────────────────────────

export interface CreateHandoffInput {
  readonly sessionId: string
  readonly progress: string
  readonly filesModified?: readonly string[]
  readonly testsStatus?: string | null
  readonly remainingWork?: string | null
  readonly context?: string | null
}

export interface SessionHandoffService {
  create(input: CreateHandoffInput): SessionHandoff
  get(sessionId: string): SessionHandoff | null
  getAll(sessionId: string): readonly SessionHandoff[]
  claim(id: string, claimedBy: string): boolean
  consume(id: string, consumedBy: string): boolean
  expire(sessionId: string): number
}

// ── Factory ──────────────────────────────────────────────────────────

export function createSessionHandoffService(db: Database.Database): SessionHandoffService {
  function create(input: CreateHandoffInput): SessionHandoff {
    return createHandoff(db, {
      session_id: input.sessionId,
      progress: input.progress,
      files_modified: input.filesModified,
      tests_status: input.testsStatus ?? null,
      remaining_work: input.remainingWork ?? null,
      context: input.context ?? null,
    })
  }

  function get(sessionId: string): SessionHandoff | null {
    return findLatestHandoff(db, sessionId)
  }

  function getAll(sessionId: string): readonly SessionHandoff[] {
    return findHandoffsBySession(db, sessionId)
  }

  function claim(id: string, claimedBy: string): boolean {
    return claimHandoff(db, id, claimedBy)
  }

  function consume(id: string, consumedBy: string): boolean {
    return consumeHandoff(db, id, consumedBy)
  }

  function expire(sessionId: string): number {
    return expireHandoffs(db, sessionId)
  }

  return { create, get, getAll, claim, consume, expire }
}
