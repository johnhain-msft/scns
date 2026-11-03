import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  rotateTelemetryIfNeeded,
  sweepParkedTelemetry,
} from '../../../src/retention/telemetry-rotator.js'

let tmp: string
let logPath: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'scns-rotator-'))
  logPath = join(tmp, 'copilot-otel.jsonl')
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('rotateTelemetryIfNeeded', () => {
  it('returns missing when the file does not exist', async () => {
    const result = await rotateTelemetryIfNeeded({
      filePath: logPath,
      maxBytes: 100,
      retainCount: 3,
    })
    expect(result.rotated).toBe(false)
    expect(result.reason).toBe('missing')
    expect(result.beforeBytes).toBe(0)
  })

  it('does not rotate when the file is under the threshold', async () => {
    writeFileSync(logPath, 'small\n')
    const result = await rotateTelemetryIfNeeded({
      filePath: logPath,
      maxBytes: 1024 * 1024,
      retainCount: 3,
    })
    expect(result.rotated).toBe(false)
    expect(result.reason).toBe('under-threshold')
    expect(existsSync(logPath)).toBe(true)
  })

  it('rotates the file to .1 and recreates an empty primary when over threshold', async () => {
    writeFileSync(logPath, 'a'.repeat(200))
    const result = await rotateTelemetryIfNeeded({
      filePath: logPath,
      maxBytes: 100,
      retainCount: 3,
    })
    expect(result.rotated).toBe(true)
    expect(result.reason).toBe('rotated')
    expect(result.beforeBytes).toBe(200)
    expect(result.archivePath).toBe(`${logPath}.1`)
    expect(existsSync(`${logPath}.1`)).toBe(true)
    expect(statSync(`${logPath}.1`).size).toBe(200)
    expect(existsSync(logPath)).toBe(true)
    expect(statSync(logPath).size).toBe(0)
    expect(typeof result.rotatedAt).toBe('string')
  })

  it('shifts older archives and drops anything beyond the retention window', async () => {
    // Pre-seed three previous archives.
    writeFileSync(`${logPath}.1`, 'one')
    writeFileSync(`${logPath}.2`, 'two')
    writeFileSync(`${logPath}.3`, 'three')
    writeFileSync(logPath, 'a'.repeat(200))

    const result = await rotateTelemetryIfNeeded({
      filePath: logPath,
      maxBytes: 100,
      retainCount: 3,
    })

    expect(result.rotated).toBe(true)
    // .3 (oldest) should be removed; .2 -> .3, .1 -> .2, current -> .1
    expect(result.removedPath).toBe(`${logPath}.3`)
    expect(readFileSync(`${logPath}.3`, 'utf8')).toBe('two')
    expect(readFileSync(`${logPath}.2`, 'utf8')).toBe('one')
    expect(statSync(`${logPath}.1`).size).toBe(200)
    expect(statSync(logPath).size).toBe(0)
  })
})

describe('sweepParkedTelemetry', () => {
  it('returns empty when the directory does not exist', () => {
    const result = sweepParkedTelemetry(join(tmp, 'nope', 'copilot-otel.jsonl'))
    expect(result.removed).toEqual([])
    expect(result.freedBytes).toBe(0)
  })

  it('deletes parked siblings and reports freed bytes', () => {
    writeFileSync(logPath, 'active')
    writeFileSync(`${logPath}.parked`, 'a'.repeat(100))
    writeFileSync(`${logPath}.parked-ws-s-1778636517`, 'b'.repeat(50))

    const result = sweepParkedTelemetry(logPath)

    expect(result.removed.sort()).toEqual(
      [`${logPath}.parked`, `${logPath}.parked-ws-s-1778636517`].sort(),
    )
    expect(result.freedBytes).toBe(150)
    expect(existsSync(`${logPath}.parked`)).toBe(false)
    expect(existsSync(`${logPath}.parked-ws-s-1778636517`)).toBe(false)
  })

  it('never touches the active log or numbered archives', () => {
    writeFileSync(logPath, 'active')
    writeFileSync(`${logPath}.1`, 'archive-1')
    writeFileSync(`${logPath}.2`, 'archive-2')
    writeFileSync(`${logPath}.parked`, 'parked')

    const result = sweepParkedTelemetry(logPath)

    expect(result.removed).toEqual([`${logPath}.parked`])
    expect(existsSync(logPath)).toBe(true)
    expect(existsSync(`${logPath}.1`)).toBe(true)
    expect(existsSync(`${logPath}.2`)).toBe(true)
  })

  it('returns empty when there are no parked files', () => {
    writeFileSync(logPath, 'active')
    writeFileSync(`${logPath}.1`, 'archive')

    const result = sweepParkedTelemetry(logPath)
    expect(result.removed).toEqual([])
    expect(result.freedBytes).toBe(0)
  })
})
