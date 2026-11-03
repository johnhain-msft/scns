/**
 * GAP-029: SSE manager/dispatcher wiring tests.
 *
 * Verifies that the /api/events/live endpoint correctly:
 * - Returns 503 when sseManager or dispatcher is missing
 * - Returns 429 when addConnection returns false
 * - Sets SSE headers and calls subscribeConnection on success
 * - Cleans up via removeConnection on client disconnect
 * - Calls sseManager.start() during route registration
 */

import { describe, it, expect, _beforeEach, afterEach, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import http from 'node:http'
import express from 'express'
import { openDatabase, closeDatabase } from '../../../../src/broker/storage/db.js'
import { createEventLog } from '../../../../src/broker/services/event-log.js'
import { registerRoutes, type RouteDeps } from '../../../../src/broker/routes/index.js'
import { createErrorHandler } from '../../../../src/broker/middleware/error-handler.js'
import type { EventDispatcher } from '../../../../src/broker/event-dispatcher.js'
import { logger } from '../../../../src/shared/logger.js'
import type Database from 'better-sqlite3'

function requestJSON(
  server: Server,
  method: string,
  path: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: 'localhost',
        port: (server.address() as { port: number }).port,
        path,
        method,
        headers: { Accept: 'application/json' },
      },
      (res) => {
        let responseBody = ''
        res.on('data', (chunk: Buffer) => {
          responseBody += chunk.toString()
        })
        res.on('end', () => {
          let parsed: unknown
          try {
            parsed = JSON.parse(responseBody)
          } catch {
            parsed = responseBody
          }
          resolve({ status: res.statusCode!, body: parsed })
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

function createMockSSEManager() {
  return {
    addConnection: vi.fn().mockReturnValue(true),
    removeConnection: vi.fn(),
    subscribeConnection: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    closeAll: vi.fn(),
    getStats: vi.fn().mockReturnValue({ total: 0, byClient: {} }),
    sendHeartbeat: vi.fn(),
    touchConnection: vi.fn(),
  }
}

function createMockDispatcher(): EventDispatcher {
  return {
    dispatch: vi.fn(),
    subscribe: vi.fn().mockReturnValue(() => {}),
    subscriberCount: vi.fn().mockReturnValue(0),
  }
}

describe('SSE wiring — GET /api/events/live', () => {
  let db: Database.Database

  afterEach(() => {
    closeDatabase(db)
  })

  it('returns 503 when sseManager is not provided', async () => {
    db = openDatabase(':memory:')
    const app = express()
    app.use(express.json())
    registerRoutes(app, { db, eventLog: createEventLog(db) })
    app.use(createErrorHandler(logger))

    const server = createServer(app)
    await new Promise<void>((resolve) => server.listen(0, resolve))

    try {
      const res = await requestJSON(server, 'GET', '/api/events/live')
      expect(res.status).toBe(503)
      expect((res.body as Record<string, unknown>).error).toBe('SSE streaming not available')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('returns 503 when dispatcher is not provided but sseManager is', async () => {
    db = openDatabase(':memory:')
    const mockSSE = createMockSSEManager()
    const app = express()
    app.use(express.json())
    registerRoutes(app, {
      db,
      eventLog: createEventLog(db),
      sseManager: mockSSE as unknown as RouteDeps['sseManager'],
    })
    app.use(createErrorHandler(logger))

    const server = createServer(app)
    await new Promise<void>((resolve) => server.listen(0, resolve))

    try {
      const res = await requestJSON(server, 'GET', '/api/events/live')
      expect(res.status).toBe(503)
      expect((res.body as Record<string, unknown>).error).toBe('SSE streaming not available')
      // start() should NOT be called when dispatcher is missing
      expect(mockSSE.start).not.toHaveBeenCalled()
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('returns 429 when addConnection returns false', async () => {
    db = openDatabase(':memory:')
    const mockSSE = createMockSSEManager()
    mockSSE.addConnection.mockReturnValue(false)
    const mockDispatcher = createMockDispatcher()

    const app = express()
    app.use(express.json())
    registerRoutes(app, {
      db,
      eventLog: createEventLog(db),
      sseManager: mockSSE as unknown as RouteDeps['sseManager'],
      dispatcher: mockDispatcher,
    })
    app.use(createErrorHandler(logger))

    const server = createServer(app)
    await new Promise<void>((resolve) => server.listen(0, resolve))

    try {
      const res = await requestJSON(server, 'GET', '/api/events/live')
      expect(res.status).toBe(429)
      expect((res.body as Record<string, unknown>).error).toBe('Too many SSE connections')
      expect(mockSSE.addConnection).toHaveBeenCalledWith(expect.any(String), expect.anything())
      expect(mockSSE.subscribeConnection).not.toHaveBeenCalled()
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('sets SSE headers and calls subscribeConnection when addConnection succeeds', async () => {
    db = openDatabase(':memory:')
    const mockSSE = createMockSSEManager()
    mockSSE.addConnection.mockReturnValue(true)
    const mockDispatcher = createMockDispatcher()

    const app = express()
    app.use(express.json())
    registerRoutes(app, {
      db,
      eventLog: createEventLog(db),
      sseManager: mockSSE as unknown as RouteDeps['sseManager'],
      dispatcher: mockDispatcher,
    })
    app.use(createErrorHandler(logger))

    const server = createServer(app)
    await new Promise<void>((resolve) => server.listen(0, resolve))

    try {
      // SSE connections stay open — we check headers then destroy
      const { headers, status } = await new Promise<{
        headers: http.IncomingHttpHeaders
        status: number
      }>((resolve, reject) => {
        const req = http.request(
          {
            hostname: 'localhost',
            port: (server.address() as { port: number }).port,
            path: '/api/events/live',
            method: 'GET',
          },
          (res) => {
            resolve({ headers: res.headers, status: res.statusCode! })
            // Destroy to close the connection
            res.destroy()
          },
        )
        req.on('error', reject)
        req.end()
      })

      expect(status).toBe(200)
      expect(headers['content-type']).toBe('text/event-stream')
      expect(headers['cache-control']).toBe('no-cache')
      expect(headers['connection']).toBe('keep-alive')
      expect(mockSSE.addConnection).toHaveBeenCalledWith(expect.any(String), expect.anything())
      expect(mockSSE.subscribeConnection).toHaveBeenCalledWith(expect.anything(), mockDispatcher)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('calls removeConnection when client disconnects', async () => {
    db = openDatabase(':memory:')
    const mockSSE = createMockSSEManager()
    mockSSE.addConnection.mockReturnValue(true)
    const mockDispatcher = createMockDispatcher()

    const app = express()
    app.use(express.json())
    registerRoutes(app, {
      db,
      eventLog: createEventLog(db),
      sseManager: mockSSE as unknown as RouteDeps['sseManager'],
      dispatcher: mockDispatcher,
    })
    app.use(createErrorHandler(logger))

    const server = createServer(app)
    await new Promise<void>((resolve) => server.listen(0, resolve))

    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            hostname: 'localhost',
            port: (server.address() as { port: number }).port,
            path: '/api/events/live',
            method: 'GET',
          },
          (res) => {
            // Wait a tick for subscribeConnection to complete
            setTimeout(() => {
              res.destroy()
              // Give the close event time to propagate
              setTimeout(() => resolve(), 50)
            }, 50)
          },
        )
        req.on('error', reject)
        req.end()
      })

      expect(mockSSE.removeConnection).toHaveBeenCalledWith(expect.any(String), expect.anything())
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('calls sseManager.start() when both sseManager and dispatcher are provided at registration', () => {
    db = openDatabase(':memory:')
    const mockSSE = createMockSSEManager()
    const mockDispatcher = createMockDispatcher()

    const app = express()
    app.use(express.json())
    registerRoutes(app, {
      db,
      eventLog: createEventLog(db),
      sseManager: mockSSE as unknown as RouteDeps['sseManager'],
      dispatcher: mockDispatcher,
    })

    // start() is called at route registration time, not on first request
    expect(mockSSE.start).toHaveBeenCalledTimes(1)
  })
})
