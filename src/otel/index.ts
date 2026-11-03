export { applyOtelSchema } from './db.js'
export { loadOtelConfig } from './config.js'
export type { OtelIngestionConfig } from './config.js'
export {
  parseOtelLine,
  extractSpans,
  extractMetrics,
  nanoToIso,
  kvToObject,
  spanKindToString,
  statusCodeToString,
} from './jsonl-parser.js'
export type {
  OtelRecord,
  ResourceSpans,
  RawSpan,
  KeyValue,
  SpanEvent,
  ResourceMetrics,
  RawMetric,
  DataPoint,
  SpanInput,
  MetricInput,
} from './jsonl-parser.js'
export {
  insertSpans,
  insertMetrics,
  findTraces,
  findSpansByTraceId,
  getMetricsSummary,
  getMetricsTimeseries,
  cleanupOlderThan,
  getSpanCount,
  getMetricCount,
} from './otel-repository.js'
export type {
  OtelSpan,
  TraceSummary,
  MetricsSummary,
  TimeseriesBucket,
  FindTracesOptions,
  MetricsSummaryOptions,
  TimeseriesOptions,
} from './otel-repository.js'
export { extractSessionSummaries, extractSessionSummary } from './session-extractor.js'
export type { SessionSummary, ExtractSessionsOptions } from './session-extractor.js'
export { buildSessionTimeline, buildRecentTimelines } from './session-timeline.js'
export type {
  TimelineEntry,
  SessionTimeline,
  BuildTimelineOptions,
  BuildRecentTimelinesOptions,
} from './session-timeline.js'
export { assembleTraceTree, flattenTraceTree } from './trace-assembler.js'
export type { SpanNode } from './trace-assembler.js'
export { createOtelFileWatcher } from './file-watcher.js'
export type { OtelFileWatcher, FileWatcherStats } from './file-watcher.js'
export {
  generateTelemetryEnvBlock,
  detectExistingConfig,
  getDefaultTelemetryPath,
  ensureTelemetryDir,
} from './auto-config.js'
export type { ExistingTelemetryConfig, TelemetryEnvOptions } from './auto-config.js'
export {
  generateSessionDigest,
  storeSessionDigest,
  generateBatchDigests,
} from './session-digest.js'
export type { SessionDigest } from './session-digest.js'
export { extractPatterns, patternsToMemoryEntries } from './pattern-extractor.js'
export type {
  WorkSchedulePattern,
  ToolPreferences,
  ModelPreferences,
  ExtractedPatterns,
} from './pattern-extractor.js'
