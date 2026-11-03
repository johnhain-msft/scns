import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { openDatabase, closeDatabase } from '../../../src/broker/storage/db.js'
import { createEventLog } from '../../../src/broker/services/event-log.js'
import { createBrokerServer, type BrokerServer } from '../../../src/broker/server.js'

function getJson(server: Server, path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: 'localhost',
        port: (server.address() as { port: number }).port,
        path,
        method: 'GET',
      },
      (res) => {
        let body = ''
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString()
        })
        res.on('end', () => {
          let parsed: unknown
          try {
            parsed = JSON.parse(body)
          } catch {
            parsed = body
          }
          resolve({ status: res.statusCode!, body: parsed })
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

describe('GET /api/footprint', () => {
  let db: Database.Database
  let broker: BrokerServer
  let server: Server
  let tmp: string

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'scns-footprint-route-'))
    const logPath = join(tmp, 'log.jsonl')
    writeFileSync(logPath, 'a'.repeat(42))
    db = openDatabase(':memory:')
    const eventLog = createEventLog(db)
    broker = createBrokerServer(db, eventLog, undefined, undefined, {
      footprint: {
        targets: [{ label: 'telemetry-log', path: logPath }],
        getLastRotationAt: () => '2026-05-12T12:00:00.000Z',
      },
    })
    server = createServer(broker.app)
    await new Promise<void>((resolve) => server.listen(0, resolve))
  })

  afterEach(async () => {
    await broker.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    closeDatabase(db)
    rmSync(tmp, { recursive: true, force: true })
  })

  it('returns the configured targets, last rotation, and total bytes', async () => {
    const res = await getJson(server, '/api/footprint')
    expect(res.status).toBe(200)
    const body = res.body as {
      totalBytes: number
      lastRotationAt: string | null
      targets: { label: string; bytes: number }[]
    }
    expect(body.totalBytes).toBe(42)
    expect(body.lastRotationAt).toBe('2026-05-12T12:00:00.000Z')
    expect(body.targets[0]?.label).toBe('telemetry-log')
    expect(body.targets[0]?.bytes).toBe(42)
  })
})
