/**
 * SCNS selfopt — Phase 0 measurement substrate (barrel).
 *
 * The "loss function" for the closed-loop capability factory: mine labelled
 * task outcomes from SCNS's own broker history, replay a candidate artifact
 * against a held-out split, and gate it strict-improve. Pure measurement —
 * Phase 0 mutates no live capability artifact.
 */
export type {
  TaskRecord,
  TaskOutcome,
  TaskSplit,
  TaskOrigin,
  ReferenceKind,
  TeamOutcome,
  ReplayResult,
  RuleJudge,
  RuleCheck,
  GateResult,
  GateAction,
  GateMetric,
} from './types.js'

export { selectGateScore, evaluateGate } from './gate.js'
export type { EvaluateGateInput } from './gate.js'

export { scoreRuleJudge, recordedJudge, requiredTools } from './judges.js'
export type { JudgeScore } from './judges.js'

export {
  parseTeamOutcomes,
  outcomesToTaskRecords,
  dedupTasks,
  assignSplits,
  mineTaskRecords,
  loadOutcomeEvents,
  changedFilesFromDiff,
  DEFAULT_VAL_FRACTION,
  DEFAULT_TEST_FRACTION,
  DEFAULT_SPLIT_SEED,
  DEFAULT_MAX_TASKS,
} from './mine.js'
export type {
  IntentResolver,
  MineOptions,
  AssignSplitsOptions,
  OutcomesToTasksOptions,
} from './mine.js'

export { mineValTasks, mineValTasksFromEvents } from './mine-val-tasks.js'
export type { MineValTasksOptions } from './mine-val-tasks.js'

export {
  runShadowEvalWithOptIns,
  createDetachedWorktree,
  WORKTREE_GIT_TIMEOUT_MS,
} from './shadow-eval-runner.js'
export type { ShadowEvalRunnerDeps, IsolatedWorktree, GitExec } from './shadow-eval-runner.js'

export {
  MockBackend,
  replayOne,
  replayBatch,
  aggregateScores,
  aggregateCost,
} from './replay.js'
export type { ReplayBackend, ReplayPair, ReplayOneOptions } from './replay.js'

export { computeBaseline } from './baseline.js'
export type { BaselineOptions, BaselineResult } from './baseline.js'

export { AcpReplayBackend, buildReplayPrompt, DEFAULT_ATTEMPT_TIMEOUT_MS } from './acp-replay-backend.js'
export type { AcpReplayBackendOptions, InjectedMemoryProvider } from './acp-replay-backend.js'

export {
  evaluateBehavioralGate,
  resolveBehavioralGateMode,
  DEFAULT_BEHAVIORAL_VAL_TASKS,
  DEFAULT_RETRIEVAL_VAL_TASKS,
  DEFAULT_WHY_RETRIEVAL_VAL_TASKS,
  ALL_RETRIEVAL_VAL_TASKS,
  BEHAVIORAL_VAL_NUDGE,
  RETRIEVAL_VAL_NUDGE,
  BEHAVIORAL_GATE_ENV,
  BEHAVIORAL_ENFORCE_ENV,
} from './behavioral-gate.js'
export type {
  BehavioralGateInput,
  BehavioralGateResult,
  BehavioralGateMode,
} from './behavioral-gate.js'

export {
  validateLoss,
  scoreLossReadings,
  resolveValidateLossMode,
  HEADLINE_TASK,
  HEADLINE_MIN_CHARS,
  SECONDARY_CONTAINS_VERIFY,
  VALIDATE_LOSS_ACP_ENV,
} from './validate-loss.js'
export type {
  ValidateLossInput,
  ValidateLossResult,
  ValidateLossMode,
  LossReading,
  BackendLabel,
} from './validate-loss.js'

export { runValidateLossWithOptIns } from './validate-loss-runner.js'
export type {
  ValidateLossRunnerDeps,
  ValidateLossRunResult,
  BackendWithPid,
} from './validate-loss-runner.js'

export { stageAndGateNegativeRule, DEFAULT_NONREGRESSION_EPSILON } from './staging.js'
export type {
  StageNegativeRuleInput,
  StageNegativeRuleResult,
  StageDecision,
  RejectionBufferEntry,
} from './staging.js'
