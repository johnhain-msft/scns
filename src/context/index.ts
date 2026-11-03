export {
  ContextStatus,
  RotationAction,
  ContextHealthConfigSchema,
  type ContextHealth,
  type ContextHealthConfig,
  type RotationRecommendation,
  type HandoffState,
} from './types.js'

export { createHealthMonitor, type HealthMonitorOptions } from './health-monitor.js'

export {
  HandoffStatus,
  type HandoffDocument,
  type HandoffDocumentSummary,
  type WorkItem,
  type BlockedItem,
  type Decision,
  type FileChange,
} from './handoff-types.js'

export {
  createHandoffGenerator,
  type HandoffGenerator,
  type HandoffGeneratorDeps,
  type HandoffInput,
  type SessionInfo,
  type TeamInfo,
  type ValidationResult,
} from './handoff-generator.js'

export { createHandoffStore, type HandoffStore } from './handoff-store.js'

export {
  calculateQualityScore,
  applyCompactionPenalty,
  applyErrorPenalty,
  createInitialQualityState,
  type QualityState,
} from './quality-decay.js'

export {
  createCompactionDetector,
  type CompactionDetector,
  type CompactionDetectorConfig,
  type CompactionDetectorOptions,
  type CompactionSignal,
  type SessionActivity,
  type RotationCandidate,
  type CompactionDetectorStats,
} from './compaction-detector.js'

export {
  createRotationController,
  type RotationController,
  type RotationControllerDeps,
  type RotationControllerConfig,
  type RotationResult,
  type RotationControllerStats,
} from './rotation-controller.js'

export { createWatchdogDaemon, type WatchdogDaemon } from './rotation-watchdog.js'
