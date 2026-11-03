import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { openDatabase, closeDatabase } from '../../../../src/broker/storage/db.js'
import { createEventLog } from '../../../../src/broker/services/event-log.js'
import { createBrokerServer, type BrokerServer } from '../../../../src/broker/server.js'
import {
  applyMetaSchema,
  recordHealthFailure,
  registerProject,
  updateChildState,
} from '../../../../src/meta-broker/registry.js'

function request(
  server: Server,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: 'localhost',
        port: (server.address() as { port: number }).port,
        path,
        method: 'GET',
      },
      (res) => {
        let responseBody = ''
        res.on('data', (chunk: Buffer) => {
          responseBody += chunk.toString()
        })
        res.on('end', () => {
          resolve({
            status: res.statusCode!,
            body: JSON.parse(responseBody) as Record<string, unknown>,
          })
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

describe('GET /api/meta/resolve (W5 per-project feedback routing)', () => {
  let db: Database.Database
  let broker: BrokerServer
  let server: Server
  let tempDir: string
  let metaDbPath: string

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'scns-meta-resolve-'))
    metaDbPath = join(tempDir, 'meta-broker.db')
    db = openDatabase(':memory:')
    const eventLog = createEventLog(db)
    broker = createBrokerServer(db, eventLog, undefined, undefined, {
      metaRegistryDbPath: metaDbPath,
    })
    server = createServer(broker.app)
    await new Promise<void>((resolve) => server.listen(0, resolve))
  })

  afterEach(async () => {
    await broker.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    closeDatabase(db)
    rmSync(tempDir, { recursive: true, force: true })
  })

  function seedProject(status: 'running' | 'failed', boundPort: number | null): void {
    const meta = new Database(metaDbPath)
    applyMetaSchema(meta)
    registerProject(meta, {
      projectId: 'cosmere-rpg',
      projectRoot: '/Users/j/Coding_Projects/Cosmere_RPG',
    })
    updateChildState(meta, 'cosmere-rpg', {
      status,
      boundPort,
      childPid: 123,
      instanceId: 'iid-1',
      lastSeenAt: new Date().toISOString(),
    })
    meta.close()
  }

  it('resolves a running child for a subdirectory of its root', async () => {
    seedProject('running', 3500)
    const res = await request(
      server,
      '/api/meta/resolve?path=' +
        encodeURIComponent('/Users/j/Coding_Projects/Cosmere_RPG/src/deep'),
    )
    expect(res.status).toBe(200)
    expect(res.body.resolved).toBe(true)
    expect(res.body.projectId).toBe('cosmere-rpg')
    expect(res.body.boundPort).toBe(3500)
    expect(res.body.brokerUrl).toBe('http://127.0.0.1:3500')
  })

  it('still resolves a running child with transient health failures recorded (#48)', async () => {
    // The supervisor keeps status='running' below the restart policy's
    // minFailures threshold; routing must key off status alone, so a
    // recorded blip never unroutes a healthy child.
    seedProject('running', 3500)
    const meta = new Database(metaDbPath)
    recordHealthFailure(meta, 'cosmere-rpg', 'transient probe blip')
    meta.close()

    const res = await request(
      server,
      '/api/meta/resolve?path=' + encodeURIComponent('/Users/j/Coding_Projects/Cosmere_RPG'),
    )
    expect(res.status).toBe(200)
    expect(res.body.resolved).toBe(true)
    expect(res.body.boundPort).toBe(3500)
  })

  it('reports child-not-running instead of routing to a dead child', async () => {
    seedProject('failed', null)
    const res = await request(
      server,
      '/api/meta/resolve?path=' + encodeURIComponent('/Users/j/Coding_Projects/Cosmere_RPG'),
    )
    expect(res.status).toBe(200)
    expect(res.body.resolved).toBe(false)
    expect(res.body.reason).toBe('child-failed')
    expect(res.body.projectId).toBe('cosmere-rpg')
  })

  it('reports no-project-for-path for an unregistered path', async () => {
    seedProject('running', 3500)
    const res = await request(
      server,
      '/api/meta/resolve?path=' + encodeURIComponent('/somewhere/else'),
    )
    expect(res.status).toBe(200)
    expect(res.body.resolved).toBe(false)
    expect(res.body.reason).toBe('no-project-for-path')
  })

  it('reports no-meta-registry when the registry DB does not exist', async () => {
    const res = await request(server, '/api/meta/resolve?path=' + encodeURIComponent('/x'))
    expect(res.status).toBe(200)
    expect(res.body.resolved).toBe(false)
    expect(res.body.reason).toBe('no-meta-registry')
  })

  it('400s on a missing/relative path param', async () => {
    const missing = await request(server, '/api/meta/resolve')
    expect(missing.status).toBe(400)
    const relative = await request(server, '/api/meta/resolve?path=relative/dir')
    expect(relative.status).toBe(400)
  })
})
