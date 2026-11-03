import type { Response } from 'express'
import { logger } from './logger.js'
import type { EventDispatcher, EventFilter, TypedEvent } from './event-dispatcher.js'

interface SSEManagerConfig {
  readonly maxConnectionsPerClient: number
  readonly heartbeatIntervalMs: number
  readonly inactiveTimeoutMs: number
}

const DEFAULT_CONFIG: SSEManagerConfig = {
  maxConnectionsPerClient: 5,
  heartbeatIntervalMs: 30_000,
  inactiveTimeoutMs: 300_000,
} as const

interface TrackedConnection {
  readonly res: Response
  lastActivity: number
}

export class SSEManager {
  private readonly config: SSEManagerConfig
  private readonly connections: Map<string, TrackedConnection[]> = new Map()
  private readonly unsubscribers: Map<Response, () => void> = new Map()
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null
  private cleanupInterval: ReturnType<typeof setInterval> | null = null

  constructor(config?: Partial<SSEManagerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /** Register a new SSE connection. Returns false if per-client limit is exceeded. */
  addConnection(clientIp: string, res: Response): boolean {
    const existing = this.connections.get(clientIp) ?? []

    if (existing.length >= this.config.maxConnectionsPerClient) {
      logger.warn(
        { clientIp, current: existing.length, max: this.config.maxConnectionsPerClient },
        'SSE connection limit exceeded',
      )
      return false
    }

    const tracked: TrackedConnection = { res, lastActivity: Date.now() }
    this.connections.set(clientIp, [...existing, tracked])

    logger.debug({ clientIp, total: existing.length + 1 }, 'SSE connection added')
    return true
  }

  /** Remove a connection (on client disconnect). */
  removeConnection(clientIp: string, res: Response): void {
    const existing = this.connections.get(clientIp)
    if (!existing) {
      return
    }

    // Unsubscribe from dispatcher if subscribed
    const unsub = this.unsubscribers.get(res)
    if (unsub) {
      unsub()
      this.unsubscribers.delete(res)
    }

    const filtered = existing.filter((conn) => conn.res !== res)

    if (filtered.length === 0) {
      this.connections.delete(clientIp)
    } else {
      this.connections.set(clientIp, filtered)
    }

    logger.debug({ clientIp, remaining: filtered.length }, 'SSE connection disconnect')
  }

  /** Update last activity timestamp for a connection (keeps it alive). */
  touchConnection(clientIp: string, res: Response): void {
    const existing = this.connections.get(clientIp)
    if (!existing) {
      return
    }

    const conn = existing.find((c) => c.res === res)
    if (conn) {
      conn.lastActivity = Date.now()
    }
  }

  /** Get connection stats for health endpoint. */
  getStats(): { total: number; byClient: Record<string, number> } {
    let total = 0
    const byClient: Record<string, number> = {}

    for (const [ip, conns] of this.connections) {
      byClient[ip] = conns.length
      total += conns.length
    }

    return { total, byClient }
  }

  /** Send heartbeat comment to all active connections. */
  sendHeartbeat(): void {
    for (const [, conns] of this.connections) {
      for (const conn of conns) {
        if (!conn.res.writableEnded) {
          try {
            conn.res.write(':heartbeat\n\n')
          } catch {
            // Connection may have been closed between check and write
          }
        }
      }
    }
  }

  /**
   * Subscribe an SSE connection to the event dispatcher with optional filters.
   * Events matching the filter are immediately pushed to the client.
   * The subscription is automatically cleaned up when removeConnection is called.
   */
  subscribeConnection(
    res: Response,
    dispatcher: EventDispatcher,
    filter: EventFilter = {},
  ): void {
    const handler = (event: TypedEvent): void => {
      if (res.writableEnded) {
        return
      }
      try {
        const data = JSON.stringify({
          id: event.id,
          type: event.event_type,
          session_id: event.session_id,
          payload: event.payload ? JSON.parse(event.payload) : null,
          team_id: event.team_id ?? null,
          created_at: event.created_at,
        })
        res.write(`data: ${data}\n\n`)
      } catch {
        // Connection may have been closed between check and write
      }
    }

    const unsub = dispatcher.subscribe(filter, handler)
    this.unsubscribers.set(res, unsub)
  }

  /** Close all connections gracefully, sending a retry hint. */
  closeAll(retryMs: number = 3000): void {
    for (const [ip, conns] of this.connections) {
      for (const conn of conns) {
        // Unsubscribe from dispatcher
        const unsub = this.unsubscribers.get(conn.res)
        if (unsub) {
          unsub()
          this.unsubscribers.delete(conn.res)
        }

        if (!conn.res.writableEnded) {
          try {
            conn.res.write(`retry: ${retryMs}\n\n`)
            conn.res.end()
          } catch {
            // Ignore errors on already-closed connections
          }
        }
      }
      // Clear after closing
      this.connections.delete(ip)
    }
  }

  /** Start heartbeat and inactive connection cleanup intervals. */
  start(): void {
    // Prevent duplicate intervals if start() is called multiple times
    this.stop()

    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat()
    }, this.config.heartbeatIntervalMs)

    this.cleanupInterval = setInterval(() => {
      this.cleanupInactive()
    }, this.config.heartbeatIntervalMs) // run cleanup at same cadence as heartbeat
  }

  /** Stop all intervals. */
  stop(): void {
    if (this.heartbeatInterval !== null) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }
    if (this.cleanupInterval !== null) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }
  }

  /** Remove connections that have been inactive beyond the configured timeout. */
  private cleanupInactive(): void {
    const now = Date.now()
    const cutoff = now - this.config.inactiveTimeoutMs

    for (const [ip, conns] of this.connections) {
      const active: TrackedConnection[] = []
      for (const conn of conns) {
        if (conn.lastActivity <= cutoff) {
          logger.debug({ clientIp: ip }, 'Closing inactive SSE connection')
          // Unsubscribe from dispatcher
          const unsub = this.unsubscribers.get(conn.res)
          if (unsub) {
            unsub()
            this.unsubscribers.delete(conn.res)
          }
          if (!conn.res.writableEnded) {
            try {
              conn.res.end()
            } catch {
              // Ignore
            }
          }
        } else {
          active.push(conn)
        }
      }

      if (active.length === 0) {
        this.connections.delete(ip)
      } else {
        this.connections.set(ip, active)
      }
    }
  }
}
