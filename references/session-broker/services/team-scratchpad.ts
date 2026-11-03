import type Database from 'better-sqlite3'
import type { EventLog } from './event-log.js'
import {
  setState,
  getState,
  deleteState,
} from '../storage/repositories/state-repository.js'

// ── Types ─────────────────────────────────────────────────────────────────

export interface ScratchpadEntry {
  readonly key: string
  readonly value: string
  readonly team_id: string
  readonly updated_by: string | null
  readonly updated_at: string
}

// ── Internal helpers ──────────────────────────────────────────────────────

const SCRATCHPAD_PREFIX = 'scratchpad'

function buildStateKey(teamId: string, key: string): string {
  return `${SCRATCHPAD_PREFIX}:${teamId}:${key}`
}

function toScratchpadEntry(
  teamId: string,
  key: string,
  row: { readonly value: string; readonly session_id?: string | null; readonly updated_at?: string },
): ScratchpadEntry {
  return {
    key,
    value: row.value,
    team_id: teamId,
    updated_by: row.session_id ?? null,
    updated_at: row.updated_at ?? new Date().toISOString(),
  }
}

// ── Public API ────────────────────────────────────────────────────────────

export function writeScratchpad(
  db: Database.Database,
  eventLog: EventLog,
  teamId: string,
  key: string,
  value: string,
  sessionId?: string,
): ScratchpadEntry {
  const stateKey = buildStateKey(teamId, key)
  const row = setState(db, {
    key: stateKey,
    value,
    story_id: null,
    session_id: sessionId ?? null,
  })

  eventLog.scratchpadUpdated(sessionId ?? null, {
    team_id: teamId,
    key,
    action: 'write',
  })

  return toScratchpadEntry(teamId, key, row)
}

export function readScratchpad(
  db: Database.Database,
  teamId: string,
  key: string,
): ScratchpadEntry | null {
  const stateKey = buildStateKey(teamId, key)
  const row = getState(db, stateKey)
  if (!row) return null
  return toScratchpadEntry(teamId, key, row)
}

export function listScratchpad(
  db: Database.Database,
  teamId: string,
): ReadonlyArray<ScratchpadEntry> {
  const escapedTeamId = teamId.replace(/%/g, '\\%').replace(/_/g, '\\_')
  const prefix = `${SCRATCHPAD_PREFIX}:${teamId}:`
  const rows = db
    .prepare("SELECT * FROM shared_state WHERE key LIKE ? ESCAPE '\\' ORDER BY key")
    .all(`${SCRATCHPAD_PREFIX}:${escapedTeamId}:%`) as ReadonlyArray<{
      readonly key: string
      readonly value: string
      readonly session_id: string | null
      readonly updated_at: string
    }>

  return rows.map((row) => {
    const entryKey = row.key.slice(prefix.length)
    return toScratchpadEntry(teamId, entryKey, row)
  })
}

export function deleteScratchpad(
  db: Database.Database,
  eventLog: EventLog,
  teamId: string,
  key: string,
): boolean {
  const stateKey = buildStateKey(teamId, key)
  const deleted = deleteState(db, stateKey)

  if (deleted) {
    eventLog.scratchpadUpdated(null, {
      team_id: teamId,
      key,
      action: 'delete',
    })
  }

  return deleted
}
