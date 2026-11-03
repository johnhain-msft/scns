import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHealthRouter } from '../../../src/broker/health.js'
import type { HealthDependencies } from '../../../src/broker/health.js'

vi.mock('../../../src/broker/storage/repositories/session-repository.js', () => ({
  countSessionsByStatus: vi.fn().mockReturnValue(0),
}))

vi.mock('../../../src/broker/storage/repositories/team-repository.js', () => ({
  _archiveSession: vi.fn().mockReturnValue(0),
  countTeamsByStatus: vi.fn().mockReturnValue(0),
}))

vi.mock('../../../src/broker/storage/repositories/task-repository.js', () => ({
  countTasksByStatus: vi.fn().mockReturnValue(0),
}))

import { countSessionsByStatus } from '../../../src/broker/storage/repositories/session-repository.js'
import { countTeamsByStatus } from '../../../src/broker/storage/repositories/team-repository.js'
import { countTasksByStatus } from '../../../src/broker/storage/repositories/task-repository.js'

function mockDb(working = true) {
  return {
    prepare: vi.fn().mockImplementation(() => {
      if (!working) throw new Error('DB error')
      return { get: () => ({ '1': 1 }) }
    }),
  } as any
}

function mockReqRes(path: string) {
  const req = { path } as any
  let statusCode = 200
  let body: any
  const res = {
    status(code: number) {
      statusCode = code
      return res
    },
    json(data: any) {
      body = data
      return res
    },
  } as any
  return { req, res, getStatus: () => statusCode, getBody: () => body }
}

function getDeps(dbWorking = true, isEmbeddingAvailable?: () => boolean): HealthDependencies {
  return {
    db: mockDb(dbWorking),
    version: '1.0.0-test',
    startedAt: Date.now() - 60_000,
    isEmbeddingAvailable,
  }
}

describe('Health Router', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function findHandler(router: any, method: string, path: string) {
    // Express Router stores routes in router.stack
    for (const layer of router.stack) {
      if (layer.route) {
        const routePath = layer.route.path
        const routeMethod = Object.keys(layer.route.methods)[0]
        if (routePath === path && routeMethod === method) {
          return layer.route.stack[0].handle
        }
      }
    }
    throw new Error(`No handler for ${method.toUpperCase()} ${path}`)
  }

  describe('GET /live', () => {
    it('returns 200 with { status: "ok" }', () => {
      const router = createHealthRouter(getDeps())
      const handler = findHandler(router, 'get', '/live')
      const { req, res, getBody } = mockReqRes('/live')

      handler(req, res)

      expect(getBody()).toEqual({ status: 'ok' })
    })
  })

  describe('GET /ready', () => {
    it('returns 200 with version, uptime, memory, dependencies', () => {
      vi.mocked(countSessionsByStatus).mockReturnValue(5)
      vi.mocked(countTeamsByStatus).mockReturnValue(2)
      vi.mocked(countTasksByStatus).mockReturnValue(3)

      const router = createHealthRouter(getDeps(true, () => true))
      const handler = findHandler(router, 'get', '/ready')
      const { req, res, getStatus, getBody } = mockReqRes('/ready')

      handler(req, res)

      expect(getStatus()).toBe(200)
      const body = getBody()
      expect(body.status).toBe('ok')
      expect(body.version).toBe('1.0.0-test')
      expect(body.uptime_seconds).toBeGreaterThanOrEqual(0)
      expect(body.memory_mb).toBeGreaterThan(0)
      expect(body.dependencies.database).toBe('ok')
      expect(body.dependencies.embeddings).toBe('ok')
    })

    it('reports embeddings as unavailable when callback returns false', () => {
      const router = createHealthRouter(getDeps(true, () => false))
      const handler = findHandler(router, 'get', '/ready')
      const { req, res, getBody } = mockReqRes('/ready')

      handler(req, res)

      expect(getBody().dependencies.embeddings).toBe('unavailable')
    })

    it('reports embeddings as unavailable when no callback provided', () => {
      const router = createHealthRouter(getDeps(true))
      const handler = findHandler(router, 'get', '/ready')
      const { req, res, getBody } = mockReqRes('/ready')

      handler(req, res)

      expect(getBody().dependencies.embeddings).toBe('unavailable')
    })

    it('reports embeddings as ok when callback returns true', () => {
      const router = createHealthRouter(getDeps(true, () => true))
      const handler = findHandler(router, 'get', '/ready')
      const { req, res, getBody } = mockReqRes('/ready')

      handler(req, res)

      expect(getBody().dependencies.embeddings).toBe('ok')
    })

    it('returns 503 when DB check fails', () => {
      const deps = getDeps(false)
      const router = createHealthRouter(deps)
      const handler = findHandler(router, 'get', '/ready')
      const { req, res, getStatus, getBody } = mockReqRes('/ready')

      handler(req, res)

      expect(getStatus()).toBe(503)
      expect(getBody().status).toBe('degraded')
      expect(getBody().dependencies.database).toBe('error')
    })

    it('includes session, team, and task counts', () => {
      vi.mocked(countSessionsByStatus).mockImplementation((_db: any, status: string) => {
        if (status === 'active') return 3
        if (status === 'zombie') return 1
        return 0
      })
      vi.mocked(countTeamsByStatus).mockReturnValue(7)
      vi.mocked(countTasksByStatus).mockImplementation((_db: any, status: string) => {
        if (status === 'pending') return 4
        if (status === 'in_progress') return 2
        return 0
      })

      const router = createHealthRouter(getDeps())
      const handler = findHandler(router, 'get', '/ready')
      const { req, res, getBody } = mockReqRes('/ready')

      handler(req, res)

      const body = getBody()
      expect(body.sessions).toEqual({
        active: 3,
        working: 0,
        reporting: 0,
        idle: 0,
        paused: 0,
        zombie: 1,
        expired: 0,
        total: 4,
      })
      expect(body.teams).toBe(7)
      expect(body.tasks).toEqual({ pending: 4, in_progress: 2 })
    })
  })

  describe('GET /', () => {
    it('returns enriched backward-compatible response', () => {
      vi.mocked(countTeamsByStatus).mockReturnValue(5)
      vi.mocked(countTasksByStatus).mockImplementation((_db: any, status: string) => {
        if (status === 'pending') return 10
        if (status === 'in_progress') return 3
        return 0
      })

      const router = createHealthRouter(getDeps())
      const handler = findHandler(router, 'get', '/')
      const { req, res, getBody } = mockReqRes('/')

      handler(req, res)

      const body = getBody()
      expect(body.status).toBe('ok')
      expect(body.version).toBe('1.0.0-test')
      // Backward-compatible fields
      expect(body.active_teams).toBe(5)
      expect(body.pending_tasks).toBe(10)
      expect(body.in_progress_tasks).toBe(3)
      // Also has enriched fields
      expect(body.dependencies).toBeDefined()
      expect(body.sessions).toBeDefined()
    })
  })
})
