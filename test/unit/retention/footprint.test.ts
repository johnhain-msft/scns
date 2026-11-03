import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import {
  computeFootprint,
  createFootprintRouter,
} from '../../../src/retention/footprint.js'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'scns-footprint-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('computeFootprint', () => {
  it('reports byte sizes for files and directories, with totals', async () => {
    const file = join(root, 'log.jsonl')
    writeFileSync(file, 'a'.repeat(123))
    const dir = join(root, 'state')
    mkdirSync(join(dir, 'sub'), { recursive: true })
    writeFileSync(join(dir, 'sub', 'plan.md'), 'b'.repeat(50))
    const missing = join(root, 'nope.db')

    const report = await computeFootprint({
      targets: [
        { label: 'telemetry', path: file },
        { label: 'session-state', path: dir },
        { label: 'broker-db', path: missing },
      ],
      lastRotationAt: '2026-05-12T00:00:00.000Z',
    })

    const byLabel = Object.fromEntries(report.targets.map((t) => [t.label, t]))
    expect(byLabel['telemetry']?.bytes).toBe(123)
    expect(byLabel['telemetry']?.exists).toBe(true)
    expect(byLabel['session-state']?.bytes).toBe(50)
    expect(byLabel['session-state']?.exists).toBe(true)
    expect(byLabel['broker-db']?.bytes).toBe(0)
    expect(byLabel['broker-db']?.exists).toBe(false)
    expect(report.totalBytes).toBe(173)
    expect(report.lastRotationAt).toBe('2026-05-12T00:00:00.000Z')
    expect(typeof report.generatedAt).toBe('string')
  })
})

describe('createFootprintRouter', () => {
  it('serves a JSON report from the provider on GET /', async () => {
    const file = join(root, 'log.jsonl')
    writeFileSync(file, 'x'.repeat(10))

    const router = createFootprintRouter(async () =>
      computeFootprint({
        targets: [{ label: 'telemetry', path: file }],
        lastRotationAt: null,
      }),
    )

    const app = express()
    app.use('/api/footprint', router)

    // Spin up an ephemeral server so we exercise the actual express wiring.
    const server = app.listen(0)
    try {
      const addr = server.address()
      if (!addr || typeof addr === 'string') throw new Error('no port')
      const res = await fetch(`http://127.0.0.1:${addr.port}/api/footprint`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        totalBytes: number
        lastRotationAt: string | null
        targets: { label: string; bytes: number }[]
      }
      expect(body.totalBytes).toBe(10)
      expect(body.lastRotationAt).toBeNull()
      expect(body.targets[0]?.label).toBe('telemetry')
      expect(body.targets[0]?.bytes).toBe(10)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
