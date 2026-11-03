/**
 * Housekeeping — data retention and cleanup tasks run during dream cycles.
 *
 * Prunes old OTel data, events, and optionally vacuums the database.
 * Designed to run during the dream consolidation phase as part of
 * the system's maintenance window.
 */

import type Database from 'better-sqlite3'
import { logger } from '../shared/logger.js'

const log = logger.child({ module: 'housekeeping' })

export interface HousekeepingConfig {
  /** Back-compat: if present and the split fields are not, this applies to both. */
  readonly otelRetentionDays: number
  /** Phase 13.12.16: spans are much smaller; safe to keep longer. */
  readonly otelSpansRetentionDays?: number
  /** Phase 13.12.16: metrics dominate DB size; default much shorter. */
  readonly otelMetricsRetentionDays?: number
  readonly eventRetentionDays: number
  /**
   * P0.2 (2026-05-19): bound `task_run_history` growth. Each scheduled
   * task tick that succeeds/fails writes one row; at ~430 rows/day
   * observed in prod this dwarfs all other operational tables within
   * a month. Default 14 days — long enough to debug a week's worth
   * of cron failures, short enough to keep the table O(thousands)
   * not O(tens-of-thousands).
   */
  readonly taskRunHistoryRetentionDays?: number
  /**
   * P0.2 (2026-05-19): bound `messages_history` growth. Sessions that
   * deregister purge their live `messages` rows here for forensics
   * (see purgeSessionToHistory). Default 90 days because debugging
   * dispatch races sometimes needs to reach further back than other
   * operational data, but unbounded is unacceptable in multi-project mode.
   */
  readonly messagesHistoryRetentionDays?: number
  readonly vacuum: boolean
  /**
   * Task 44: issue `PRAGMA wal_checkpoint(TRUNCATE)` at the end of
   * housekeeping so the -wal file is reclaimed even when `vacuum:false`
   * (the live-broker / restart-manager Phase-1 path). Default true.
   * Set false only for tests that need to assert the *un*-truncated
   * baseline. No-op on non-WAL databases.
   */
  readonly truncateWal?: boolean
  /**
   * P5b (2026-06-03): payload-bytes cap for `otel_spans`. Row-count
   * caps were rejected as a primary lever after live verification
   * showed only ~2k rows but 103 MB of table data (avg ~52KB/span —
   * fat JSON blobs dominate the footprint). When set, after age-based
   * pruning we walk traces oldest-first and delete entire traces
   * (never individual spans, which would break trace assembly) until
   * the estimated byte total is ≤ this cap. Opt-in: undefined = skip.
   */
  readonly otelSpansMaxBytes?: number
  /**
   * P5b: freshness floor for trace-group pruning. Traces whose newest
   * span is within this many hours of `now` are NEVER deleted, even
   * if they push the total over `otelSpansMaxBytes`. Guards against
   * deleting an in-flight large trace mid-assembly. Default 24h.
   */
  readonly otelSpansFreshnessHours?: number
  /**
   * P5b: row-count cap for `otel_metrics`. Metrics are independent
   * rows (no trace-assembly concern) so a row-count cap is safe.
   * After age-based pruning, if `COUNT(*) > maxRows`, delete the
   * oldest by `timestamp ASC` until under cap. Opt-in: undefined = skip.
   */
  readonly otelMetricsMaxRows?: number
}

export interface HousekeepingResult {
  readonly success: boolean
  readonly otelSpansPruned: number
  readonly otelMetricsPruned: number
  readonly eventsPruned: number
  /** P0.2: rows deleted from task_run_history. */
  readonly taskRunHistoryPruned: number
  /** P0.2: rows deleted from messages_history. */
  readonly messagesHistoryPruned: number
  readonly vacuumed: boolean
  /**
   * Task 44: whether `wal_checkpoint(TRUNCATE)` ran successfully and
   * shrank the -wal file. False on non-WAL DBs, when `truncateWal` is
   * disabled, or when the checkpoint was blocked by a concurrent
   * reader (`busy=1`). Surface this in monitoring/logs so we can tell
   * a benign idle truncation apart from a blocked one.
   */
  readonly walTruncated: boolean
  /** Frames written back to the main DB by the final checkpoint. */
  readonly walFramesCheckpointed: number
  readonly durationMs: number
  readonly error?: string
  /** P5b: extra trace-group prune statistics (zero when feature unused). */
  readonly otelTraceGroupsPruned?: number
  readonly otelSpansFreedBytesEstimated?: number
  readonly otelSpansFreshFloorHit?: boolean
}

