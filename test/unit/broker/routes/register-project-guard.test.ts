import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import http from 'node:http'
import { openDatabase, closeDatabase } from '../../../../src/broker/storage/db.js'
import { createEventLog } from '../../../../src/broker/services/event-log.js'
import { createBrokerServer, type BrokerServer } from '../../../../src/broker/server.js'
import type Database from 'better-sqlite3'

const PROJECT_ROOT = process.platform === 'win32' ? 'C:\\repo\\fabrikam' : '/repo/fabrikam'
const FOREIGN_DIR = process.platform === 'win32' ? 'C:\\repo\\scns' : '/repo/scns'
const NESTED_DIR =
  process.platform === 'win32' ? 'C:\\repo\\fabrikam\\src\\app' : '/repo/fabrikam/src/app'

function request(
  server: Server,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined
    const req = http.request(
      {
        hostname: 'localhost',
        port: (server.address() as { port: number }).port,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
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
    if (data) req.write(data)
    req.end()
  })
}

function countSessions(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n
}

/**
 * A child broker must refuse a session that belongs to another project.
 *
 * Child ports are re-dealt on every meta-broker restart while a session pins
 * its broker URL once at startup, so a live session can end up POSTing to a
 * different project's broker. This is the last line of defence: even if the
 * route is wrong, the foreign rows never land.
 */
describe('POST /api/register — project root guard', () => {
  let db: Database.Database
  let broker: BrokerServer
  let server: Server

  async function start(projectRoot?: string): Promise<void> {
    db = openDatabase(':memory:')
    const eventLog = createEventLog(db)
    broker = createBrokerServer(db, eventLog, undefined, undefined, {
      ...(projectRoot ? { projectRoot, projectId: 'fabrikam-ee9a1386' } : {}),
    })
    server = createServer(broker.app)
    await new Promise<void>((resolve) => server.listen(0, resolve))
  }

  afterEach(async () => {
    await broker.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    closeDatabase(db)
  })

  describe('on a project-scoped child broker', () => {
    beforeEach(async () => {
      await start(PROJECT_ROOT)
    })

    it('accepts a session whose working_dir is the project root', async () => {
      const res = await request(server, 'POST', '/api/register', {
        id: 's-root',
        purpose: 'test',
        working_dir: PROJECT_ROOT,
      })
      expect(res.status).toBe(200)
    })

    it('accepts a session nested under the project root', async () => {
      const res = await request(server, 'POST', '/api/register', {
        id: 's-nested',
        purpose: 'test',
        working_dir: NESTED_DIR,
      })
      expect(res.status).toBe(200)
    })

    it('rejects a session from another project and persists nothing', async () => {
      const res = await request(server, 'POST', '/api/register', {
        id: 's-foreign',
        purpose: 'test',
        working_dir: FOREIGN_DIR,
      })
      expect(res.status).toBe(409)
      expect(JSON.stringify(res.body)).toContain('does not serve')
      expect(countSessions(db)).toBe(0)
    })

    // The child brokers all run with the SCNS package root as their cwd, so
    // defaulting an omitted working_dir to process.cwd() would make every
    // project except scns reject its own sessions.
    it('defaults an omitted working_dir to the project root, not the broker cwd', async () => {
      const res = await request(server, 'POST', '/api/register', {
        id: 's-default',
        purpose: 'test',
      })
      expect(res.status).toBe(200)
      const row = db.prepare('SELECT working_dir FROM sessions WHERE id = ?').get('s-default') as
        | { working_dir: string }
        | undefined
      expect(row?.working_dir).toBe(PROJECT_ROOT)
    })

    it('registers a cwd-less hook under the child root rather than the SCNS package cwd', async () => {
      const res = await request(server, 'POST', '/api/hooks/session-start', {
        event: 'session-start',
        timestamp: new Date().toISOString(),
        sessionId: 's-hook',
      })
      expect(res.status).toBe(200)
      expect(db.prepare('SELECT working_dir FROM sessions WHERE id=?').get('s-hook')).toEqual({
        working_dir: PROJECT_ROOT,
      })
    })

    it.each(['session-start', 'user-prompt', 'session-end'])(
      'rejects a foreign %s hook before recording any session or event',
      async (event) => {
        const before = db.prepare('SELECT COUNT(*) AS n FROM events').get()
        const res = await request(server, 'POST', `/api/hooks/${event}`, {
          event,
          timestamp: new Date().toISOString(),
          sessionId: 's-foreign-hook',
          metadata: { cwd: FOREIGN_DIR },
        })
        expect(res.status).toBe(409)
        expect(res.body).toMatchObject({ error: 'project_mismatch' })
        expect(countSessions(db)).toBe(0)
        expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual(before)
      },
    )

    it('rejects an invalid hook cwd without persisting bogus ownership', async () => {
      const res = await request(server, 'POST', '/api/hooks/session-start', {
        event: 'session-start',
        timestamp: new Date().toISOString(),
        sessionId: 's-invalid-hook',
        metadata: { cwd: 42 },
      })
      expect(res.status).toBe(400)
      expect(countSessions(db)).toBe(0)
    })

    it('does not let a foreign session-end hook complete an existing native session', async () => {
      await request(server, 'POST', '/api/register', { id: 's-native', purpose: 'test' })
      const before = db.prepare('SELECT * FROM sessions WHERE id=?').get('s-native')
      const eventsBefore = db.prepare('SELECT COUNT(*) AS n FROM events').get()
      const res = await request(server, 'POST', '/api/hooks/session-end', {
        event: 'session-end',
        timestamp: new Date().toISOString(),
        sessionId: 's-native',
        metadata: { cwd: FOREIGN_DIR },
      })
      expect(res.status).toBe(409)
      expect(db.prepare('SELECT * FROM sessions WHERE id=?').get('s-native')).toEqual(before)
      expect(db.prepare('SELECT COUNT(*) AS n FROM events').get()).toEqual(eventsBefore)
    })

    it('keeps a valid hook subdirectory instead of flattening it to the project root', async () => {
      const res = await request(server, 'POST', '/api/hooks/session-start', {
        event: 'session-start',
        timestamp: new Date().toISOString(),
        sessionId: 's-nested-hook',
        metadata: { cwd: NESTED_DIR },
      })
      expect(res.status).toBe(200)
      expect(
        db.prepare('SELECT working_dir FROM sessions WHERE id=?').get('s-nested-hook'),
      ).toEqual({
        working_dir: NESTED_DIR,
      })
    })
  })

  describe('on the global broker (no project root)', () => {
    beforeEach(async () => {
      await start()
    })

    it('accepts any working_dir, preserving pre-guard behaviour', async () => {
      const res = await request(server, 'POST', '/api/register', {
        id: 's-global',
        purpose: 'test',
        working_dir: FOREIGN_DIR,
      })
      expect(res.status).toBe(200)
      expect(countSessions(db)).toBe(1)
    })
  })
})
