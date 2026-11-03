/** Configuration for OTel telemetry ingestion from Copilot CLI. */
export interface OtelIngestionConfig {
  readonly enabled: boolean
  readonly filePath: string | null
  readonly retentionDays: number
  readonly maxSpansPerTrace: number
  readonly pollIntervalMs: number
}

/** Three-state activation: unconfigured (no env), configured (env set), active (spans ingested). */
export type OtelActivationStatus = 'unconfigured' | 'configured' | 'active'

const DEFAULTS: OtelIngestionConfig = {
  enabled: true,
  filePath: null,
  retentionDays: 7,
  maxSpansPerTrace: 1000,
  pollIntervalMs: 1000,
}

function readInt(envVar: string | undefined, fallback: number): number {
  if (envVar === undefined) return fallback
  const parsed = Number(envVar)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function loadOtelConfig(): OtelIngestionConfig {
  const scnsPath = process.env['OTEL_SCNS_FILE_PATH'] ?? null
  const copilotPath = process.env['COPILOT_OTEL_FILE_EXPORTER_PATH'] ?? null
  const filePath = scnsPath ?? copilotPath ?? DEFAULTS.filePath

  const explicitDisabled = process.env['OTEL_SCNS_ENABLED'] === 'false'
  const explicitEnabled = process.env['OTEL_SCNS_ENABLED'] === 'true'

  // Phase 13.12.8: default enabled=true. Only explicit OTEL_SCNS_ENABLED=false
  // disables ingestion. When enabled with no filePath, callers fall back to
  // getDefaultTelemetryPath() and call ensureTelemetryDir() to materialize
  // the directory so copilot's exporter can write to it.
  const enabled = explicitDisabled ? false : explicitEnabled || DEFAULTS.enabled

  return Object.freeze({
    enabled,
    filePath,
    retentionDays: readInt(process.env['OTEL_SCNS_RETENTION_DAYS'], DEFAULTS.retentionDays),
    maxSpansPerTrace: readInt(
      process.env['OTEL_SCNS_MAX_SPANS_PER_TRACE'],
      DEFAULTS.maxSpansPerTrace,
    ),
    pollIntervalMs: readInt(process.env['OTEL_SCNS_POLL_INTERVAL_MS'], DEFAULTS.pollIntervalMs),
  })
}

/** Determine OTel activation status from config and optional runtime state. */
export function getOtelActivationStatus(
  config: OtelIngestionConfig,
  hasIngestedSpans = false,
): OtelActivationStatus {
  if (!config.enabled && config.filePath === null) return 'unconfigured'
  if (hasIngestedSpans) return 'active'
  return 'configured'
}