export const DEFAULT_HOUSEKEEPING_CONFIG: HousekeepingConfig = {
  otelRetentionDays: 7,
  otelSpansRetentionDays: 7,
  // Metrics ingestion is very high-volume (~2M rows/day observed in prod).
  // Capping at 2 days keeps the DB small enough for nightly backups.
  otelMetricsRetentionDays: 2,
  eventRetentionDays: 30,
  taskRunHistoryRetentionDays: 14,
  messagesHistoryRetentionDays: 90,
  vacuum: true,
  truncateWal: true,
  // P5b defaults: 50 MiB span payload cap (vs the 103 MB live blowup) and
  // 24h freshness floor. Conservative — opt-in caller can lower.
  otelSpansMaxBytes: 50 * 1024 * 1024,
  otelSpansFreshnessHours: 24,
  otelMetricsMaxRows: 100_000,
}

/** Check if a table exists in the database */
function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table' AND name=?")
    .get(name) as { cnt: number }
  return row.cnt > 0
}

export interface PruneOldestTracesConfig {
  readonly otelSpansMaxBytes?: number
  readonly otelSpansFreshnessHours?: number
}

export interface PruneOldestTracesResult {
  readonly tracesDeleted: number
  readonly spansDeleted: number
  readonly freedBytesEstimated: number
  readonly freshFloorHit: boolean
}

interface TraceAggRow {
  readonly trace_id: string
  readonly oldest_start: string
  readonly newest_start: string
  readonly span_count: number
  readonly est_bytes: number
  readonly is_fresh: number
}

/**
 * P5b: trace-group prune for `otel_spans`. Estimates per-span payload bytes
 * via `length(attributes_json)+length(events_json)+length(resource_json)+length(name)`
 * (cheap; no JSON parsing). Walks traces oldest-first by `MIN(start_time)`
 * and deletes entire traces until estimated bytes ≤ `otelSpansMaxBytes`.
 * Never half-deletes — a trace with a missing root or missing children
 * would break trace assembly downstream. Traces whose newest span is
 * within `otelSpansFreshnessHours` of now are never deleted (default 24h).
 *
 * Returns `freshFloorHit: true` if at least one in-window trace was
 * encountered and skipped — useful for monitoring whether the cap is
 * being held back by recent traffic.
 *
 * Entire operation runs in a single `db.transaction` so readers see
 * either all-of-trace or none-of-trace, never a partial state.
 */
