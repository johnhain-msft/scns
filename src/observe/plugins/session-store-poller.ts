/**
 * Session-Store Poller — ObserverPlugin that polls the Copilot CLI session-store.db.
 *
 * Reads from ~/.copilot/session-store.db (read-only) as a fallback
 * for sessions that don't have the SCNS extension installed.
 * Cursor-based polling, emits ObservationEvents for new sessions/turns.
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { z } from 'zod'
import Database from 'better-sqlite3'
import type {
  ObserverPlugin,
  ObserverHealth,
  PluginMetadata,
  ObserverCapability,
} from '../plugin.js'
import type { ObservationEvent } from '../plugin-events.js'
import type { ObserverState } from '../observer.js'
import { ObservationType } from '../types.js'
import { logger } from '../../shared/logger.js'

const SessionStoreConfigSchema = z.object({
  dbPath: z.string().default('~/.copilot/session-store.db'),
  pollIntervalMs: z.number().min(5000).default(60_000),
  maxSessionsPerPoll: z.number().min(1).default(50),
})

// SessionStoreConfig type inferred from schema above, used internally

/** Row from the sessions table */
export interface SessionStoreRow {
  readonly id: string
  readonly cwd: string | null
  readonly repository: string | null
  readonly branch: string | null
  readonly summary: string | null
  readonly created_at: string
  readonly updated_at: string
}

/** Row from the turns table */
export interface TurnRow {
  readonly id: number
  readonly session_id: string
  readonly turn_index: number
  readonly user_message: string | null
  readonly assistant_response: string | null
  readonly timestamp: string
}

/** Abstraction for database operations (testable) */
export interface SessionStoreDbReader {
  exists(path: string): boolean
  open(path: string): void
  close(): void
  getNewSessions(since: string): readonly SessionStoreRow[]
  getNewTurns(sinceId: number): readonly TurnRow[]
  getSessionCount(): number
}

/** Default SQLite-based implementation using better-sqlite3 */
export function createDefaultDbReader(): SessionStoreDbReader {
  let db: Database.Database | null = null

  return {
    exists(path: string): boolean {
      const resolved = path.replace(/^~/, process.env['HOME'] || '')
      return existsSync(resolved)
    },
    open(path: string): void {
      const resolved = path.replace(/^~/, process.env['HOME'] || '')
      db = new Database(resolved, { readonly: true, fileMustExist: true })
      db.pragma('journal_mode = WAL')
    },
    close(): void {
      if (db) {
        db.close()
        db = null
      }
    },
    getNewSessions(since: string): readonly SessionStoreRow[] {
      if (!db) return []
      try {
        return db
          .prepare(
            `SELECT id, cwd, repository, branch, summary, created_at, updated_at
           FROM sessions WHERE created_at > ? ORDER BY created_at ASC LIMIT 100`,
          )
          .all(since) as SessionStoreRow[]
      } catch {
        return []
      }
    },
    getNewTurns(sinceId: number): readonly TurnRow[] {
      if (!db) return []
      try {
        return db
          .prepare(
            `SELECT rowid as id, session_id, turn_index, user_message, assistant_response, timestamp
           FROM turns WHERE rowid > ? ORDER BY rowid ASC LIMIT 200`,
          )
          .all(sinceId) as TurnRow[]
      } catch {
        return []
      }
    },
    getSessionCount(): number {
      if (!db) return 0
      try {
        const row = db.prepare('SELECT COUNT(*) as cnt FROM sessions').get() as { cnt: number }
        return row.cnt
      } catch {
        return 0
      }
    },
  }
}

export interface SessionStorePollerOptions {
  readonly dbReader?: SessionStoreDbReader
  readonly onEvent?: (event: ObservationEvent) => void
  readonly dbPath?: string
  readonly pollIntervalMs?: number
  readonly maxSessionsPerPoll?: number
}

