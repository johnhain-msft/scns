// Suggestion Layer — Phase 6
export {
  SuggestionType,
  SuggestionStatus,
  SuggestionSchema,
  type Suggestion,
  type Evidence,
} from './types.js'

export {
  serializeSuggestion,
  parseSuggestion,
  parseFrontmatter,
  serializeFrontmatter,
} from './suggestion-file.js'

export { createSuggestionStore, type SuggestionStoreOptions } from './suggestion-store.js'

export { createConfidenceScorer } from './confidence.js'
export type { ConfidenceScores, ConfidenceOptions, ConfidenceInput } from './confidence.js'
export { createEvidenceGatherer } from './evidence.js'
export type { EvidenceGathererOptions, OtelPatterns } from './evidence.js'
export { createSuggestionGenerator } from './generator.js'
export type { GeneratorOptions, GeneratorDeps } from './generator.js'

export { createExecutor, StepAction } from './executor.js'
export type {
  ExecutorOptions,
  ImplementationPlan,
  ImplementationStep,
  ExecutionResult,
} from './executor.js'

export { generateArtifact } from './artifact-generators.js'
export type { ArtifactOutput } from './artifact-generators.js'

export { createMemoryExporter } from './memory-exporter.js'
export type { ExportOptions, ExportResult, SuggestionFilter } from './memory-exporter.js'

export { createReviewWorkflow } from './review.js'
export type { ReviewDeps, ReviewResult, SuggestionSummary } from './review.js'

export {
  formatSummaryRow,
  formatSuggestionDetail,
  formatSummaryTable,
  formatReviewResult,
  formatPlan,
  formatArtifactPreview,
} from './format.js'
