import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runHousekeeping, type HousekeepingConfig } from '../../../src/dream/housekeeping.js'

describe('runHousekeeping', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')

    // Create the tables that match broker schema
    db.exec(`
      CREATE TABLE otel_spans (
        trace_id TEXT NOT NULL,
        span_id TEXT PRIMARY KEY,
        parent_span_id TEXT,
        name TEXT NOT NULL,
        kind TEXT,
        start_time TEXT NOT NULL,
        end_time TEXT,
        duration_ms REAL,
        status TEXT,
        attributes_json TEXT DEFAULT '{}',
        events_json TEXT DEFAULT '[]',
        resource_json TEXT DEFAULT '{}',
        session_id TEXT,
        created_at DATETIME NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE otel_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        metric_type TEXT NOT NULL,
        value REAL NOT NULL,
        attributes_json TEXT DEFAULT '{}',
        resource_json TEXT DEFAULT '{}',
        timestamp TEXT NOT NULL,
        created_at DATETIME NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        session_id TEXT,
        payload TEXT NOT NULL,
        created_at DATETIME DEFAULT (datetime('now'))
      );
    `)
  })

  afterEach(() => {
    db.close()
  })

  function insertOtelSpans(count: number, daysAgo: number) {
    const stmt = db.prepare(`
      INSERT INTO otel_spans (trace_id, span_id, name, start_time, created_at)
      VALUES (?, ?, 'test-span', datetime('now', '-' || ? || ' days'), datetime('now', '-' || ? || ' days'))
    `)
    for (let i = 0; i < count; i++) {
      stmt.run(`trace-${daysAgo}-${i}`, `span-${daysAgo}-${i}`, daysAgo, daysAgo)
    }
  }

  function insertOtelMetrics(count: number, daysAgo: number) {
    const stmt = db.prepare(`
      INSERT INTO otel_metrics (name, metric_type, value, timestamp, created_at)
      VALUES ('test.metric', 'counter', 1.0, datetime('now', '-' || ? || ' days'), datetime('now', '-' || ? || ' days'))
    `)
    for (let i = 0; i < count; i++) {
      stmt.run(daysAgo, daysAgo)
    }
  }

  function insertEvents(count: number, daysAgo: number) {
    const stmt = db.prepare(`
      INSERT INTO events (event_type, payload, created_at)
      VALUES ('hook_received', '{}', datetime('now', '-' || ? || ' days'))
    `)
    for (let i = 0; i < count; i++) {
      stmt.run(daysAgo)
    }
  }

  it('should prune OTel spans older than retention days', () => {
    insertOtelSpans(10, 1) // recent
    insertOtelSpans(20, 10) // old
    const config: HousekeepingConfig = { otelRetentionDays: 7, eventRetentionDays: 30, vacuum: false }

    const result = runHousekeeping(db, config)

    expect(result.otelSpansPruned).toBe(20)
    const remaining = (db.prepare('SELECT COUNT(*) as cnt FROM otel_spans').get() as { cnt: number }).cnt
    expect(remaining).toBe(10)
  })

  it('should prune OTel metrics older than retention days', () => {
    insertOtelMetrics(5, 1) // recent
    insertOtelMetrics(50, 10) // old
    const config: HousekeepingConfig = { otelRetentionDays: 7, eventRetentionDays: 30, vacuum: false }

    const result = runHousekeeping(db, config)

    expect(result.otelMetricsPruned).toBe(50)
    const remaining = (db.prepare('SELECT COUNT(*) as cnt FROM otel_metrics').get() as { cnt: number }).cnt
    expect(remaining).toBe(5)
  })

  it('should prune events older than retention days', () => {
    insertEvents(5, 1) // recent
    insertEvents(100, 60) // old
    const config: HousekeepingConfig = { otelRetentionDays: 7, eventRetentionDays: 30, vacuum: false }

    const result = runHousekeeping(db, config)

    expect(result.eventsPruned).toBe(100)
    const remaining = (db.prepare('SELECT COUNT(*) as cnt FROM events').get() as { cnt: number }).cnt
    expect(remaining).toBe(5)
  })

  it('should not prune data within retention window', () => {
    insertOtelSpans(10, 3)
    insertOtelMetrics(10, 3)
    insertEvents(10, 15)
    const config: HousekeepingConfig = { otelRetentionDays: 7, eventRetentionDays: 30, vacuum: false }

    const result = runHousekeeping(db, config)

    expect(result.otelSpansPruned).toBe(0)
    expect(result.otelMetricsPruned).toBe(0)
    expect(result.eventsPruned).toBe(0)
  })

  it('should handle empty tables gracefully', () => {
    const config: HousekeepingConfig = { otelRetentionDays: 7, eventRetentionDays: 30, vacuum: false }
    const result = runHousekeeping(db, config)

    expect(result.otelSpansPruned).toBe(0)
    expect(result.otelMetricsPruned).toBe(0)
    expect(result.eventsPruned).toBe(0)
    expect(result.success).toBe(true)
  })

  it('should run VACUUM when requested', () => {
    insertOtelMetrics(100, 10)
    const config: HousekeepingConfig = { otelRetentionDays: 7, eventRetentionDays: 30, vacuum: true }

    const result = runHousekeeping(db, config)

    expect(result.otelMetricsPruned).toBe(100)
    expect(result.vacuumed).toBe(true)
    expect(result.success).toBe(true)
  })

  it('should report total duration', () => {
    const config: HousekeepingConfig = { otelRetentionDays: 7, eventRetentionDays: 30, vacuum: false }
    const result = runHousekeeping(db, config)

    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('should handle missing tables gracefully', () => {
    const emptyDb = new Database(':memory:')
    const config: HousekeepingConfig = { otelRetentionDays: 7, eventRetentionDays: 30, vacuum: false }

    const result = runHousekeeping(emptyDb, config)

    expect(result.success).toBe(true)
    expect(result.otelSpansPruned).toBe(0)
    emptyDb.close()
  })

  // Phase 13.12.16 — split retention for spans vs metrics.
  describe('split retention (Phase 13.12.16)', () => {
    it('honors otelMetricsRetentionDays for metrics separately from spans', () => {
      insertOtelSpans(10, 1)
      insertOtelSpans(10, 5) // would be pruned if spansDays<5
      insertOtelMetrics(10, 1)
      insertOtelMetrics(10, 5) // should be pruned with metricsDays=2

      const config: HousekeepingConfig = {
        otelRetentionDays: 7, // back-compat fallback
        otelSpansRetentionDays: 7, // keep all spans
        otelMetricsRetentionDays: 2, // prune metrics older than 2 days
        eventRetentionDays: 30,
        vacuum: false,
      }
      const result = runHousekeeping(db, config)

      expect(result.otelSpansPruned).toBe(0)
      expect(result.otelMetricsPruned).toBe(10)
      const remainingMetrics = db
        .prepare('SELECT COUNT(*) as c FROM otel_metrics')
        .get() as { c: number }
      expect(remainingMetrics.c).toBe(10)
    })

    it('falls back to otelRetentionDays when split fields are omitted', () => {
      insertOtelMetrics(5, 10)
      const result = runHousekeeping(db, {
        otelRetentionDays: 3,
        eventRetentionDays: 30,
        vacuum: false,
      })
      expect(result.otelMetricsPruned).toBe(5)
    })
  })

  /**
   * P0.2 (2026-05-19): task_run_history and messages_history retention.
   * Each scheduled-task tick logs to task_run_history (~430 rows/day in prod);
   * unbounded growth is the dominant data.db bloat source after OTel.
   * messages_history accumulates as sessions deregister.
   */
  describe('task_run_history + messages_history retention', () => {
    beforeEach(() => {
      db.exec(`
        CREATE TABLE scheduled_tasks (id TEXT PRIMARY KEY);
        INSERT INTO scheduled_tasks (id) VALUES ('heartbeat-poller');
        CREATE TABLE task_run_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT NOT NULL,
          status TEXT NOT NULL,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          duration_ms REAL,
          error_message TEXT,
          created_at DATETIME NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE messages_history (
          id TEXT NOT NULL,
          sender_id TEXT,
          receiver_id TEXT,
          content TEXT NOT NULL,
          story_id TEXT,
          reply_to TEXT,
          created_at DATETIME,
          read_at DATETIME,
          purged_at DATETIME DEFAULT (datetime('now'))
        );
      `)
    })

    function insertTaskRunRows(count: number, daysAgo: number) {
      const stmt = db.prepare(
        `INSERT INTO task_run_history (task_id, status, started_at)
         VALUES ('heartbeat-poller', 'success', datetime('now', '-' || ? || ' days'))`,
      )
      for (let i = 0; i < count; i++) stmt.run(daysAgo)
    }

    function insertMessagesHistoryRows(count: number, daysAgo: number) {
      const stmt = db.prepare(
        `INSERT INTO messages_history (id, content, purged_at)
         VALUES (?, 'msg', datetime('now', '-' || ? || ' days'))`,
      )
      for (let i = 0; i < count; i++) stmt.run(`mh-${daysAgo}-${i}`, daysAgo)
    }

    it('prunes task_run_history rows older than retention', () => {
      insertTaskRunRows(5, 1)
      insertTaskRunRows(20, 30)
      const result = runHousekeeping(db, {
        otelRetentionDays: 7,
        eventRetentionDays: 30,
        taskRunHistoryRetentionDays: 14,
        vacuum: false,
      })
      expect(result.taskRunHistoryPruned).toBe(20)
      const remaining = db.prepare('SELECT COUNT(*) as c FROM task_run_history').get() as {
        c: number
      }
      expect(remaining.c).toBe(5)
    })

    it('prunes messages_history rows older than retention (filtered on purged_at)', () => {
      insertMessagesHistoryRows(3, 10)
      insertMessagesHistoryRows(7, 200)
      const result = runHousekeeping(db, {
        otelRetentionDays: 7,
        eventRetentionDays: 30,
        messagesHistoryRetentionDays: 90,
        vacuum: false,
      })
      expect(result.messagesHistoryPruned).toBe(7)
      const remaining = db.prepare('SELECT COUNT(*) as c FROM messages_history').get() as {
        c: number
      }
      expect(remaining.c).toBe(3)
    })

    it('applies the documented defaults when retentionDays fields are omitted', () => {
      insertTaskRunRows(2, 20)
      insertMessagesHistoryRows(2, 100)
      const result = runHousekeeping(db, {
        otelRetentionDays: 7,
        eventRetentionDays: 30,
        vacuum: false,
      })
      // Default is 14 days for task_run_history → 20-day-old rows pruned
      expect(result.taskRunHistoryPruned).toBe(2)
      // Default is 90 days for messages_history → 100-day-old rows pruned
      expect(result.messagesHistoryPruned).toBe(2)
    })

    it('reports zero pruned and skips the prune when table does not exist', () => {
      db.exec('DROP TABLE task_run_history; DROP TABLE messages_history;')
      const result = runHousekeeping(db, {
        otelRetentionDays: 7,
        eventRetentionDays: 30,
        vacuum: false,
      })
      expect(result.taskRunHistoryPruned).toBe(0)
      expect(result.messagesHistoryPruned).toBe(0)
      expect(result.success).toBe(true)
    })

    it('triggers VACUUM when only the new prune paths produce deletes', () => {
      // No OTel/events deletes; only task_run_history
      insertTaskRunRows(10, 30)
      const result = runHousekeeping(db, {
        otelRetentionDays: 7,
        eventRetentionDays: 30,
        taskRunHistoryRetentionDays: 14,
        vacuum: true,
      })
      expect(result.taskRunHistoryPruned).toBe(10)
      expect(result.vacuumed).toBe(true)
    })
  })
})