export function pruneOldestTraces(
  db: Database.Database,
  cfg: PruneOldestTracesConfig,
): PruneOldestTracesResult {
  const empty: PruneOldestTracesResult = {
    tracesDeleted: 0,
    spansDeleted: 0,
    freedBytesEstimated: 0,
    freshFloorHit: false,
  }
  if (cfg.otelSpansMaxBytes === undefined || cfg.otelSpansMaxBytes <= 0) {
    return empty
  }
  if (!tableExists(db, 'otel_spans')) {
    return empty
  }

  const maxBytes = cfg.otelSpansMaxBytes
  const freshnessHours = cfg.otelSpansFreshnessHours ?? 24

  const traces = db
    .prepare(
      `SELECT trace_id,
              MIN(start_time) AS oldest_start,
              MAX(start_time) AS newest_start,
              COUNT(*) AS span_count,
              SUM(
                length(COALESCE(attributes_json, '')) +
                length(COALESCE(events_json, '')) +
                length(COALESCE(resource_json, '')) +
                length(COALESCE(name, ''))
              ) AS est_bytes,
              CASE
                WHEN MAX(start_time) >= datetime('now', '-' || ? || ' hours') THEN 1
                ELSE 0
              END AS is_fresh
         FROM otel_spans
         GROUP BY trace_id
         ORDER BY MIN(start_time) ASC`,
    )
    .all(freshnessHours) as readonly TraceAggRow[]

  let totalBytes = traces.reduce((s, t) => s + (t.est_bytes ?? 0), 0)
  if (totalBytes <= maxBytes) {
    const freshFloorHit = traces.some((t) => t.is_fresh === 1)
    return { ...empty, freshFloorHit }
  }

  let tracesDeleted = 0
  let spansDeleted = 0
  let freedBytesEstimated = 0
  let freshFloorHit = false

  const deleteTrace = db.prepare('DELETE FROM otel_spans WHERE trace_id = ?')
  const tx = db.transaction(() => {
    for (const trace of traces) {
      if (totalBytes <= maxBytes) break
      if (trace.is_fresh === 1) {
        freshFloorHit = true
        continue
      }
      const result = deleteTrace.run(trace.trace_id)
      tracesDeleted += 1
      spansDeleted += result.changes
      freedBytesEstimated += trace.est_bytes ?? 0
      totalBytes -= trace.est_bytes ?? 0
    }
  })
  tx()

  return { tracesDeleted, spansDeleted, freedBytesEstimated, freshFloorHit }
}

/**
 * P5b helper: enforce a row-count cap on `otel_metrics`. Metrics rows are
 * independent (no trace-assembly invariants) so a strict row-cap is safe.
 * Deletes oldest-first by `timestamp ASC`. Returns number of rows removed.
 */
export function pruneOldestMetrics(db: Database.Database, maxRows: number): number {
  if (!Number.isFinite(maxRows) || maxRows <= 0) return 0
  if (!tableExists(db, 'otel_metrics')) return 0
  const current = (db.prepare('SELECT COUNT(*) AS n FROM otel_metrics').get() as { n: number }).n
  if (current <= maxRows) return 0
  const excess = current - maxRows
  const result = db
    .prepare(
      `DELETE FROM otel_metrics WHERE id IN (
         SELECT id FROM otel_metrics ORDER BY timestamp ASC, id ASC LIMIT ?
       )`,
    )
    .run(excess)
  return result.changes
}

/**
 * Task 44: explicitly truncate the WAL after housekeeping so the
 * `data.db-wal` file actually shrinks on disk. The auto-checkpoint
 * configured by `PRAGMA wal_autocheckpoint` is PASSIVE — it copies
 * pages back into the main DB but never reduces the WAL file size —
 * so without this call the WAL grows monotonically until the broker
 * is recycled. We try TRUNCATE first; if blocked by a reader (`busy=1`)
 * we fall back to RESTART (which at least rewinds the WAL's logical
 * end-of-file even if the on-disk file is not yet reclaimed) and
 * report walTruncated=false so the caller knows the file is still
 * large. Non-WAL DBs return `walTruncated: false` without erroring.
 */
function truncateWalIfPossible(
  db: Database.Database,
): { walTruncated: boolean; walFramesCheckpointed: number } {
  try {
    const mode = db.pragma('journal_mode', { simple: true }) as string | undefined
    if (mode !== 'wal') {
      return { walTruncated: false, walFramesCheckpointed: 0 }
    }
    const rows = db.pragma('wal_checkpoint(TRUNCATE)') as ReadonlyArray<{
      busy: number
      log: number
      checkpointed: number
    }>
    const row = rows[0]
    if (row && row.busy === 0) {
      log.info(
        { framesCheckpointed: row.checkpointed, walFrames: row.log },
        'WAL checkpoint(TRUNCATE) succeeded',
      )
      return { walTruncated: true, walFramesCheckpointed: row.checkpointed }
    }
    // Reader contention — best-effort RESTART so the next writer at
    // least reuses the WAL from the beginning instead of appending.
    log.warn(
      { busy: row?.busy, walFrames: row?.log, framesCheckpointed: row?.checkpointed },
      'WAL checkpoint(TRUNCATE) blocked; falling back to RESTART',
    )
    try {
      db.pragma('wal_checkpoint(RESTART)')
    } catch {
      /* non-fatal */
    }
    return { walTruncated: false, walFramesCheckpointed: row?.checkpointed ?? 0 }
  } catch (err) {
    log.warn({ err }, 'WAL checkpoint failed')
    return { walTruncated: false, walFramesCheckpointed: 0 }
  }
}

