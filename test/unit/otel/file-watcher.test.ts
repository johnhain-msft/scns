import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync, appendFileSync, mkdtempSync, rmSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { applyOtelSchema } from '../../../src/otel/db.js'
import { createOtelFileWatcher } from '../../../src/otel/file-watcher.js'
import type { OtelIngestionConfig } from '../../../src/otel/config.js'

// ── Sample JSONL data ─────────────────────────────────────────

function makeSpanLine(traceId: string, spanId: string): string {
  return JSON.stringify({
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
                attributes: [],
                events: [],
              },
            ],
          },
        ],
      },
    ],
  })
}

function makeMetricLine(metricName: string): string {
  return JSON.stringify({
    resourceMetrics: [
      {
        resource: {
          attributes: [{ key: 'service.name', value: { stringValue: 'test' } }],
        },
        scopeMetrics: [
          {
            metrics: [
              {
                name: metricName,
                gauge: {
                  dataPoints: [
                    {
                      timeUnixNano: '1700000010000000000',
                      asDouble: 42.0,
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  })
}

// ── Tests ─────────────────────────────────────────────────────

describe('otel-file-watcher', () => {
  let tempDir: string
  let filePath: string
  let db: Database.Database
  let dbPath: string

  function makeConfig(overrides?: Partial<OtelIngestionConfig>): OtelIngestionConfig {
    return {
      enabled: true,
      filePath: filePath,
      retentionDays: 7,
      maxSpansPerTrace: 1000,
      pollIntervalMs: 1000,
      ...overrides,
    }
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'scns-fw-test-'))
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

  it('reads new lines from a JSONL file', async () => {
    const line1 = makeSpanLine('trace-1', 'span-1')
    const line2 = makeSpanLine('trace-1', 'span-2')
    writeFileSync(filePath, line1 + '\n' + line2 + '\n')

    const watcher = createOtelFileWatcher(makeConfig(), db)
    watcher._poll()

    const stats = watcher.getStats()
    expect(stats.linesProcessed).toBe(2)
    expect(stats.spansIngested).toBe(2)
    expect(stats.errors).toBe(0)
  })

  it('ignores already-read lines via offset tracking', async () => {
    writeFileSync(filePath, makeSpanLine('trace-1', 'span-1') + '\n')

    const watcher = createOtelFileWatcher(makeConfig(), db)
    watcher._poll()

    expect(watcher.getStats().linesProcessed).toBe(1)

    // Append more data
    appendFileSync(filePath, makeSpanLine('trace-1', 'span-2') + '\n')
    watcher._poll()

    expect(watcher.getStats().linesProcessed).toBe(2)
    expect(watcher.getStats().spansIngested).toBe(2)

    // Verify DB has exactly 2 spans
    const count = db.prepare('SELECT COUNT(*) AS cnt FROM otel_spans').get() as { cnt: number }
    expect(count.cnt).toBe(2)
  })

  it('handles file rotation (truncation resets offset)', async () => {
    // Write multiple lines so offset is large
    writeFileSync(
      filePath,
      makeSpanLine('trace-1', 'span-1') + '\n' + makeSpanLine('trace-1', 'span-extra') + '\n',
    )

    const watcher = createOtelFileWatcher(makeConfig(), db)
    watcher._poll()

    expect(watcher.getStats().linesProcessed).toBe(2)

    // Simulate rotation: truncate and write single new line (smaller than old offset)
    writeFileSync(filePath, makeSpanLine('trace-2', 'span-3') + '\n')
    watcher._poll()

    expect(watcher.getStats().linesProcessed).toBe(3)
    expect(watcher.getStats().spansIngested).toBe(3)
  })

  it('handles file replacement with inode change', async () => {
    writeFileSync(filePath, makeSpanLine('trace-1', 'span-1') + '\n')

    const watcher = createOtelFileWatcher(makeConfig(), db)
    watcher._poll()

    expect(watcher.getStats().spansIngested).toBe(1)

    // Replace via rename-then-recreate — the shape telemetry-rotator.ts uses.
    // A bare unlink+recreate does NOT guarantee a new inode (ext4 readily
    // reuses the just-freed one, which made this test fail on Linux CI);
    // renaming the old file aside keeps its inode allocated, so the
    // recreated primary must get a fresh one on every platform.
    const oldIno = statSync(filePath).ino
    renameSync(filePath, filePath + '.1')
    writeFileSync(filePath, makeSpanLine('trace-2', 'span-new') + '\n')
    expect(statSync(filePath).ino).not.toBe(oldIno)
    watcher._poll()

    expect(watcher.getStats().spansIngested).toBe(2)
  })

  it('handles missing file gracefully', async () => {
    const missingPath = join(tempDir, 'nonexistent.jsonl')
    const watcher = createOtelFileWatcher(makeConfig({ filePath: missingPath }), db)

    // Should not throw
    watcher._poll()

    const stats = watcher.getStats()
    expect(stats.linesProcessed).toBe(0)
    expect(stats.errors).toBe(0)
  })

  it('handles malformed lines (skips, increments error count)', async () => {
    const lines =
      [
        'not json at all',
        makeSpanLine('trace-1', 'span-1'),
        '{"invalid": true}', // valid JSON but no spans/metrics — not an error, just 0 extracted
        '{bad json{{{',
      ].join('\n') + '\n'

    writeFileSync(filePath, lines)

    const watcher = createOtelFileWatcher(makeConfig(), db)
    watcher._poll()

    const stats = watcher.getStats()
    // "not json at all" and "{bad json{{" → 2 parse errors
    expect(stats.errors).toBe(2)
    // Only span-1 is a valid span
    expect(stats.spansIngested).toBe(1)
    // 4 lines total processed (all attempted)
    expect(stats.linesProcessed).toBe(4)
  })

  it('stats reflect actual ingestion counts', async () => {
    const lines =
      [
        makeSpanLine('trace-1', 'span-1'),
        makeMetricLine('test.metric.1'),
        makeSpanLine('trace-2', 'span-2'),
      ].join('\n') + '\n'

    writeFileSync(filePath, lines)

    const watcher = createOtelFileWatcher(makeConfig(), db)
    watcher._poll()

    const stats = watcher.getStats()
    expect(stats.linesProcessed).toBe(3)
    expect(stats.spansIngested).toBe(2)
    expect(stats.metricsIngested).toBe(1)
    expect(stats.errors).toBe(0)
    expect(stats.lastPollAt).not.toBeNull()
  })

  it('multiple polls accumulate data correctly', async () => {
    writeFileSync(filePath, makeSpanLine('trace-1', 'span-1') + '\n')

    const watcher = createOtelFileWatcher(makeConfig(), db)
    watcher._poll()

    appendFileSync(filePath, makeSpanLine('trace-1', 'span-2') + '\n')
    watcher._poll()

    appendFileSync(filePath, makeMetricLine('test.metric') + '\n')
    watcher._poll()

    const stats = watcher.getStats()
    expect(stats.linesProcessed).toBe(3)
    expect(stats.spansIngested).toBe(2)
    expect(stats.metricsIngested).toBe(1)
  })

  it('start() and stop() manage polling lifecycle', async () => {
    writeFileSync(filePath, makeSpanLine('trace-1', 'span-1') + '\n')

    const watcher = createOtelFileWatcher(makeConfig({ pollIntervalMs: 50 }), db)
    watcher.start()

    // Wait for a few poll cycles
    await new Promise((resolve) => setTimeout(resolve, 200))

    watcher.stop()

    const stats = watcher.getStats()
    expect(stats.linesProcessed).toBeGreaterThanOrEqual(1)
    expect(stats.lastPollAt).not.toBeNull()
  })

  it('stop() is idempotent', () => {
    const watcher = createOtelFileWatcher(makeConfig(), db)
    watcher.stop() // no-op when not started
    watcher.start()
    watcher.stop()
    watcher.stop() // no-op
  })

  it('start() is idempotent', () => {
    writeFileSync(filePath, '')
    const watcher = createOtelFileWatcher(makeConfig({ pollIntervalMs: 50 }), db)
    watcher.start()
    watcher.start() // should not create a second interval
    watcher.stop()
  })

  it('handles empty file gracefully', () => {
    writeFileSync(filePath, '')
    const watcher = createOtelFileWatcher(makeConfig(), db)
    watcher._poll()

    expect(watcher.getStats().linesProcessed).toBe(0)
    expect(watcher.getStats().errors).toBe(0)
  })

  it('handles lines with only whitespace', () => {
    writeFileSync(filePath, '   \n\n  \n')
    const watcher = createOtelFileWatcher(makeConfig(), db)
    watcher._poll()

    // Empty/whitespace lines are skipped by parseOtelLine
    expect(watcher.getStats().errors).toBe(0)
  })

  it('getStats() returns a snapshot (not a live reference)', () => {
    writeFileSync(filePath, makeSpanLine('trace-1', 'span-1') + '\n')
    const watcher = createOtelFileWatcher(makeConfig(), db)
    watcher._poll()

    const stats1 = watcher.getStats()
    appendFileSync(filePath, makeSpanLine('trace-1', 'span-2') + '\n')
    watcher._poll()

    const stats2 = watcher.getStats()
    expect(stats1.linesProcessed).toBe(1)
    expect(stats2.linesProcessed).toBe(2)
  })

  it('clears partial buffer on file rotation', () => {
    // Write a line without trailing newline (partial)
    writeFileSync(filePath, makeSpanLine('trace-1', 'span-1'))
    const watcher = createOtelFileWatcher(makeConfig(), db)
    watcher._poll()

    // Partial line not yet processed
    expect(watcher.getStats().linesProcessed).toBe(0)

    // Rotate the file — partial should be discarded
    writeFileSync(filePath, makeSpanLine('trace-2', 'span-2') + '\n')
    watcher._poll()

    expect(watcher.getStats().spansIngested).toBe(1)
    expect(watcher.getStats().linesProcessed).toBe(1)
  })

  it('handles extract/insert errors gracefully', () => {
    // Valid JSON but will cause BigInt error in nanoToIso if startTimeUnixNano is missing
    const badSpanLine = JSON.stringify({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: 't1',
                  spanId: 's1',
                  name: 'bad',
                  startTimeUnixNano: 'not-a-number',
                },
              ],
            },
          ],
        },
      ],
    })
    writeFileSync(filePath, badSpanLine + '\n')

    const watcher = createOtelFileWatcher(makeConfig(), db)
    watcher._poll()

    // Should not crash, should count as error
    expect(watcher.getStats().errors).toBe(1)
    expect(watcher.getStats().linesProcessed).toBe(1)
  })
})
