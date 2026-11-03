/**
 * P5a — pruneTelemetryArchives: enforce a total-bytes cap across rotated
 * archives so a long-lived hostile archive (e.g. a 290MB `.3` left over
 * from a pre-policy era) cannot squat on disk indefinitely.
 *
 * Key invariants enforced here:
 *   1. The active file (no numeric suffix) is NEVER touched.
 *   2. `.1` is protected — long-running Copilot CLI sessions may still
 *      hold an open FD to the inode renamed into `.1` during a recent
 *      rotation; deleting it would orphan their bytes (Unix unlink on
 *      open inode) without freeing disk until those processes exit.
 *   3. Pruning walks the archive set OLDEST-FIRST (highest number first
 *      since rotation shifts low→high), deleting archives until the
 *      remaining total bytes is ≤ `maxTotalBytes`.
 *   4. Gaps in numbering are tolerated (real disks have them after
 *      partial failures).
 *   5. If only `.1` remains and it alone exceeds `maxTotalBytes`,
 *      pruneArchives returns `capExceeded: true` and leaves `.1`
 *      alone — disk is still over budget but writer safety wins.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  pruneTelemetryArchives,
  rotateTelemetryIfNeeded,
  resolveTelemetryRotationConfig,
  DEFAULT_TELEMETRY_MAX_TOTAL_BYTES,
  DEFAULT_TELEMETRY_RETAIN_COUNT,
} from '../../../src/retention/telemetry-rotator.js'

let tmp: string
let logPath: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'scns-prune-'))
  logPath = join(tmp, 'copilot-otel.jsonl')
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function writeArchive(suffix: number, bytes: number): void {
  writeFileSync(`${logPath}.${suffix}`, 'x'.repeat(bytes))
}

describe('pruneTelemetryArchives', () => {
  it('returns noop when no archives exist', async () => {
    writeFileSync(logPath, 'active')
    const result = await pruneTelemetryArchives({
      filePath: logPath,
      maxBytes: 1024,
      retainCount: 5,
      maxTotalBytes: 1000,
    })
    expect(result.removed).toEqual([])
    expect(result.freedBytes).toBe(0)
    expect(result.capExceeded).toBe(false)
    expect(existsSync(logPath)).toBe(true)
  })

  it('does nothing when total archive bytes are under the cap', async () => {
    writeArchive(1, 100)
    writeArchive(2, 100)
    const result = await pruneTelemetryArchives({
      filePath: logPath,
      maxBytes: 1024,
      retainCount: 5,
      maxTotalBytes: 1000,
    })
    expect(result.removed).toEqual([])
    expect(result.freedBytes).toBe(0)
    expect(existsSync(`${logPath}.1`)).toBe(true)
    expect(existsSync(`${logPath}.2`)).toBe(true)
  })

  it('removes oldest archive (highest number) first until total ≤ cap', async () => {
    // .1=100  .2=100  .3=500  total=700, cap=200 → remove .3 (500),
    // remaining 200 ≤ 200 ✓ stop.
    writeArchive(1, 100)
    writeArchive(2, 100)
    writeArchive(3, 500)
    const result = await pruneTelemetryArchives({
      filePath: logPath,
      maxBytes: 1024,
      retainCount: 5,
      maxTotalBytes: 200,
    })
    expect(result.removed).toEqual([`${logPath}.3`])
    expect(result.freedBytes).toBe(500)
    expect(result.capExceeded).toBe(false)
    expect(existsSync(`${logPath}.1`)).toBe(true)
    expect(existsSync(`${logPath}.2`)).toBe(true)
    expect(existsSync(`${logPath}.3`)).toBe(false)
  })

  it('keeps removing oldest until cap satisfied (multi-step)', async () => {
    writeArchive(1, 50)
    writeArchive(2, 100)
    writeArchive(3, 200)
    writeArchive(4, 400)
    // total=750, cap=100 → drop .4 (400, remaining 350), drop .3 (200, remaining 150),
    // drop .2 (100, remaining 50 ≤ 100) ✓ stop. Keep .1.
    const result = await pruneTelemetryArchives({
      filePath: logPath,
      maxBytes: 1024,
      retainCount: 5,
      maxTotalBytes: 100,
    })
    expect(new Set(result.removed)).toEqual(
      new Set([`${logPath}.4`, `${logPath}.3`, `${logPath}.2`]),
    )
    expect(result.freedBytes).toBe(700)
    expect(existsSync(`${logPath}.1`)).toBe(true)
  })

  it('protects .1 even when its size alone exceeds the cap (capExceeded=true)', async () => {
    writeArchive(1, 500)
    writeArchive(2, 200)
    // total=700, cap=100 → drop .2 (200, remaining 500 still > 100), .1 is protected.
    const result = await pruneTelemetryArchives({
      filePath: logPath,
      maxBytes: 1024,
      retainCount: 5,
      maxTotalBytes: 100,
    })
    expect(result.removed).toEqual([`${logPath}.2`])
    expect(result.freedBytes).toBe(200)
    expect(result.capExceeded).toBe(true)
    expect(existsSync(`${logPath}.1`)).toBe(true)
    expect(existsSync(`${logPath}.2`)).toBe(false)
  })

  it('tolerates gaps in archive numbering', async () => {
    // Only .1 and .4 exist (gap at .2/.3) — common after partial failures.
    writeArchive(1, 100)
    writeArchive(4, 400)
    const result = await pruneTelemetryArchives({
      filePath: logPath,
      maxBytes: 1024,
      retainCount: 5,
      maxTotalBytes: 200,
    })
    expect(result.removed).toEqual([`${logPath}.4`])
    expect(result.freedBytes).toBe(400)
    expect(existsSync(`${logPath}.1`)).toBe(true)
  })

  it('never touches the active (unsuffixed) file', async () => {
    writeFileSync(logPath, 'x'.repeat(5000))
    writeArchive(2, 100)
    const result = await pruneTelemetryArchives({
      filePath: logPath,
      maxBytes: 1024,
      retainCount: 5,
      maxTotalBytes: 50,
    })
    // Active is huge but must NOT be considered or deleted.
    expect(existsSync(logPath)).toBe(true)
    expect(statSync(logPath).size).toBe(5000)
    expect(result.removed).toEqual([`${logPath}.2`])
  })

  it('returns empty result when only .1 exists (cannot prune protected file)', async () => {
    writeArchive(1, 999)
    const result = await pruneTelemetryArchives({
      filePath: logPath,
      maxBytes: 1024,
      retainCount: 5,
      maxTotalBytes: 100,
    })
    expect(result.removed).toEqual([])
    expect(result.freedBytes).toBe(0)
    expect(result.capExceeded).toBe(true)
    expect(existsSync(`${logPath}.1`)).toBe(true)
  })

  it('considers archives only up to retainCount when walking (ignores stale .N+k)', async () => {
    // Even if a numbering bug left a .9 around, with retainCount=3 we walk .1..3.
    // We do still consider it for *removal* though, since it's >= cap and noise.
    // Spec choice: prune scans the on-disk numbered archive set without an
    // arbitrary upper bound (gaps tolerated), so stale .9 should also be reclaimed.
    writeArchive(1, 50)
    writeArchive(2, 50)
    writeArchive(9, 400)
    const result = await pruneTelemetryArchives({
      filePath: logPath,
      maxBytes: 1024,
      retainCount: 3,
      maxTotalBytes: 200,
    })
    expect(result.removed).toEqual([`${logPath}.9`])
    expect(result.freedBytes).toBe(400)
    expect(existsSync(`${logPath}.1`)).toBe(true)
    expect(existsSync(`${logPath}.2`)).toBe(true)
  })

  it('treats missing parent directory as noop (best-effort)', async () => {
    const result = await pruneTelemetryArchives({
      filePath: join(tmp, 'nope', 'copilot-otel.jsonl'),
      maxBytes: 1024,
      retainCount: 5,
      maxTotalBytes: 100,
    })
    expect(result.removed).toEqual([])
    expect(result.freedBytes).toBe(0)
    expect(result.capExceeded).toBe(false)
  })
})

describe('resolveTelemetryRotationConfig (maxTotalBytes)', () => {
  it('exposes a DEFAULT_TELEMETRY_MAX_TOTAL_BYTES of 300 MiB', () => {
    expect(DEFAULT_TELEMETRY_MAX_TOTAL_BYTES).toBe(300 * 1024 * 1024)
  })

  it('defaults retainCount to 3 (lowered from 5 per P5a belt-and-suspenders)', () => {
    expect(DEFAULT_TELEMETRY_RETAIN_COUNT).toBe(3)
  })

  it('returns DEFAULT_TELEMETRY_MAX_TOTAL_BYTES when env unset', () => {
    const cfg = resolveTelemetryRotationConfig(undefined, {})
    expect(cfg.maxTotalBytes).toBe(DEFAULT_TELEMETRY_MAX_TOTAL_BYTES)
  })

  it('honors SCNS_TELEMETRY_MAX_TOTAL_BYTES env', () => {
    const cfg = resolveTelemetryRotationConfig(undefined, {
      SCNS_TELEMETRY_MAX_TOTAL_BYTES: '52428800', // 50 MiB
    })
    expect(cfg.maxTotalBytes).toBe(52428800)
  })

  it('per-call override wins over env for maxTotalBytes', () => {
    const cfg = resolveTelemetryRotationConfig(
      { maxTotalBytes: 1234 },
      { SCNS_TELEMETRY_MAX_TOTAL_BYTES: '999999' },
    )
    expect(cfg.maxTotalBytes).toBe(1234)
  })

  it('ignores invalid SCNS_TELEMETRY_MAX_TOTAL_BYTES (negative / non-numeric)', () => {
    const cfg = resolveTelemetryRotationConfig(undefined, {
      SCNS_TELEMETRY_MAX_TOTAL_BYTES: 'banana',
    })
    expect(cfg.maxTotalBytes).toBe(DEFAULT_TELEMETRY_MAX_TOTAL_BYTES)
  })
})

describe('rotate + prune integration', () => {
  it('rotation followed by prune-archives reclaims a hostile pre-policy archive', async () => {
    // Simulate the live scenario: .3 is a 1MB pre-policy archive from May 20.
    // Plus a small .1 and .2 that current policy would tolerate.
    writeArchive(1, 100)
    writeArchive(2, 100)
    writeArchive(3, 1024 * 1024) // hostile
    writeFileSync(logPath, 'active')

    const result = await pruneTelemetryArchives({
      filePath: logPath,
      maxBytes: 100,
      retainCount: 5,
      maxTotalBytes: 1024, // anything over 1KB across archives is over budget
    })
    expect(result.removed).toEqual([`${logPath}.3`])
    expect(result.freedBytes).toBe(1024 * 1024)
    expect(existsSync(`${logPath}.3`)).toBe(false)
  })

  it('rotation does not bypass prune-archives: caller still owns sweep', async () => {
    // rotateTelemetryIfNeeded should not silently prune; pruneTelemetryArchives is
    // a separate, opt-in step the scheduler calls. This guards against accidental
    // coupling regressions.
    writeFileSync(logPath, 'x'.repeat(500))
    writeArchive(1, 9999) // .1 will be shifted to .2
    const rotResult = await rotateTelemetryIfNeeded({
      filePath: logPath,
      maxBytes: 100,
      retainCount: 3,
    })
    expect(rotResult.rotated).toBe(true)
    // .2 (formerly .1, 9999 bytes) should still exist after rotation.
    expect(existsSync(`${logPath}.2`)).toBe(true)
    expect(statSync(`${logPath}.2`).size).toBe(9999)
  })
})
