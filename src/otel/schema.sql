-- ── OpenTelemetry Spans ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS otel_spans (
  trace_id TEXT NOT NULL,
  span_id TEXT PRIMARY KEY,
  parent_span_id TEXT,
  name TEXT NOT NULL,
  kind TEXT,
  start_time TEXT NOT NULL,
  end_time TEXT,
  duration_ms REAL,
  status TEXT CHECK (status IN ('OK', 'ERROR', 'UNSET')),
  attributes_json TEXT DEFAULT '{}',
  events_json TEXT DEFAULT '[]',
  resource_json TEXT DEFAULT '{}',
  session_id TEXT,
  created_at DATETIME NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_otel_spans_trace ON otel_spans(trace_id);
CREATE INDEX IF NOT EXISTS idx_otel_spans_time ON otel_spans(start_time);
CREATE INDEX IF NOT EXISTS idx_otel_spans_name ON otel_spans(name);
CREATE INDEX IF NOT EXISTS idx_otel_spans_session ON otel_spans(session_id);

-- ── OpenTelemetry Metrics ────────────────────────────────────
CREATE TABLE IF NOT EXISTS otel_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  metric_type TEXT NOT NULL CHECK (metric_type IN ('histogram', 'counter', 'gauge', 'sum')),
  value REAL NOT NULL,
  attributes_json TEXT DEFAULT '{}',
  resource_json TEXT DEFAULT '{}',
  timestamp TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_otel_metrics_name ON otel_metrics(name);
CREATE INDEX IF NOT EXISTS idx_otel_metrics_time ON otel_metrics(timestamp);

-- ── OTel Ingestor Checkpoint (Phase 13.12.14) ────────────────
-- Persists the current byte offset + inode for each watched JSONL file so
-- the streaming ingestor can resume after broker restart without re-reading
-- the entire (potentially gigabyte-sized) file.
CREATE TABLE IF NOT EXISTS otel_ingest_state (
  file_path TEXT PRIMARY KEY,
  byte_offset INTEGER NOT NULL DEFAULT 0,
  inode INTEGER NOT NULL DEFAULT 0,
  updated_at DATETIME NOT NULL DEFAULT (datetime('now'))
);