/**
 * WAL truncation regression suite (task 44).
 *
 * Symptom: as of 2026-05-15 the broker's data.db-wal grew to 342MB
 * (1:1 with the main DB) and the blue/green restart's Phase 1
 * housekeeping did NOT shrink it. The root cause was that
 * runHousekeeping prunes/vacuums but never issues
 * `PRAGMA wal_checkpoint(TRUNCATE)`, so the WAL file keeps any pages
 * the auto-checkpoint (PASSIVE) couldn't reclaim past the read mark.
 *
 * These tests use a real on-disk DB so the WAL file is observable on
 * the filesystem (an :memory: DB has no WAL).
 */
describe('runHousekeeping — WAL truncation (task 44)', () => {
  let tmpDir: string
  let dbPath: string
  let db: Database.Database

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'scns-housekeeping-wal-'))
    dbPath = join(tmpDir, 'data.db')
    db = new Database(dbPath)
    // Match broker's openDatabase pragmas (WAL mode + NORMAL sync).
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')

    db.exec(`
      CREATE TABLE otel_spans (
        trace_id TEXT NOT NULL,
        span_id TEXT PRIMARY KEY,
        parent_span_id TEXT,
        name TEXT NOT NULL,
        kind TEXT,
        start_time TEXT NOT NULL,
        end_time TEXT,
        duration_ms REAL,
        status TEXT,
        attributes_json TEXT DEFAULT '{}',
        events_json TEXT DEFAULT '[]',
        resource_json TEXT DEFAULT '{}',
        session_id TEXT,
        created_at DATETIME NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE otel_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        metric_type TEXT NOT NULL,
        value REAL NOT NULL,
        attributes_json TEXT DEFAULT '{}',
        resource_json TEXT DEFAULT '{}',
        timestamp TEXT NOT NULL,
        created_at DATETIME NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        session_id TEXT,
        payload TEXT NOT NULL,
        created_at DATETIME DEFAULT (datetime('now'))
      );
    `)
  })

  afterEach(() => {
    try {
      db.close()
    } catch {
      /* ignore */
    }
    rmSync(tmpDir, { recursive: true, force: true })
  })

  /**
   * Inflate the WAL by writing many rows in many small transactions.
   * Each commit appends WAL frames; with the default `wal_autocheckpoint`
   * of 1000 frames, the WAL still grows substantially before any
   * checkpoint and is NEVER truncated unless we explicitly TRUNCATE.
   */
  function inflateWal(): void {
    // ~50k rows of recent metrics — enough payload to push the WAL past
    // 2MB on any reasonable platform.
    const insert = db.prepare(`
      INSERT INTO otel_metrics (name, metric_type, value, timestamp, attributes_json)
      VALUES ('test.metric', 'counter', ?, datetime('now'), ?)
    `)
    const filler = 'x'.repeat(256)
    for (let batch = 0; batch < 50; batch++) {
      // Many small transactions = many WAL frames.
      const txn = db.transaction((n: number) => {
        for (let i = 0; i < 1000; i++) {
          insert.run(n * 1000 + i, filler)
        }
      })
      txn(batch)
    }
  }

  function walSize(): number {
    const walPath = `${dbPath}-wal`
    if (!existsSync(walPath)) return 0
    return statSync(walPath).size
  }

  it('reports walTruncated:true and shrinks the WAL file when DB is in WAL mode', () => {
    inflateWal()
    const walBefore = walSize()
    // Sanity: we actually inflated the WAL (more than 1MB).
    expect(walBefore).toBeGreaterThan(1024 * 1024)

    const config: HousekeepingConfig = {
      otelRetentionDays: 7,
      eventRetentionDays: 30,
      vacuum: false,
    }
    const result = runHousekeeping(db, config)

    expect(result.success).toBe(true)
    expect(result.walTruncated).toBe(true)

    const walAfter = walSize()
    // After TRUNCATE the WAL header is at most 4KB; we cap at 256KB to
    // give cross-platform headroom while still catching the 342MB bug.
    expect(walAfter).toBeLessThan(256 * 1024)
    expect(walAfter).toBeLessThan(walBefore)
  })

  it('truncates the WAL even when there is no data to prune (the restart-manager Phase-1 path)', () => {
    // Simulate the restart-manager path: housekeeping is called with
    // vacuum:false and there is nothing past retention to prune. Prior
    // to the fix the function returned early without touching the WAL.
    inflateWal()
    const walBefore = walSize()
    expect(walBefore).toBeGreaterThan(1024 * 1024)

    const result = runHousekeeping(db, {
      // Long retention windows — nothing should be pruned.
      otelRetentionDays: 365,
      otelSpansRetentionDays: 365,
      otelMetricsRetentionDays: 365,
      eventRetentionDays: 365,
      vacuum: false,
    })

    expect(result.otelMetricsPruned).toBe(0)
    expect(result.walTruncated).toBe(true)
    expect(walSize()).toBeLessThan(256 * 1024)
  })

  it('reports walTruncated:false on a non-WAL database without throwing', () => {
    const journalDbPath = join(tmpDir, 'journal.db')
    const journalDb = new Database(journalDbPath)
    // Default journal mode (delete / rollback). Confirm we did not flip to WAL.
    const mode = journalDb.pragma('journal_mode', { simple: true }) as string
    expect(mode).not.toBe('wal')

    const result = runHousekeeping(journalDb, {
      otelRetentionDays: 7,
      eventRetentionDays: 30,
      vacuum: false,
    })

    expect(result.success).toBe(true)
    expect(result.walTruncated).toBe(false)
    journalDb.close()
  })

  it('honors truncateWal:false to skip the checkpoint entirely', () => {
    inflateWal()
    const walBefore = walSize()
    expect(walBefore).toBeGreaterThan(1024 * 1024)

    const result = runHousekeeping(db, {
      otelRetentionDays: 7,
      eventRetentionDays: 30,
      vacuum: false,
      truncateWal: false,
    })

    expect(result.success).toBe(true)
    expect(result.walTruncated).toBe(false)
    // WAL is NOT truncated when explicitly disabled — still large.
    expect(walSize()).toBeGreaterThanOrEqual(walBefore - 64 * 1024)
  })
})
