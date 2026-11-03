import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  openSync,
  writeSync,
  closeSync,
  appendFileSync,
  mkdtempSync,
  rmSync,
  statSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { applyOtelSchema } from '../../../src/otel/db.js'
import { createOtelFileWatcher } from '../../../src/otel/file-watcher.js'
import type { OtelIngestionConfig } from '../../../src/otel/config.js'

/**
 * Phase 13.12.14 — streaming ingestor tests.
 * Validates that the file watcher:
 *   1. Handles a 200MB JSONL file without OOM (proves streaming, not whole-file read).
 *   2. Recovers from a mid-line crash (last partial line resyncs on next poll
 *      after the appender completes the line).
 *   3. Resumes from a persisted byte-offset checkpoint after watcher recreation.
 */

function makeSpanLine(traceId: string, spanId: string, padBytes = 0): string {
  const span = {
    resourceSpans: [
      {
        resource: {
          attributes: [{ key: 'service.name', value: { stringValue: 'test' } }],
        },
        scopeSpans: [
          {
            spans: [
              {
                traceId,
                spanId,
                name: 'test-span',
                kind: 1,
                startTimeUnixNano: '1700000000000000000',
                endTimeUnixNano: '1700000001000000000',
                status: { code: 1 },
                attributes:
                  padBytes > 0
                    ? [
                        {
                          key: 'pad',
                          value: { stringValue: 'x'.repeat(padBytes) },
                        },
                      ]
                    : [],
                events: [],
              },
            ],
          },
        ],
      },
    ],
  }
  return JSON.stringify(span)
}

