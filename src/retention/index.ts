export {
  rotateTelemetryIfNeeded,
  resolveTelemetryRotationConfig,
  sweepParkedTelemetry,
  pruneTelemetryArchives,
  DEFAULT_TELEMETRY_MAX_BYTES,
  DEFAULT_TELEMETRY_RETAIN_COUNT,
  DEFAULT_TELEMETRY_MAX_TOTAL_BYTES,
} from './telemetry-rotator.js'
export type {
  TelemetryRotationConfig,
  TelemetryRotationResult,
  TelemetryRotationReason,
  ParkedSweepResult,
  TelemetryPruneResult,
} from './telemetry-rotator.js'

export { isRetentionDisabled } from './retention-policy.js'
export type { RetentionTaskKey } from './retention-policy.js'

export {
  reapStaleSessionStates,
  DEFAULT_SESSION_STATE_MAX_AGE_MS,
} from './session-state-reaper.js'
export type {
  SessionStateReaperConfig,
  ReapResult,
  ReapError,
} from './session-state-reaper.js'

export { computeFootprint, createFootprintRouter } from './footprint.js'
export type {
  FootprintTarget,
  FootprintEntry,
  FootprintReport,
  ComputeFootprintOptions,
} from './footprint.js'