/**
 * Run housekeeping tasks: prune old data, vacuum DB.
 * Safe to call on any database — gracefully handles missing tables.
 */
export function runHousekeeping(
  db: Database.Database,
  config: HousekeepingConfig = DEFAULT_HOUSEKEEPING_CONFIG,
): HousekeepingResult {
  const start = Date.now()
  let otelSpansPruned = 0
  let otelMetricsPruned = 0
  let eventsPruned = 0
  let taskRunHistoryPruned = 0
  let messagesHistoryPruned = 0
  let vacuumed = false

  try {
    const spansDays = config.otelSpansRetentionDays ?? config.otelRetentionDays
    const metricsDays = config.otelMetricsRetentionDays ?? config.otelRetentionDays

    // Prune OTel spans
    if (tableExists(db, 'otel_spans')) {
      const result = db
        .prepare(`DELETE FROM otel_spans WHERE created_at < datetime('now', '-' || ? || ' days')`)
        .run(spansDays)
      otelSpansPruned = result.changes
      if (otelSpansPruned > 0) {
        log.info({ pruned: otelSpansPruned, retentionDays: spansDays }, 'Pruned OTel spans')
      }
    }

    // Prune OTel metrics
    if (tableExists(db, 'otel_metrics')) {
      const result = db
        .prepare(`DELETE FROM otel_metrics WHERE created_at < datetime('now', '-' || ? || ' days')`)
        .run(metricsDays)
      otelMetricsPruned = result.changes
      if (otelMetricsPruned > 0) {
        log.info({ pruned: otelMetricsPruned, retentionDays: metricsDays }, 'Pruned OTel metrics')
      }
    }

    // Prune events
    if (tableExists(db, 'events')) {
      const result = db
        .prepare(`DELETE FROM events WHERE created_at < datetime('now', '-' || ? || ' days')`)
        .run(config.eventRetentionDays)
      eventsPruned = result.changes
      if (eventsPruned > 0) {
        log.info({ pruned: eventsPruned, retentionDays: config.eventRetentionDays }, 'Pruned events')
      }
    }

    // P0.2: Prune task_run_history. Filtered on `started_at` (TEXT in ISO-8601
    // form, lexicographically comparable to SQLite's datetime() output).
    const taskRunDays = config.taskRunHistoryRetentionDays ?? 14
    if (tableExists(db, 'task_run_history')) {
      const result = db
        .prepare(
          `DELETE FROM task_run_history WHERE started_at < datetime('now', '-' || ? || ' days')`,
        )
        .run(taskRunDays)
      taskRunHistoryPruned = result.changes
      if (taskRunHistoryPruned > 0) {
        log.info(
          { pruned: taskRunHistoryPruned, retentionDays: taskRunDays },
          'Pruned task_run_history',
        )
      }
    }

    // P0.2: Prune messages_history. Filtered on `purged_at` (the moment the
    // row was archived from `messages`), not `created_at` — we want to keep
    // sessions findable for N days after they end, regardless of when the
    // underlying messages were originally sent.
    const messagesHistoryDays = config.messagesHistoryRetentionDays ?? 90
    if (tableExists(db, 'messages_history')) {
      const result = db
        .prepare(
          `DELETE FROM messages_history WHERE purged_at < datetime('now', '-' || ? || ' days')`,
        )
        .run(messagesHistoryDays)
      messagesHistoryPruned = result.changes
      if (messagesHistoryPruned > 0) {
        log.info(
          { pruned: messagesHistoryPruned, retentionDays: messagesHistoryDays },
          'Pruned messages_history',
        )
      }
    }

    // P5b: row-count cap for metrics (after age-based prune).
    if (config.otelMetricsMaxRows !== undefined && tableExists(db, 'otel_metrics')) {
      const metricsCapped = pruneOldestMetrics(db, config.otelMetricsMaxRows)
      if (metricsCapped > 0) {
        otelMetricsPruned += metricsCapped
        log.info(
          { capped: metricsCapped, maxRows: config.otelMetricsMaxRows },
          'Capped otel_metrics to maxRows',
        )
      }
    }

    // P5b: trace-group payload-byte prune for spans (after age-based prune).
    // Row counts are a poor proxy for span footprint; ~52KB/span observed
    // in prod means a few thousand rows dominate the DB. This pass walks
    // traces oldest-first and deletes whole traces until estimated bytes
    // are under cap, preserving trace integrity and an in-flight freshness
    // window.
    let otelTraceGroupsPruned = 0
    let otelSpansFreedBytesEstimated = 0
    let otelSpansFreshFloorHit = false
    if (config.otelSpansMaxBytes !== undefined && tableExists(db, 'otel_spans')) {
      const traceResult = pruneOldestTraces(db, {
        otelSpansMaxBytes: config.otelSpansMaxBytes,
        otelSpansFreshnessHours: config.otelSpansFreshnessHours,
      })
      if (traceResult.tracesDeleted > 0 || traceResult.freshFloorHit) {
        otelTraceGroupsPruned = traceResult.tracesDeleted
        otelSpansFreedBytesEstimated = traceResult.freedBytesEstimated
        otelSpansFreshFloorHit = traceResult.freshFloorHit
        otelSpansPruned += traceResult.spansDeleted
        if (traceResult.tracesDeleted > 0) {
          log.info(
            {
              tracesDeleted: traceResult.tracesDeleted,
              spansDeleted: traceResult.spansDeleted,
              freedBytesEstimated: traceResult.freedBytesEstimated,
              freshFloorHit: traceResult.freshFloorHit,
              maxBytes: config.otelSpansMaxBytes,
            },
            'Pruned oldest OTel traces (payload-bytes cap)',
          )
        }
      }
    }

    // VACUUM if requested and any data was pruned
    const totalPruned =
      otelSpansPruned + otelMetricsPruned + eventsPruned + taskRunHistoryPruned + messagesHistoryPruned
    if (config.vacuum && totalPruned > 0) {
      db.exec('VACUUM')
      vacuumed = true
      log.info('Database vacuumed')
    }

    // Task 44: ALWAYS try to reclaim the WAL on disk unless explicitly
    // disabled, regardless of whether anything was pruned/vacuumed. The
    // restart-manager Phase-1 path runs with `vacuum:false` and may not
    // prune anything when retention windows are wide, but the WAL still
    // needs truncating because the auto-checkpoint is PASSIVE only.
    const truncateRequested = config.truncateWal !== false
    const walResult = truncateRequested
      ? truncateWalIfPossible(db)
      : { walTruncated: false, walFramesCheckpointed: 0 }

    const durationMs = Date.now() - start
    log.info(
      {
        otelSpansPruned,
        otelMetricsPruned,
        eventsPruned,
        taskRunHistoryPruned,
        messagesHistoryPruned,
        vacuumed,
        walTruncated: walResult.walTruncated,
        walFramesCheckpointed: walResult.walFramesCheckpointed,
        durationMs,
      },
      'Housekeeping complete',
    )

    return {
      success: true,
      otelSpansPruned,
      otelMetricsPruned,
      eventsPruned,
      taskRunHistoryPruned,
      messagesHistoryPruned,
      vacuumed,
      walTruncated: walResult.walTruncated,
      walFramesCheckpointed: walResult.walFramesCheckpointed,
      durationMs,
      otelTraceGroupsPruned,
      otelSpansFreedBytesEstimated,
      otelSpansFreshFloorHit,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error({ err }, 'Housekeeping failed')
    return {
      success: false,
      otelSpansPruned,
      otelMetricsPruned,
      eventsPruned,
      taskRunHistoryPruned,
      messagesHistoryPruned,
      vacuumed,
      walTruncated: false,
      walFramesCheckpointed: 0,
      durationMs: Date.now() - start,
      error: message,
    }
  }
}
