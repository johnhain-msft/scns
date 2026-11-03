/**
 * Ideation wedge (D1) — public API.
 *
 * LLM-driven novel-proposal generation: spawn ONE isolated, bounded, deny-all
 * Copilot ACP session over real signals and write novel proposals to the review
 * inbox (`~/.scns/ideation/`). Advisory-only and DEFAULT-OFF in D1 — proposals
 * are never auto-spawned. D2 closes the loop via the `outcome` slot on records.
 */

export type {
  IdeationProposal,
  IdeationRecord,
  IdeationOutcome,
  IdeationStatus as IdeationStatusType,
  IdeationSignals,
  TelemetrySignal,
  CodebaseSignal,
  RecentOutcomesSignal,
  GapSignal,
  PriorProposalOutcome,
} from './types.js'
export {
  IdeationProposalSchema,
  IdeationRecordSchema,
  IdeationOutcomeSchema,
  IdeationStatus,
  IDEATION_PROPOSAL_FIELDS,
} from './types.js'

export { buildIdeationPrompt } from './prompt.js'
export type { BuildIdeationPromptOptions } from './prompt.js'

export { parseIdeationResponse } from './parse.js'
export type { ParseIdeationOptions, ParseIdeationResult } from './parse.js'

export { createIdeationInbox } from './inbox.js'
export type { IdeationInbox, AppendMeta } from './inbox.js'

export {
  gatherIdeationSignals,
  telemetrySignalFromPatterns,
  summarizeRecentOutcomes,
  readCodebaseSignal,
} from './signals.js'
export type { IdeationSignalSources } from './signals.js'

export {
  createDefaultIdeationBackend,
  DEFAULT_IDEATION_ATTEMPT_TIMEOUT_MS,
} from './backend.js'
export type { IdeationBackend, DefaultIdeationBackendOptions } from './backend.js'

export {
  runIdeation,
  ideationEnabledFromEnv,
  synthEnabledFromEnv,
  memGapsEnabledFromEnv,
  DEFAULT_IDEATION_K,
} from './runner.js'
export type { RunIdeationDeps, RunIdeationOptions, RunIdeationResult } from './runner.js'

export { synthesizeProposals, createSynthIdeationBackend } from './synth.js'
export type { SynthesizeOptions } from './synth.js'

export { deriveOpenGaps } from './open-gaps.js'
export type { DeriveOpenGapsInput, NegMemThemeInput } from './open-gaps.js'

export {
  feedbackEnabledFromEnv,
  titleFamily,
  buildPriorOutcomes,
  linkOutcomes,
  applyLinkedOutcomes,
} from './feedback.js'
export type { RealizedOutcomes } from './feedback.js'