/** Create a session-store poller observer plugin */
export function createSessionStorePoller(options?: SessionStorePollerOptions): ObserverPlugin {
  const log = logger.child({ module: 'session-store-poller' })

  const config = SessionStoreConfigSchema.parse({
    dbPath: options?.dbPath,
    pollIntervalMs: options?.pollIntervalMs,
    maxSessionsPerPoll: options?.maxSessionsPerPoll,
  })

  const dbReader = options?.dbReader ?? createDefaultDbReader()
  const onEvent = options?.onEvent

  let state: ObserverState = 'idle'
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let lastSessionTimestamp = '1970-01-01T00:00:00Z'
  let lastTurnId = 0
  let totalEventsEmitted = 0
  let lastPollTime: string | null = null
  let lastError: string | null = null
  let isDbOpen = false

  const metadata: Readonly<PluginMetadata> = Object.freeze({
    name: 'session-store-poller',
    version: '1.0.0',
    source: '@scns/session-store-poller',
    description: 'Polls Copilot CLI session-store.db for session activity',
  })

  function emitEvent(event: ObservationEvent): void {
    totalEventsEmitted++
    onEvent?.(event)
  }

  function emitSessionEvent(session: SessionStoreRow): void {
    emitEvent({
      id: randomUUID(),
      source: 'session-store-poller',
      type: 'session-discovered',
      timestamp: session.created_at || new Date().toISOString(),
      payload: {
        sessionId: session.id,
        cwd: session.cwd,
        repository: session.repository,
        branch: session.branch,
        summary: session.summary,
      },
      tags: [
        'observer:session-store-poller',
        'event:session-discovered',
        ...(session.repository ? [`repo:${session.repository}`] : []),
        ...(session.branch ? [`branch:${session.branch}`] : []),
      ],
    })
  }

  function emitTurnEvent(turn: TurnRow): void {
    const promptPreview = turn.user_message?.slice(0, 200) ?? ''
    emitEvent({
      id: randomUUID(),
      source: 'session-store-poller',
      type: 'turn-observed',
      timestamp: turn.timestamp || new Date().toISOString(),
      payload: {
        sessionId: turn.session_id,
        turnIndex: turn.turn_index,
        promptPreview,
        hasResponse: !!turn.assistant_response,
      },
      tags: ['observer:session-store-poller', 'event:turn-observed', `session:${turn.session_id}`],
    })
  }

  function poll(): void {
    if (!dbReader) return

    try {
      if (!isDbOpen) {
        if (!dbReader.exists(config.dbPath)) {
          log.debug({ path: config.dbPath }, 'Session store DB not found, skipping poll')
          return
        }
        dbReader.open(config.dbPath)
        isDbOpen = true
      }

      // Poll for new sessions
      const newSessions = dbReader.getNewSessions(lastSessionTimestamp)
      for (const session of newSessions.slice(0, config.maxSessionsPerPoll)) {
        emitSessionEvent(session)
        if (session.created_at > lastSessionTimestamp) {
          lastSessionTimestamp = session.created_at
        }
      }

      // Poll for new turns
      const newTurns = dbReader.getNewTurns(lastTurnId)
      for (const turn of newTurns) {
        emitTurnEvent(turn)
        if (turn.id > lastTurnId) {
          lastTurnId = turn.id
        }
      }

      lastPollTime = new Date().toISOString()
      lastError = null
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn({ err: message }, 'Session store poll failed')
      lastError = message

      // If DB was deleted or locked, reset connection
      if (
        message.includes('SQLITE_BUSY') ||
        message.includes('no such table') ||
        message.includes('unable to open')
      ) {
        try {
          dbReader.close()
        } catch {
          /* ignore */
        }
        isDbOpen = false
      }
    }
  }

  const plugin: ObserverPlugin = {
    type: ObservationType.SessionHook,
    name: 'session-store-poller',
    metadata,
    capabilities: ['sessions'] as readonly ObserverCapability[],

    get state(): ObserverState {
      return state
    },

    start(): void {
      if (state === 'running') return
      state = 'running'
      log.info(
        { path: config.dbPath, intervalMs: config.pollIntervalMs },
        'Session store poller starting',
      )

      // Initial poll
      poll()

      // Schedule recurring polls
      pollTimer = setInterval(poll, config.pollIntervalMs)
    },

    stop(): void {
      if (state === 'idle') return
      state = 'stopping'

      if (pollTimer) {
        clearInterval(pollTimer)
        pollTimer = null
      }

      if (dbReader && isDbOpen) {
        try {
          dbReader.close()
        } catch (err) {
          log.warn({ err }, 'Failed to close session store DB')
        }
        isDbOpen = false
      }

      state = 'idle'
      log.info('Session store poller stopped')
    },

    isRunning(): boolean {
      return state === 'running'
    },

    configure(newConfig: Record<string, unknown>): void {
      const parsed = SessionStoreConfigSchema.partial().safeParse(newConfig)
      if (parsed.success) {
        log.info({ config: parsed.data }, 'Session store poller reconfigured')
      }
    },

    getConfigSchema(): z.ZodType {
      return SessionStoreConfigSchema
    },

    async healthCheck(): Promise<ObserverHealth> {
      const healthy = state === 'running' && lastError === null
      return {
        healthy,
        message: lastError ?? (state === 'running' ? 'Running' : 'Idle'),
        lastCheck: new Date().toISOString(),
        details: {
          dbPath: config.dbPath,
          lastPollTime,
          totalEventsEmitted,
          lastSessionTimestamp,
          lastTurnId,
          isDbOpen,
        },
      }
    },
  }

  return plugin
}
