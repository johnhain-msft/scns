/**
 * Streaming OTel JSONL file watcher (Phase 13.12.14).
 *
 * Reads the JSONL telemetry file in fixed-size chunks (CHUNK_BYTES) and
 * processes complete lines incrementally. Replaces the previous
 * "read entire delta into memory" approach which OOMed on >512MB files
 * (V8 max string length: ~0x1fffffe8 chars).
 *
 * Per-line JSON parse errors are logged (warn) and skipped — a single bad
 * line never aborts the loop. The current byte offset is checkpointed to
 * `otel_ingest_state` after each poll cycle so a broker restart does not
 * re-ingest the entire file.
 */

import { openSync, readSync, closeSync, statSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { logger } from '../shared/logger.js'
import { parseOtelLine, extractSpans, extractMetrics } from './jsonl-parser.js'
import { insertSpans, insertMetrics } from './otel-repository.js'
import type { OtelIngestionConfig } from './config.js'
import type Database from 'better-sqlite3'

// ── Tunables ──────────────────────────────────────────────────

/**
 * Per-read chunk size. Small enough that a single chunk plus the leftover
 * partial line cannot approach V8's 512MB string limit, big enough that we
 * don't issue a syscall per line. Each chunk's worth of complete lines is
 * processed in a single DB transaction (via insertSpans/insertMetrics) and
 * the buffers are released before the next chunk is read.
 */
const CHUNK_BYTES = 1 * 1024 * 1024 // 1 MiB

/**
 * Hard cap on accumulated partial-line length. Defends against pathological
 * inputs (e.g. a file with no newlines) by dropping the runaway line and
 * resyncing on the next newline. Logged as an error.
 */
const MAX_PARTIAL_BYTES = 8 * 1024 * 1024 // 8 MiB

// ── Types ─────────────────────────────────────────────────────

export interface FileWatcherStats {
  readonly linesProcessed: number
  readonly spansIngested: number
  readonly metricsIngested: number
  readonly errors: number
  readonly lastPollAt: Date | null
  /** Current byte offset within the watched file (Phase 13.12.14). */
  readonly byteOffset: number
}

export interface OtelFileWatcher {
  start(): void
  stop(): void
  getStats(): FileWatcherStats
  /** Exposed for testing — performs one poll cycle synchronously. */
  _poll(): void
}

// ── Checkpoint helpers ────────────────────────────────────────

interface Checkpoint {
  readonly offset: number
  readonly inode: number
}

function loadCheckpoint(db: Database.Database, path: string): Checkpoint | null {
  try {
    const row = db
      .prepare(
        'SELECT byte_offset AS offset, inode FROM otel_ingest_state WHERE file_path = ?',
      )
      .get(path) as { offset: number; inode: number } | undefined
    if (!row) return null
    return { offset: Number(row.offset), inode: Number(row.inode) }
  } catch {
    // Schema may not be applied yet (older DB or test stub). Treat as no-checkpoint.
    return null
  }
}

function saveCheckpoint(
  db: Database.Database,
  path: string,
  offset: number,
  inode: number,
): void {
  try {
    db.prepare(
      `INSERT INTO otel_ingest_state (file_path, byte_offset, inode, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(file_path) DO UPDATE SET
         byte_offset = excluded.byte_offset,
         inode = excluded.inode,
         updated_at = datetime('now')`,
    ).run(path, offset, inode)
  } catch (err) {
    // Logged in caller via stats.errors increment if persistent; one-off failures shouldn't kill polling.
    logger.warn({ err, path }, 'Failed to persist OTel ingest checkpoint')
  }
}

// ── Implementation ────────────────────────────────────────────

export function createOtelFileWatcher(
  config: OtelIngestionConfig,
  db: Database.Database,
): OtelFileWatcher {
  const log = logger.child({ module: 'otel-file-watcher' })

  let offset = 0
  let lastIno = 0
  let partial = Buffer.alloc(0)
  let timer: ReturnType<typeof setInterval> | null = null
  let initialized = false
  let checkpointLoaded = false

  const stats = {
    linesProcessed: 0,
    spansIngested: 0,
    metricsIngested: 0,
    errors: 0,
    lastPollAt: null as Date | null,
  }

  function ensureCheckpointLoaded(path: string): void {
    if (checkpointLoaded) return
    checkpointLoaded = true
    const cp = loadCheckpoint(db, path)
    if (cp) {
      offset = cp.offset
      lastIno = cp.inode
      // initialized stays false until first stat() so rotation detection still
      // works on first poll (we'll compare cp.inode to current).
      log.info(
        { path, offset, inode: lastIno },
        'Resumed OTel ingestion from checkpoint',
      )
    }
  }

  /**
   * Process a single complete line from the JSONL file. Errors are logged
   * and counted but never thrown — a malformed line MUST NOT kill the loop.
   */
  function processLine(
    line: string,
    spansAcc: ReturnType<typeof extractSpans> extends ReadonlyArray<infer T> ? T[] : never,
    metricsAcc: ReturnType<typeof extractMetrics> extends ReadonlyArray<infer T> ? T[] : never,
  ): void {
    const trimmed = line.trim()
    if (trimmed.length === 0) return

    stats.linesProcessed++

    let record: ReturnType<typeof parseOtelLine>
    try {
      record = parseOtelLine(trimmed)
    } catch (err) {
      stats.errors++
      log.warn({ err, snippet: trimmed.slice(0, 200) }, 'parseOtelLine threw on JSONL line')
      return
    }

    if (record === null) {
      stats.errors++
      log.warn({ snippet: trimmed.slice(0, 200) }, 'Failed to parse JSONL line')
      return
    }

    try {
      const spans = extractSpans(record)
      const metrics = extractMetrics(record)
      spansAcc.push(...spans)
      metricsAcc.push(...metrics)
    } catch (err) {
      stats.errors++
      log.warn({ err }, 'Failed to extract spans/metrics from valid JSON')
    }
  }

  function flushBatch(
    allSpans: ReturnType<typeof extractSpans> extends ReadonlyArray<infer T> ? T[] : never,
    allMetrics: ReturnType<typeof extractMetrics> extends ReadonlyArray<infer T> ? T[] : never,
  ): void {
    if (allSpans.length > 0) {
      try {
        const inserted = insertSpans(db, allSpans)
        stats.spansIngested += inserted
      } catch (err) {
        stats.errors++
        log.error({ err }, 'Failed to insert spans into DB')
      }
    }
    if (allMetrics.length > 0) {
      try {
        const inserted = insertMetrics(db, allMetrics)
        stats.metricsIngested += inserted
      } catch (err) {
        stats.errors++
        log.error({ err }, 'Failed to insert metrics into DB')
      }
    }
  }

  function poll(): void {
    const path = config.filePath
    if (!path) return

    stats.lastPollAt = new Date()

    ensureCheckpointLoaded(path)

    let fileStat: ReturnType<typeof statSync>
    try {
      fileStat = statSync(path)
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        log.debug({ path }, 'File not found, will retry on next poll')
        return
      }
      throw err
    }

    const currentIno = fileStat.ino
    const currentSize = fileStat.size

    // Detect rotation/truncation. Reuse a checkpointed inode mismatch on the
    // first poll after restart too (initialized==false but lastIno from CP).
    const inoKnown = initialized || lastIno !== 0
    if (inoKnown && (currentIno !== lastIno || currentSize < offset)) {
      log.info(
        { path, oldIno: lastIno, newIno: currentIno, oldOffset: offset, newSize: currentSize },
        'File rotation/truncation detected, resetting offset',
      )
      offset = 0
      partial = Buffer.alloc(0)
    }

    lastIno = currentIno
    initialized = true

    if (currentSize === offset) {
      // Persist checkpoint so newly-tracked inode is recorded even with no data.
      saveCheckpoint(db, path, offset, lastIno)
      return
    }

    const decoder = new StringDecoder('utf8')

    const allSpans: ReturnType<typeof extractSpans> extends ReadonlyArray<infer T> ? T[] : never =
      []
    const allMetrics: ReturnType<typeof extractMetrics> extends ReadonlyArray<infer T>
      ? T[]
      : never = []

    const fd = openSync(path, 'r')
    try {
      const chunk = Buffer.alloc(CHUNK_BYTES)
      while (offset < currentSize) {
        const want = Math.min(CHUNK_BYTES, currentSize - offset)
        const bytesRead = readSync(fd, chunk, 0, want, offset)
        if (bytesRead <= 0) break
        offset += bytesRead

        // Combine partial-from-previous-chunk + new bytes, then split on \n.
        // We hold at most CHUNK_BYTES + MAX_PARTIAL_BYTES in memory at once.
        const combinedLength = partial.length + bytesRead
        let text: string
        if (partial.length === 0) {
          text = decoder.write(chunk.subarray(0, bytesRead)) + decoder.end()
        } else {
          const merged = Buffer.concat([partial, chunk.subarray(0, bytesRead)], combinedLength)
          text = decoder.write(merged) + decoder.end()
        }

        const segments = text.split('\n')
        const lastSegment = segments.pop()!
        if (lastSegment.length > MAX_PARTIAL_BYTES) {
          stats.errors++
          log.error(
            { path, partialBytes: lastSegment.length, limit: MAX_PARTIAL_BYTES },
            'Dropping pathological partial line (no newline within limit); resyncing',
          )
          partial = Buffer.alloc(0)
        } else if (lastSegment.length > 0) {
          partial = Buffer.from(lastSegment, 'utf8')
        } else {
          partial = Buffer.alloc(0)
        }

        for (const line of segments) {
          processLine(line, allSpans, allMetrics)
        }

        // Flush per-chunk to keep accumulator memory bounded on huge files.
        if (allSpans.length > 0 || allMetrics.length > 0) {
          flushBatch(allSpans, allMetrics)
          allSpans.length = 0
          allMetrics.length = 0
        }
      }
    } finally {
      closeSync(fd)
    }

    // Final flush (in case last chunk produced records that weren't flushed).
    flushBatch(allSpans, allMetrics)

    saveCheckpoint(db, path, offset, lastIno)
  }

  function safePoll(): void {
    try {
      poll()
    } catch (err) {
      stats.errors++
      log.error({ err }, 'OTel poll cycle threw; will retry next interval')
    }
  }

  return {
    start() {
      if (timer !== null) return
      log.info({ pollIntervalMs: config.pollIntervalMs }, 'Starting OTel file watcher')
      safePoll()
      timer = setInterval(safePoll, config.pollIntervalMs)
    },

    stop() {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
        log.info('Stopped OTel file watcher')
      }
    },

    getStats(): FileWatcherStats {
      return { ...stats, byteOffset: offset }
    },

    _poll: poll,
  }
}
