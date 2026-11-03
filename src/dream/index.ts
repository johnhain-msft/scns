// AutoDream Consolidation — Phase 3
export {
  MAX_ENTRYPOINT_LINES,
  MAX_ENTRYPOINT_BYTES,
  truncateEntrypoint,
  countLines,
  countBytes,
} from './memory-limits.js'
export type { TruncateResult } from './memory-limits.js'

export { convertRelativeDates, parseRelativeDate } from './date-utils.js'

export {
  parseMemoryMd,
  serializeMemoryMd,
  detectDuplicates,
  deduplicateEntries,
  resolveContradictions,
  validateMemoryEntry,
} from './memory-entries.js'
export type { MemoryEntry } from './memory-entries.js'

export {
  type DreamState,
  type DreamRunResult,
  initDreamState,
  getDreamState,
  recordDreamRun,
  incrementSessionCount,
  acquireDreamLock,
  releaseDreamLock,
  breakStaleDreamLock,
} from './dream-state.js'

export {
  type DreamGateConfig,
  type DreamGateResult,
  DEFAULT_DREAM_GATE_CONFIG,
  checkDreamGates,
} from './dream-gates.js'

export {
  type EntryPriority,
  getEntryPriority,
  sortByPriority,
  trimToFit,
} from './consolidation-priorities.js'

export {
  type ConsolidationInput,
  type ConsolidationResult,
  type ConsolidationPhaseLog,
  type ConsolidateResult,
  type PruneResult,
  orient,
  gather,
  consolidate,
  prune,
  runConsolidation,
} from './consolidation.js'

export {
  type DailyLogEntry,
  parseDailyLog,
  classifyEntry,
  extractFromLog,
  extractFromMultipleLogs,
  generateEntryName,
} from './extraction.js'

export { openDreamDatabase } from './dream-schema.js'

export {
  type DreamDaemonConfig,
  type DreamRunResult as DaemonRunResult,
  type DreamStatus,
  type DreamDaemon,
  createDreamDaemon,
} from './dream-daemon.js'