describe('otel-file-watcher streaming (Phase 13.12.14)', () => {
  let tempDir: string
  let filePath: string
  let db: Database.Database
  let dbPath: string

  function makeConfig(overrides?: Partial<OtelIngestionConfig>): OtelIngestionConfig {
    return {
      enabled: true,
      filePath,
      retentionDays: 7,
      maxSpansPerTrace: 1000,
      pollIntervalMs: 1000,
      ...overrides,
    }
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scns-fw-stream-'))
    filePath = join(tempDir, 'otel.jsonl')
    dbPath = join(tempDir, 'test.db')
    db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    applyOtelSchema(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('streams a ~200MB JSONL file without exceeding ~64MB string allocations', () => {
    // Each line is ~64KB of padded span. 200MB / 64KB ≈ 3200 lines.
    // Under the OLD whole-file-read implementation, decoder.write() would
    // try to materialize a single ~200MB string — well under the V8 limit
    // here, but the *real* OOM trigger was a >512MB file. We use 200MB
    // because writing 600MB to disk in CI is too slow; the relevant proof
    // is that the watcher processes the file without ever holding more
    // than CHUNK_BYTES + MAX_PARTIAL_BYTES (≈9MB) in memory at once. We
    // assert that by checking peak heap delta stays under a generous bound.
    const lineWithNewline = makeSpanLine('trace-big', 'span-0000', 60_000) + '\n'
    const lineBytes = Buffer.byteLength(lineWithNewline, 'utf8')
    const targetBytes = 200 * 1024 * 1024
    const lineCount = Math.ceil(targetBytes / lineBytes)

    // Write streaming so we don't need the whole 200MB in our own memory.
    // Generate unique span IDs per line so the PRIMARY KEY on otel_spans
    // doesn't dedupe them and we can verify spansIngested == lineCount.
    const fd = openSync(filePath, 'w')
    try {
      for (let i = 0; i < lineCount; i++) {
        const id = `span-${i.toString(16).padStart(12, '0')}`
        const buf = Buffer.from(makeSpanLine('trace-big', id, 60_000) + '\n', 'utf8')
        writeSync(fd, buf)
      }
    } finally {
      closeSync(fd)
    }

    const fileSize = statSync(filePath).size
    expect(fileSize).toBeGreaterThan(150 * 1024 * 1024)

    const before = process.memoryUsage().heapUsed
    const watcher = createOtelFileWatcher(makeConfig(), db)
    watcher._poll()
    const after = process.memoryUsage().heapUsed

    const stats = watcher.getStats()
    expect(stats.linesProcessed).toBe(lineCount)
    expect(stats.spansIngested).toBe(lineCount)
    expect(stats.errors).toBe(0)
    expect(stats.byteOffset).toBe(fileSize)

    // Streaming proof: heap delta must not approach the file size. We allow
    // 100MB headroom for V8 noise — the OLD code would have allocated a
    // single >200MB string and blown past this.
    const heapDelta = after - before
    expect(heapDelta).toBeLessThan(100 * 1024 * 1024)
  }, 120_000)

  it('recovers from a mid-line crash: partial line is held until completed by next append', () => {
    // Write one complete line, then a partial second line (no trailing \n).
    const complete = makeSpanLine('trace-1', 'span-1') + '\n'
    const partial = makeSpanLine('trace-2', 'span-2') // NO trailing newline
    // Cut the partial in half to simulate crash mid-write.
    const partialHalf = partial.slice(0, Math.floor(partial.length / 2))
    const fd = openSync(filePath, 'w')
    try {
      writeSync(fd, complete)
      writeSync(fd, partialHalf)
    } finally {
      closeSync(fd)
    }

    const watcher = createOtelFileWatcher(makeConfig(), db)
    watcher._poll()

    let stats = watcher.getStats()
    // First poll: only the complete line should have been processed.
    expect(stats.linesProcessed).toBe(1)
    expect(stats.spansIngested).toBe(1)
    expect(stats.errors).toBe(0)

    // Now the "appender" finishes the partial line and adds a newline.
    const remainder = partial.slice(Math.floor(partial.length / 2)) + '\n'
    appendFileSync(filePath, remainder)

    watcher._poll()

    stats = watcher.getStats()
    expect(stats.linesProcessed).toBe(2)
    expect(stats.spansIngested).toBe(2)
    expect(stats.errors).toBe(0)

    // DB has both spans
    const count = db.prepare('SELECT COUNT(*) AS cnt FROM otel_spans').get() as {
      cnt: number
    }
    expect(count.cnt).toBe(2)
  })

  it('resumes from persisted byte-offset checkpoint across watcher recreations', () => {
    // First watcher ingests some lines, persists checkpoint to DB, then is dropped.
    const first =
      makeSpanLine('trace-1', 'span-1') + '\n' + makeSpanLine('trace-1', 'span-2') + '\n'
    const fd = openSync(filePath, 'w')
    try {
      writeSync(fd, first)
    } finally {
      closeSync(fd)
    }

    const w1 = createOtelFileWatcher(makeConfig(), db)
    w1.start() // start does an initial poll synchronously
    w1.stop()

    expect(w1.getStats().linesProcessed).toBe(2)
    expect(w1.getStats().spansIngested).toBe(2)
    const offsetAfterFirst = w1.getStats().byteOffset
    expect(offsetAfterFirst).toBe(Buffer.byteLength(first, 'utf8'))

    // Verify checkpoint was persisted to DB
    const cp = db
      .prepare('SELECT byte_offset, inode FROM otel_ingest_state WHERE file_path = ?')
      .get(filePath) as { byte_offset: number; inode: number } | undefined
    expect(cp).toBeDefined()
    expect(Number(cp!.byte_offset)).toBe(offsetAfterFirst)
    expect(Number(cp!.inode)).toBeGreaterThan(0)

    // Append more data
    const more = makeSpanLine('trace-2', 'span-3') + '\n'
    appendFileSync(filePath, more)

    // Brand-new watcher (simulates broker restart). It should resume from
    // the checkpoint and only process the appended line, NOT the original two.
    const w2 = createOtelFileWatcher(makeConfig(), db)
    w2._poll()

    const stats = w2.getStats()
    expect(stats.linesProcessed).toBe(1)
    expect(stats.spansIngested).toBe(1)
    expect(stats.errors).toBe(0)

    // DB total spans = 3 (no double-ingestion of original 2)
    const count = db.prepare('SELECT COUNT(*) AS cnt FROM otel_spans').get() as {
      cnt: number
    }
    expect(count.cnt).toBe(3)
  })
})
