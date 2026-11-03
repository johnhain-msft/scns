// Observation Layer — Phase 4
export * from './types.js'
export * from './observer.js'
export * from './config.js'
export * from './tags.js'
export * from './daily-log-writer.js'
export { createPrivacyFilter, matchGlob } from './privacy-filter.js'
export type { PrivacyFilterOptions, FilterContext } from './privacy-filter.js'
export { createSecretSanitizer } from './secret-sanitizer.js'
export type { SecretType, SecretDetection, SanitizeOptions } from './secret-sanitizer.js'
export { createSanitizePipeline } from './sanitize-pipeline.js'
export { createFileChangeObserver, createNativeFileWatcher } from './observers/file-changes.js'
export type { FileWatcher, FileChangeObserverOptions } from './observers/file-changes.js'
export { createGitActivityObserver, createGitClient } from './observers/git-activity.js'
export type { GitClient, GitCommit, GitActivityObserverOptions } from './observers/git-activity.js'
export { createSystemExecutor, isDarwin } from './command-executor.js'
export type { CommandExecutor, CommandResult } from './command-executor.js'
export { createActiveAppObserver } from './observers/active-app.js'
export type { ActiveAppObserverOptions } from './observers/active-app.js'
export { createBrowserTabObserver } from './observers/browser-tabs.js'
export type { BrowserTabObserverOptions } from './observers/browser-tabs.js'
export {
  createTerminalHistoryObserver,
  createFileStatReader,
} from './observers/terminal-history.js'
export type {
  FileStatReader,
  TerminalHistoryObserverOptions,
} from './observers/terminal-history.js'
export { createSessionHookHandler } from './observers/session-hooks.js'
export type {
  SessionEvent,
  SessionEventData,
  SessionHookHandlerOptions,
} from './observers/session-hooks.js'
export { createPatternDetector } from './pattern-detector.js'
export type {
  WorkSchedulePattern,
  ToolFrequencyPattern,
  ProjectFocusPattern,
  DetectedPatterns,
  PatternDetectorOptions,
} from './pattern-detector.js'
export { createConfigChangeObserver } from './discovery/config-change-observer.js'
export type { ConfigChangeObserverOptions } from './discovery/config-change-observer.js'
export { createObservationManager } from './observation-manager.js'
export type {
  ObserverFactory,
  ObservationManagerOptions,
  ObservationManagerStatus,
} from './observation-manager.js'
export { createBuiltinAdapter } from './builtin-adapter.js'
export type { AdapterOptions } from './builtin-adapter.js'
export { OBSERVER_CAPABILITIES, OBSERVER_DESCRIPTIONS } from './builtin-capabilities.js'
export { ObserverCapability } from './plugin.js'
export type { ObserverHealth, PluginMetadata, ObserverPlugin } from './plugin.js'
export { toObservation } from './plugin-events.js'
export type { ObservationEvent } from './plugin-events.js'
export { createPluginRegistry } from './plugin-registry.js'
export type { PluginRegistryOptions } from './plugin-registry.js'
export { createPluginLoader } from './plugin-loader.js'
export type { PluginLoaderOptions } from './plugin-loader.js'
// Cross-source pattern detection
export {
  createCrossSourceCorrelator,
  type CrossSourceEvent,
  type CrossSourcePattern,
} from './cross-source/correlator.js'
export { generateCrossToolDigest, type CrossToolDigest } from './cross-source/digest.js'
export { createChroniclePlugin } from './plugins/chronicle-reader.js'
export type {
  ChronicleConfig,
  ChronicleEntry,
  ChronicleFileReader,
  ChroniclePluginOptions,
} from './plugins/chronicle-reader.js'
export { createChronicleDedup } from './plugins/chronicle-dedup.js'
export type { DedupState } from './plugins/chronicle-dedup.js'
export { ChronicleObserverConfigSchema } from './config.js'
export type { ChronicleObserverConfig } from './config.js'
